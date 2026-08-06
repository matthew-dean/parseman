/**
 * U4 — THE ASSEMBLY, AS EMITTED SOURCE.
 *
 * `assemble.ts` lowers each reachable site to a closure. This file lowers the
 * same sites to TEXT, compiled once per (grammar × option set) at run start.
 * Semantics are `assemble.ts`'s, site for site; the identity sweep
 * (`bench/table-lowering-identity.ts`) gates the two against each other and
 * against the interpreter, and `expected` is inside the digest it compares.
 *
 * ## Why text, and not a rearrangement of `assemble.ts`
 *
 * V8 attaches inline-cache feedback per FUNCTION LITERAL, not per closure. The
 * second closure minted from a `CreateClosure` site moves its `FeedbackCell` to
 * `kManyClosures`, and the vector is shared from then on. `assemble.ts` mints 18
 * arity-2 `SEQV` closures for `less/stylesheet` from ONE literal, so the two
 * child call sites inside that literal see 18 unrelated callees and go
 * megamorphic — a hash lookup in the megamorphic stub cache, no inlining, no
 * type feedback for the callee body. No rearrangement of a file that MINTS
 * closures can produce a distinct literal per site. Emitting one
 * `function _pf<N>` per site can: inside `_pf12` the call `_pf7(…)` names ONE
 * binding and stays monomorphic.
 *
 * ## What may be shared, and what must be emitted
 *
 * A body containing a call to another PIECE must be emitted per site, or the
 * megamorphism relocates from `assemble.ts` into a shared helper and nothing
 * changes. That is why `nextTerm` is INLINED at every sequence term here rather
 * than called.
 *
 * The rule this file applies is narrower than "no helpers", and it is the whole
 * criterion: **a shared emitted-scope helper is sound exactly when it takes no
 * piece as an argument**, because then it has no call site whose feedback a
 * second caller could pollute. `_skipTrivia` qualifies — it calls the installed
 * trivia scanner, which is runtime state in either engine. `nextTerm` does not.
 *
 * ## Cycles
 *
 * `assemble.ts` needs one forwarding stub per recursive site,
 * `const fwd = (input, pos, ctx) => target!(input, pos, ctx)` — a SINGLE
 * function literal that every back-edge in the process funnels through.
 * Emitted `function` declarations hoist, so a back-edge here is a direct name
 * reference and the stub does not exist.
 *
 * ## Refusal
 *
 * Any construct not lowered raises `Unemittable`, naming it. `assemble.ts`
 * catches that, RECORDS it on the assembly, and falls back to the closure path.
 * The fallback is observable (`Assembly.emitRefusal`): a silent one would make
 * a permanently slow path indistinguishable from a fast one, which is exactly
 * what `encode.ts:1208-1213` refuses to allow for `OP_LIVE`.
 */
import type { ParseContext } from '../types.ts'
import {
  OP_ADJ, OP_ATTEMPT, OP_CHOICE, OP_EMPTY, OP_GATE, OP_LIT, OP_LIT_TRACK, OP_NAMES,
  OP_NODE, OP_NODE_TRACK, OP_NOT, OP_OPT, OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX,
  OP_RX_TRACK, OP_SCAN, OP_SCOPE, OP_SCOPE_CAP, OP_SEQ, OP_SEQV, OP_SEQX, OP_XFORM,
} from './ops.ts'
import type { ResolvedClass, ResolvedTable, TableProgram } from './program.ts'
import {
  CAP_OFF, CAP_ON, TRI_NONE, TRI_UNKNOWN, TOP, computeSiteLabels, type SiteLabel,
} from './site-labels.ts'

/** What the compiled factory hands back — the emitted twin of `Assembly`. */
export type EmittedPiece = (input: string, pos: number, ctx: ParseContext) => unknown
export type EmittedAssembly = {
  readonly pieces: Record<string, EmittedPiece>
  /** Sites named for `subtreeComb` — the scan pool and the scan-skip sets. */
  readonly byIp: Record<number, EmittedPiece | undefined>
  readonly end: () => number
  readonly begin: (ctx: ParseContext) => void
}
/** The `new Function` result. Its parameters are `EMITTED_PARAMS`, in order. */
export type EmittedFactory = (...args: readonly unknown[]) => EmittedAssembly

/** A construct the emitter does not lower. Names the CONSTRUCT, never a type. */
export class Unemittable extends Error {
  readonly construct: string
  constructor(construct: string) {
    super(`table emitter: cannot emit ${construct}`)
    this.name = 'Unemittable'
    this.construct = construct
  }
}

/**
 * The names the emitted scope is closed over, in the order the factory takes
 * them. ONE list, so the parameter list and the argument list cannot drift — a
 * mismatch binds the wrong function to the wrong name and yields a parser that
 * runs and is wrong, which no type in this file would catch.
 */
export const EMITTED_PARAMS = [
  'FAIL', 'K', 'FX', 'FNS', 'MASK', 'CLS', 'AFX', 'TRIVIA', 'TRIVIALABELS', 'TRIVIASCAN',
  'SCANS', 'DISP', 'EMPTY_FX', 'EMPTY_CH', 'EMPTY_TLOG', 'EMPTY_TL',
  'cstCaptureActive', 'pushCstLeaf', 'pushCstChild', 'rollbackTriviaAt', 'failAt',
  'classHas', 'consumeTrivia', 'buildFieldMap', 'projectChild', 'unwrapChild',
  'demoteCapturedToRaw', 'cstLeavesLen', 'skipTriviaScanned', 'needsDeferredTriviaCommit',
  'scanTrivia', 'advanceTrivia', 'refuseUnclassifiedRootScope', 'spanLines', 'rawEntry', 'lead',
] as const

/**
 * The state the emitted scope owns, and the helpers that touch it.
 *
 * `_pfEnd` is the shared end-position out-parameter; `assemble.ts:342`'s own
 * comment already calls it *"`_pfEnd` in emitted code"*. `_pfScan` is the
 * installed trivia scanner, which `OP_SCOPE` swaps mid-parse and so cannot be a
 * constant in either engine.
 *
 * Every function here is shared by the rule in this file's header: none takes a
 * piece as an argument.
 */
const RUNTIME_PRELUDE = `
let _pfEnd=0
let _pfScan=null
let _pfHost
function _skipTrivia(input,cur,ctx){
const s=_pfScan
if(s!==null&&ctx._triviaLog===undefined&&!(ctx.captureTrivia===true&&(ctx._cstBuf!==undefined||ctx._cstTriviaLog!==undefined)))return s(input,cur)
if(s!==null)return skipTriviaScanned(s,input,cur,ctx)
if(needsDeferredTriviaCommit(ctx)){const sc=scanTrivia(input,cur,ctx);sc.commit();return sc.end}
return advanceTrivia(input,cur,ctx)
}
function _pushLeaf(ctx,value,s,e){pushCstLeaf(ctx,{_tag:'leaf',value,span:{start:s,end:e}})}
function _pushLeafBuf(ctx,value,s,e){
const l={_tag:'leaf',value,span:{start:s,end:e}}
const b=ctx._cstBuf
if(b.ch!==undefined)b.ch.push(l)
else if(b.single!==undefined){b.ch=[b.single,l];b.single=undefined}
else b.single=l
if(b.raw!==undefined)b.raw.push(l)
else if(b.rawSingle!==undefined){b.raw=[b.rawSingle,l];b.rawSingle=undefined}
else b.rawSingle=l
}
function _accSet(ax,acc){
if(ax===undefined||ax.length===0)return acc
if(acc===undefined)return ax.slice()
for(const s of ax)acc.push(s)
return acc
}
function _trackLines(ctx,input,end){
const from=ctx._lineScannedTo??0
if(end<=from)return
const starts=ctx._lineStarts
if(starts===undefined)return
for(let i=from;i<end;i++)if(input.charCodeAt(i)===10)starts.push(i+1)
ctx._lineScannedTo=end
}
function _rollbackNeeded(ctx){
return ctx._cstBuf!==undefined||ctx._cstLeaves!==undefined||ctx._cstRawChildren!==undefined||ctx._cstTriviaLog!==undefined||ctx._fields!==undefined||ctx._errors!==undefined||ctx._triviaLog!==undefined||ctx._rootTriviaLog!==undefined
}
function _rbBuf(ctx,raw,tl,lv,lg,rt){
const b=ctx._cstBuf
const ra=b.raw
if(ra!==undefined){
if(raw===0)b.raw=undefined
else if(raw===1){b.rawSingle=ra[0];b.raw=undefined}
else if(ra.length!==raw)ra.length=raw
}else if(raw===0)b.rawSingle=undefined
const ch=b.ch
if(ch!==undefined){
if(lv===0)b.ch=undefined
else if(lv===1){b.single=ch[0];b.ch=undefined}
else if(ch.length!==lv)ch.length=lv
}else if(lv===0)b.single=undefined
const bt=b.tl
if(bt!==undefined){
if(tl===0)b.tl=undefined
else if(bt.length!==tl)bt.length=tl
}
if(ctx._triviaLog!==undefined&&ctx._triviaLog.length!==lg)ctx._triviaLog.length=lg
if(ctx._rootTriviaLog!==undefined&&ctx._rootTriviaLog.length!==rt)ctx._rootTriviaLog.length=rt
}
`

function q(s: string): string {
  return JSON.stringify(s)
}

/**
 * The rollback-mark prologue as SSA locals, rather than the eight shared slots
 * `assemble.ts` writes and reads back.
 *
 * `markCst` exists in the closure engine because a `{ raw, tl, lv }` return
 * would allocate per mark and marks are the most-executed thing in the driver.
 * Emitted, the question does not arise: a mark is seven locals in a frame the
 * body already has. Same scalarisation `rollbackCstCaptureAt` documents, one
 * step further because the source form can take it.
 */
function emitMark(t: string, buf: boolean): string {
  // THE SITE IS INSIDE A NODE. `OP_NODE` opens `ctx._cstBuf` unconditionally and
  // closes it on the way out, so the whole discriminating chain below — which
  // sink is live, and whether a mark is needed at all — has ONE answer here, and
  // the pass knows it. What is left is the five loads a mark actually is.
  if (buf) {
    return `let ${t}raw=0,${t}tl=0,${t}lv=0,${t}lg=0,${t}rt=0
{const b=ctx._cstBuf
const r=b.raw;${t}raw=r!==undefined?r.length:b.rawSingle!==undefined?1:0
const h=b.ch;${t}lv=h!==undefined?h.length:b.single!==undefined?1:0
const l=b.tl;${t}tl=l!==undefined?l.length:0
${t}lg=ctx._triviaLog!==undefined?ctx._triviaLog.length:0
${t}rt=ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length:0}`
  }
  return `let ${t}n=false,${t}raw=0,${t}tl=0,${t}lv=0,${t}lg=0,${t}rt=0
{const b=ctx._cstBuf
if(b!==undefined){
const r=b.raw;${t}raw=r!==undefined?r.length:b.rawSingle!==undefined?1:0
const h=b.ch;${t}lv=h!==undefined?h.length:b.single!==undefined?1:0
const l=b.tl;${t}tl=l!==undefined?l.length:0
${t}n=true
}else if(ctx._cstLeaves!==undefined||ctx._cstRawChildren!==undefined||ctx._cstTriviaLog!==undefined||ctx._fields!==undefined||ctx._errors!==undefined||ctx._triviaLog!==undefined||ctx._rootTriviaLog!==undefined){
${t}raw=ctx._cstRawChildren!==undefined?ctx._cstRawChildren.length:0
${t}tl=ctx._cstTriviaLog!==undefined?ctx._cstTriviaLog.length:0
${t}lv=ctx._cstLeaves!==undefined?ctx._cstLeaves.length:0
${t}n=true
}
if(${t}n){
${t}lg=ctx._triviaLog!==undefined?ctx._triviaLog.length:0
${t}rt=ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length:0
}}`
}

/**
 * The matching rollback for a mark emitted with prefix `t`.
 *
 * THE `_fields` AND `_errors` MARKS ARE NOT TAKEN, because in an EMITTED
 * assembly neither sink can grow. `OP_FIELD` is the only writer of `_fields`
 * and `OP_EXPECT`/`recoverScan` the only writers of `_errors`, and none of the
 * three is lowered by this file — a table containing one raises `Unemittable`
 * and the WHOLE assembly falls back to `assemble.ts`'s closures, so no emitted
 * body ever runs beside one. That is what makes this an emit-time fact rather
 * than a per-parse guess, and it is why `assemble.ts`'s `nextTerm` still takes
 * all seven: it is the engine those constructs actually run in.
 *
 * The two sinks are passed differently because `rollbackCstCaptureAt` guards
 * them differently. `_errors` is guarded on `errors !== undefined`, so
 * `undefined` is its established "no mark taken" sentinel and is correct even
 * for a caller-supplied context that arrived with errors already on it.
 * `_fields` has no such guard — `length = undefined` would throw — so it takes
 * the literal `0` that a per-node `_fields` no `OP_FIELD` can push to always has.
 */
function emitRollback(t: string, buf: boolean): string {
  // `_rbBuf` is the `_cstBuf` arm of `rollbackCstCaptureAt` plus the two trivia
  // truncations, with the sink discrimination the label already answered removed.
  // It takes no piece, so the header's sharing rule admits it.
  if (buf) return `_rbBuf(ctx,${t}raw,${t}tl,${t}lv,${t}lg,${t}rt)`
  return `if(${t}n)rollbackTriviaAt(ctx,${t}raw,${t}tl,${t}lv,0,undefined,${t}lg,${t}rt)`
}

/**
 * ONE SEQUENCE TERM — `assemble.ts`'s `nextTerm`, inlined at the site.
 *
 * Reads and writes `cur`; the term's value lands in `dst`; failure returns
 * `FAIL` directly, because emitted here there is no shared return channel to
 * encode a −1 sentinel into.
 *
 * The `ctx.trivia === undefined` test is GONE wherever the site label answers
 * it. It was never an option — `OP_SCOPE` swaps `ctx.trivia` mid-parse, which is
 * why it could not be lifted into `RunCfg` — but it IS a property of where the
 * term sits, and `site-labels.ts` resolves it at encode time. `TRI_NONE` keeps
 * only the first branch, a known slot keeps only the second (with the scope's own
 * scanner already bound into `skip`), and `TRI_UNKNOWN` keeps both.
 */
function emitTerm(callee: string, dst: string, t: string, l: SiteLabel, skip: string): string {
  const fast = `const ${t}v=${callee}(input,cur,ctx)
if(${t}v===FAIL)return FAIL
${dst}=${t}v
cur=_pfEnd`
  if (l.tri === TRI_NONE) return fast
  const scanned = `${emitMark(t, l.buf)}
const ${t}s=${skip}(input,cur,ctx)
const ${t}v=${callee}(input,${t}s,ctx)
if(${t}v===FAIL)return FAIL
${dst}=${t}v
if(_pfEnd>${t}s)cur=_pfEnd
else{${emitRollback(t, l.buf)}}`
  if (l.tri !== TRI_UNKNOWN) return scanned
  return `if(ctx.trivia===undefined){
${fast}
}else{
${scanned}
}`
}

/**
 * The repetition's LEAD-TRIVIA skip, as a BLOCK.
 *
 * A block and not a bare statement because the separator form spells it
 * `} else <this>`, and a label that erases the skip entirely would otherwise
 * leave a dangling `else` to swallow the statement after it.
 */
function leadSkip(hasTrivia: string, leadTrivia: string, skip: string): string {
  if (hasTrivia === 'false') return '{}'
  const call = `itemStart=${skip}(input,itemStart,ctx)`
  if (hasTrivia === 'true') return leadTrivia === 'true' ? `{${call}}` : `{if(${leadTrivia})${call}}`
  return `{if(hasTrivia&&${leadTrivia})${call}}`
}

/** Everything the compiled factory needs bound, beside the emitted text. */
export type EmitResult = {
  readonly source: string
  /** Site offsets the emitter reached — the emitted twin of `Assembly.reached`. */
  readonly reached: ReadonlySet<number>
  /** Hoisted per-choice candidate masks, in `MASK` order. */
  readonly masks: readonly Uint32Array[]
  /** Hoisted per-arm class gates, in `CLS` order. */
  readonly classes: readonly (ResolvedClass | null)[][]
  /** Hoisted per-arm expected sets, in `AFX` order. */
  readonly armExpected: readonly (readonly string[])[][]
}

/**
 * Emit the whole assembly for one resolved table and one option set.
 *
 * Throws `Unemittable` for any construct not lowered. It does NOT compile the
 * text — `assemble.ts` does — so a refusal and a compile failure stay two
 * distinguishable outcomes at the call site.
 */
export function emitAssemblySource(
  t: ResolvedTable,
  prog: TableProgram,
  cfg: { hostCst: boolean; trackLines: boolean; tolerant: boolean; coverage: boolean; probe: boolean },
  extraIps: readonly number[] = [],
): EmitResult {
  const { code, k, disp, triviaLabelled } = t
  const swapLegal = !cfg.trackLines
  const hostCst = cfg.hostCst

  // RECOVERY IS NOT EMITTED. `recoverScan`'s protocol has three implementations
  // already and a fourth is how an error span drifts between engines that are
  // gated against each other to stop exactly that. It is also cold by
  // construction — reached only on the failure of an element — so the speed
  // argument for emitting it is absent. Refused BY NAME, not skipped.
  if (prog.rec === 1 && cfg.tolerant) throw new Unemittable('a recovery (tolerant) assembly')
  if (cfg.coverage) throw new Unemittable('a coverage assembly')

  // THE DOWNWARD PASS, BEFORE ANY LOWERING. The roots are exactly the sites
  // `link` is called on from outside a body — the rule entries and the scan
  // pool's `extraIps` — and each starts at `TOP`, because a caller outside the
  // emitted scope supplies a context this pass cannot see.
  const labels = computeSiteLabels(
    code,
    [...Object.values(prog.rules), ...extraIps],
    hostCst,
  )

  const bodies: string[] = []
  const byIp = new Map<number, string>()
  const alias = new Map<number, string>()
  const reached = new Set<number>()
  const prelude: string[] = []
  const skipDefs: string[] = []
  const skipPool = new Map<string, string>()
  const pool = new Map<string, string>()
  const masks: Uint32Array[] = []
  const classes: (ResolvedClass | null)[][] = []
  const armExpected: (readonly string[])[][] = []

  /** `codegen.ts`'s hoisted pools, same spelling: `_k<N>` / `_fx<N>` / `_fn<N>`. */
  function hoist(kind: string, expr: string): string {
    const hit = pool.get(expr)
    if (hit !== undefined) return hit
    const nm = `_${kind}${pool.size}`
    pool.set(expr, nm)
    prelude.push(`const ${nm}=${expr}`)
    return nm
  }
  const kRef = (i: number): string => hoist('k', `K[${i}]`)
  const fxRef = (i: number): string => hoist('fx', `FX[${i}]`)
  const fnRef = (i: number): string => hoist('fn', `FNS[${i}]`)

  /** A fresh local prefix, so two inlined marks in one body cannot collide. */
  let uid = 0
  const tmp = (): string => `_t${uid++}_`

  /**
   * THE TRIVIA SCAN FOR ONE SITE LABEL.
   *
   * `_skipTrivia` answers four questions on every call — is a scanner installed,
   * is the global trivia log live, is capture on, is a capture sink open — and
   * three of them are what the label already knows. This mints the arm that
   * survives, once per distinct label, and every site with that label calls it by
   * name.
   *
   * Shared, and the header's rule is why it may be: none of these takes a PIECE.
   * The installed scanner arrives as a hoisted `TRIVIASCAN[ki]` const, not as an
   * argument, so a second caller cannot pollute a call site's feedback. That is
   * the same test `_skipTrivia` passed and `nextTerm` failed.
   *
   * `_triviaLog` is deliberately NOT resolved here. It is neither an option nor a
   * site property — nothing in `src` writes it except a caller-supplied
   * `ParseContext` (`types.ts:524`) — so it stays the one runtime read.
   */
  function skipFor(l: SiteLabel): string {
    if (l.tri < 0) return '_skipTrivia'
    const ki = l.tri
    // `TRIVIASCAN[ki]` IS NULLABLE. `program.ts:475` maps every trivia through
    // `fastTriviaScanner`, which declines any shape it cannot lower, so the slot
    // holds `null` for those — which is why `OP_SCOPE` installs a scanner it
    // still has to null-test. The presence of a lowering is table data like the
    // label bit beside it, so it belongs in the key rather than in a branch.
    const hasScan = swapLegal && !triviaLabelled[ki]! && t.triviaScan[ki] != null
    const key = `${ki}|${hasScan ? 1 : 0}|${l.buf ? 1 : 0}|${l.cap}`
    const hit = skipPool.get(key)
    if (hit !== undefined) return hit
    const nm = `_sk${skipPool.size}`
    skipPool.set(key, nm)
    if (!hasScan) {
      // No installed scanner: the labelled/`trackLines` path, which records
      // through `scanTrivia`. `needsDeferredTriviaCommit` is implied by an open
      // buffer, so an in-node site skips the call that asks.
      skipDefs.push(l.buf
        ? `function ${nm}(input,cur,ctx){const s=scanTrivia(input,cur,ctx);s.commit();return s.end}`
        : `function ${nm}(input,cur,ctx){
if(needsDeferredTriviaCommit(ctx)){const s=scanTrivia(input,cur,ctx);s.commit();return s.end}
return advanceTrivia(input,cur,ctx)}`)
      return nm
    }
    const sc = hoist('ts', `TRIVIASCAN[${ki}]`)
    // `ctx.captureTrivia === true && (a sink is open)`, with both conjuncts
    // resolved as far as the label takes them.
    const sink = l.buf ? 'true' : '(ctx._cstBuf!==undefined||ctx._cstTriviaLog!==undefined)'
    const capturing = l.cap === CAP_OFF ? 'false' : l.cap === CAP_ON ? sink : `(ctx.captureTrivia===true&&${sink})`
    if (capturing === 'true') {
      // Capture is on and a sink is open: the bare-scanner arm is unreachable.
      skipDefs.push(`function ${nm}(input,cur,ctx){return skipTriviaScanned(${sc},input,cur,ctx)}`)
      return nm
    }
    const guard = capturing === 'false'
      ? 'ctx._triviaLog===undefined'
      : `ctx._triviaLog===undefined&&!${capturing}`
    skipDefs.push(`function ${nm}(input,cur,ctx){
if(${guard})return ${sc}(input,cur)
return skipTriviaScanned(${sc},input,cur,ctx)}`)
    return nm
  }

  function link(ip: number): string {
    const hit = byIp.get(ip)
    if (hit !== undefined) return hit
    const al = alias.get(ip)
    if (al !== undefined) return al
    // An ALIAS site forwards to its child with no body of its own. Resolved
    // before reservation so no name is minted for a function that would only
    // add a call frame — `assemble.ts` makes the same choice by returning the
    // child piece itself.
    const forwarded = aliasOf(ip)
    if (forwarded !== undefined) {
      reached.add(ip)
      // Provisional, so a cycle through an alias terminates.
      alias.set(ip, `_pf${ip}`)
      const target = link(forwarded)
      alias.set(ip, target)
      return target
    }
    const fname = `_pf${ip}`
    // Reserved BEFORE lowering, so a back-edge into a site still in flight binds
    // to the hoisted declaration rather than to a forwarding stub. This is the
    // whole of `assemble.ts`'s `inFlight` map and its one shared closure.
    byIp.set(ip, fname)
    reached.add(ip)
    bodies.push(lower(ip, fname))
    return fname
  }

  /** Sites that forward to a child with no body, decided by option, data, or LABEL. */
  function aliasOf(ip: number): number | undefined {
    const op = code[ip]
    // `OP_GATE` under a probe or a tolerant recovery is a no-op that forwards to
    // its child, exactly as `assemble.ts:952` resolves it.
    if (op === OP_GATE && (cfg.tolerant || cfg.probe)) return code[ip + 2]!
    if (op === OP_RULE) return code[ip + 1]!
    // A SCOPE THAT INSTALLS WHAT IS ALREADY INSTALLED. `encode.ts:520` wraps
    // EVERY rule of a `rules({ trivia }, …)` map in its own `OP_SCOPE`, so a
    // grammar with one ambient trivia re-installs the same slot at every rule
    // entry — six context stores, a scanner swap and their six restores, per
    // call, to arrive at the values already there.
    //
    // The label is what makes this decidable: `tri >= 0` can ONLY have come from
    // an enclosing `OP_SCOPE` carrying that slot, and that scope set
    // `ctx.triviaKindLabels` and `_pfScan` from the same slot, so all three are
    // already the values this row would write. Restricted to plain `OP_SCOPE`
    // with no root-capture policy: `OP_SCOPE_CAP` also raises `captureTrivia`,
    // and the two flag bits are a real refusal and a real save/restore.
    //
    // `ki >= 0` is required rather than implied: `TRI_NONE` and `TRI_UNKNOWN` are
    // themselves negative, so comparing a negative operand against a lattice
    // element would read "unknown" as a match.
    if (op === OP_SCOPE && code[ip + 3]! === 0 && code[ip + 1]! >= 0
      && labels.at(ip).tri === code[ip + 1]!) {
      return code[ip + 2]!
    }
    return undefined
  }

  function lower(ip: number, fname: string): string {
    const op = code[ip]
    const head = `function ${fname}(input,pos,ctx){`
    const L = labels.at(ip)
    /**
     * THE LEAF CAPTURE TEST, and only the test.
     *
     * `cstCaptureActive` is `_cstBuf !== undefined || _cstLeaves !== undefined`,
     * and `OP_NODE` opens `_cstBuf` on entry regardless of host mode — so under a
     * node the answer is a constant `true`. What that licenses is dropping the
     * CALL, never the capture: the captured leaves feed `kids` → `build(...)`,
     * and eliding them on `hostCst === false` would be a wrong tree, not a fast
     * one. Off-label the test is INLINED rather than called, which is sound
     * everywhere and costs nothing.
     *
     * THE PUSH ITSELF is two cross-module calls — `pushCstLeaf` to decide on
     * `trackLines`, then `pushCstChild` to decide which collector is live — on
     * the most-executed path there is. Both decisions are settled here:
     * `trackLines` is `RunCfg`, and an open `_cstBuf` is the label. `_pushLeafBuf`
     * is that pair with both branches taken, and it takes no piece.
     */
    const pushLeaf = L.buf && !cfg.trackLines ? '_pushLeafBuf' : '_pushLeaf'
    const captureLeaf = (value: string): string => {
      const call = `${pushLeaf}(ctx,${value},pos,e)`
      return L.buf ? call : `if(ctx._cstBuf!==undefined||ctx._cstLeaves!==undefined)${call}`
    }
    switch (op) {
      case OP_LIT:
      case OP_LIT_TRACK: {
        const s = k[code[ip + 1]!] as string
        const xf = fxRef(code[ip + 2]!)
        const track = op === OP_LIT_TRACK
        // LENGTH IS TABLE DATA, so the compare is chosen here — the emitted twin
        // of the closure engine's length-keyed literal bodies.
        const test = s.length === 1
          ? `input.charCodeAt(pos)===${s.charCodeAt(0)}`
          : s.length === 2
            ? `input.charCodeAt(pos)===${s.charCodeAt(0)}&&input.charCodeAt(pos+1)===${s.charCodeAt(1)}`
            : `input.startsWith(${q(s)},pos)`
        return `${head}
if(${test}){
const e=pos+${s.length}
${captureLeaf(q(s))}
${track ? '_trackLines(ctx,input,e)\n' : ''}_pfEnd=e
return ${q(s)}
}
ctx._fe=pos;ctx._fx=${xf}
${cfg.probe ? `failAt(ctx,${xf},pos)\n` : ''}return FAIL
}`
      }

      case OP_RX:
      case OP_RX_TRACK: {
        const re = kRef(code[ip + 1]!)
        const xf = fxRef(code[ip + 2]!)
        const track = op === OP_RX_TRACK
        return `${head}
${re}.lastIndex=pos
const m=${re}.exec(input)
if(m!==null){
const v=m[0]
const e=pos+v.length
${captureLeaf("v")}
${track ? '_trackLines(ctx,input,e)\n' : ''}_pfEnd=e
return v
}
ctx._fe=pos;ctx._fx=${xf}
${cfg.probe ? `failAt(ctx,${xf},pos)\n` : ''}return FAIL
}`
      }

      case OP_EMPTY:
        return `${head}_pfEnd=pos;return null}`

      case OP_GATE: {
        const child = link(code[ip + 2]!)
        const ci = classes.push([t.cc[code[ip + 1]!]!]) - 1
        const cls = hoist('cl', `CLS[${ci}][0]`)
        const xf = fxRef(code[ip + 3]!)
        return `${head}
if(!classHas(${cls},lead(input,pos))){ctx._fe=pos;ctx._fx=${xf};return FAIL}
return ${child}(input,pos,ctx)
}`
      }

      case OP_XFORM: {
        const fn = fnRef(code[ip + 1]!)
        const child = link(code[ip + 2]!)
        return `${head}
const v=${child}(input,pos,ctx)
if(v===FAIL)return FAIL
return ${fn}(v,{start:pos,end:_pfEnd})
}`
      }

      case OP_SCAN: {
        const si = code[ip + 1]!
        // The scan pool is built FROM subtrees, so it is populated after this
        // text compiles. The array is passed by reference and indexed on
        // execution, which is what the closure engine's lazy bind amounts to.
        return `${head}
const r=SCANS[${si}].parse(input,pos,ctx)
if(!r.ok){ctx._fe=r.span.start;ctx._fx=r.expected??EMPTY_FX;return FAIL}
_pfEnd=r.span.end
return r.value
}`
      }

      case OP_SCOPE:
      case OP_SCOPE_CAP: {
        const ki = code[ip + 1]!
        const cap = op === OP_SCOPE_CAP
        const flags = code[ip + 3]!
        const child = link(code[ip + 2]!)
        // THE SWAP, RESOLVED AT EMIT. `swapLegal` is `!trackLines`, an option;
        // the other two are table data. All three are known here, so the body
        // holds the scanner it installs as a hoisted const.
        const scanFor = swapLegal && ki >= 0 && !triviaLabelled[ki]! ? hoist('ts', `TRIVIASCAN[${ki}]`) : 'null'
        const tri = ki < 0 ? 'undefined' : hoist('tv', `TRIVIA[${ki}]`)
        const lab = ki < 0 ? 'undefined' : hoist('tl', `TRIVIA[${ki}]._meta.triviaKindLabels`)
        // The two root-capture policies are TABLE DATA, so they are emitted INTO
        // the body. `scopeRootPolicy`'s two wrapper closures and their two extra
        // call frames do not exist here.
        const strict = (flags & 2) !== 0 ? 'refuseUnclassifiedRootScope(ctx._rootTriviaStrictScopes)\n' : ''
        const rootCap = (flags & 1) !== 0
        return `${head}
${strict}${rootCap ? 'const sR=ctx._rootTriviaCapture\nctx._rootTriviaCapture=false\n' : ''}const sT=ctx.trivia,sL=ctx.triviaKindLabels,sS=_pfScan${cap ? ',sC=ctx.captureTrivia' : ''}
_pfScan=${scanFor}
ctx.trivia=${tri}
ctx.triviaKindLabels=${lab}
${cap ? 'ctx.captureTrivia=true\n' : ''}const v=${child}(input,pos,ctx)
${cap ? 'ctx.captureTrivia=sC\n' : ''}ctx.trivia=sT
ctx.triviaKindLabels=sL
_pfScan=sS
${rootCap ? 'ctx._rootTriviaCapture=sR\n' : ''}return v
}`
      }

      case OP_ATTEMPT: {
        const child = link(code[ip + 1]!)
        const p = tmp()
        return `${head}
${emitMark(p, L.buf)}
const v=${child}(input,pos,ctx)
if(v!==FAIL)return v
${emitRollback(p, L.buf)}
if(ctx._fc===true)return FAIL
ctx._fe=pos
return FAIL
}`
      }

      case OP_NOT: {
        const child = link(code[ip + 1]!)
        const xf = fxRef(code[ip + 2]!)
        const p = tmp()
        return `${head}
${emitMark(p, L.buf)}
const v=${child}(input,pos,ctx)
${emitRollback(p, L.buf)}
if(v===FAIL){_pfEnd=pos;return null}
ctx._fe=pos
ctx._fx=${xf}
return FAIL
}`
      }

      case OP_PEEK: {
        const child = link(code[ip + 1]!)
        const xf = fxRef(code[ip + 2]!)
        const p = tmp()
        return `${head}
${emitMark(p, L.buf)}
const v=${child}(input,pos,ctx)
${emitRollback(p, L.buf)}
if(v===FAIL){ctx._fe=pos;ctx._fx=${xf};return FAIL}
_pfEnd=pos
return null
}`
      }

      case OP_OPT: {
        const child = link(code[ip + 1]!)
        const p = tmp()
        return `${head}
${emitMark(p, L.buf)}
ctx._fc=false
const v=${child}(input,pos,ctx)
if(v===FAIL){
if(ctx._fc===true)return FAIL
${emitRollback(p, L.buf)}
_pfEnd=pos
return null
}
return v
}`
      }

      case OP_SEQ:
      case OP_SEQV:
      case OP_SEQX: {
        const fused = op === OP_SEQX
        const base = fused ? ip + 3 : ip + 2
        const n = code[fused ? ip + 2 : ip + 1]!
        const wantValues = op !== OP_SEQV
        // ADJACENCY changes the PARENT's term-boundary emission: the assertion
        // must be answered at the cursor, BEFORE the ambient trivia scan.
        // Refused rather than lowered wrong — a piece handed the post-scan
        // position finds the gap already consumed and answers "adjacent" every
        // time, SILENTLY (`ops.ts:226-251`).
        for (let i = 1; i < n; i++) {
          if (code[code[base + i]!] === OP_ADJ) {
            throw new Unemittable('a sequence carrying an adjacency assertion (OP_ADJ)')
          }
        }
        const fn = fused ? fnRef(code[ip + 1]!) : undefined
        const kids: string[] = []
        for (let i = 0; i < n; i++) kids.push(link(code[base + i]!))
        const parts: string[] = [head, `const v0=${kids[0]}(input,pos,ctx)`, 'if(v0===FAIL)return FAIL']
        if (n === 1) {
          parts.push(fused ? `return ${fn}([v0],{start:pos,end:_pfEnd})` : wantValues ? 'return [v0]' : 'return undefined')
          return `${parts.join('\n')}\n}`
        }
        parts.push('let cur=_pfEnd')
        const names: string[] = ['v0']
        for (let i = 1; i < n; i++) {
          const vn = `v${i}`
          parts.push(`let ${vn}`)
          parts.push(emitTerm(kids[i]!, vn, tmp(), L, skipFor(L)))
          names.push(vn)
        }
        parts.push('_pfEnd=cur')
        parts.push(fused
          ? `return ${fn}([${names.join(',')}],{start:pos,end:cur})`
          : wantValues ? `return [${names.join(',')}]` : 'return undefined')
        return `${parts.join('\n')}\n}`
      }

      case OP_CHOICE: {
        const table = disp[code[ip + 1]!]!
        const n = code[ip + 2]!
        const choiceFx = fxRef(code[ip + 3]!)
        const base = ip + 4
        const arms: string[] = []
        for (let i = 0; i < n; i++) arms.push(link(code[base + i]!))
        const axi = armExpected.push(
          Array.from({ length: n }, (_, i) => t.fx[code[base + n + i]!] as readonly string[]),
        ) - 1
        const afx = hoist('afx', `AFX[${axi}]`)

        if (table.exclusive) {
          // NO OPEN ARMS EXIST under `exclusive` — `resolveDispatch` clears the
          // flag for any arm whose class is −1 — so there is no fallback loop.
          const di = code[ip + 1]!
          const asc = hoist('as', `DISP[${di}].ascii`)
          const hiArr = table.hi
          // Arms named, one `case` each: the interpreter's `arms[arm](…)` is an
          // array index feeding ONE call site, which is the megamorphic site
          // this unit exists to remove.
          const armSwitch = arms.map((a, i) => `case ${i}:v=${a}(input,pos,ctx);break`).join('\n')
          return `${head}
const c=lead(input,pos)
let arm=-1
if(c>=0&&c<128){const a=${asc}[c];if(a!==0)arm=a-1}
${hiArr.length === 0 ? '' : `else if(c>=128){const h=${hoist('hi', `DISP[${di}].hi`)}
for(let i=0;i<h.length;i+=3){if(c>=h[i]&&c<=h[i+1]){arm=h[i+2];break}}}`}
if(arm>=0){
ctx._fc=false
let v
switch(arm){
${armSwitch}
}
if(v!==FAIL)return v
if(ctx._fc===true)return FAIL
const af=ctx._fx
if(af!==undefined&&af.length>0){ctx._fe=pos;return FAIL}
}
ctx._fe=pos;ctx._fx=${choiceFx}
return FAIL
}`
        }

        // THE PER-ARM GATE. `assemble.ts` precomputes a candidate bitmask so one
        // `Uint32Array` load replaces `n` class tests, then walks the set bits
        // through `arms[i]`. The mask survives here; the indexed CALL does not.
        const ci = classes.push(Array.from({ length: n }, (_, i) => table.armCls[i] ?? null)) - 1
        const gates = classes[ci]!
        const gRef = hoist('g', `CLS[${ci}]`)
        const maskable = n <= 32
        let maskName = ''
        if (maskable) {
          const m = new Uint32Array(129)
          for (let i = 0; i < n; i++) {
            const cls = gates[i]!
            const bit = 1 << i
            if (cls === null) { for (let c = 0; c < 129; c++) m[c]! |= bit; continue }
            for (let c = 0; c < 128; c++) if (cls.ascii[c] === 1) m[c]! |= bit
          }
          maskName = hoist('mk', `MASK[${masks.push(m) - 1}]`)
        }
        const p = tmp()
        // THE SKIPPED ARMS' SETS STAY LAZY. `prev` and the catch-up loop are the
        // closure engine's, kept verbatim: they run only on a FAILURE path, and
        // an arm that MATCHES returns without paying for any of it. Unrolling
        // them would put an `_accSet` — and its `slice()` — on the success path.
        const maskArms = arms.map((a, i) => `
if((bits&${1 << i})!==0){
ctx._fc=false
{const v=${a}(input,pos,ctx)
if(v!==FAIL)return v}
for(let j=prev;j<${i};j++)if((bits&(1<<j))===0)acc=_accSet(${afx}[j],acc)
prev=${i + 1}
acc=_accSet(ctx._fx,acc)
if(ctx._fc===true){if(acc!==undefined)ctx._fx=acc;return FAIL}
${emitRollback(p, L.buf)}
}`).join('')

        const generalArms = arms.map((a, i) => `
if(${gRef}[${i}]===null||classHas(${gRef}[${i}],c)){
ctx._fc=false
{const v=${a}(input,pos,ctx)
if(v!==FAIL)return v}
acc=_accSet(ctx._fx,acc)
if(ctx._fc===true){if(acc!==undefined)ctx._fx=acc;return FAIL}
${emitRollback(p, L.buf)}
}else acc=_accSet(${afx}[${i}],acc)`).join('')

        return `${head}
const c=lead(input,pos)
${emitMark(p, L.buf)}
let acc
${maskable ? `if(c<128){
const bits=${maskName}[c<0?128:c]
let prev=0
${maskArms}
for(let j=prev;j<${n};j++)if((bits&(1<<j))===0)acc=_accSet(${afx}[j],acc)
ctx._fe=pos;ctx._fx=acc??${choiceFx}
return FAIL
}
` : ''}${generalArms}
ctx._fe=pos;ctx._fx=acc??${choiceFx}
return FAIL
}`
      }

      case OP_REP:
      case OP_REPV: {
        const child = link(code[ip + 1]!)
        const min = code[ip + 2]!
        const max = code[ip + 3]!
        const sepIp = code[ip + 4]!
        const sep = sepIp >= 0 ? link(sepIp) : undefined
        const flags = code[ip + 5]!
        const keepSeparators = (flags & 2) !== 0
        const trailingAllowed = (flags & 1) !== 0
        const reportItem = (flags & 4) !== 0
        const itemFx = reportItem ? fxRef(code[ip + 6]!) : 'EMPTY_FX'
        const collect = op === OP_REP
        const skipBeforeFirst = sepIp < 0 && min === 0
        const p = tmp()
        // `viaRepItem` is `sep === undefined && count >= min && (count > 0 ||
        // skipBeforeFirst)`. Two of its three conjuncts are table data, so only
        // what survives them is emitted.
        const via = sep !== undefined
          ? 'false'
          : min === 0
            ? (skipBeforeFirst ? 'true' : 'count>0')
            : `count>=${min}&&count>0`
        const leadTrivia = skipBeforeFirst ? 'true' : 'count>0'
        // THE TWO LOOP-INVARIANT HOISTS, RESOLVED AT EMIT WHERE THE LABEL ANSWERS
        // THEM. `hasTrivia` is the site's trivia scope; `needMark` is implied by
        // an open `_cstBuf`. Both were read once per repetition SITE, which is
        // cheap on its own and is not the point — what they gated was a branch
        // per item and a branch at every one of the five rollback points below.
        const skip = skipFor(L)
        const knownTrivia = L.tri === TRI_NONE ? false : L.tri !== TRI_UNKNOWN ? true : undefined
        const hasTrivia = knownTrivia === undefined ? 'hasTrivia' : String(knownTrivia)
        const needMark = L.buf ? 'true' : 'needMark'
        // THE `_fields` AND `_errors` MARKS ARE NOT TAKEN, on exactly the argument
        // `emitRollback` already makes for the non-loop marks (45eb01a): neither
        // sink can grow in an EMITTED assembly, because `OP_FIELD`, `OP_EXPECT`
        // and `recoverScan` are all unemittable and a table carrying one falls
        // back whole. The loop was still paying two loads and two stores per item.
        const rb = L.buf
          ? `_rbBuf(ctx,${p}raw,${p}tl,${p}lv,${p}lg,${p}rt)`
          : `if(needMark)rollbackTriviaAt(ctx,${p}raw,${p}tl,${p}lv,0,undefined,${p}lg,${p}rt)`
        const markBody = L.buf
          ? `const b=ctx._cstBuf
const r=b.raw;${p}raw=r!==undefined?r.length:b.rawSingle!==undefined?1:0
const h=b.ch;${p}lv=h!==undefined?h.length:b.single!==undefined?1:0
const l=b.tl;${p}tl=l!==undefined?l.length:0
${p}lg=ctx._triviaLog!==undefined?ctx._triviaLog.length:0
${p}rt=ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length:0`
          : `if(needMark){
const b=ctx._cstBuf
if(b!==undefined){
const r=b.raw;${p}raw=r!==undefined?r.length:b.rawSingle!==undefined?1:0
const h=b.ch;${p}lv=h!==undefined?h.length:b.single!==undefined?1:0
const l=b.tl;${p}tl=l!==undefined?l.length:0
}else{
${p}raw=ctx._cstRawChildren!==undefined?ctx._cstRawChildren.length:0
${p}tl=ctx._cstTriviaLog!==undefined?ctx._cstTriviaLog.length:0
${p}lv=ctx._cstLeaves!==undefined?ctx._cstLeaves.length:0
}
${p}lg=ctx._triviaLog!==undefined?ctx._triviaLog.length:0
${p}rt=ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length:0
}`
        return `${head}
const out=${collect ? '[]' : 'undefined'}
${knownTrivia === undefined ? 'const hasTrivia=ctx.trivia!==undefined\n' : ''}${L.buf ? '' : 'const needMark=_rollbackNeeded(ctx)\n'}let cur=pos
let count=0
for(;;){
${max >= 0 ? `if(count>=${max})break\n` : ''}${sep !== undefined ? `if(count>0&&count>=${min}&&cur>=input.length)break\n` : ''}let ${p}raw=0,${p}tl=0,${p}lv=0,${p}lg=0,${p}rt=0
${markBody}
let itemStart=cur
let sepEnd=-1
${sep !== undefined ? `if(count>0){
const lb=cstLeavesLen(ctx)
let sp=cur
${hasTrivia === 'false' ? '' : hasTrivia === 'true' ? `sp=${skip}(input,sp,ctx)\n` : `if(hasTrivia)sp=${skip}(input,sp,ctx)\n`}ctx._fc=false
const sv=${sep}(input,sp,ctx)
if(sv===FAIL){
${rb}
if(ctx._fc===true)return FAIL
break
}
${keepSeparators ? '' : 'demoteCapturedToRaw(ctx,lb)\n'}sepEnd=_pfEnd
itemStart=${hasTrivia === 'false' ? '_pfEnd' : hasTrivia === 'true' ? `${skip}(input,_pfEnd,ctx)` : `hasTrivia?${skip}(input,_pfEnd,ctx):_pfEnd`}
}else ${leadSkip(hasTrivia, leadTrivia, skip)}
` : `${leadSkip(hasTrivia, leadTrivia, skip)}
`}if(itemStart>=input.length&&${via}){
${rb}
${trailingAllowed ? 'if(sepEnd>=0)cur=sepEnd\n' : ''}break
}
ctx._fc=false
const v=${child}(input,itemStart,ctx)
if(v===FAIL){
${rb}
if(ctx._fc===true)return FAIL
${trailingAllowed ? 'if(sepEnd>=0)cur=sepEnd\n' : ''}break
}
if(_pfEnd===itemStart&&${via}){
${rb}
break
}
${collect ? 'out.push(v)\n' : ''}cur=_pfEnd
count++
}
${min > 0 ? `if(count<${min}){
${reportItem ? `ctx._fe=cur;ctx._fx=${itemFx}\n` : ''}return FAIL
}
` : ''}_pfEnd=cur
return out
}`
      }

      case OP_NODE:
      case OP_NODE_TRACK: {
        const flags = code[ip + 3]!
        const child = link(code[ip + 2]!)
        const proj = code[ip + 4]!
        const buildIdx = code[ip + 1]!
        const type = k[code[ip + 5]!] as string
        const tagIdx = code[ip + 6]!
        const tags = tagIdx < 0 ? 'undefined' : kRef(tagIdx)
        const tracked = op === OP_NODE_TRACK
        const readsTrivia = (flags & 4) !== 0
        const readsState = (flags & 8) !== 0
        const hasFields = (flags & 16) !== 0
        const collapse = (flags & 32) !== 0
        const unwrap = (flags & 64) !== 0
        const trailingTrivia = (flags & 128) !== 0
        // HOST MODE IS AN OPTION, and it decided five runtime ternaries in the
        // interpreter's node case — the most-executed non-terminal in any of
        // these grammars. It selects the emitted shape instead.
        const wantFields = hasFields || hostCst
        const captureWide = readsTrivia || hostCst
        const build = buildIdx >= 0 ? fnRef(buildIdx) : undefined
        const structural = build === undefined && proj < 0
        const ty = q(type)
        const stArg = readsState ? 'st' : '(ctx.state!==undefined?Object.assign({},ctx.state):undefined)'
        const hostCall = `_pfHost(${ty},kids,fieldMap,span,rawKids,tlog,${stArg},${tags})`
        let value: string
        if (proj >= 0) {
          value = hostCst
            ? `nd=_pfHost!==undefined?${hostCall}:projectChild(kids,${proj},${ty})`
            : `nd=projectChild(kids,${proj},${ty})`
        } else if (build !== undefined) {
          // A direct builder is bypassed under a CST host.
          const direct = `${build}(kids,fieldMap,span,rawKids,${captureWide ? 'tlog' : 'EMPTY_TL'},st)`
          value = hostCst ? `nd=_pfHost!==undefined?${hostCall}:${direct}` : `nd=${direct}`
        } else {
          value = `nd=_pfHost!==undefined?_pfHost(${ty},kids,fieldMap,span,rawKids,tlog,st,${tags}):{_tag:'node',type:${ty},span,state:st??null,children:kids}`
        }
        // HOST COLLAPSE applies wherever the node's VALUE comes from the host —
        // any node under a CST host, not only the builder-less ones.
        const collapsible = hostCst || (build === undefined && proj < 0)
        return `${head}
const sCh=ctx._cstChildren,sLv=ctx._cstLeaves,sRaw=ctx._cstRawChildren,sTl=ctx._cstTriviaLog
const sCap=ctx.captureTrivia,sBuf=ctx._cstBuf
const buf={}
ctx._cstBuf=buf
ctx._cstChildren=undefined
ctx._cstLeaves=undefined
ctx._cstRawChildren=undefined
ctx._cstTriviaLog=undefined
ctx.captureTrivia=${captureWide}
const savedFields=ctx._fields
ctx._fields=${wantFields ? '[]' : 'undefined'}
${structural ? `const savedMask=ctx._triviaCaptureMask
if(_pfHost!==undefined&&_pfHost._parsemanTriviaKinds!==undefined)ctx._triviaCaptureMask=_pfHost._parsemanTriviaKinds(${ty})
` : ''}const v=${child}(input,pos,ctx)
${trailingTrivia && L.tri !== TRI_NONE
  ? `if(v!==FAIL${L.tri === TRI_UNKNOWN ? '&&ctx.trivia!==undefined' : ''})_pfEnd=consumeTrivia(input,_pfEnd,ctx)\n`
  : ''}const fieldMap=${wantFields ? 'buildFieldMap(ctx._fields)' : 'undefined'}
ctx._fields=savedFields
${structural ? 'ctx._triviaCaptureMask=savedMask\n' : ''}const kids=buf.ch??(buf.single!==undefined?[buf.single]:EMPTY_CH)
const rawKids=buf.raw??(buf.rawSingle!==undefined?[buf.rawSingle]:EMPTY_CH)
const tlog=buf.tl??EMPTY_TLOG
ctx._cstBuf=sBuf
ctx._cstChildren=sCh
ctx._cstLeaves=sLv
ctx._cstRawChildren=sRaw
ctx._cstTriviaLog=sTl
ctx.captureTrivia=sCap
if(v===FAIL)return FAIL
const end=_pfEnd
const span=${tracked ? 'spanLines(ctx,pos,end)' : '{start:pos,end}'}
const st=${readsState ? '(ctx.state!==undefined?Object.assign({},ctx.state):undefined)' : 'undefined'}
let nd
${unwrap ? 'if(kids.length===1)nd=unwrapChild(kids[0])\nelse ' : ''}${collapse ? 'if(kids.length===1)nd=kids[0]\nelse ' : ''}${collapsible ? `if(_pfHost!==undefined&&_pfHost._parsemanCstCollapse!==undefined&&kids.length===1&&rawKids.length===1&&_pfHost._parsemanCstCollapse(${ty},kids[0],kids,rawKids))nd=kids[0]
else ` : ''}{${value}}
${L.buf
  // The OUTER buffer, which this body saved into `sBuf` before opening its own —
  // so an in-node site's parent collector is present by the same fact.
  ? 'pushCstChild(ctx,nd,rawEntry(nd,input,pos,end))'
  : 'if(sBuf!==undefined||sCh!==undefined)pushCstChild(ctx,nd,rawEntry(nd,input,pos,end))'}
_pfEnd=end
return nd
}`
      }

      default:
        throw new Unemittable(`OP_${OP_NAMES[op!] ?? String(op)}`)
    }
  }

  const ruleEntries: string[] = []
  for (const [rname, entryIp] of Object.entries(prog.rules)) {
    // `_r_<Name>` — the composition surface, in `codegen.ts`'s own spelling and
    // deliberately NOT namespaced, so a sibling calls it by name.
    const target = link(entryIp)
    const rn = `_r_${rname.replace(/[^A-Za-z0-9_$]/g, '_')}`
    bodies.push(`const ${rn}=${target}`)
    ruleEntries.push(`${q(rname)}:${rn}`)
  }
  // Sites the SCAN pool and the scan-skip sets reference. They are linked
  // through `subtreeComb` outside the emitted scope, so they need names.
  const extra: string[] = []
  for (const ip of extraIps) extra.push(`${ip}:${link(ip)}`)

  // The per-label trivia scans sit AFTER the hoisted pool they close over: they
  // are `function` declarations, so a body may call one that is textually below
  // it, but the `const _ts<N>` each one reads must be initialised before any
  // parse runs, not merely before the declaration is evaluated.
  const source = `${RUNTIME_PRELUDE}
${prelude.join('\n')}
${skipDefs.join('\n')}
${bodies.join('\n')}
function _begin(ctx){_pfScan=null;_pfHost=ctx.build}
return{
pieces:{${ruleEntries.join(',')}},
byIp:{${extra.join(',')}},
end:function(){return _pfEnd},
begin:_begin
}`

  return { source, reached, masks, classes, armExpected }
}
