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
 * Emission makes each fixed grammar edge a direct generated identifier and is
 * also the form a build can serialise as an ordinary function literal for CSP.
 * The closure assembler can bind the same topology directly through scalar
 * captures; emission's distinct job is to print that binding, not to assert a
 * V8 property that the semantic design depends on.
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
import { regexCanMatchEmpty } from '../regex/first-set.ts'
import {
  OP_ADJ, OP_ATTEMPT, OP_CHOICE, OP_DISPATCH, OP_EMPTY, OP_EXPECT, OP_FIELD, OP_GATE,
  OP_LABEL, OP_LEAF, OP_LIT, OP_LIT_CI, OP_LIT_CI_TRACK, OP_LIT_TRACK, OP_NAMES,
  OP_NODE, OP_NODE_TRACK, OP_NOT, OP_OPT, OP_PEEK, OP_REP, OP_REPV, OP_ROUTED, OP_RULE, OP_RX,
  OP_RX_TRACK, OP_SCAN, OP_SCOPE, OP_SCOPE_CAP, OP_SCOPE_PLAIN, OP_SEQ, OP_SEQV, OP_SEQX, OP_TOKEN, OP_XFORM,
  OP_LEX_BODY, OP_LEX_PROGRAM,
} from './ops.ts'
import {
  choiceRollbackMask, failureRollbackClean, validateDispatchSpec,
  type ResolvedClass, type ResolvedTable, type TableProgram,
} from './program.ts'
import { emitShapeMatch, scanShapeFromRegex } from './scan-shapes.ts'
import {
  CAP_OFF, CAP_ON, RAW_CAPTURE, RAW_OMIT, TRI_NONE, TRI_UNKNOWN,
  computeSiteLabels, reachableSites, type SiteLabel,
} from './site-labels.ts'
import {
  leadingScalarTerminal, scalarTerminalNodeChild, scalarTerminalNotChild,
} from './scalar-terminal.ts'
import { childSlots } from './child-slots.ts'

/** What the compiled factory hands back — the emitted twin of `Assembly`. */
export type EmittedPiece = (input: string, pos: number, ctx: ParseContext) => unknown
export type EmittedAssembly = {
  readonly pieces: Record<string, EmittedPiece>
  /** Sites named for `subtreeComb` — the scan pool and the scan-skip sets. */
  readonly byIp: Record<number, EmittedPiece | undefined>
  readonly end: () => number
  readonly begin: (ctx: ParseContext) => void
  readonly finish: () => void
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
  'EC', 'FAIL', 'K', 'FX', 'FNS', 'MASK', 'CLS', 'AFX', 'TRIVIA', 'TRIVIALABELS', 'TRIVIASCAN',
  'SCANS', 'DISP', 'DSP', 'EMPTY_FX', 'EMPTY_CH', 'EMPTY_TLOG', 'EMPTY_TL',
  'cstCaptureActive', 'pushCstLeaf', 'pushCstChild', 'rollbackTriviaAt', 'rollbackScannedTriviaAt', 'failAt',
  'classHas', 'consumeTrivia', 'buildFieldMap', 'projectChild', 'unwrapChild',
  'demoteCapturedToRaw', 'cstLeavesLen', 'skipTriviaScanned', 'needsDeferredTriviaCommit',
  'scanTrivia', 'advanceTrivia', 'refuseUnclassifiedRootScope', 'spanLines', 'rawEntry', 'lead',
  'asciiFoldKey', 'ROUTED_FX',
  // RECOVERY, bound rather than reimplemented. `SENTS` is the sync sentinel per
  // char-class index — the emitted twin of `assemble.ts`'s `sentinelFor` memo,
  // and an interpreted `Combinator` indexed out of an array for the same reason
  // `SCANS` is. The four functions are `recovery/scan.ts`'s own, so an error's
  // span, expected set and CST embedding are produced by the SAME code in every
  // engine and cannot drift.
  'SENTS', 'matchesAt', 'recoverScan', 'orSentinel', 'captureError',
  // Pure scalar terminal recognizers, indexed by the terminal's existing const
  // operand. Appended for compatibility with older precompiled factories.
  'RECOG',
  // Appended so precompiled factories produced by earlier runtimes keep every
  // positional helper binding. Older factories ignore this trailing argument.
  'commitTriviaScan', 'scanTriviaCompact', 'LEX',
  // Appended for old precompiled-factory ABI: old factories ignore it.
  'adjacencyHolds',
  // Appended for selected composite lexical programs; old factories ignore it.
  'LEXPROG',
] as const

/**
 * The state the emitted scope owns, and the helpers that touch it.
 *
 * `EC` is the assembly's end-position cell, INJECTED (see `cell.ts`) rather
 * than a slot this scope owns: a mixed assembly runs emitted pieces beside
 * closure pieces or an `exec.ts` driver, and all three must write one slot or a
 * cross-engine call reports the end of whatever the other engine last did.
 * `_pfScan` is the
 * installed trivia scanner, which `OP_SCOPE` swaps mid-parse and so cannot be a
 * constant in either engine.
 *
 * Every function here is shared by the rule in this file's header: none takes a
 * piece as an argument.
 */
const RUNTIME_PRELUDE = `
let _pfScan=null
let _pfHost
let _pfDepth=0
const _pfFrames=[]
let _pfTokInput
let _pfTokPos=-1
let _pfTokBody=-1
let _pfTokPacked=-1
let _pfTokValue
let _pfTokDispatch=-1
let _pfTokArm=-1
let _pfTokEnd=-1
function _asciiFoldCode(c){return c>=65&&c<=90?c+32:c}
function _skipTrivia(input,cur,ctx){
const s=_pfScan
if(s!==null&&ctx._triviaLog===undefined&&!(ctx.captureTrivia===true&&(ctx._cstBuf!==undefined||ctx._cstTriviaLog!==undefined)))return s(input,cur)
if(s!==null)return skipTriviaScanned(s,input,cur,ctx)
if(needsDeferredTriviaCommit(ctx))return commitTriviaScan(scanTriviaCompact(input,cur,ctx))
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
function _capturedFlatChildren(children){
if(children.length===0)return EMPTY_CH
if(children[0]!==undefined)return children
let first=1
while(first<children.length&&children[first]===undefined)first++
return first===children.length?EMPTY_CH:children.slice(first)
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

/** Printed only into assemblies that open a count-only raw buffer. */
const NO_RAW_RUNTIME_PRELUDE = `
function _pushLeafNoRawBuf(ctx,value,s,e){
const l={_tag:'leaf',value,span:{start:s,end:e}}
const b=ctx._cstBuf
if(b.ch!==undefined)b.ch.push(l)
else if(b.single!==undefined){b.ch=[b.single,l];b.single=undefined}
else b.single=l
b.rawLen++
}
function _pushNodeNoRawBuf(ctx,value){
const b=ctx._cstBuf
if(b.ch!==undefined)b.ch.push(value)
else if(b.single!==undefined){b.ch=[b.single,value];b.single=undefined}
else b.single=value
b.rawLen++
}
function _rbNoRawBuf(ctx,raw,tl,lv,lg,rt){
const b=ctx._cstBuf
if(b.rawLen!==raw)b.rawLen=raw
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
 * WHICH SIDE SINKS A MARK IN THIS ASSEMBLY HAS TO COVER.
 *
 * `_fields` and `_errors` used to be free: `emitRollback`'s own comment argued
 * that neither could grow in an emitted assembly, because `OP_FIELD` and
 * `OP_EXPECT` were both unemittable and a table carrying one fell back whole.
 * Emitting them retires that argument, so the marks come back — but ONLY for a
 * table that actually contains the writer, which is an emit-time fact about the
 * program and not a per-parse test.
 *
 * Per TABLE and not per SITE, deliberately. A site's subtree reaches through
 * `OP_RULE` into the rule graph, so "can a field run under this mark" is very
 * nearly "does the grammar have a field" for every mark that is not a leaf's —
 * and a per-site answer would buy a handful of sites at the cost of a second
 * fixpoint walk over the code array.
 */
type Sinks = { readonly fd: boolean; readonly er: boolean }
const NO_SINKS: Sinks = { fd: false, er: false }

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
function sinkSlots(t: string, s: Sinks): string {
  return `${s.fd ? `,${t}fd=0` : ''}${s.er ? `,${t}er=0` : ''}`
}
function sinkReads(t: string, s: Sinks): string {
  return `${s.fd ? `\n${t}fd=ctx._fields!==undefined?ctx._fields.length:0` : ''}${s.er ? `\n${t}er=ctx._errors!==undefined?ctx._errors.length:0` : ''}`
}

function emitMark(t: string, buf: boolean, rawMode: number, s: Sinks = NO_SINKS, decl = true): string {
  // THE SITE IS INSIDE A NODE. `OP_NODE` opens `ctx._cstBuf` unconditionally and
  // closes it on the way out, so the whole discriminating chain below — which
  // sink is live, and whether a mark is needed at all — has ONE answer here, and
  // the pass knows it. What is left is the five loads a mark actually is.
  //
  // `decl === false` RE-TAKES a mark into locals that already exist —
  // `OP_DISPATCH` marks, rolls back to the selector's mark, and marks again.
  if (buf) {
    const raw = rawMode === RAW_OMIT
      ? `${t}raw=b.rawLen`
      : rawMode === RAW_CAPTURE
        ? `const r=b.raw;${t}raw=r!==undefined?r.length:b.rawSingle!==undefined?1:0`
        : `const r=b.raw;${t}raw=b.noRaw===true?b.rawLen:(r!==undefined?r.length:b.rawSingle!==undefined?1:0)`
    return `${decl ? `let ${t}raw=0,${t}tl=0,${t}lv=0,${t}lg=0,${t}rt=0${sinkSlots(t, s)}\n` : ''}{const b=ctx._cstBuf
${raw}
const h=b.ch;${t}lv=h!==undefined?h.length:b.single!==undefined?1:0
const l=b.tl;${t}tl=l!==undefined?l.length:0
${t}lg=ctx._triviaLog!==undefined?ctx._triviaLog.length:0
${t}rt=ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length:0${sinkReads(t, s)}}`
  }
  return `${decl ? `let ${t}n=false,${t}raw=0,${t}tl=0,${t}lv=0,${t}lg=0,${t}rt=0${sinkSlots(t, s)}\n` : `${t}n=false\n`}{const b=ctx._cstBuf
if(b!==undefined){
const r=b.raw;${t}raw=b.noRaw===true?b.rawLen:(r!==undefined?r.length:b.rawSingle!==undefined?1:0)
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
${t}rt=ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length:0${sinkReads(t, s)}
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
 * Both sinks use `undefined` as "no mark taken". A literal zero is not a safe
 * substitute: a sink-free speculative subtree may run inside a node whose
 * enclosing `_fields` already contains entries, and rolling that array back to
 * zero would erase state the subtree did not create.
 */
function emitRollback(t: string, buf: boolean, rawMode: number, s: Sinks = NO_SINKS): string {
  // `_rbBuf` is the `_cstBuf` arm of `rollbackCstCaptureAt` plus the two trivia
  // truncations, with the sink discrimination the label already answered removed.
  // It takes no piece, so the header's sharing rule admits it.
  //
  // The two side sinks stay OUT of `_rbBuf` rather than growing its parameter
  // list: they are absent from most tables, and a fixed seven-argument helper
  // would make every grammar pay the two extra pushes to serve the ones that
  // carry a field. Both are emitted only from a defined mark; the generic
  // helper applies the same `undefined` sentinel when a site cannot write one.
  const fd = s.fd ? `\nif(ctx._fields!==undefined&&ctx._fields.length!==${t}fd)ctx._fields.length=${t}fd` : ''
  const er = s.er ? `\nif(ctx._errors!==undefined&&ctx._errors.length!==${t}er)ctx._errors.length=${t}er` : ''
  if (buf && rawMode === RAW_OMIT) return `_rbNoRawBuf(ctx,${t}raw,${t}tl,${t}lv,${t}lg,${t}rt)${fd}${er}`
  if (buf && rawMode === RAW_CAPTURE) return `_rbBuf(ctx,${t}raw,${t}tl,${t}lv,${t}lg,${t}rt)${fd}${er}`
  if (buf) return `rollbackTriviaAt(ctx,${t}raw,${t}tl,${t}lv,${s.fd ? `${t}fd` : 'undefined'},${s.er ? `${t}er` : 'undefined'},${t}lg,${t}rt)`
  if (!s.fd && !s.er) return `if(${t}n)rollbackTriviaAt(ctx,${t}raw,${t}tl,${t}lv,undefined,undefined,${t}lg,${t}rt)`
  return `if(${t}n){rollbackTriviaAt(ctx,${t}raw,${t}tl,${t}lv,${s.fd ? `${t}fd` : 'undefined'},${s.er ? `${t}er` : 'undefined'},${t}lg,${t}rt)}`
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
cur=EC.e`
  if (l.tri === TRI_NONE) return fast
  const scanned = `const ${t}tl=ctx._cstBuf!==undefined?(ctx._cstBuf.tl!==undefined?ctx._cstBuf.tl.length:0):(ctx._cstTriviaLog!==undefined?ctx._cstTriviaLog.length:0)
const ${t}lg=ctx._triviaLog!==undefined?ctx._triviaLog.length:0
const ${t}rt=ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length:0
const ${t}s=${skip}(input,cur,ctx)
const ${t}stl=ctx._cstBuf!==undefined?(ctx._cstBuf.tl!==undefined?ctx._cstBuf.tl.length:0):(ctx._cstTriviaLog!==undefined?ctx._cstTriviaLog.length:0)
const ${t}slg=ctx._triviaLog!==undefined?ctx._triviaLog.length:0
const ${t}srt=ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length:0
const ${t}v=${callee}(input,${t}s,ctx)
if(${t}v===FAIL)return FAIL
${dst}=${t}v
if(EC.e>${t}s)cur=EC.e
else{rollbackScannedTriviaAt(ctx,${t}tl,${t}stl,${t}lg,${t}slg,${t}rt,${t}srt)}`
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

/**
 * THE THREE POOLS, SAID AS INDICES INTO THE PROGRAM.
 *
 * The pools themselves are `Uint32Array`s, `{ascii, hi}` class objects and
 * string arrays — printable, but at 129 words per mask and 128 bytes per class
 * they would dwarf the table they belong to. Every entry is already IN the
 * program: a class is `cc[i]`, an arm's expected set is `fx[i]`, and a mask is a
 * pure function of its class row. So the plan is three arrays of small integers,
 * and `rebuildPools` turns it back into the pools with allocation only — no
 * string building, and in particular no `Function` constructor.
 *
 * This is what lets the macro pre-compile an assembly: the FACTORY is printed as
 * a real function literal, and its data arguments are rebuilt from this.
 */
export type PoolPlan = {
  /** Per `CLS` row: the `cc` index of each entry, `-1` for a null (ungated) arm. */
  readonly classes: readonly (readonly number[])[]
  /** Per `AFX` row: the `fx` index of each arm's expected set. */
  readonly armExpected: readonly (readonly number[])[]
  /**
   * Per `MASK` row: a non-negative legacy `CLS` row index, or `~dispIndex` for
   * a directly bound choice. The negative form names the EXISTING resolved
   * dispatch row rather than serialising a second copy of its arm classes.
   */
  readonly masks: readonly number[]
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
  /** The same three pools as indices, for a build-time emitter. */
  readonly plan: PoolPlan
}

/** The candidate mask for one `CLS` row — the ONE definition, shared with the emitter. */
function maskForClassRow(gates: readonly (ResolvedClass | null)[]): Uint32Array {
  const m = new Uint32Array(129)
  for (let i = 0; i < gates.length; i++) {
    const cls = gates[i]!
    const bit = 1 << i
    if (cls === null) { for (let c = 0; c < 129; c++) m[c]! |= bit; continue }
    for (let c = 0; c < 128; c++) if (cls.ascii[c] === 1) m[c]! |= bit
  }
  return m
}

/**
 * Rebuild the three pools a pre-compiled factory takes, from the resolved table
 * and the plan the emitter printed. Allocation only.
 */
export function rebuildPools(
  cc: readonly ResolvedClass[],
  fx: readonly (readonly string[])[],
  disp: ResolvedTable['disp'],
  plan: PoolPlan,
): { masks: Uint32Array[]; classes: (ResolvedClass | null)[][]; armExpected: (readonly string[])[][] } {
  const classes = plan.classes.map(row => row.map(i => (i < 0 ? null : cc[i] ?? null)))
  return {
    classes,
    armExpected: plan.armExpected.map(row => row.map(i => fx[i] ?? [])),
    masks: plan.masks.map(source => {
      const row = source >= 0 ? classes[source] : disp[~source]?.armCls
      if (row === undefined) throw new TypeError(`table emitter: invalid MASK plan source ${source}`)
      return maskForClassRow(row)
    }),
  }
}

/**
 * Emit the whole assembly for one resolved table and one option set.
 *
 * Throws `Unemittable` for any construct not lowered. It does NOT compile the
 * text — `assemble.ts` does — so a refusal and a compile failure stay two
 * distinguishable outcomes at the call site.
 *
 * `staticBuild` is true only when `emit.ts` embeds the returned source as an
 * ordinary factory literal in a macro artifact. It permits macro-only code
 * shaping without perturbing the runtime `compile()` emitter, whose generated
 * parser must remain byte-identical when the optimization cannot affect it.
 */
export function emitAssemblySource(
  t: ResolvedTable,
  prog: TableProgram,
  cfg: {
    hostCst: boolean
    hostReadsChildren?: boolean
    hostCaptureTrivia?: ((type: string) => boolean) | undefined
    trackLines: boolean
    tolerant: boolean
    coverage: boolean
    probe: boolean
  },
  extraIps: readonly number[] = [],
  staticBuild = false,
): EmitResult {
  const { code, k, fx, disp, dsp, triviaLabelled } = t
  const swapLegal = !cfg.trackLines
  const hostCst = cfg.hostCst

  /**
   * RECOVERY IS EMITTED, and the refusal this replaces was wrong in SCOPE.
   *
   * The refusal read: *"`recoverScan`'s protocol has three implementations
   * already and a fourth is how an error span drifts... It is also cold by
   * construction — reached only on the failure of an element — so the speed
   * argument for emitting it is absent."*
   *
   * The drift half is answered by construction, not by argument: NOTHING of the
   * protocol is reimplemented here. `recoverScan`, `matchesAt`, `orSentinel` and
   * `captureError` are BOUND and CALLED, exactly as the closure engine calls
   * them, so there is no fourth implementation to drift — the same reason
   * `OP_SCAN` may bind an interpreted combinator and index it (`SCANS[i]`).
   *
   * The cold half was true of recovery and FALSE of the refusal. This throw sat
   * at the top of the emitter, so it did not decline the cold recovery rows — it
   * declined THE ENTIRE ASSEMBLY. Every tolerant parse in the product therefore
   * ran the array-indexed closure walk for its whole hot path: every literal,
   * every choice, every repetition, none of which is recovery and all of which is
   * as hot as the strict path that is emitted. The speed argument is absent for
   * `recoverScan` and was never absent for the table around it.
   *
   * What stays interpreted is what was already interpreted for the strict path.
   */
  const REC = prog.rec === 1 && cfg.tolerant
  if (cfg.coverage) throw new Unemittable('a coverage assembly')

  // THE DOWNWARD PASS, BEFORE ANY LOWERING. The roots are exactly the sites
  // `link` is called on from outside a body — the rule entries and the scan
  // pool's `extraIps` — and each starts at `TOP`, because a caller outside the
  // emitted scope supplies a context this pass cannot see.
  const roots = [...Object.values(prog.rules), ...extraIps]
  const reachable = [...reachableSites(code, roots)]
  const labels = computeSiteLabels(code, roots, hostCst)
  // Eligibility is pooled by the terminal's existing constant operand, matching
  // the closure recognizer pool: distinct terminal rows sharing one spec share
  // both the recognizer and the ordinary-terminal lowering.
  const scalarSpecs = new Set<number>()
  type TokenChoiceCandidate = { readonly arm: number; readonly dispatchIp: number }
  const tokenChoiceCandidates = new Map<number, TokenChoiceCandidate>()
  const tokenChoiceDispatches = new Set<number>()
  const tokenChoiceBodies = new Set<number>()
  if (!hostCst && !cfg.tolerant && !cfg.probe && !cfg.coverage && !cfg.trackLines) {
    for (const ip of reachable) {
      if (code[ip] === OP_NODE) {
        const child = scalarTerminalNodeChild(code, ip)
        if (child >= 0) scalarSpecs.add(code[child + 1]!)
        continue
      }
      if (code[ip] !== OP_CHOICE || disp[code[ip + 1]!]!.exclusive) continue
      const n = code[ip + 2]!
      for (let i = 0; i < n; i++) {
        if (n === 2 || n === 3) {
          const child = leadingScalarTerminal(code, code[ip + 4 + i]!)
          if (child >= 0) scalarSpecs.add(code[child + 1]!)
        }
      }

      // A direct value-only transform around a dispatch cannot consume, branch,
      // publish, or call author code before the dispatch selector. When that
      // selector is one compiler-selected lexical body, the emitted choice may
      // recognize and classify it before entering the arm, then hand the exact
      // packed range and route to the ordinary LEX_BODY/DISPATCH readers. One
      // candidate per ordered choice keeps source order authoritative: a second
      // eligible arm leaves the whole site on the established PEG path.
      let candidate: TokenChoiceCandidate | undefined
      let ambiguous = false
      for (let i = 0; i < n; i++) {
        const armIp = code[ip + 4 + i]!
        if (code[armIp] !== OP_XFORM) continue
        const dispatchIp = code[armIp + 2]!
        if (code[dispatchIp] !== OP_DISPATCH) continue
        const selectorIp = code[dispatchIp + 1]!
        if (code[selectorIp] !== OP_LEX_BODY) continue
        if (candidate !== undefined) { ambiguous = true; break }
        candidate = { arm: i, dispatchIp }
      }
      if (!ambiguous && candidate !== undefined) {
        tokenChoiceCandidates.set(ip, candidate)
        tokenChoiceDispatches.add(candidate.dispatchIp)
        tokenChoiceBodies.add(code[code[candidate.dispatchIp + 1]! + 1]!)
      }
    }
  }

  // Helpers are referenced by DESCENDANT publication/rollback sites, not only
  // by the node row that opened the count-only buffer. A specialized no-raw node
  // can contain a shared child whose merged label is unknown even though this
  // occurrence emits `_pushNodeNoRawBuf`; the node flag is the conservative
  // factory-level authority for including the tiny prelude.
  const needsNoRawPrelude = !hostCst && reachable.some(ip => {
    const op = code[ip]
    return (op === OP_NODE || op === OP_NODE_TRACK)
      && code[ip + 1]! >= 0 && code[ip + 4]! < 0 && (code[ip + 3]! & 2) !== 0
  })

  // THE SIDE-SINK FIXPOINT, over the same graph the labels walk. `OP_FIELD` is
  // the only direct `_fields` writer and `OP_EXPECT` the only direct `_errors`
  // writer. A tolerant repetition can also write `_errors` through recoverScan.
  // Propagating those two bits through the child graph gives every speculative
  // site the exact side sinks its subtree can mutate, including through cyclic
  // OP_RULE edges.
  //
  // `OP_SCAN` RAISES BOTH, and that is not caution — it is a measured defect.
  // The row runs an INTERPRETED combinator (`scanTo`/`balanced`, rebuilt by
  // `resolveTable`'s pool from subtrees), so its interior is not in this code
  // array and this walk cannot see what it writes. `balanced()`'s unclosed-group
  // failure pushes a `parseError` carrying its closer, and less's `at-rules.less`
  // and `css-3.less` each left several of them on `RunResult.errors` — errors
  // that the CLOSURE engine rolls back, because its mark covers `_errors`
  // unconditionally. The two engines disagreed on the errors facet of a parse
  // that otherwise matched byte for byte.
  //
  // Any future row whose child is not an offset in `code` belongs here for the
  // same reason. `OP_LIVE` is the other such row, and it is unemittable.
  const sinkSites = reachable
  const sinkBits = new Map<number, number>()
  for (const ip of sinkSites) {
    const op = code[ip]
    sinkBits.set(ip,
      op === OP_SCAN ? 3
        : (op === OP_FIELD ? 1 : 0)
          | (op === OP_EXPECT || (REC && (op === OP_REP || op === OP_REPV)) ? 2 : 0))
  }
  const sinkKids: number[] = []
  let sinkChanged = true
  while (sinkChanged) {
    sinkChanged = false
    for (const ip of sinkSites) {
      let bits = sinkBits.get(ip) ?? 0
      sinkKids.length = 0
      childSlots(code, ip, sinkKids)
      for (let i = 0; i < sinkKids.length; i++) bits |= sinkBits.get(sinkKids[i]!) ?? 0
      if (bits !== sinkBits.get(ip)) {
        sinkBits.set(ip, bits)
        sinkChanged = true
      }
    }
  }
  const sinksAt = (ip: number): Sinks => {
    const bits = sinkBits.get(ip) ?? 0
    return bits === 0 ? NO_SINKS : { fd: (bits & 1) !== 0, er: (bits & 2) !== 0 }
  }

  const bodies: string[] = []
  const byIp = new Map<number, string>()
  const reached = new Set<number>()
  const prelude: string[] = []
  const skipDefs: string[] = []
  const choiceDefs: string[] = []
  const skipPool = new Map<string, string>()
  const pool = new Map<string, string>()
  const masks: Uint32Array[] = []
  const classes: (ResolvedClass | null)[][] = []
  const armExpected: (readonly string[])[][] = []
  /**
   * THE POOLS, SAID AS INDICES — see `PoolPlan`. Written in lockstep with the
   * three arrays above so a build-time emitter can print the plan instead of the
   * pools, and `rebuildPools` can reproduce them from the resolved table alone.
   * Kept adjacent to each `push` for exactly the reason `EMITTED_PARAMS` is one
   * list: two orders that must agree cannot be allowed to live apart.
   */
  const classPlan: number[][] = []
  const armExpectedPlan: number[][] = []
  const maskPlan: number[] = []

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
  const recognizerRef = (i: number): string => hoist('rec', `RECOG[${i}]`)
  /**
   * The sync sentinel for a char-class index, hoisted once per class.
   *
   * −1 is "no usable sentinel" — the same answer `firstSetSentinel` gives for an
   * `any`/`empty` first set — and it lowers to the literal `undefined` so the
   * publish below collapses to the inherited sentinel with no array read.
   */
  const sentRef = (cls: number): string => cls < 0 ? 'undefined' : hoist('sent', `SENTS[${cls}]`)

  /** A fresh local prefix, so two inlined marks in one body cannot collide. */
  let uid = 0
  const tmp = (): string => `_t${uid++}_`

  /** One dispatch matcher as source, shared by the ordinary and token-first paths. */
  const dispatchClaim = (m: readonly [number, string, string, number]): string => {
    switch (m[0]) {
      case 0: return `key.startsWith(${q(m[1])})`
      case 1: return `key.endsWith(${q(m[1])})`
      case 3: return `asciiFoldKey(key).startsWith(${q(m[1])})`
      case 4: return `asciiFoldKey(key).endsWith(${q(m[1])})`
      default: {
        if (!m[2].includes('g') && !m[2].includes('y')) {
          try {
            // Validate without changing malformed-row error timing.
            new RegExp(m[1], m[2])
            return `${hoist('dm', `new RegExp(${q(m[1])},${q(m[2])})`)}.test(key)`
          } catch {}
        }
        return `new RegExp(${q(m[1])},${q(m[2])}).test(key)`
      }
    }
  }

  type TokenDecisionRef = { readonly name: string; readonly expected: string }
  const tokenDecisionRefs = new Map<number, TokenDecisionRef>()
  function tokenDecisionFor(dispatchIp: number): TokenDecisionRef {
    const prior = tokenDecisionRefs.get(dispatchIp)
    if (prior !== undefined) return prior
    const selectorIp = code[dispatchIp + 1]!
    const body = code[selectorIp + 1]!
    const lineFlags = code[selectorIp + 4]!
    const hasSuffix = (lineFlags & 4) !== 0
    const di = code[dispatchIp + 2]!
    const spec = dsp[di]!
    const n = code[dispatchIp + 5]!
    validateDispatchSpec(spec, n, code[dispatchIp + 4]!)
    const recognize = hoist('lex', `LEX[${body}]`)
    const bk = hoist('bk', `DSP[${di}].byKey`)
    const expected = hoist('dx', `DSP[${di}].expected`)
    const fold = spec.byFold.size > 0
      ? `if(arm===undefined)arm=${hoist('bf', `DSP[${di}].byFold`)}.get(asciiFoldKey(key))\n`
      : ''
    const chain = spec.match.length === 0
      ? ''
      : `if(arm===undefined){\n${spec.match.map((m, i) => `${i === 0 ? '' : 'else '}if(${dispatchClaim(m)})arm=${m[3]}`).join('\n')}\n}\n`
    const foldedEntries = [...spec.byFold.entries()]
    const fixedFunctionChoice = spec.byKey.size === 0
      && foldedEntries.length === 1
      && spec.match.length === 1
      && spec.match[0]![0] === 2
      && spec.match[0]![1] === '^(?!(?:url|calc)\\($).+\\($'
      && spec.match[0]![2] === 'i'
      && code[dispatchIp + 3]! < 0
    const foldedRangeEquals = (value: string): string => {
      const folded = value.replace(/[A-Z]/g, c => c.toLowerCase())
      return `e-pos===${folded.length}&&${[...folded].map((c, i) => {
        const cc = c.charCodeAt(0)
        return `_asciiFoldCode(input.charCodeAt(pos+${i}))===${cc}`
      }).join('&&')}`
    }
    const classify = fixedFunctionChoice
      ? (() => {
          const [exact, exactArm] = foldedEntries[0]!
          const genericArm = spec.match[0]![3]
          return `let arm
if(${foldedRangeEquals(exact)})arm=${exactArm}
else if(sm&&e>pos+1){
let clean=true
for(let i=pos;i<e;i++){const c=input.charCodeAt(i);if(c===10||c===13||c===0x2028||c===0x2029){clean=false;break}}
if(clean&&!(${foldedRangeEquals('url(')})&&!(${foldedRangeEquals('calc(')}))arm=${genericArm}
}`
        })()
      : `const key=input.slice(pos,e)
let arm=${bk}.get(key)
${fold}${chain}`
    const name = `_td${tokenDecisionRefs.size}_`
    choiceDefs.push(`function ${name}(input,pos){
const r=${recognize}(input,pos)
if(r<0)return -1
const sm=${hasSuffix ? 'r%2===1' : 'false'},e=(r-(sm?1:0))/2
${classify}
if(arm===undefined){
${code[dispatchIp + 3]! < 0 ? '_pfTokEnd=e;return 0' : `arm=${n}`}
}
${fixedFunctionChoice ? 'const key=input.slice(pos,e)' : ''}
_pfTokInput=input
_pfTokPos=pos
_pfTokBody=${body}
_pfTokPacked=r
_pfTokValue=key
_pfTokDispatch=${dispatchIp}
_pfTokArm=arm
return 1
}`)
    const made = { name, expected }
    tokenDecisionRefs.set(dispatchIp, made)
    return made
  }

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
        ? `function ${nm}(input,cur,ctx){return commitTriviaScan(scanTriviaCompact(input,cur,ctx))}`
        : `function ${nm}(input,cur,ctx){
if(needsDeferredTriviaCommit(ctx))return commitTriviaScan(scanTriviaCompact(input,cur,ctx))
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

  /**
   * The BODY OF A LOWERED REGEX ROW, or `undefined` when the shape declines.
   *
   * Declining is the safe direction and the only one this can take: a shape it
   * fails to recognise falls through to the regex, which is what the row did
   * before. A shape it recognises WRONGLY is a defect, and the gate for that is
   * `bench/scan-shape-oracle.ts` — every regex constant of every workload
   * grammar driven at every position of its own corpus against the sticky
   * `exec` it replaces, end for end.
   *
   * The value is `input.slice(pos, end)`, which for a STICKY regex is `m[0]`
   * character for character. The `u`/`i`/`m`/`s` flags are handled inside
   * `scanShapeFromRegex`; `u` declines outright, because a code-unit scan is not
   * a code-point one.
   *
   * `captureLeaf` is the SITE'S — it arrives from `lower`, already resolved
   * against that site's label, so a lowered row pushes its leaf through exactly
   * the form `OP_LIT` and `OP_LIT_CI` push theirs. Re-deriving the capture test
   * here would put a second answer to a settled question inside the one body
   * that runs most.
   */
  function emitScan(
    ki: number,
    xf: string,
    track: boolean,
    captureLeaf: (value: string) => string,
  ): string | undefined {
    const re = k[ki]
    if (!(re instanceof RegExp)) return undefined
    const shape = scanShapeFromRegex(re.source, re.flags)
    if (shape === null) return undefined
    let n = 0
    const p = tmp()
    const m = emitShapeMatch(shape, 'pos', (prefix = '_v') => `${p}${prefix}${n++}`, '')
    return `
${m.setup.join('\n')}
if(${m.ok}){
const e=${m.end}
const v=input.slice(pos,e)
${captureLeaf('v')}
${track ? '_trackLines(ctx,input,e)\n' : ''}EC.e=e
return v
}
ctx._fe=pos;ctx._fx=${xf}
${cfg.probe ? `failAt(ctx,${xf},pos)\n` : ''}return FAIL
`
  }

  function link(ip: number): string {
    const hit = byIp.get(ip)
    if (hit !== undefined) return hit
    // An ALIAS site forwards to its child with no body of its own. Resolved
    // before reservation so no name is minted for a function that would only
    // add a call frame — `assemble.ts` makes the same choice by returning the
    // child piece itself.
    const target = resolveAlias(ip)
    const done = byIp.get(target)
    if (done !== undefined) return done
    const fname = `_pf${target}`
    // Reserved BEFORE lowering, so a back-edge into a site still in flight binds
    // to the hoisted declaration rather than to a forwarding stub. This is the
    // whole of `assemble.ts`'s `inFlight` map and its one shared closure.
    byIp.set(target, fname)
    bodies.push(lower(target, fname))
    return fname
  }

  /**
   * FOLLOW THE ALIAS CHAIN TO THE FIRST SITE WITH A BODY — iteratively, and
   * BEFORE anything is reserved.
   *
   * The previous form recursed through `link` and parked a PROVISIONAL name
   * `_pf<ip>` in the alias map so that a cycle would terminate. It terminated,
   * and it emitted a call to a function that does not exist: `OP_RULE` is the
   * only back-edge in a table, `OP_RULE` is an alias, so a recursive rule whose
   * cycle re-enters through the alias row still in flight bound to the
   * provisional name, and every grammar with that shape compiled to
   * `_pf1100 is not defined` — a ReferenceError at parse time, from a body that
   * the `new Function` call above accepts as syntactically valid.
   *
   * Resolving the chain first removes the window: no name is ever handed out for
   * a site that will not get a body, because the only name handed out is the
   * CHAIN'S END, which is always lowered.
   *
   * A cycle of alias-only rows — `A` aliasing to `B` aliasing back to `A`, with
   * no body anywhere in between — is a rule that expands to itself and consumes
   * nothing. Refused BY NAME rather than looped on: it is a defect in the
   * grammar, and the closure engine meets it as a stack overflow at parse time.
   */
  function resolveAlias(ip: number): number {
    let cur = ip
    let seen: Set<number> | undefined
    for (;;) {
      reached.add(cur)
      const next = aliasOf(cur)
      if (next === undefined) return cur
      if (seen === undefined) seen = new Set([cur])
      else if (seen.has(cur)) throw new Unemittable('a cycle of alias-only sites (a rule that expands to itself)')
      else seen.add(cur)
      cur = next
    }
  }

  /** Sites that forward to a child with no body, decided by option, data, or LABEL. */
  function aliasOf(ip: number): number | undefined {
    const op = code[ip]
    // `OP_GATE` under a probe or a tolerant recovery is a no-op that forwards to
    // its child, exactly as `assemble.ts:952` resolves it.
    if (op === OP_GATE && (cfg.tolerant || cfg.probe)) return code[ip + 2]!
    if (op === OP_RULE) return code[ip + 1]!
    // A SCOPE THAT INSTALLS WHAT IS ALREADY INSTALLED. `encode.ts:520` wraps
    // EVERY rule of a `rules({ trivia }, …)` map in its own `OP_SCOPE_PLAIN`, so a
    // grammar with one ambient trivia re-installs the same slot at every rule
    // entry — six context stores, a scanner swap and their six restores, per
    // call, to arrive at the values already there.
    //
    // The label is what makes this decidable: `tri >= 0` can ONLY have come from
    // an enclosing scope carrying that slot, and that scope set
    // `ctx.triviaKindLabels` and `_pfScan` from the same slot, so all three are
    // already the values this row would write. `OP_SCOPE_PLAIN` has no root
    // policy by construction; a policy-bearing `OP_SCOPE` aliases only when its
    // literal policy is zero. `OP_SCOPE_CAP` also raises `captureTrivia`.
    //
    // `ki >= 0` is required rather than implied: `TRI_NONE` and `TRI_UNKNOWN` are
    // themselves negative, so comparing a negative operand against a lattice
    // element would read "unknown" as a match.
    if ((op === OP_SCOPE_PLAIN || (op === OP_SCOPE && code[ip + 3]! === 0)) && code[ip + 1]! >= 0
      && labels.at(ip).tri === code[ip + 1]!) {
      return code[ip + 2]!
    }
    return undefined
  }

  function lower(ip: number, fname: string): string {
    const op = code[ip]
    const head = `function ${fname}(input,pos,ctx){`
    const L = labels.at(ip)
    const sinks = sinksAt(ip)
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
    const pushLeaf = L.buf && !cfg.trackLines
      ? L.raw === RAW_OMIT ? '_pushLeafNoRawBuf' : L.raw === RAW_CAPTURE ? '_pushLeafBuf' : '_pushLeaf'
      : '_pushLeaf'
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
        if (!track && scalarSpecs.has(code[ip + 1]!)) {
          const recognize = recognizerRef(code[ip + 1]!)
          return `${head}
const e=${recognize}(input,pos)
if(e>=0){
${captureLeaf(q(s))}
EC.e=e
return ${q(s)}
}
ctx._fe=pos;ctx._fx=${xf}
return FAIL
}`
        }
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
${track ? '_trackLines(ctx,input,e)\n' : ''}EC.e=e
return ${q(s)}
}
ctx._fe=pos;ctx._fx=${xf}
${cfg.probe ? `failAt(ctx,${xf},pos)\n` : ''}return FAIL
}`
      }

      case OP_LIT_CI:
      case OP_LIT_CI_TRACK: {
        const s = k[code[ip + 1]!] as string
        const xf = fxRef(code[ip + 2]!)
        const track = op === OP_LIT_CI_TRACK
        // THE FOLD, UNROLLED AGAINST CONSTANTS.
        //
        // `assemble.ts:866-873` holds the folded literal in an ARRAY and walks it
        // with a loop and a ternary per character — a load, a bounds check and a
        // branch for a comparison whose right-hand side is known here. Emitted, the
        // literal is not data at all: each character is one or two compares
        // against integers, straight-line, no array and no closure.
        //
        // Semantics are `asciiFoldEq`'s exactly. `foldedLit[i]` is the literal
        // folded, so it is never in A-Z; and `fold` maps A-Z INTO a-z and is the
        // identity everywhere else. So for a folded character `c`:
        //   - `c` in a-z  — the input matches iff it is `c` or `c - 32`
        //   - otherwise   — the input matches iff it is exactly `c`, because the
        //                   only characters fold moves land in a-z
        // Past end of input `charCodeAt` is NaN, which compares unequal to both —
        // the same answer the length test gave.
        //
        // The match VALUE is `input.slice(pos, e)`, the INPUT's casing and not the
        // literal's, exactly as `literal.ts:86` has it — returning the literal
        // would silently normalise case in any node built from it.
        const tests: string[] = []
        const reads: string[] = []
        for (let i = 0; i < s.length; i++) {
          const raw = s.charCodeAt(i)
          const f = raw >= 65 && raw <= 90 ? raw + 32 : raw
          const at = i === 0 ? 'pos' : `pos+${i}`
          if (f >= 97 && f <= 122) {
            reads.push(`const c${i}=input.charCodeAt(${at})`)
            tests.push(`(c${i}===${f}||c${i}===${f - 32})`)
          } else {
            tests.push(`input.charCodeAt(${at})===${f}`)
          }
        }
        return `${head}
${reads.length > 0 ? `${reads.join('\n')}\n` : ''}if(${tests.join('&&')}){
const e=pos+${s.length}
const v=input.slice(pos,e)
${captureLeaf('v')}
${track ? '_trackLines(ctx,input,e)\n' : ''}EC.e=e
return v
}
ctx._fe=pos;ctx._fx=${xf}
${cfg.probe ? `failAt(ctx,${xf},pos)\n` : ''}return FAIL
}`
      }

      case OP_RX:
      case OP_RX_TRACK: {
        const xf = fxRef(code[ip + 2]!)
        const track = op === OP_RX_TRACK
        if (!track && scalarSpecs.has(code[ip + 1]!)) {
          const recognize = recognizerRef(code[ip + 1]!)
          return `${head}
const e=${recognize}(input,pos)
if(e>=0){
const v=input.slice(pos,e)
${captureLeaf('v')}
EC.e=e
return v
}
ctx._fe=pos;ctx._fx=${xf}
return FAIL
}`
        }
        // THE MATCH ARRAY IS THE COST, not the matching. `re.exec` allocates one
        // per row — 6,005 rows per `json/document` parse, 12.9% of everything
        // executed — and every field of it but `[0]` is discarded here. A shape
        // that lowers replaces the call with a straight-line scan over
        // `charCodeAt`, and the ranges are FOLDED INTO THE SOURCE by
        // `classCond`/`litCond`/`foldEq` rather than read from a table at run
        // time: emitted as a static body consulting `inRanges`, this would
        // reproduce the per-character loop it exists to remove.
        const scanned = emitScan(code[ip + 1]!, xf, track, captureLeaf)
        if (scanned !== undefined) return `${head}${scanned}}`
        // STICKINESS IS THE PRECONDITION OF BOTH FORMS BELOW, and it is checked
        // rather than assumed. `encode.ts:588` appends `y` to every regex row it
        // emits, so a non-sticky constant here would be a new encoder path — and
        // `lastIndex=pos` would already have been meaningless for it, silently
        // matching from wherever the last row left off.
        const rxk = k[code[ip + 1]!]
        if (!(rxk instanceof RegExp) || !rxk.sticky) throw new Unemittable('a non-sticky regex row')
        // A ROW THAT DOES NOT LOWER STILL NEED NOT ALLOCATE. `test` and `exec`
        // run the identical match; `exec` additionally materialises a
        // JSRegExpResult, and V8's `test` fast path does not. For a STICKY
        // regex `lastIndex` IS the match end on success (RegExpBuiltinExec
        // step 15), so `input.slice(pos, lastIndex)` is `m[0]` character for
        // character, and the array was the only thing dropped. Counted, not
        // reasoned: 400×~2k sticky matches of json's unlowered string body take
        // 99 scavenges through `exec` and 10 through `test`, reproduced.
        const re = kRef(code[ip + 1]!)
        return `${head}
${re}.lastIndex=pos
if(${re}.test(input)){
const e=${re}.lastIndex
const v=input.slice(pos,e)
${captureLeaf('v')}
${track ? '_trackLines(ctx,input,e)\n' : ''}EC.e=e
return v
}
ctx._fe=pos;ctx._fx=${xf}
${cfg.probe ? `failAt(ctx,${xf},pos)\n` : ''}return FAIL
}`
      }

      case OP_EMPTY:
        // `''`, not `null` — the zero-width match's value. The other three engines
        // (exec.ts, exec-baseline.ts, assemble.ts) all return `''`; this one returned
        // `null`, so the SAME program yielded a different `value` depending only on
        // which engine ran. Unreached from the combinator API today — `OP_EMPTY` is
        // emitted only as `finish()` padding for an EMPTY rule map, which then has no
        // walk roots for the emitter to visit — but that is an accident of two
        // unguarded facts, not an invariant, and it is already reachable through the
        // hand-built-program idiom this file's driver tests use.
        return `${head}EC.e=pos;return ''}`

      case OP_GATE: {
        const child = link(code[ip + 2]!)
        const ci = classes.push([t.cc[code[ip + 1]!]!]) - 1
        classPlan.push([code[ip + 1]!])
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
return ${fn}(v,{start:pos,end:EC.e})
}`
      }

      case OP_LABEL: {
        const child = link(code[ip + 1]!)
        const xf = fxRef(code[ip + 2]!)
        // `_fe` IS NOT TOUCHED — `map.ts:84` keeps the child's span and replaces
        // only the expected set. A label that moved the failure position would
        // report the diagnostic at the label's start rather than where the input
        // actually stopped.
        return `${head}
const v=${child}(input,pos,ctx)
if(v===FAIL)ctx._fx=${xf}
return v
}`
      }

      case OP_FIELD: {
        const name = q(k[code[ip + 1]!] as string)
        const child = link(code[ip + 2]!)
        // `ctx._fields?.push(…)` — conditional on a field-reading node being
        // open, exactly as `map.ts` has it, so a field outside one costs a load
        // and a branch. The ARRAY is what `OP_NODE` hands to `buildFieldMap`.
        return `${head}
const v=${child}(input,pos,ctx)
if(v===FAIL)return FAIL
const f=ctx._fields
if(f!==undefined)f.push({name:${name},value:v,span:{start:pos,end:EC.e}})
return v
}`
      }

      case OP_EXPECT: {
        const child = link(code[ip + 1]!)
        const xf = fxRef(code[ip + 2]!)
        // TWO ARMS, mirroring `assemble.ts:1050`. A TOLERANT `expect()` EMBEDS
        // ITS ERROR IN THE TREE and not only in the flat `_errors` side-channel
        // (`combinators/expect.ts:150`, codegen's `_ctx._rec.capture` at
        // codegen.ts:4470) — so a tree walk finds every diagnostic and the node
        // survives incremental subtree reuse. `captureError` is the shared
        // function, called; the embedding is not restated here.
        //
        // `_fc` IS CLEARED IN BOTH: a recovered failure is no longer a failure,
        // and the commit bit the child raised must not survive it and cut an
        // enclosing choice (`assemble.ts:1058-1066`).
        return `${head}
const v=${child}(input,pos,ctx)
if(v!==FAIL)return v
const err={_tag:'parseError',span:${prog.lines === 1 ? 'spanLines(ctx,pos,pos)' : '{start:pos,end:pos}'},expected:${xf}}
const es=ctx._errors
if(es!==undefined)es.push(err)
${REC ? 'if(ctx._tolerant===true)captureError(ctx,err)\n' : ''}ctx._fc=false
EC.e=pos
return err
}`
      }

      case OP_ROUTED: {
        const fb = code[ip + 1]!
        const fallback = fb >= 0 ? link(fb) : undefined
        // The SPAN is the routed item's own object, not a copy — `assemble.ts`
        // hands the same one to the leaf, and a fresh `{start,end}` here would
        // be a different tree for any consumer comparing by identity.
        const push = `pushCstLeaf(ctx,{_tag:'leaf',value:it.value,span:it.span})`
        return `${head}
const it=ctx._routed
if(it===undefined||pos!==it.span.start){
${fallback !== undefined ? `return ${fallback}(input,pos,ctx)` : 'ctx._fe=pos;ctx._fx=ROUTED_FX;return FAIL'}
}
${L.buf ? push : `if(ctx._cstBuf!==undefined||ctx._cstLeaves!==undefined)${push}`}
EC.e=it.span.end
return it.value
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
EC.e=r.span.end
return r.value
}`
      }

      case OP_SCOPE:
      case OP_SCOPE_CAP:
      case OP_SCOPE_PLAIN: {
        const ki = code[ip + 1]!
        const cap = op === OP_SCOPE_CAP
        const flags = op === OP_SCOPE_PLAIN ? 0 : code[ip + 3]!
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

      /* ── boundaries ──────────────────────────────────────────────────────── */

      case OP_TOKEN:
      case OP_LEAF: {
        const isToken = op === OP_TOKEN
        const fn = isToken ? undefined : fnRef(code[ip + 1]!)
        const child = link(isToken ? code[ip + 1]! : code[ip + 2]!)
        // `try`/`finally`, AS `assemble.ts` HAS IT. `OP_SCOPE` restores linearly
        // and this does not, and the difference is not an oversight in either:
        // `test/unit/token.test.ts:198` pins CONTEXT RESTORATION ON A THROWING
        // BODY across the interpreter and `compile`, and jess's reducers
        // throw on purpose — that is how its dialects reject illegal constructs
        // (`bench/jess/digest.ts:64`). A boundary that leaked `ctx.trivia` and
        // five capture sinks on the way out would corrupt every subsequent parse
        // through the same context, so the handler IS the semantics here.
        //
        // `cstCaptureActive` IS THE SAVED STATE, read BEFORE the sinks are
        // cleared — the leaf this body contributes goes to the OUTER collector.
        // Inside a node the answer is the label's, and the call disappears.
        const wasCap = L.buf ? 'true' : '(ctx._cstBuf!==undefined||ctx._cstLeaves!==undefined)'
        // `token()` additionally clears the TRIVIA scope and the root trivia
        // log: its whole point is that the child sees no ambient skipping, so
        // the match is one contiguous run of input (`ops.ts:180-190`).
        return `${head}
const sBuf=ctx._cstBuf,sCh=ctx._cstChildren,sLv=ctx._cstLeaves,sRaw=ctx._cstRawChildren,sTl=ctx._cstTriviaLog
const sOtl=ctx._triviaLog
${isToken ? 'const sTri=ctx.trivia,sKinds=ctx.triviaKindLabels,sScan=_pfScan,sRtl=ctx._rootTriviaLog\n' : ''}const wasCap=${wasCap}
${isToken ? `_pfScan=null
ctx.trivia=undefined
ctx.triviaKindLabels=undefined
` : ''}ctx._cstBuf=undefined
ctx._cstChildren=undefined
ctx._cstLeaves=undefined
ctx._cstRawChildren=undefined
ctx._cstTriviaLog=undefined
ctx._triviaLog=undefined
${isToken ? 'ctx._rootTriviaLog=undefined\n' : ''}let v
try{v=${child}(input,pos,ctx)}finally{
${isToken ? `_pfScan=sScan
ctx.trivia=sTri
ctx.triviaKindLabels=sKinds
ctx._rootTriviaLog=sRtl
` : ''}ctx._cstBuf=sBuf
ctx._cstChildren=sCh
ctx._cstLeaves=sLv
ctx._cstRawChildren=sRaw
ctx._cstTriviaLog=sTl
ctx._triviaLog=sOtl
}
if(v===FAIL)return FAIL
const e=EC.e
const out=${isToken ? 'input.slice(pos,e)' : `${fn}(v,{start:pos,end:e})`}
if(wasCap)pushCstLeaf(ctx,{_tag:'leaf',value:out,span:{start:pos,end:e}})
EC.e=e
return out
}`
      }

      case OP_LEX_BODY: {
        const body = code[ip + 1]!
        const recognize = hoist('lex', `LEX[${body}]`)
        const expected = fxRef(code[ip + 2]!)
        const suffixExpected = fxRef(code[ip + 3]!)
        const lineFlags = code[ip + 4]!
        const hasSuffix = (lineFlags & 4) !== 0
        const pending = tokenChoiceBodies.has(body)
        return `${head}
${pending ? `const tp=_pfTokBody===${body}&&_pfTokInput===input&&_pfTokPos===pos
const r=tp?_pfTokPacked:${recognize}(input,pos)` : `const r=${recognize}(input,pos)`}
if(r<0){ctx._fe=pos;ctx._fx=${expected};if(ctx._probe!==undefined)failAt(ctx,${expected},pos);return FAIL}
const sm=${hasSuffix ? 'r%2===1' : 'false'},e=(r-(sm?1:0))/2
${(lineFlags & 1) !== 0 ? '_trackLines(ctx,input,sm?e-1:e)' : ''}
${hasSuffix ? 'ctx._fc=false' : ''}
${hasSuffix && (lineFlags & 2) !== 0 ? 'if(sm)_trackLines(ctx,input,e)' : ''}
${hasSuffix ? `if(!sm){ctx._fe=e;ctx._fx=${suffixExpected};if(ctx._probe!==undefined)failAt(ctx,${suffixExpected},e)}` : ''}
const v=${pending ? 'tp?_pfTokValue:' : ''}input.slice(pos,e)
${pending ? 'if(tp){_pfTokBody=-1;_pfTokValue=undefined}' : ''}
if(ctx._cstBuf!==undefined||ctx._cstLeaves!==undefined)pushCstLeaf(ctx,{_tag:'leaf',value:v,span:{start:pos,end:e}})
EC.e=e
return v
}`
      }

      case OP_LEX_PROGRAM: {
        const programId = code[ip + 1]!
        const run = hoist('lexProgram', `LEXPROG[${programId}]`)
        const scanId = t.lexPrograms[programId]!.scan
        if (scanId !== undefined) return `${head}
const sTri=ctx.trivia,sKinds=ctx.triviaKindLabels,sScan=_pfScan
const sBuf=ctx._cstBuf,sCh=ctx._cstChildren,sLv=ctx._cstLeaves,sRaw=ctx._cstRawChildren,sTl=ctx._cstTriviaLog
const sOtl=ctx._triviaLog,sRtl=ctx._rootTriviaLog
const wasCap=ctx._cstBuf!==undefined||ctx._cstLeaves!==undefined
_pfScan=null
ctx.trivia=undefined
ctx.triviaKindLabels=undefined
ctx._cstBuf=undefined
ctx._cstChildren=undefined
ctx._cstLeaves=undefined
ctx._cstRawChildren=undefined
ctx._cstTriviaLog=undefined
ctx._triviaLog=undefined
ctx._rootTriviaLog=undefined
let e
try{e=${run}(input,pos,ctx,SCANS[${scanId}])}finally{
_pfScan=sScan
ctx.trivia=sTri
ctx.triviaKindLabels=sKinds
ctx._cstBuf=sBuf
ctx._cstChildren=sCh
ctx._cstLeaves=sLv
ctx._cstRawChildren=sRaw
ctx._cstTriviaLog=sTl
ctx._triviaLog=sOtl
ctx._rootTriviaLog=sRtl
}
if(e<0)return FAIL
const v=input.slice(pos,e)
if(wasCap)pushCstLeaf(ctx,{_tag:'leaf',value:v,span:{start:pos,end:e}})
EC.e=e
return v
}`
        return `${head}
const e=${run}(input,pos,ctx)
if(e<0)return FAIL
const v=input.slice(pos,e)
if(ctx._cstBuf!==undefined||ctx._cstLeaves!==undefined)pushCstLeaf(ctx,{_tag:'leaf',value:v,span:{start:pos,end:e}})
EC.e=e
return v
}`
      }

      /* ── transaction ─────────────────────────────────────────────────────── */

      case OP_ATTEMPT: {
        const child = link(code[ip + 1]!)
        const clean = !REC && failureRollbackClean(prog, ip)
        const p = tmp()
        return `${head}
${clean ? '' : emitMark(p, L.buf, L.raw, sinks)}
const v=${child}(input,pos,ctx)
if(v!==FAIL)return v
${clean ? '' : emitRollback(p, L.buf, L.raw, sinks)}
if(ctx._fc===true)return FAIL
ctx._fe=pos
return FAIL
}`
      }

      case OP_NOT: {
        const scalarChild = scalarTerminalNotChild(code, ip)
        if (scalarChild >= 0) {
          const recognize = recognizerRef(code[scalarChild + 1]!)
          const xf = fxRef(code[ip + 2]!)
          return `${head}
if(${recognize}(input,pos)<0){EC.e=pos;return null}
ctx._fe=pos
ctx._fx=${xf}
EC.e=pos
return FAIL
}`
        }
        const child = link(code[ip + 1]!)
        const xf = fxRef(code[ip + 2]!)
        const p = tmp()
        return `${head}
${emitMark(p, L.buf, L.raw, sinks)}
const v=${child}(input,pos,ctx)
${emitRollback(p, L.buf, L.raw, sinks)}
if(v===FAIL){EC.e=pos;return null}
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
${emitMark(p, L.buf, L.raw, sinks)}
const v=${child}(input,pos,ctx)
${emitRollback(p, L.buf, L.raw, sinks)}
if(v===FAIL){ctx._fe=pos;ctx._fx=${xf};return FAIL}
EC.e=pos
return null
}`
      }

      case OP_OPT: {
        const child = link(code[ip + 1]!)
        const clean = !REC && failureRollbackClean(prog, ip)
        const p = tmp()
        return `${head}
${clean ? '' : emitMark(p, L.buf, L.raw, sinks)}
ctx._fc=false
const v=${child}(input,pos,ctx)
if(v===FAIL){
if(ctx._fc===true)return FAIL
${clean ? '' : emitRollback(p, L.buf, L.raw, sinks)}
EC.e=pos
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
        const reducer = fused ? code[ip + 1]! : -1
        const projection = reducer < 0 ? ~reducer : -1
        const fn = fused && projection < 0 ? fnRef(reducer) : undefined
        const kids: string[] = []
        for (let i = 0; i < n; i++) {
          const childIp = code[base + i]!
          kids.push(code[childIp] === OP_ADJ ? '' : link(childIp))
        }
        /**
         * A RECOVERY SEQUENCE PUBLISHES `ctx._sync`, and that is the WHOLE of
         * "recovery config" — no grammar carries any (`assemble.ts:1446`).
         *
         * Before term `i`, the sentinel for the union of every LATER term's first
         * set becomes the sync point a list nested in that term resyncs to, so a
         * `sepBy` inside `sequence('{', list, '}')` finds `}` with nothing
         * annotated. Where there is no usable local follow — the last term, an
         * `any` first set — the INHERITED sentinel stays published, which is how
         * an enclosing delimiter reaches across a rule boundary. `sentRef` emits
         * the literal `undefined` for that case, so it costs no array read.
         *
         * THE `n` SYNC OPERANDS SIT AFTER THE `n` CHILD OPERANDS, laid down by
         * `encodeTable({ recovery })` — the same operands `assemble.ts:1468`
         * reads, at the same offsets.
         *
         * RESTORED IN A `finally`, matching `sequence()`'s own
         * (`combinators/sequence.ts:105`) and the closure engine's. `emitTerm`
         * emits `return FAIL` INLINE at several points, so a restore placed on
         * the fall-through paths alone would leak a stale sentinel out of exactly
         * the failure the recovery path is about to read. `finally` is the only
         * placement that covers an inlined return, and it is on the tolerant
         * assembly only — the strict one emits none of this.
         */
        const sy = REC ? `${tmp()}sy` : ''
        const pub = (i: number): string => {
          const s = sentRef(code[base + n + i]!)
          return s === 'undefined' ? `ctx._sync=${sy}` : `ctx._sync=${s}??${sy}`
        }
        const parts: string[] = [head]
        if (REC) parts.push(`const ${sy}=ctx._sync`, 'try{', pub(0))
        parts.push(`const v0=${kids[0]}(input,pos,ctx)`, 'if(v0===FAIL)return FAIL')
        const close = (): string => REC ? `${parts.join('\n')}\n}finally{ctx._sync=${sy}}\n}` : `${parts.join('\n')}\n}`
        if (n === 1) {
          parts.push(fused
            ? projection === 0 ? 'return v0' : `return ${fn}([v0],{start:pos,end:EC.e})`
            : wantValues ? 'return [v0]' : 'return undefined')
          return close()
        }
        parts.push('let cur=EC.e')
        const names: string[] = ['v0']
        for (let i = 1; i < n; i++) {
          const vn = `v${i}`
          parts.push(`let ${vn}`)
          if (REC) parts.push(pub(i))
          const childIp = code[base + i]!
          if (code[childIp] === OP_ADJ) {
            const negated = code[childIp + 1] === 1
            const ki = code[childIp + 2]!
            const kinds = ki < 0 ? 'undefined' : `K[${ki}]`
            const expected = fxRef(code[childIp + 3]!)
            parts.push(
              `if(!adjacencyHolds(input,cur,ctx,${negated ? 'true' : 'false'},${kinds})){ctx._fe=cur;ctx._fx=${expected};return FAIL}`,
              `${vn}=null`,
            )
          } else parts.push(emitTerm(kids[i]!, vn, tmp(), L, skipFor(L)))
          names.push(vn)
        }
        parts.push('EC.e=cur')
        parts.push(fused
          ? projection >= 0 ? `return ${names[projection]}` : `return ${fn}([${names.join(',')}],{start:pos,end:cur})`
          : wantValues ? `return [${names.join(',')}]` : 'return undefined')
        return close()
      }

      case OP_CHOICE: {
        const table = disp[code[ip + 1]!]!
        const n = code[ip + 2]!
        const choiceFx = fxRef(code[ip + 3]!)
        const base = ip + 4
        const arms: string[] = []
        for (let i = 0; i < n; i++) arms.push(link(code[base + i]!))

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

        {
          // Direct topology for every fixed arity. The emitted body names every
          // child, gate and expected set; no AFX/CLS row survives merely to feed
          // an indexed winner back into one call site.
          const di = code[ip + 1]!
          const expected = Array.from({ length: n }, (_, i) => fxRef(code[base + n + i]!))
          const gates = Array.from({ length: n }, (_, i) => table.armCls[i] ?? null)
          const gateRefs = Array.from({ length: n }, (_, i) => hoist('g', `DISP[${di}].armCls[${i}]`))
          type ChoicePretest = {
            readonly scalar?: string
            readonly token?: TokenDecisionRef
          }
          const tokenCandidate = tokenChoiceCandidates.get(ip)
          const pretests = Array.from({ length: n }, (_, i): ChoicePretest | undefined => {
            if (tokenCandidate?.arm === i) {
              return { token: tokenDecisionFor(tokenCandidate.dispatchIp) }
            }
            if (n !== 2 && n !== 3) return undefined
            const terminal = leadingScalarTerminal(code, code[base + i]!)
            if (terminal < 0 || !scalarSpecs.has(code[terminal + 1]!)) return undefined
            return { scalar: recognizerRef(code[terminal + 1]!) }
          })
          const maskable = n <= 32
          const maskName = maskable
            ? hoist('mk', `MASK[${masks.push(maskForClassRow(gates)) - 1}]`)
            : ''
          // `~di` points back to the authoritative dispatch row. A precompiled
          // module reconstructs only the input-indexed mask from that row; it
          // cannot carry a second mutable answer for the arms' classes.
          if (maskable) maskPlan.push(~di)
          const p = tmp()
          // This proof lives only on the compiler-created program while the
          // precompiled assembly is printed. A hand-built or deserialized table
          // has no authority and therefore keeps the established all-arm path.
          const encodedRollbackMask = choiceRollbackMask(prog, ip) ?? -1
          const rollbackMask = REC ? -1 : encodedRollbackMask
          const hasRollback = rollbackMask !== 0
          // An always-consuming leading scalar makes a failure at `pos`
          // statically exact: it is the arm's derived opener set, and the
          // choice's own `choiceFx` already concatenates every such set in
          // source order. Defer array merging until an arm reaches deeper input
          // so a later successful arm pays no diagnostic-allocation tax.
          //
          // attempt() is a hard boundary: it can fail deeper and deliberately
          // re-anchor `_fe` at `pos` while keeping the inner dynamic expected
          // set. A zero-width regex has the same ambiguity, so neither qualifies.
          const startFailureExact = arms.every((_arm, i) => {
            const terminal = leadingScalarTerminal(code, code[base + i]!, 0, false)
            if (terminal < 0) return false
            const op = code[terminal]
            const spec = k[code[terminal + 1]!]
            // Recognition shape is not diagnostic authority. word() is one
            // important counterexample: its terminal reports `keyword`, while
            // deriveExpected at an enclosing choice names the concrete word.
            // Substituting choiceFx for the dynamic terminal set is sound only
            // when both encoded authorities agree byte-for-byte, including
            // duplicates and source order.
            const terminalFx = fx[code[terminal + 2]!]!
            const armFx = fx[code[base + n + i]!]!
            if (terminalFx.length !== armFx.length
              || terminalFx.some((expected, at) => expected !== armFx[at])) return false
            if (op === OP_LIT) return typeof spec === 'string' && spec.length > 0
            return op === OP_RX && spec instanceof RegExp && !regexCanMatchEmpty(spec.source)
          })
          const rollbackFor = (i: number): string =>
            rollbackMask === -1 || (rollbackMask & (1 << i)) !== 0
              ? emitRollback(p, L.buf, L.raw, sinks)
              : ''
          const catchName = maskable ? `_cx${uid++}_` : ''
          if (maskable) {
            const catchCases = expected.map((e, i) =>
              `case ${i}:if(target<=${i})return acc;acc=_accSet(${e},acc)`).join('\n')
            choiceDefs.push(`function ${catchName}(target,prev,acc){switch(prev){\n${catchCases}\n}return acc}`)
          }
          const maskArms = maskable ? arms.map((arm, i) => {
            const pretest = pretests[i]
            const decision = pretest?.token === undefined ? '' : tmp()
            const condition = pretest?.token !== undefined
              ? `&&(${decision}=${pretest.token.name}(input,pos))>0`
              : pretest?.scalar === undefined ? '' : `&&${pretest.scalar}(input,pos)>=0`
            const routeMiss = pretest?.token === undefined ? '' : `
if(${decision}===0){
ctx._fc=false
${startFailureExact ? '' : `if(best===pos)acc=${catchName}(${i},prev,acc)
prev=${i + 1}`}
{const at=_pfTokEnd
if(at>best){best=at;acc=undefined}
if(at===best${startFailureExact ? '&&at>pos' : ''})acc=_accSet(${pretest.token.expected},acc)}
}`
            return `${decision === '' ? '' : `let ${decision}=-1\n`}if((bits&${1 << i})!==0${condition}){
ctx._fc=false
{const v=${arm}(input,pos,ctx)
if(v!==FAIL)return v}
${startFailureExact ? '' : `if(best===pos)acc=${catchName}(${i},prev,acc)
prev=${i + 1}`}
{const at=ctx._fe??pos
if(at>best){best=at;acc=undefined}
if(at===best${startFailureExact ? '&&at>pos' : ''})acc=_accSet(ctx._fx,acc)}
if(ctx._fc===true){${startFailureExact ? `if(best===pos){acc=${catchName}(${i},0,undefined);acc=_accSet(ctx._fx,acc)}` : ''}if(acc!==undefined)ctx._fx=acc;return FAIL}
${rollbackFor(i)}
}${routeMiss}`
          }).join('\n') : ''
          const generalArms = arms.map((arm, i) => {
            const pretest = pretests[i]
            const decision = pretest?.token === undefined ? '' : tmp()
            const condition = pretest?.token !== undefined
              ? `&&(${decision}=${pretest.token.name}(input,pos))>0`
              : pretest?.scalar === undefined ? '' : `&&${pretest.scalar}(input,pos)>=0`
            const miss = pretest?.token === undefined
              ? startFailureExact ? '' : `else if(best===pos)acc=_accSet(${expected[i]},acc)`
              : `else if(${decision}===0){
ctx._fc=false
const at=_pfTokEnd
if(at>best){best=at;acc=undefined}
if(at===best${startFailureExact ? '&&at>pos' : ''})acc=_accSet(${pretest.token.expected},acc)
}${startFailureExact ? '' : `else if(best===pos)acc=_accSet(${expected[i]},acc)`}`
            return `${decision === '' ? '' : `let ${decision}=-1\n`}if((${gateRefs[i]}===null||classHas(${gateRefs[i]},c))${condition}){
ctx._fc=false
{const v=${arm}(input,pos,ctx)
if(v!==FAIL)return v}
{const at=ctx._fe??pos
if(at>best){best=at;acc=undefined}
if(at===best${startFailureExact ? '&&at>pos' : ''})acc=_accSet(ctx._fx,acc)}
if(ctx._fc===true){${startFailureExact ? `if(best===pos){acc=${catchName}(${i},0,undefined);acc=_accSet(ctx._fx,acc)}` : ''}if(acc!==undefined)ctx._fx=acc;return FAIL}
${rollbackFor(i)}
}${miss}`
          }).join('\n')

          // A zero compatible-arm mask is stronger than a speculative miss: no
          // arm can run, so the choice's encoded flat expected set is already
          // the exact result. Do not walk the arm ladder merely to rebuild it.
          return `${head}
const c=lead(input,pos)
${hasRollback ? emitMark(p, L.buf, L.raw, sinks) : ''}
let acc
let best=pos
${maskable ? `if(c<128){
const bits=${maskName}[c<0?128:c]
if(bits===0){ctx._fe=pos;ctx._fx=${choiceFx};return FAIL}
${startFailureExact ? '' : 'let prev=0'}
${maskArms}
${startFailureExact ? '' : `if(best===pos)acc=${catchName}(${n},prev,acc)`}
ctx._fe=pos;ctx._fx=${startFailureExact ? `best===pos?${choiceFx}:acc??${choiceFx}` : `acc??${choiceFx}`}
return FAIL
}
` : ''}
${generalArms}
ctx._fe=pos;ctx._fx=${startFailureExact ? `best===pos?${choiceFx}:acc??${choiceFx}` : `acc??${choiceFx}`}
return FAIL
}`
        }

      }

      case OP_DISPATCH: {
        const di = code[ip + 2]!
        const spec = dsp[di]
        const selector = link(code[ip + 1]!)
        const otherIp = code[ip + 3]!
        const other = otherIp >= 0 ? link(otherIp) : undefined
        const otherRouted = code[ip + 4]! === 1
        const n = code[ip + 5]!
        validateDispatchSpec(spec, n, code[ip + 4]!)
        const armBase = ip + 6
        const arms: string[] = []
        for (let i = 0; i < n; i++) arms.push(link(code[armBase + i]!))
        const bk = hoist('bk', `DSP[${di}].byKey`)
        const dx = hoist('dx', `DSP[${di}].expected`)
        const chain = spec.match.length === 0
          ? ''
          : `if(arm===undefined){\n${spec.match.map((m, i) => `${i === 0 ? '' : 'else '}if(${dispatchClaim(m)})arm=${m[3]}`).join('\n')}\n}\n`
        const fold = spec.byFold.size > 0
          ? `if(arm===undefined)arm=${hoist('bf', `DSP[${di}].byFold`)}.get(asciiFoldKey(key))\n`
          : ''
        const m1 = tmp()
        const m2 = tmp()
        const routedCall = (target: string): string => `{const savedRouted=ctx._routed
${emitRollback(m1, L.buf, L.raw, sinks)}
${emitMark(m2, L.buf, L.raw, sinks, false)}
ctx._routed={value:key,span:{start:pos,end:selEnd}}
try{v=${target}(input,pos,ctx)}finally{ctx._routed=savedRouted}
break}`
        const plainCall = (target: string): string => `v=${target}(input,selEnd,ctx);break`
        const armCases = arms.map((target, i) => `case ${i}:${spec.routed[i] === 1
          ? routedCall(target)
          : plainCall(target)}`).join('\n')
        const fallbackCase = other === undefined ? '' : `default:${otherRouted
          ? routedCall(other)
          : plainCall(other)}`
        const armSelection = tokenChoiceDispatches.has(ip)
          ? `const tp=_pfTokDispatch===${ip}&&_pfTokInput===input&&_pfTokPos===pos
let arm
if(tp){
arm=_pfTokArm
_pfTokDispatch=-1
_pfTokInput=undefined
if(arm===${n})arm=undefined
}else{
arm=${bk}.get(key)
${fold}${chain}}`
          : `let arm=${bk}.get(key)
${fold}${chain}`
        // THE SELECTOR RUNS ONCE and the key it returns picks the arm — that is
        // what `dispatch()` buys over a choice of arms that each re-parse the
        // opener. A routed arm rewinds the selector's trivia capture and gets
        // the token handed to it (`OP_ROUTED`) instead of re-matching it.
        return `${head}
${emitMark(m1, L.buf, L.raw, sinks)}
const sv=${selector}(input,pos,ctx)
if(sv===FAIL)return FAIL
const selEnd=EC.e
const key=sv
${armSelection}
if(arm===undefined){
${other === undefined ? `ctx._fe=selEnd;ctx._fx=${dx};return FAIL` : ''}
}
${emitMark(m2, L.buf, L.raw, sinks)}
let v
switch(arm){
${armCases}
${fallbackCase}
}
if(v===FAIL){
${emitRollback(m2, L.buf, L.raw, sinks)}
ctx._fc=true
return FAIL
}
return [key,v]
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
        let itemCls: string | undefined
        if (!REC) {
          const itemClassIndex = sepIp < 0 ? code[ip + 7]! : -1
          if (itemClassIndex >= 0) {
            const ci = classes.push([t.cc[itemClassIndex]!]) - 1
            classPlan.push([itemClassIndex])
            itemCls = hoist('ri', `CLS[${ci}][0]`)
          }
        }
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
        // THE `_fields` AND `_errors` MARKS ARE TAKEN ONLY WHERE THE TABLE HAS A
        // WRITER, which is the same emit-time census `emitMark` applies to the
        // non-loop marks. Before `OP_FIELD` and `OP_EXPECT` were emittable the
        // answer was "never"; it is now "per table", and a grammar with no field
        // still pays neither the two loads nor the two stores per item.
        const pfd = sinks.fd ? `${p}fd` : 'undefined'
        const per = sinks.er ? `${p}er` : 'undefined'
        const rbHelper = L.raw === RAW_OMIT ? '_rbNoRawBuf' : '_rbBuf'
        const rb = L.buf && L.raw !== 0
          ? `${rbHelper}(ctx,${p}raw,${p}tl,${p}lv,${p}lg,${p}rt)${sinks.fd ? `\nif(ctx._fields!==undefined&&ctx._fields.length!==${p}fd)ctx._fields.length=${p}fd` : ''}${sinks.er ? `\nif(ctx._errors!==undefined&&ctx._errors.length!==${p}er)ctx._errors.length=${p}er` : ''}`
          : L.buf
            ? `rollbackTriviaAt(ctx,${p}raw,${p}tl,${p}lv,${pfd},${per},${p}lg,${p}rt)`
          : `if(needMark)rollbackTriviaAt(ctx,${p}raw,${p}tl,${p}lv,${pfd},${per},${p}lg,${p}rt)`
        const markSinks = `${sinks.fd ? `\n${p}fd=ctx._fields!==undefined?ctx._fields.length:0` : ''}${sinks.er ? `\n${p}er=ctx._errors!==undefined?ctx._errors.length:0` : ''}`
        const markRaw = L.raw === RAW_OMIT
          ? `${p}raw=b.rawLen`
          : L.raw === RAW_CAPTURE
            ? `const r=b.raw;${p}raw=r!==undefined?r.length:b.rawSingle!==undefined?1:0`
            : `const r=b.raw;${p}raw=b.noRaw===true?b.rawLen:(r!==undefined?r.length:b.rawSingle!==undefined?1:0)`
        const markBody = L.buf
          ? `const b=ctx._cstBuf
${markRaw}
const h=b.ch;${p}lv=h!==undefined?h.length:b.single!==undefined?1:0
const l=b.tl;${p}tl=l!==undefined?l.length:0
${p}lg=ctx._triviaLog!==undefined?ctx._triviaLog.length:0
${p}rt=ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length:0${markSinks}`
          : `if(needMark){
const b=ctx._cstBuf
if(b!==undefined){
const r=b.raw;${p}raw=b.noRaw===true?b.rawLen:(r!==undefined?r.length:b.rawSingle!==undefined?1:0)
const h=b.ch;${p}lv=h!==undefined?h.length:b.single!==undefined?1:0
const l=b.tl;${p}tl=l!==undefined?l.length:0
}else{
${p}raw=ctx._cstRawChildren!==undefined?ctx._cstRawChildren.length:0
${p}tl=ctx._cstTriviaLog!==undefined?ctx._cstTriviaLog.length:0
${p}lv=ctx._cstLeaves!==undefined?ctx._cstLeaves.length:0
}
${p}lg=ctx._triviaLog!==undefined?ctx._triviaLog.length:0
${p}rt=ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length:0${markSinks}
}`
        /**
         * TOLERANT RECOVERY — the SAME functions the other three engines call
         * (`recovery/scan.ts`), so an error's span, its expected set and its CST
         * embedding are produced once and cannot drift between engines.
         *
         * Reached only in a recovery table, and inside it only on the FAILURE of
         * an element, so a matching item pays one `_sync` read at entry and
         * nothing else. Everything else in this loop is the emitted strict loop
         * unchanged — which is the whole point, and what the top-level refusal
         * this replaces was giving up.
         *
         * THE FOUR AGREEMENTS WITH `assemble.ts:2036`, each load-bearing:
         *  - a MANDATORY item of a separator-less repeat does NOT recover, so the
         *    gate is `sep !== undefined || count >= min`. Both conjuncts are
         *    table data here, so the test is CONSTANT-FOLDED rather than run.
         *  - the check is `matchesAt(mySync, itemStart)`: sitting ON the sync
         *    token is a clean list end, not junk, and `itemStart` is past any
         *    leading trivia so trivia is never swallowed into the error span.
         *  - a separated list scans to its OWN separator or the enclosing
         *    delimiter (`orSentinel`); a separator-less one to the inherited
         *    sentinel alone.
         *  - the separator-less path rolls leading trivia back BEFORE recovering
         *    and the separated path does NOT — a consumed separator and the error
         *    after it both belong to the list (repeat.ts:533). This is why the
         *    strict loop's unconditional `${'${rb}'}` could not simply be reused.
         *
         * `mySync` IS CAPTURED AT ENTRY, not read per item: an element's own
         * sequence publishes over `_sync` while it runs. The interpreter restores
         * in a `finally`, codegen saves at entry — same value, and so does this.
         */
        const my = `${p}my`
        // `reportItem` gates the FAILURE report only. `recoverScan`'s expected set
        // is taken unconditionally by the closure engine (`assemble.ts:2067`), so
        // it is resolved separately from `itemFx` — reusing that one would hand
        // `EMPTY_FX` to every recovered error in a grammar that does not report.
        const recFx = REC ? fxRef(code[ip + 6]!) : ''
        const sepSent = REC ? sentRef(code[ip + 7]!) : 'undefined'
        const recSent = sep === undefined
          ? my
          : sepSent === 'undefined'
            ? `orSentinel(${my},undefined)`
            : `orSentinel(${sepSent}??${my},${sepSent}===undefined?undefined:${my})`
        const recGate = sep !== undefined || min === 0 ? '' : `count>=${min}&&`
        const recBranch = !REC ? '' : `if(ctx._tolerant===true&&${my}!==undefined&&${recGate}!matchesAt(${my},input,itemStart,ctx)){
${sep === undefined ? `${rb}\n` : ''}const rr=recoverScan(input,itemStart,ctx,${recSent},${recFx})
${collect ? 'out.push(rr.error)\n' : ''}captureError(ctx,rr.error)
count++
cur=rr.end
continue
}
`
        return `${head}
const out=${collect ? '[]' : 'undefined'}
${knownTrivia === undefined ? 'const hasTrivia=ctx.trivia!==undefined\n' : ''}${L.buf ? '' : 'const needMark=_rollbackNeeded(ctx)\n'}${REC ? `const ${my}=ctx._sync\n` : ''}${itemCls === undefined ? '' : `const ${p}gate=ctx._probe===undefined\n`}let cur=pos
let count=0
for(;;){
${max >= 0 ? `if(count>=${max})break\n` : ''}${sep !== undefined ? `if(count>0&&count>=${min}&&cur>=input.length)break\n` : ''}${itemCls !== undefined && sep === undefined ? `if(count>=${min}&&${p}gate&&${hasTrivia === 'false' ? 'true' : hasTrivia === 'true' ? 'false' : '!hasTrivia'}&&!classHas(${itemCls},lead(input,cur)))break\n` : ''}let ${p}raw=0,${p}tl=0,${p}lv=0,${p}lg=0,${p}rt=0${sinks.fd ? `,${p}fd=0` : ''}${sinks.er ? `,${p}er=0` : ''}
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
${keepSeparators ? '' : 'demoteCapturedToRaw(ctx,lb)\n'}sepEnd=EC.e
itemStart=${hasTrivia === 'false' ? 'EC.e' : hasTrivia === 'true' ? `${skip}(input,EC.e,ctx)` : `hasTrivia?${skip}(input,EC.e,ctx):EC.e`}
}else ${leadSkip(hasTrivia, leadTrivia, skip)}
` : `${leadSkip(hasTrivia, leadTrivia, skip)}
`}if(itemStart>=input.length&&${via}){
${rb}
${trailingAllowed ? 'if(sepEnd>=0)cur=sepEnd\n' : ''}break
}
${itemCls === undefined ? '' : `if(count>=${min}&&${p}gate&&!classHas(${itemCls},lead(input,itemStart))){
${rb}
${trailingAllowed ? 'if(sepEnd>=0)cur=sepEnd\n' : ''}break
}
`}ctx._fc=false
const v=${child}(input,itemStart,ctx)
if(v===FAIL){
${REC
  // THE ROLLBACK MOVES INSIDE THE ARMS. The strict loop rolls back
  // unconditionally before testing `_fc`, which is sound because every path out
  // of it rolls back. The recovery arm is the one path that must NOT: a
  // separated list keeps the consumed separator and the trivia after it, both of
  // which belong to the list (repeat.ts:533). So `committed` is tested first and
  // each arm takes its own rollback — the same order as `assemble.ts:2113`.
  ? `if(ctx._fc===true){
${rb}
return FAIL
}
${recBranch}${rb}`
  : `${rb}
if(ctx._fc===true)return FAIL`}
${trailingAllowed ? 'if(sepEnd>=0)cur=sepEnd\n' : ''}break
}
if(EC.e===itemStart&&${via}){
${rb}
break
}
${collect ? 'out.push(v)\n' : ''}cur=EC.e
count++
}
${min > 0 ? `if(count<${min}){
${reportItem ? `ctx._fe=cur;ctx._fx=${itemFx}\n` : ''}return FAIL
}
` : ''}EC.e=cur
return out
}`
      }

      case OP_NODE:
      case OP_NODE_TRACK: {
        const flags = code[ip + 3]!
        const scalarChild = scalarTerminalNodeChild(code, ip)
        if (scalarChild >= 0 && scalarSpecs.has(code[scalarChild + 1]!)) {
          const recognize = recognizerRef(code[scalarChild + 1]!)
          const spec = code[scalarChild] === OP_RX ? null : k[code[scalarChild + 1]!] as string
          const value = spec === null ? 'input.slice(pos,end)' : q(spec)
          const xf = fxRef(code[scalarChild + 2]!)
          const build = fnRef(code[ip + 1]!)
          return `${head}
const end=${recognize}(input,pos)
if(end<0){ctx._fe=pos;ctx._fx=${xf};return FAIL}
const value=${value}
const leaf={_tag:'leaf',value,span:{start:pos,end}}
const kids=[leaf],rawKids=[leaf],span={start:pos,end}
EC.e=end
const nd=${build}(kids,undefined,span,rawKids,EMPTY_TL,undefined)
${L.buf && L.raw === RAW_OMIT
  ? '_pushNodeNoRawBuf(ctx,nd)'
  : L.buf && L.raw === RAW_CAPTURE
    ? 'pushCstChild(ctx,nd,rawEntry(nd,input,pos,end))'
  : staticBuild
    ? 'if(ctx._cstBuf!==undefined||ctx._cstChildren!==undefined)pushCstChild(ctx,nd,ctx._cstBuf!==undefined&&ctx._cstBuf.noRaw===true?undefined:ctx._cstBuf!==undefined||ctx._cstRawChildren!==undefined?rawEntry(nd,input,pos,end):undefined)'
    : 'if(ctx._cstBuf!==undefined||ctx._cstChildren!==undefined)pushCstChild(ctx,nd,rawEntry(nd,input,pos,end))'}
EC.e=end
return nd
}`
        }
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
        const build = buildIdx >= 0 ? fnRef(buildIdx) : undefined
        // The closure assembler's direct-builder capture tiers are table facts,
        // not closure-only semantics. Print the same body for a precompiled
        // assembly so a large composeLeaf artifact does not fall back to opening
        // the generic raw/trivia buffer that its reducer arity proved unread.
        if (!hostCst && !tracked && build !== undefined && proj < 0
          && (flags === 2 || flags === 18 || flags === 34)) {
          const fields = flags === 18
          const collapseChildren = flags === 34
          const publish = L.buf && L.raw === RAW_OMIT
            ? '_pushNodeNoRawBuf(ctx,nd)'
            : L.buf && L.raw === RAW_CAPTURE ? `if(sBuf!==undefined){
if(sBuf.rawOnly!==true){
if(sBuf.ch!==undefined)sBuf.ch.push(nd)
else if(sBuf.single!==undefined){sBuf.ch=[sBuf.single,nd];sBuf.single=undefined}
else sBuf.single=nd
}
const rawNd=rawEntry(nd,input,pos,end)
if(sBuf.raw!==undefined)sBuf.raw.push(rawNd)
else if(sBuf.rawSingle!==undefined){sBuf.raw=[sBuf.rawSingle,rawNd];sBuf.rawSingle=undefined}
else sBuf.rawSingle=rawNd
}else if(sCh!==undefined){
sCh.push(nd)
if(sRaw!==undefined)sRaw.push(rawEntry(nd,input,pos,end))
}` : `if(sBuf!==undefined){
if(sBuf.noRaw===true)_pushNodeNoRawBuf(ctx,nd)
else{
if(sBuf.rawOnly!==true){
if(sBuf.ch!==undefined)sBuf.ch.push(nd)
else if(sBuf.single!==undefined){sBuf.ch=[sBuf.single,nd];sBuf.single=undefined}
else sBuf.single=nd
}
const rawNd=rawEntry(nd,input,pos,end)
if(sBuf.raw!==undefined)sBuf.raw.push(rawNd)
else if(sBuf.rawSingle!==undefined){sBuf.raw=[sBuf.rawSingle,rawNd];sBuf.rawSingle=undefined}
else sBuf.rawSingle=rawNd
}
}else if(sCh!==undefined){
sCh.push(nd)
if(sRaw!==undefined)sRaw.push(rawEntry(nd,input,pos,end))
}`
          return `${head}
const sCh=ctx._cstChildren,sLv=ctx._cstLeaves,sRaw=ctx._cstRawChildren,sTl=ctx._cstTriviaLog
const sCap=ctx.captureTrivia,sBuf=ctx._cstBuf,sFields=ctx._fields
const flat=[]
ctx._cstBuf=undefined
ctx._cstChildren=flat
ctx._cstLeaves=flat
ctx._cstRawChildren=undefined
ctx._cstTriviaLog=undefined
ctx.captureTrivia=false
ctx._fields=${fields ? '[]' : 'undefined'}
const v=${child}(input,pos,ctx)
const captured=_capturedFlatChildren(flat)
${fields ? 'const fieldMap=buildFieldMap(ctx._fields)\n' : ''}ctx._fields=sFields
ctx._cstBuf=sBuf
ctx._cstChildren=sCh
ctx._cstLeaves=sLv
ctx._cstRawChildren=sRaw
ctx._cstTriviaLog=sTl
ctx.captureTrivia=sCap
if(v===FAIL)return FAIL
const end=EC.e
${collapseChildren
    ? `const nd=captured.length===1?captured[0]:${build}(captured,undefined,{start:pos,end},EMPTY_CH,EMPTY_TL,undefined)`
    : `const nd=${build}(captured,${fields ? 'fieldMap' : 'undefined'},{start:pos,end},EMPTY_CH,EMPTY_TL,undefined)`}
${publish}
EC.e=end
return nd
}`
        }
        const structural = build === undefined && proj < 0
        const grammarCapture = (flags & 1) !== 0 || trailingTrivia
        const hostCapturesThisType = structural && cfg.hostCaptureTrivia !== undefined
          ? cfg.hostCaptureTrivia(type)
          : undefined
        const wantFields = hasFields || hostCst
        const captureWide = readsTrivia || hostCst
          ? !structural || grammarCapture || hostCapturesThisType !== false
          : hostCapturesThisType === true
        const keepChildren = !structural || cfg.hostReadsChildren !== false || collapse || unwrap
        const omitsRaw = !hostCst && build !== undefined && proj < 0 && (flags & 2) !== 0
        const ty = q(type)
        const stArg = readsState ? 'st' : '(ctx.state!==undefined?Object.assign({},ctx.state):undefined)'
        const hostCall = `_pfHost(${ty},hostKids,fieldMap,span,rawKids,tlog,${stArg},${tags})`
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
          value = `nd=_pfHost!==undefined?_pfHost(${ty},hostKids,fieldMap,span,rawKids,tlog,st,${tags}):{_tag:'node',type:${ty},span,state:st??null,children:kids}`
        }
        // HOST COLLAPSE applies wherever the node's VALUE comes from the host —
        // any node under a CST host, not only the builder-less ones.
        const collapsible = keepChildren && (hostCst || (build === undefined && proj < 0))
        const openCapture = omitsRaw
          ? `const buf={noRaw:true,rawLen:0}
ctx._cstBuf=buf
ctx._cstChildren=undefined
ctx._cstLeaves=undefined
ctx._cstRawChildren=undefined
ctx._cstTriviaLog=undefined`
          : keepChildren
          ? `const buf={}
ctx._cstBuf=buf
ctx._cstChildren=undefined
ctx._cstLeaves=undefined
ctx._cstRawChildren=undefined
ctx._cstTriviaLog=undefined`
          : `const buf={rawOnly:true}
ctx._cstBuf=buf
ctx._cstChildren=undefined
ctx._cstLeaves=undefined
ctx._cstRawChildren=undefined
ctx._cstTriviaLog=undefined`
        const finishCapture = omitsRaw
          ? `const kids=buf.ch??(buf.single!==undefined?[buf.single]:EMPTY_CH)
const hostKids=kids
const rawKids=EMPTY_CH
const tlog=buf.tl??EMPTY_TLOG`
          : keepChildren
          ? `const kids=buf.ch??(buf.single!==undefined?[buf.single]:EMPTY_CH)
const hostKids=kids
const rawKids=buf.raw??(buf.rawSingle!==undefined?[buf.rawSingle]:EMPTY_CH)
const tlog=buf.tl??EMPTY_TLOG`
          : `const kids=EMPTY_CH
const hostKids=kids
const rawKids=buf.raw??(buf.rawSingle!==undefined?[buf.rawSingle]:EMPTY_CH)
const tlog=buf.tl??EMPTY_TLOG`
        return `${head}
const sCh=ctx._cstChildren,sLv=ctx._cstLeaves,sRaw=ctx._cstRawChildren,sTl=ctx._cstTriviaLog
const sCap=ctx.captureTrivia,sBuf=ctx._cstBuf
${openCapture}
ctx.captureTrivia=${captureWide}
const savedFields=ctx._fields
ctx._fields=${wantFields ? '[]' : 'undefined'}
${structural ? `const savedMask=ctx._triviaCaptureMask
if(_pfHost!==undefined&&_pfHost._parsemanTriviaKinds!==undefined)ctx._triviaCaptureMask=_pfHost._parsemanTriviaKinds(${ty})
` : ''}const v=${child}(input,pos,ctx)
${trailingTrivia && L.tri !== TRI_NONE
  ? `if(v!==FAIL${L.tri === TRI_UNKNOWN ? '&&ctx.trivia!==undefined' : ''})EC.e=consumeTrivia(input,EC.e,ctx)\n`
  : ''}const fieldMap=${wantFields ? 'buildFieldMap(ctx._fields)' : 'undefined'}
ctx._fields=savedFields
${structural ? 'ctx._triviaCaptureMask=savedMask\n' : ''}${finishCapture}
ctx._cstBuf=sBuf
ctx._cstChildren=sCh
ctx._cstLeaves=sLv
ctx._cstRawChildren=sRaw
ctx._cstTriviaLog=sTl
ctx.captureTrivia=sCap
if(v===FAIL)return FAIL
const end=EC.e
const span=${tracked ? 'spanLines(ctx,pos,end)' : '{start:pos,end}'}
const st=${readsState ? '(ctx.state!==undefined?Object.assign({},ctx.state):undefined)' : 'undefined'}
let nd
${unwrap ? 'if(kids.length===1)nd=unwrapChild(kids[0])\nelse ' : ''}${collapse ? 'if(kids.length===1)nd=kids[0]\nelse ' : ''}${collapsible ? `if(_pfHost!==undefined&&_pfHost._parsemanCstCollapse!==undefined&&kids.length===1&&rawKids.length===1&&_pfHost._parsemanCstCollapse(${ty},kids[0],kids,rawKids))nd=kids[0]
else ` : ''}{${value}}
${L.buf && L.raw === RAW_OMIT
  ? '_pushNodeNoRawBuf(ctx,nd)'
  : L.buf && L.raw === RAW_CAPTURE
  // The OUTER buffer, which this body saved into `sBuf` before opening its own —
  // so an in-node site's parent collector is present by the same fact.
  ? 'pushCstChild(ctx,nd,rawEntry(nd,input,pos,end))'
  : staticBuild
    ? 'if(sBuf!==undefined||sCh!==undefined)pushCstChild(ctx,nd,sBuf!==undefined?(sBuf.noRaw===true?undefined:rawEntry(nd,input,pos,end)):sRaw!==undefined?rawEntry(nd,input,pos,end):undefined)'
    : 'if(sBuf!==undefined||sCh!==undefined)pushCstChild(ctx,nd,rawEntry(nd,input,pos,end))'}
EC.e=end
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
  const source = `${RUNTIME_PRELUDE}${needsNoRawPrelude ? NO_RAW_RUNTIME_PRELUDE : ''}
${prelude.join('\n')}
${skipDefs.join('\n')}
${choiceDefs.join('\n')}
${bodies.join('\n')}
function _begin(ctx){
const host=ctx.build
if(_pfDepth>0)_pfFrames.push([_pfScan,_pfHost,EC.e])
_pfDepth++
_pfScan=null
_pfHost=host
}
function _finish(){
if(_pfDepth<=0)throw new Error('parseman emitted table assembly frame underflow')
_pfDepth--
if(_pfDepth===0){
_pfTokInput=undefined
_pfTokBody=-1
_pfTokValue=undefined
_pfTokDispatch=-1
return
}
const prior=_pfFrames.pop()
_pfScan=prior[0]
_pfHost=prior[1]
EC.e=prior[2]
}
return{
pieces:{${ruleEntries.join(',')}},
byIp:{${extra.join(',')}},
end:function(){return EC.e},
begin:_begin,
finish:_finish
}`

  return {
    source, reached, masks, classes, armExpected,
    plan: { classes: classPlan, armExpected: armExpectedPlan, masks: maskPlan },
  }
}
