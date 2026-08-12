import type { AutoNotCheck, Combinator, FirstSet, ParserDef } from '../types.ts'
import { firstSetOf, matchesEmpty, union, type RefResolver } from '../combinators/first-set.ts'
import { childrenOf } from '../analysis/gating.ts'
import { getCoreLiteralValue } from '../combinators/choice.ts'
import { deriveExpected } from '../combinators/expect.ts'
import { buildReadsState, buildReadsTrivia } from '../compiler/build-arity.ts'
import { buildReadsFields, parserHasOwnFields } from '../compiler/fields.ts'
import { asciiFoldKey, branchUsesRouted, parserUsesRouted } from '../combinators/dispatch.ts'
import {
  OP_CHOICE, OP_EMPTY, OP_GATE, OP_LEAF, OP_LIT, OP_NODE, OP_NOT, OP_OPT,
  OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX, OP_SEQ, OP_SEQV, OP_XFORM,
  OP_LIT_TRACK, OP_RX_TRACK, OP_NODE_TRACK, OP_SCOPE, OP_SCOPE_CAP, OP_SCOPE_PLAIN, OP_EXPECT, OP_SEQX, OP_SCAN,
  OP_LIVE, OP_ATTEMPT, OP_LABEL,
  OP_FIELD, OP_DISPATCH, OP_ROUTED, OP_LIT_CI, OP_LIT_CI_TRACK, OP_TOKEN, OP_WITHCTX, OP_GUARD,
  OP_ADJ, OP_GREEDY, OP_REJECT, OP_ARMGATE, OP_COV,
} from './ops.ts'
import { adjacencyExpected } from '../combinators/adjacency.ts'
import { resolveAdjacencyKindMask } from '../cst/trivia-kinds.ts'
import { missingInferredType } from '../combinators/node.ts'
import { hasOwnTriviaBoundary } from '../combinators/trivia-boundary.ts'
import type { BalancedSpec } from '../combinators/scanTo.ts'
import type { DispatchSpec, ScanSpec, SubtreeRef, TableProgram, TriviaSpec } from './program.ts'
import { covKindCode, encodeClassSpec, ownTableProgram } from './program.ts'
import type { GrammarCoveragePlan } from '../compiler/grammar-coverage-ids.ts'

/**
 * Can `emitConst` print this? Mirrors the guard in `emit.ts` — scalars, arrays
 * of scalars, and plain objects of those. Kept as a predicate here so the
 * encoder can record a NAMED runtime-only reason instead of letting the printer
 * throw a bare TypeError at emit time.
 */
function emittableConst(v: unknown): boolean {
  const scalar = (x: unknown): boolean =>
    x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'
  if (scalar(v) || v instanceof RegExp) return true
  if (Array.isArray(v)) return v.every(scalar)
  if (typeof v === 'object' && v !== null) {
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(v).every(x => scalar(x) || (Array.isArray(x) && x.every(scalar)))
  }
  return false
}

/**
 * Does the rule-map entry `winner` bottom out AT the reference `p`?
 *
 * The question `Encoder.winners` has to ask before resolving a `g.X` by name. A
 * map entry that IS the reference — directly, or under the scope wrappers that
 * `rules()` puts there — is not an override to resolve to; it is the reference's
 * own binding, and the only thing that reaches the rule's BODY from there is the
 * ref's thunk. Resolving by name instead hands back the row already in flight for
 * that entry, which is an alias cycle rather than a parser (see `winners`).
 *
 * ONLY WRAPPERS `rules()` ITSELF INTRODUCES are unwrapped — `parser()`/`noTrivia`
 * scopes (`grammar`) and `trivia()`. Both are single-child and both can encode to
 * NO ROW, which is what makes the cycle degenerate. Walking further, into a
 * `seq()` or a `choice()` arm, would answer a different question: a rule whose
 * body legitimately contains a reference to itself is ordinary recursion and must
 * keep resolving by name.
 */
function wrapsRef(winner: Combinator<unknown>, p: Combinator<unknown>): boolean {
  let cur = winner
  // Bounded rather than `while (true)`: `_def.parser` is author-supplied and a
  // hand-built cycle of scopes would otherwise hang the encoder. Nothing legal
  // nests these more than a couple deep.
  for (let n = 0; n < 16; n++) {
    if (cur === p) return true
    const d = cur._def as ParserDef
    if (d.tag !== 'grammar' && d.tag !== 'trivia') return false
    cur = d.parser
  }
  return false
}

/** Raised when a construct has no opcode yet. Prototype scope is explicit. */
export class UnsupportedConstruct extends Error {
  readonly tag: string
  constructor(tag: string) { super(`table lowering: no opcode for '${tag}'`); this.tag = tag }
}

/** Settings that select the TABLE'S CONTENTS. They never reach the driver. */
export type TableSettings = {
  readonly hostMode?: 'ast' | 'cst'
  readonly trackLines?: boolean
  /**
   * ACCEPTED AND IGNORED. RECOVERY IS ALWAYS LOWERED (owner ruling).
   *
   * It used to be opt-in because the sync sentinel a list resyncs to is derived
   * from grammar structure and so has to be known before the table exists — a
   * BUILD setting for the same reason `hostMode` is. The consequence was a
   * `CompiledParser` whose `parseWithErrors()` THREW unless the caller had
   * happened to pass a flag `compile()` does not require, which is a contract
   * break against the source lowering, not a trade.
   *
   * The cost of always lowering it is the extra rows, measured on the emitted
   * module: json 1,081 → 1,214 B (+12.3%), graphql 2,925 → 3,397 B (+16.1%).
   * Against codegen's 15,138 B for the same json root the table is still ~12×
   * smaller, so the size argument for making it optional no longer holds.
   *
   * LOWERING RECOVERY IS NOT RUNNING IT. Every recovery path stays gated on
   * `ctx._tolerant` — the same dormancy the source lowering emits
   * (`codegen.ts:3153`) and the interpreter tests (`repeat.ts:163`) — so a strict
   * parse is strict, and `test/parity/table-recovery-always.test.ts` pins that.
   *
   * The field is kept rather than deleted so `compile` stays signature-
   * compatible with `compile()`, whose `{ recovery: true }` is real. Passing it
   * is harmless; passing `false` does NOT switch recovery off, and saying so here
   * is the point — a setting that silently means nothing is the defect class this
   * project keeps finding.
   */
  readonly recovery?: boolean
  /**
   * THE COVERAGE PLAN, when this table is being encoded for grammar coverage.
   *
   * Its maps are keyed by COMBINATOR IDENTITY, which is what makes threading the
   * plan through the encoder exact: at the moment a choice, dispatch, label or
   * rule body is laid down, the combinator being encoded IS the key, so no code
   * offset has to be matched back to a structural path after the fact. `OP_COV`
   * rows go in beside those sites and the plan's definitions become `prog.cov`.
   *
   * A plan is a BUILD input for the same reason `hostMode` is: the rows either
   * exist in the table or they do not, and no per-parse flag can conjure them.
   * Which of the resulting assemblies actually counts is the separate,
   * assembly-selected question `RunCfg.coverage` answers.
   */
  readonly coverage?: GrammarCoveragePlan
}

type Emitted = { readonly ip: number }


class Encoder {
  code: number[] = []
  k: unknown[] = []
  fns: unknown[] = []
  /**
   * SOURCE TEXT per `fns` entry, or `null` where the author's callback reached
   * the encoder as a live closure with no source (the runtime path).
   *
   * Parallel to `fns`, in the same order, because that is the order the emitters
   * print `f:[…]` in. Without it a macro build has no way to print an author
   * reducer at all: `emitTableModule` falls back to `() => {}` per entry, which
   * produces a module that LOADS and returns the wrong tree — the exact class of
   * failure that a `null` return from `compileRuleMap` (its `mfCovered &&
   * buildCovered` gate) exists to prevent on the source-lowering side. The table
   * counterpart cannot honour that same all-or-nothing contract without this.
   *
   * NOT part of `TableProgram`: it is build-time metadata for the printer, never
   * data the driver reads, and it must not travel in an emitted artifact.
   */
  fnSrcs: (string | null)[] = []
  cc: string[] = []
  fx: (readonly string[])[] = []
  disp: (readonly number[])[] = []
  dsp: DispatchSpec[] = []
  labels: readonly string[] | undefined = undefined
  /** Trivia table in scope at the row being encoded — codegen's `ctx.activeTrivia`. */
  activeTrivia: Combinator<unknown> | undefined = undefined
  classified = false
  scans: ScanSpec[] = []
  /** Ambient `scanSkip` sets, pooled by the ARRAY's identity (stable per grammar). */
  scanSkipSets: (readonly SubtreeRef[])[] = []
  private scanSkipIndex = new Map<readonly Combinator<unknown>[], number>()
  /** Per rule, in `rules` order: which pooled set its entry installs, or −1. */
  scanSkipOf: number[] = []
  /** Reasons this program can RUN but not be EMITTED. */
  runtimeOnly = new Set<string>()
  /**
   * The rule map being encoded, so a named reference resolves BY NAME.
   *
   * This is what makes a MERGED rule map — the shape composition produces, where
   * a later piece overrides an earlier piece's rule — encode to the parser
   * `compose()` means. Without it `case 'lazy'` resolves a reference by calling
   * its thunk, and a thunk closes over the piece that DEFINED the reference: a
   * base piece's internal `g.Atom` keeps reaching the base's own `Atom` even
   * after the merged map binds that name to an override. The encode succeeds,
   * the table parses, and it silently returns the base's tree — open recursion,
   * which `compose()` is largely FOR, quietly absent.
   *
   * The source lowering never had this problem because it compiles every rule to
   * a canonical `_r_<Name>` and fusion drops them into one scope, so a reference
   * resolves by name for free (`compiler/linker.ts:1`). The table has no shared
   * scope, so the name lookup has to be explicit and is done here.
   *
   * For a NON-merged map this is a no-op: the name resolves to the same
   * combinator the thunk returns. The self-resolution guard is load-bearing — a
   * rule map entry may BE the named lazy proxy for its own body, and resolving
   * that to itself would return the in-progress memoized row and never encode
   * the body at all.
   *
   * THAT GUARD CANNOT BE OBJECT IDENTITY. `rules({ trackLines: true }, …)`
   * REPLACES every map entry with `parser({ trackLines: true }, entry)` carrying
   * the SAME `_ruleName` (`combinators/parser.ts:228-241`), so for all four
   * `*PositionsGrammar` exports the entry is a WRAPPER around the rule's own lazy
   * proxy. `winner !== p` is then trivially true, the proxy resolves by name to
   * the wrapper that is already in flight, `node()` hands back the recursion
   * trampoline, and `case 'grammar'` — a `parser()` scope with no trivia, no
   * capture and no root policy emits NO ROW — passes that trampoline straight out
   * as the wrapper's own offset. The trampoline is patched to itself, the rule's
   * real body is never encoded, and every parse dies on its first byte with
   * `Maximum call stack size exceeded`: 87/87 css, 314/314 less, 24/24 jess and
   * 2408/2408 scss files, all four `-lines` variants, from `dccb7fa` (which added
   * this map) to `90aa867`. So the question is not "is the winner this object"
   * but "does the winner bottom out AT this reference", and `wrapsRef` asks that.
   */
  winners: Readonly<Record<string, Combinator<unknown>>> | undefined = undefined
  triviaSpecs: TriviaSpec[] = []
  private triviaIndex = new Map<Combinator<unknown>, number>()

  /**
   * A trivia combinator as DATA where its shape allows.
   *
   * `classifiedTrivia()` builds exactly `trivia(oneOrMore(choice(label(name,
   * arm)…)))` (src/combinators/map.ts) and the four shipping grammars give it
   * regex arms, so the whole thing round-trips through `[label, source, flags]`
   * triples. Anything else is kept LIVE and recorded, so the program runs and
   * emit refuses by name.
   */
  private triviaSlot(t: Combinator<unknown>): number {
    const hit = this.triviaIndex.get(t)
    if (hit !== undefined) return hit
    const idx = this.triviaSpecs.length
    this.triviaIndex.set(t, idx)
    this.triviaSpecs.push(this.triviaSpecOf(t))
    return idx
  }

  private triviaSpecOf(t: Combinator<unknown>): TriviaSpec {
    const unlowered = (why: string): TriviaSpec => {
      this.runtimeOnly.add(`rules({ trivia }) — ${why}`)
      return { arms: [], live: t }
    }
    const d = t._def
    // THE `trivia()` WRAPPER IS A MARKER, NOT THE SHAPE. It sets `_meta.isTrivia`
    // and delegates; `parser({ trivia })` / `rules({ trivia })` store whatever they
    // are handed verbatim (`combinators/grammar.ts:71`), and the only consumers —
    // `advanceTrivia` / `scanTrivia` — read `span.end` off it without ever looking
    // at the tag. So demanding the wrapper refused grammars every other engine runs:
    // `parser({ trivia: regex(/ +/) })` is ordinary authoring and it fell all the way
    // back to the interpreter, silently, with the parseman import still in place.
    // Unwrap it WHEN PRESENT and classify the body either way.
    let inner = d.tag === 'trivia' ? d.parser._def : d
    // A `transform()` over a trivia body is a VALUE map, and a trivia VALUE is
    // never observed by anything: `advanceTrivia` and `scanTrivia`
    // (combinators/trivia-skip.ts:189, :219) are the only consumers of `ctx.trivia`
    // and both read `span.end` alone — the parsed value is dropped on every path.
    // So the wrapper is UNWRAPPED rather than refused. This is not "close enough":
    // the recognition it wraps is the entire observable contract of trivia, and
    // dropping a reducer whose result provably cannot escape loses nothing.
    // (`examples/json/jsonc.ts` writes exactly `transform(many(…), () => '')`.)
    while (inner.tag === 'transform') inner = inner.parser._def
    if (inner.tag === 'regex') return { arms: [], plain: [inner.source, inner.flags] }
    // The repetition around the alternation. `oneOrMore` is the tag min>=1 always
    // carries (repeat.ts:201) and `many` is the nullable min-0 loop; both lower,
    // and the floor travels in the spec so the rebuild is the same combinator
    // rather than a same-shaped one. A BOUNDED repeat does not lower — `max` has
    // nowhere to go in the spec and silently unbounding it would accept input the
    // grammar rejects.
    if (inner.tag !== 'oneOrMore' && inner.tag !== 'many') {
      return unlowered(`unrecognised trivia body '${inner.tag}'`)
    }
    if (inner.max !== undefined) {
      return unlowered(`trivia body is a BOUNDED repeat (max ${inner.max}), which the spec cannot carry`)
    }
    const min = inner.min
    const rep = inner.parser._def
    // A single un-alternated body (`trivia(many(regex))`) is the one-arm case.
    const parsers = rep.tag === 'choice' ? rep.parsers : [inner.parser]
    // Two shapes, and an arm set must be wholly one or the other. LABELLED is
    // `classifiedTrivia()`'s exact output. UNLABELLED is the plain
    // `trivia(oneOrMore(choice(ws, comment)))` that `examples/css/parser.ts`
    // writes and that had no lowering at all. Mixing them is refused rather than
    // half-labelled: `classifiedTrivia` requires a label per arm, so there is no
    // rebuild that keeps both, and inventing labels would put names in the CST
    // trivia log that the grammar never wrote.
    const labelled: Array<readonly [string, string, string]> = []
    const bare: Array<readonly [string, string]> = []
    for (const arm of parsers) {
      const a = arm._def
      if (a.tag === 'regex') {
        bare.push([a.source, a.flags])
        continue
      }
      if (a.tag !== 'label') return unlowered(`trivia arm is '${a.tag}', not a labelled arm or a regex`)
      const body = a.parser._def
      if (body.tag !== 'regex') return unlowered(`trivia arm ${JSON.stringify(a.label)} is '${body.tag}', not a regex`)
      labelled.push([a.label, body.source, body.flags])
    }
    if (labelled.length > 0 && bare.length > 0) {
      return unlowered('trivia arms are a MIX of labelled and bare regexes, which has no single rebuild')
    }
    if (labelled.length > 0) {
      // `classifiedTrivia()` builds min-1 by construction, so a min-0 labelled
      // body cannot be rebuilt through it and is not quietly promoted.
      if (min !== 1) return unlowered(`labelled trivia arms need a min-1 repeat, got min ${min}`)
      return { arms: labelled }
    }
    return { arms: [], alts: bare, min }
  }
  rules: Record<string, number> = {}

  /**
   * THE COVERAGE DEFINITION POOL, in `plan.definitions` order, or `undefined`
   * when this is an ordinary encode. Ordinary is the default and it must stay
   * byte-for-byte the table it always was, so every coverage member is absent —
   * not empty — unless a plan was passed.
   */
  private readonly cov: (readonly [string, 0 | 1 | 2 | 3])[] | undefined
  private readonly covIndex: ReadonlyMap<string, number>
  readonly plan: GrammarCoveragePlan | undefined

  /**
   * Wrap one site in its counter row.
   *
   * `id` comes from the plan and is therefore already a definition; an id the
   * pool does not know is a plan/encoder disagreement and is refused rather than
   * appended, because a hit on an id outside the denominator is a hit the
   * collector silently drops (`createGrammarCoverageCollector.hit` tests `known`)
   * — a site that reads as instrumented and counts nothing.
   */
  private covWrap(child: number, id: string | undefined, on: 0 | 1): number {
    if (id === undefined || this.cov === undefined) return child
    const slot = this.covIndex.get(id)
    if (slot === undefined) {
      throw new UnsupportedConstruct(`coverage(id ${JSON.stringify(id)} is not in the plan's definitions)`)
    }
    return this.emit(OP_COV, child, slot, on)
  }

  private kIndex = new Map<unknown, number>()
  private ccIndex = new Map<string, number>()
  private fxIndex = new Map<string, number>()
  /** Memoized by combinator identity: a shared sub-combinator is ONE row. */
  memo = new Map<Combinator<unknown>, number>()
  /**
   * Memo for `lazy` REFERENCES, keyed by the trivia scope the reference is made
   * from. A cross-rule reference's row depends on that scope (`scopedRef`), so the
   * single `memo` slot every other construct uses would freeze the FIRST
   * reference's scope onto every later one and undo the fix.
   */
  refMemo = new Map<Combinator<unknown>, Map<Combinator<unknown> | undefined, number>>()
  pending = new Map<Combinator<unknown>, number[]>()

  readonly settings: TableSettings
  /** Resolved once, HERE, at table-build time — never consulted at run time. */
  readonly track: boolean
  /**
   * Decides the extra operands laid down below. ALWAYS TRUE — see
   * `TableSettings.recovery`. Kept as a field rather than folded away because it
   * is what every emit site reads, and the emit sites are where the shape of the
   * row is stated.
   */
  readonly rec: boolean
  constructor(settings: TableSettings) {
    this.settings = settings
    this.track = settings.trackLines === true
    this.rec = true
    this.plan = settings.coverage
    this.cov = settings.coverage === undefined
      ? undefined
      : settings.coverage.definitions.map(d => [d.id, covKindCode(d.kind)] as const)
    this.covIndex = new Map((this.cov ?? []).map((d, i) => [d[0], i]))
  }

  /**
   * The class of the follow set of term `i` in a sequence — the sync sentinel a
   * list nested in that term resyncs to, INFERRED from structure exactly as
   * `sequence()` (combinators/sequence.ts:58) and `emitSeqValues`
   * (compiler/codegen.ts:1756) infer it: the union of every LATER term's first
   * set, not merely up to the first non-nullable one, so a mandatory middle term
   * cannot hide a later close. −1 where there is no usable sentinel, which is the
   * same set of cases `firstSetSentinel` answers `null` for.
   */
  private followClass(parsers: readonly Combinator<unknown>[], i: number): number {
    let fs: FirstSet = { kind: 'empty' }
    const rr = this.refResolver()
    for (let j = i + 1; j < parsers.length; j++) fs = union(fs, firstSetOf(parsers[j]!, new Set(), rr))
    return this.charClass(fs)
  }

  private constant(v: unknown): number {
    const key = v instanceof RegExp ? `re:${JSON.stringify([v.source, v.flags])}` : v
    const hit = this.kIndex.get(key)
    if (hit !== undefined) return hit
    const i = this.k.length
    this.k.push(v)
    this.kIndex.set(key, i)
    return i
  }

  /**
   * A `notAdjacent({ kinds })` filter, pooled by its CONTENTS.
   *
   * `constant()` keys an array by identity, and every `notAdjacent()` call
   * builds a fresh one — so `calc()`'s four `{ kinds: ['whitespace'] }` sites
   * would each park an identical array in the pool.
   */
  private kindsIndex = new Map<string, number>()
  private kindsSlot(kinds: readonly string[]): number {
    const key = JSON.stringify(kinds)
    const hit = this.kindsIndex.get(key)
    if (hit !== undefined) return hit
    const i = this.k.length
    this.k.push([...kinds])
    this.kindsIndex.set(key, i)
    return i
  }

  /**
   * Park an author callback, WITH its source when the caller has it.
   *
   * `src` is required at every call site rather than optional so that adding a
   * new `fn()`-bearing lowering forces a decision about its source instead of
   * silently defaulting to "unprintable" — which reads as a working encode and
   * emits a `() => {}` placeholder downstream.
   */
  private fn(v: unknown, src: string | null): number {
    const i = this.fns.length
    this.fns.push(v)
    this.fnSrcs.push(src)
    return i
  }

  private expected(list: readonly string[]): number {
    const key = JSON.stringify(list)
    const hit = this.fxIndex.get(key)
    if (hit !== undefined) return hit
    const i = this.fx.length
    this.fx.push(list)
    this.fxIndex.set(key, i)
    return i
  }

  /**
   * THE GATING ANALYSIS'S VIEW OF A CROSS-PIECE HOLE — `winners`, the same map
   * emission already resolves those holes against.
   *
   * `firstSetOf` and `matchesEmpty` degrade a `lazy` whose thunk THROWS to `any`
   * / nullable. A grammar loaded at runtime never hits that: `composeLeaf` binds
   * every `g.X` before the encoder sees the map, so the thunks resolve. A grammar
   * lowered by the MACRO does hit it — `plugin/evaluator.ts` mints an
   * `externalRefs` slot for any `g.X` this `rules()` call does not itself define
   * and never `.define()`s it, because the definition lives in another piece and
   * is merged afterwards. The ref still ENCODES correctly (`case 'lazy'` resolves
   * it through `winners` at `:1169`), so the artifact parses the same input — it
   * simply parses it with the gate switched off at every choice arm that reaches
   * a hole.
   *
   * Measured on jess's less grammar (`bench/jess/macro-program-diff.ts`): 195 of
   * 562 reachable choice arms carried NO first set in the shipped artifact
   * against 103 of 540 in the runtime encode, and 10 dispatch sites lost the O(1)
   * `exclusive` piece (`assemble.ts:1758`) for the candidate-mask loop. With this
   * resolver both figures land exactly on the runtime encode's: 103 and 41.
   *
   * SOUNDNESS. `firstSetOf` warns that deep resolution is sound only where refs
   * are FINAL, because a compose OVERRIDE could widen a referenced rule's set
   * after the fact. `winners` IS the final map — it is the merged rule map being
   * encoded, the one `case 'lazy'` points the arm's CALL at. Gating an arm on the
   * first set of the very row it will call cannot skip a match that row would
   * accept. And this only ever runs in the CATCH branch: where a thunk resolves,
   * nothing consults the resolver and nothing changes, which is why the runtime
   * leg's counts are byte-for-byte what they were.
   */
  private refResolver(): RefResolver | undefined {
    const w = this.winners
    return w === undefined ? undefined : (name: string) => w[name]
  }

  /** A first set becomes a char class string, or −1 for `any`. */
  private charClass(fs: FirstSet): number {
    if (fs.kind !== 'ranges' || fs.ranges.length === 0) return -1
    // `fromCharCode` truncates every endpoint to 16 bits. That silently turned
    // U+1F600 into U+F600 in the dispatch table: `lead()` correctly produced the
    // astral code point, but no encoded class could claim it. The shared codec
    // keeps BMP endpoints compact and escapes astral endpoints unambiguously.
    const spec = encodeClassSpec(fs.ranges)
    const hit = this.ccIndex.get(spec)
    if (hit !== undefined) return hit
    const i = this.cc.length
    this.cc.push(spec)
    this.ccIndex.set(spec, i)
    return i
  }

  /**
   * Wrap one choice arm in its `autoNot` checks (`OP_REJECT`).
   *
   * A `firstSet` check's class comes from `codesToFirstSet` (choice.ts), which
   * only ever builds a non-empty `ranges` set over codes 1..127 — so `charClass`
   * cannot answer −1 here. It is asserted rather than assumed, because a −1 would
   * index past `cc` and silently stop rejecting.
   */
  private reject(child: number, checks: readonly AutoNotCheck[]): number {
    const ops: number[] = []
    for (const c of checks) {
      if (c.kind === 'startsWith') { ops.push(0, this.constant(c.value)); continue }
      const cls = this.charClass(c.set)
      if (cls < 0) throw new UnsupportedConstruct('choice(autoNot: unmappable first set)')
      ops.push(1, cls)
    }
    const head = this.emitHead(OP_REJECT, 2 + ops.length)
    this.code[head + 1] = child
    this.code[head + 2] = ops.length >> 1
    for (let i = 0; i < ops.length; i++) this.code[head + 3 + i] = ops[i]!
    return head
  }

  private emit(...words: number[]): number {
    const ip = this.code.length
    for (const w of words) this.code.push(w)
    return ip
  }

  /** Reserve `n` operand slots to patch once children are laid out. */
  private emitHead(op: number, n: number): number {
    const ip = this.code.length
    this.code.push(op)
    for (let i = 0; i < n; i++) this.code.push(0)
    return ip
  }

  /**
   * A combinator carried as a table SUBTREE plus its first set.
   *
   * The first set is not decoration: `buildBalancedInterior` reads each skipper's
   * to decide whether the interior content run can be one bounded regex
   * (scanTo.ts:280). A reference that reported `any` would rebuild a different —
   * one-character-at-a-time — interior than the grammar's own.
   */
  private subtree(c: Combinator<unknown>): SubtreeRef {
    const ip = this.node(c).ip
    const fs = firstSetOf(c, new Set(), this.refResolver())
    return [ip, fs.kind === 'empty' ? -2 : this.charClass(fs)]
  }

  /** Pool one scan spec. One per combinator: `node()` memoizes by identity. */
  private scanSlot(spec: ScanSpec): number {
    const i = this.scans.length
    this.scans.push(spec)
    return i
  }

  private scanSkipSlot(set: readonly Combinator<unknown>[]): number {
    const hit = this.scanSkipIndex.get(set)
    if (hit !== undefined) return hit
    const i = this.scanSkipSets.length
    // Reserve the slot BEFORE encoding: an ambient skipper can be a `balanced()`
    // whose own encoding reaches back here through the same array.
    this.scanSkipIndex.set(set, i)
    this.scanSkipSets.push([])
    this.scanSkipSets[i] = set.map(c => this.subtree(c))
    return i
  }

  /** Take trivia labels / classification off one carrier, first one wins. */
  private carryTriviaMeta(c: Combinator<unknown> | undefined): void {
    if (c === undefined) return
    this.labels ??= c._meta.triviaKindLabels
    if (c._meta.rootTriviaClassified === true) this.classified = true
  }

  encodeRule(name: string, p: Combinator<unknown>): void {
    // `rules({ trivia }, …)` is ambient for the whole rule body, so it is in
    // scope for a `notAdjacent({ kinds })` anywhere inside it — see the same
    // save/restore in `case 'grammar'`.
    this.activeTrivia = p._meta.grammarTrivia
    const body = this.node(p).ip
    this.activeTrivia = undefined
    // GRAMMAR-LEVEL AMBIENT TRIVIA (`rules({ trivia }, …)`).
    //
    // `run()` installs this from `entry._meta.grammarTrivia`, but ONLY for a
    // combinator entry — a compiled entry is a FUNCTION and is expected to have
    // baked it in (src/functional/run.ts:269). A table entry is also a function,
    // so without this the whole grammar parses with NO ambient trivia and every
    // whitespace-bearing input silently fails to match the same way in every
    // path — which makes a three-way identity check AGREE while proving nothing.
    // Bake it, exactly as the compiled path does.
    // AMBIENT `scanSkip`, PER RULE — the granularity `run()` uses, because it
    // reads the ENTRY rule's own `_meta.grammarScanSkip` (grammar.ts:203). It is
    // stamped by `rules({ scanSkip }, …)` on that map's rules only
    // (parser.ts:210); a `parser()` scope has no `scanSkip` at all, so a rule is
    // the finest scope that can carry one. In a `composeLeaf` grammar the pieces
    // disagree — 67 of jess's 195 css rules carry no set — and taking the first
    // one for the whole program handed those entries a skip list the interpreter
    // does not give them.
    const gss = p._meta.grammarScanSkip
    this.scanSkipOf.push(gss === undefined ? -1 : this.scanSkipSlot(gss))
    const amb = p._meta.grammarTrivia
    // Carried so `tableRules` can stamp the entry — see TableProgram.labels.
    //
    // THREE PLACES, because that is where `run()` looks (`triviaKindLabelsFromRunnable`
    // / `rootTriviaClassifiedFromRunnable`, functional/run.ts): `rules({ trivia }, …)`
    // leaves it on `_meta.grammarTrivia`, `classifiedTrivia()` leaves it on the
    // combinator's OWN `_meta`, and `parser({ trivia }, …)` leaves it on
    // `_def.triviaParser` with nothing on `_meta` at all.
    //
    // Reading only the first meant a table lowered from a `parser({ trivia:
    // classifiedTrivia(…) }, …)` root PARSED correctly and then reported no
    // labels, so `run({ rootTrivia: { select } })` rejected a grammar that plainly
    // has labelled trivia — and a bare `classifiedTrivia()` passed as
    // `options.trivia` lost its labels the same way. Neither is visible to a
    // value-identity sweep: the tree is the same, only the metadata is gone.
    this.carryTriviaMeta(amb)
    this.carryTriviaMeta(p)
    if (p._def.tag === 'grammar') this.carryTriviaMeta(p._def.triviaParser)
    // `body` is ALREADY the counter row when this rule has one — `node()` wraps
    // it there, not here. Wrapping the rule ENTRY instead would credit the rule
    // only when it is the start rule: an internal `g.X` reference resolves
    // straight to the body's offset (`case 'lazy'`), so every recursive call and
    // every cross-rule reference would jump past the counter, and a grammar with
    // one entry would report one hit rule however much of it ran.
    this.rules[name] = amb === undefined ? body : this.emit(OP_SCOPE_PLAIN, this.triviaSlot(amb), body)
  }

  /**
   * The row a cross-rule `g.X` reference jumps to — the target's body, RE-WRAPPED
   * in the target rule's own ambient trivia when that differs from the trivia
   * lexically active at the reference.
   *
   * `encodeRule` wraps a rule ENTRY in `OP_SCOPE`, but only the entry: a `g.X`
   * reference resolves straight to the body's offset and jumps past it (the note
   * at `encodeRule`). So a rule referenced from inside a `noTrivia(...)` region ran
   * with NO ambient trivia of its own — the table scoped trivia DYNAMICALLY, by
   * caller, where codegen scopes it LEXICALLY, per rule, by binding each rule's
   * trivia scanner at compile time.
   *
   * jess's Less grammar sits on that seam: `StandardDeclaration` wraps its value in
   * `noTrivia(...)` while the `!important` tail lives in the referenced rule
   * `ValueListWithPriority`, so `color: red !important` could not cross the space
   * before `!` — and a 107 KB stylesheet stopped at 68.5% reporting `ok: true`.
   *
   * ONLY WHERE THE SCOPE WAS CLEARED. `activeTrivia` is the encoder's lexical scope
   * tracker (maintained by `case 'grammar'` across `parser()` / `noTrivia`), and a
   * reference made under ANY live trivia stays a bare jump, so the table gains no
   * rows anywhere except inside a cleared region. The broader form — restore
   * wherever the scope merely DIFFERS — also overrides a caller that set its own
   * live trivia, and that regressed `@less/test-data`'s `selectors.less` from 3791
   * bytes to 1784 while repairing nothing extra.
   *
   * ONLY WHERE THE TARGET HAS A BOUNDARY TO REPAIR — `hasOwnTriviaBoundary`, the
   * same gate `ref.ts` applies, because the two engines must ask the same question
   * or they parse different languages again. A rule whose body is a bare
   * alternation, a dispatch, or a single terminal never consults an ambient
   * scanner itself, so the scope row cannot repair it and only leaks past its arms.
   * jess's SCSS `MathUnary` — `choice(noTrivia(…), noTrivia(…), g.ValueAtom)` — is
   * exactly that shape: the row it gained handed its third arm a live scope, and
   * `KeywordOrInterpolatedValue`'s `many()` then skipped the space between two
   * identifiers. `gen-workload.scss` stopped at byte 218 of 287543 and `a{b: c d}`
   * silently produced the ONE keyword `bc`.
   */
  private scopedRef(p: Combinator<unknown>, target: Combinator<unknown>): number {
    const ip = this.node(target).ip
    // `rules()` stamps `grammarTrivia` on the map entry, which for a proxied rule
    // is the REF itself; a composed `winners` entry carries it on the target.
    const amb = p._meta.grammarTrivia ?? target._meta.grammarTrivia
    if (amb === undefined || this.activeTrivia !== undefined) return ip
    if (!hasOwnTriviaBoundary(target)) return ip
    return this.emit(OP_SCOPE_PLAIN, this.triviaSlot(amb), ip)
  }

  node(p: Combinator<unknown>): Emitted {
    // See `refMemo`: a reference is memoised per REFERENCING trivia scope, every
    // other construct once for the program.
    const lazyRef = (p._def as ParserDef).tag === 'lazy'
    const scopeKey = lazyRef ? this.activeTrivia : undefined
    const refMemo = this.refMemo
    const hit = lazyRef ? refMemo.get(p)?.get(scopeKey) : this.memo.get(p)
    if (hit !== undefined) return { ip: hit }
    // Recursion: reserve a trampoline row now, patch its target when the real
    // body lands. One extra indirection per recursive rule, zero per call site.
    const inFlight = this.pending.get(p)
    if (inFlight !== undefined) {
      const ip = this.emitHead(OP_RULE, 1)
      inFlight.push(ip + 1)
      return { ip }
    }
    const patches: number[] = []
    this.pending.set(p, patches)
    // A RULE IS CREDITED ON ENTRY, not on success — `codegen.ts:4529` emits the
    // hook as the first statement of the named function body, so a rule that is
    // reached and then fails still counts as exercised. The counter goes on the
    // MEMOISED offset, which is the one every reference to this combinator lands
    // on, and the recursion trampolines below are patched with it too.
    const ip = this.covWrap(this.encodeDef(p), this.plan?.rules.get(p), 0)
    this.pending.delete(p)
    if (lazyRef) {
      let byScope = refMemo.get(p)
      if (byScope === undefined) { byScope = new Map(); refMemo.set(p, byScope) }
      byScope.set(scopeKey, ip)
    } else {
      this.memo.set(p, ip)
    }
    for (const slot of patches) {
      // A TRAMPOLINE PATCHED TO ITSELF IS NOT A TABLE. `OP_RULE ip → ip` makes no
      // progress in either driver: `exec.ts`'s `case OP_RULE` recurses on the same
      // `ip`, and `assemble.ts` builds a piece that calls itself, so the first byte
      // of the first file is `Maximum call stack size exceeded`. It is produced
      // when a combinator's whole encoding emits NO row of its own and resolves
      // back to the trampoline reserved for it — an ALIAS CYCLE, never a grammar
      // this table can run. Raised here, at the one line that can write it, so the
      // encoder names the construct instead of every parse dying at run time.
      if (slot - 1 === ip) {
        const rule = (p as unknown as { _ruleName?: string })._ruleName
        throw new Error(
          `table lowering: alias cycle — ${p._tag}${rule === undefined ? '' : ` (rule '${rule}')`} encodes to its own recursion trampoline at ${ip}`,
        )
      }
      this.code[slot] = ip
    }
    return { ip }
  }

  private encodeDef(p: Combinator<unknown>): number {
    const d = p._def as ParserDef
    // THE SCANNING CONSTRUCTS, as their constructor arguments.
    //
    // Neither is recoverable from `_def` alone — `balanced()` overrides `.parse`
    // and leaves `_def` as its EAGER interior, so a structural encoding builds a
    // parser that skips the wrong things and reports nothing. Both are fully
    // described by what they were CONSTRUCTED with, which is what `ScanSpec`
    // carries; `resolveTable` hands that back to `scanTo()`/`balanced()`.
    //
    // The `balanced()` test reads `_balancedSpec` on the object `balanced()`
    // RETURNS. That object is a `token()` and the ambient marker lives on the
    // combinator INSIDE it, so testing `_balancedAmbient` here would either miss
    // the construct or reach past the `token()` that gives it its one leaf.
    const bal = (p as BalancedSpec)._balancedSpec
    if (bal !== undefined) return this.emit(OP_SCAN, this.scanSlot({
      kind: 1,
      flags: (bal.raw ? 1 : 0) | (bal.strict ? 4 : 0),
      skip: bal.ownSkip.map(c => this.subtree(c)),
      open: bal.open,
      close: bal.close,
    }))
    if (d.tag === 'scanTo') {
      const sentDef = d.sentinel._def
      return this.emit(OP_SCAN, this.scanSlot({
        kind: 0,
        flags: (d.raw ? 1 : 0) | (d.orEOF ? 2 : 0),
        skip: d.skip.map(c => this.subtree(c)),
        sentinel: this.subtree(d.sentinel),
        sent: sentDef.tag === 'literal' ? sentDef.value : null,
      }))
    }
    switch (d.tag) {
      case 'literal': {
        if (d.caseInsensitive) {
          return this.emit(this.track ? OP_LIT_CI_TRACK : OP_LIT_CI, this.constant(d.value), this.expected(deriveExpected(p)))
        }
        return this.emit(this.track ? OP_LIT_TRACK : OP_LIT, this.constant(d.value), this.expected(deriveExpected(p)))
      }
      case 'regex': {
        const flags = d.flags.includes('y') ? d.flags : `${d.flags}y`
        return this.emit(this.track ? OP_RX_TRACK : OP_RX, this.constant(new RegExp(d.source, flags)), this.expected(deriveExpected(p)))
      }
      case 'keywords': {
        // `keywords()` compiles to ONE sticky regex and pushes a leaf — which is
        // exactly what OP_RX does. Rebuilding the same regex here needs no new
        // opcode. Construction mirrors src/combinators/keywords.ts:87-106; the
        // words arrive already sorted longest-first on the def.
        const alt = d.words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
        const boundary = d.boundary ? `(?![${d.boundary}])` : ''
        const flags = d.caseInsensitive ? 'iy' : 'uy'
        return this.emit(
          this.track ? OP_RX_TRACK : OP_RX,
          this.constant(new RegExp(`(?:${alt})${boundary}`, flags)),
          // `['keyword']`, NOT `deriveExpected(p)`. `keywords.ts:137` reports the
          // one word `keyword` — the whole point of the combinator is that a
          // failing keyword arm names the CATEGORY rather than reciting every
          // literal in the family. `deriveExpected` reports the literals, so the
          // table said `'"media"'` where both other engines say `'keyword'`.
          this.expected(['keyword']),
        )
      }
      case 'expect': {
        // `expect()` NEVER fails: on a failed child it yields a ParseError value
        // at zero width. That is a distinct outcome, so it gets its own row.
        return this.emit(OP_EXPECT, this.node(d.parser).ip, this.expected([...d.expected]))
      }
      case 'sequence': {
        const kids = d.parsers.map(c => this.node(c).ip)
        // A RECOVERY table appends one follow-set class per term AFTER the child
        // slots. Appending keeps every existing read (`ip + 2 + i`) and the
        // `collapseIndirection` slot map exactly as they were, so a strict table
        // is word-for-word the table it always was.
        const head = this.emitHead(d.valueUnused ? OP_SEQV : OP_SEQ, 1 + kids.length + (this.rec ? kids.length : 0))
        this.code[head + 1] = kids.length
        for (let i = 0; i < kids.length; i++) this.code[head + 2 + i] = kids[i]!
        if (this.rec) {
          for (let i = 0; i < kids.length; i++) this.code[head + 2 + kids.length + i] = this.followClass(d.parsers, i)
        }
        return head
      }
      case 'choice': {
        // `greedyClassify` is NOT a choice at all — one arm runs and another arm
        // is credited — so it gets its own row rather than an arm ordering.
        if (d.strategy.tag === 'greedyClassify') {
          const superIndex = d.strategy.superIndex
          const sup = this.node(d.parsers[superIndex]!).ip
          // Same construction as `choice()`'s own `greedyLitMap` (choice.ts:64-70):
          // every NON-super arm that has a core literal value, keyed by that value.
          // An arm without one is unreachable through classification and is left
          // to the super arm exactly as the interpreter leaves it.
          // COVERAGE CREDITS THE CLASSIFIED ARM AND NOT THE SUPER ARM, which is
          // what the interpreter reference does: `coverage.ts:230` suppresses the
          // per-arm hit for a `greedyClassify` site precisely because the super
          // arm runs as an implementation detail, and only the arm the
          // classification SELECTS is a semantic winner. Here the selected arm is
          // re-run (`assemble.ts` `OP_GREEDY`), so wrapping it is exact.
          //
          // THE SUPER ARM'S OWN ID IS NOT INSTRUMENTED, and that is a stated gap,
          // not an oversight: it is credited when classification finds nothing,
          // and that outcome is decided INSIDE the greedy row rather than by any
          // child of it. Instrumenting the super arm's offset would credit it on
          // every invocation, including the ones the interpreter credits to a
          // literal arm — an over-count, which inflates the ratio. Leaving it
          // uninstrumented under-counts, which is the direction every other
          // coverage decision in this codebase fails in.
          const covIds = this.plan?.choices.get(p)
          const pairs: number[] = []
          for (let i = 0; i < d.parsers.length; i++) {
            if (i === superIndex) continue
            const lit = getCoreLiteralValue(d.parsers[i]!)
            if (lit === null) continue
            pairs.push(this.constant(lit), this.covWrap(this.node(d.parsers[i]!).ip, covIds?.[i], 1))
          }
          const head = this.emitHead(OP_GREEDY, 2 + pairs.length)
          this.code[head + 1] = sup
          this.code[head + 2] = pairs.length >> 1
          for (let i = 0; i < pairs.length; i++) this.code[head + 3 + i] = pairs[i]!
          return head
        }
        // Arm ORDER is semantics. `literalsLongestFirst` / `sharedPrefix` reorder
        // the arms, so encoding them as a declared-order choice would pick a
        // different arm and build a different tree while still parsing. ORDER is
        // the only thing they change, though, and order is table data:
        // `literalsLongestFirst` carries its order explicitly, and `sharedPrefix`
        // is documented in choice.ts:52 as a firstMatch specialization, so
        // declared order is already correct for it.
        const order = d.strategy.tag === 'literalsLongestFirst'
          ? d.strategy.sortedIndices
          : d.parsers.map((_, i) => i)
        const arms = order.map(i => d.parsers[i]!)
        // `autoNot` rejects an arm that ALREADY MATCHED when a later arm would
        // have consumed more, so a matched arm loses. It wraps the arm's row and
        // does not touch the arm's identity in `memo`: the same combinator used
        // at a site with no `autoNot` still reaches the bare row.
        //
        // A GATED arm (`choice({ gate, combinator })`) is wrapped OUTSIDE its
        // `autoNot` wrapper, mirroring the interpreter's order: the gate is
        // consulted before the arm runs (choice.ts:150) and `autoNot` only after
        // it has already matched (choice.ts:160-164). Wrapping — rather than
        // splicing the predicate into the arm — is what preserves the arm's own
        // first set for `classes` below, and with it the site's O(1) dispatch.
        // ARM IDS ARE INDEXED BY DECLARED POSITION, not by encoded position:
        // `buildGrammarPlan` mints `choice:…/arm:i` off `def.parsers`, and `order`
        // is a permutation of that. `src` is the declared index, so the id and the
        // `autoNot`/`gates` entries are all taken with the same subscript.
        const armCovIds = this.plan?.choices.get(p)
        const kids = arms.map((c, k) => {
          const src = order[k]!
          const checks = d.autoNot[src]
          const inner = this.node(c).ip
          const ip = checks === null || checks === undefined || checks.length === 0
            ? inner
            : this.reject(inner, checks)
          const gate = d.gates[src]
          const gated = gate === null || gate === undefined
            ? ip
            : this.emit(OP_ARMGATE, this.fn(gate, d.gateSrcs?.[src] ?? null), ip, this.expected(deriveExpected(c)))
          // OUTSIDE both wrappers, because an arm is credited once it has WON —
          // after its gate admitted it and after `autoNot` declined to reject it.
          // Inside either, a gate-rejected or auto-rejected arm would count as
          // covered on a parse where the choice picked somebody else.
          return this.covWrap(gated, armCovIds?.[src], 1)
        })
        // O(1) first-char dispatch is only SOUND when the arms are disjoint.
        // With overlapping first sets, "the first arm whose class contains this
        // char" is not "the first arm that matches": a `Keyword` arm whose first
        // set over-approximates to include digits was selected ahead of `Num`
        // for the input `0` — the parse still succeeded, and only the TREE moved.
        // Disjointness is computed HERE, not read off `d.disjoint`. That flag is
        // set when `choice()` is CONSTRUCTED, at which point `g.X` arms are
        // unresolved refs whose first set is `any` — so every recursive grammar
        // reports non-disjoint and loses its dispatch. (Codegen has the same
        // problem and solves it the same way: a placeholder resolved at fuse.)
        // EVERY choice now carries its arms' classes. The old code recorded them
        // only when the whole site qualified for O(1) selection — all arms
        // non-nullable, pairwise disjoint and mappable — and a single failure
        // left the site with no gate of any kind, so all its arms were entered
        // at every position it was reached.
        //
        // An arm's class is its OWN gate and is sound on its own: a
        // non-nullable arm whose first set excludes the char at `pos` cannot
        // match there, whatever the other arms do. `firstSetOf` already skips a
        // leading zero-width assertion so `not(X) Y` reports firstSet(Y) rather
        // than `any` (`first-set.ts` `isZeroWidthAssertion`), and `charClass`
        // returns −1 for anything it cannot represent — both directions are the
        // safe one. A NULLABLE arm is never gated: it can match at a position
        // its first set does not contain, by consuming nothing.
        //
        // `resolveDispatch` decides from these classes whether the site keeps
        // the O(1) table (`exclusive`) or falls to the ordered per-arm path.
        // Arm ORDER is preserved on both, which is what makes this a PEG-safe
        // change rather than a reordering.
        const rr = this.refResolver()
        const classes = arms.map(a => matchesEmpty(a, new Set(), rr) ? -1 : this.charClass(firstSetOf(a, new Set(), rr)))
        const dispIdx = this.disp.length
        this.disp.push(classes)
        // PER-ARM EXPECTED SETS RIDE ALONG, after the arm offsets. The ordered
        // path reports the CONCATENATION of the arms' sets (`choice.ts:167`), and
        // it must include the arms the driver's char gate declined to enter — the
        // interpreter has no such gate, runs them, and gets exactly their static
        // opener set back. Without these words a partially-gated site reported
        // only the arms that happened to run.
        const head = this.emitHead(OP_CHOICE, 3 + 2 * kids.length)
        this.code[head + 1] = dispIdx
        this.code[head + 2] = kids.length
        // THE CHOICE'S OWN SET IS THE ARMS' FLATMAP, NOT `deriveExpected(p)`.
        // `deriveExpected` DEDUPES, and neither engine does: `choice.ts:110-118`
        // is `parsers.flatMap(p => p.parse(...).expected)`, so a shared-prefix
        // choice whose two arms both open with `/::?/` reports it TWICE. The
        // deduped union silently collapsed that to one.
        this.code[head + 3] = this.expected(arms.flatMap(a => deriveExpected(a)))
        for (let i = 0; i < kids.length; i++) {
          this.code[head + 4 + i] = kids[i]!
          this.code[head + 4 + kids.length + i] = this.expected(deriveExpected(arms[i]!))
        }
        return head
      }
      case 'many':
      case 'oneOrMore': {
        const child = this.node(d.parser).ip
        const op = d.valueUnused ? OP_REPV : OP_REP
        const min = d.tag === 'many' ? 0 : d.min
        // ip + 6 is the ITEM's expected set and ip + 7 the separator's sentinel
        // class (−1: there is no separator). Both are only laid down for a
        // recovery table, where the resync error's payload has to be the ITEM's
        // set — `deriveExpected(combinator)` in repeat.ts:170, and
        // `deriveExpectedArr([def.parser])` in codegen's emitMany.
        return this.rec
          ? this.emit(op, child, min, d.max ?? -1, -1, 0, this.expected(deriveExpected(d.parser)), -1)
          : this.emit(op, child, min, d.max ?? -1, -1, 0)
      }
      case 'sepBy': {
        const child = this.node(d.parser).ip
        const sep = this.node(d.separator).ip
        // A list contributes its ITEMS and nothing else (release/0.47.0
        // `7cb528e feat(lists)!`). The separator is demoted out of `children`
        // after it matches unless the author opted in with `keepSeparator()`.
        // Bit 2: an ITEM-expected fx index follows at `ip + 6`. A list that ends
        // under `min` reports what would have let it CONTINUE — the ITEM, which
        // is what `failAt` (repeat.ts) and `deriveExpectedArr([def.parser])`
        // (codegen emitSepBy) both use; the driver otherwise reports whatever
        // sub-parse failed last, which is the SEPARATOR. Only `min >= 2` can
        // reach that end under `min` with items already taken — at `min === 1`
        // it means the FIRST item failed, and that failure already set the
        // item's own set. So no committed grammar grows by a word.
        const flags = (d.trailing === 'allow' ? 1 : 0) | (d.keepSeparators === true ? 2 : 0) | (d.min >= 2 ? 4 : 0)
        // A RECOVERY table always carries ip + 6 (the ITEM's expected set, which
        // the resync error reports) and ip + 7 (the SEPARATOR's sentinel class, so
        // a tolerant list resyncs to its own separator OR the enclosing
        // delimiter — `orSentinel(separator, term)` in repeat.ts:454 and
        // `_rec.or(sepSent, mySync)` in codegen's emitSepBy).
        if (this.rec) {
          return this.emit(
            OP_REP, child, d.min, d.max ?? -1, sep, flags,
            this.expected(deriveExpected(d.parser)), this.charClass(firstSetOf(d.separator, new Set(), this.refResolver())),
          )
        }
        return d.min >= 2
          ? this.emit(OP_REP, child, d.min, d.max ?? -1, sep, flags, this.expected(deriveExpected(d.parser)))
          : this.emit(OP_REP, child, d.min, d.max ?? -1, sep, flags)
      }
      case 'optional':
        return this.emit(OP_OPT, this.node(d.parser).ip)
      case 'transform': {
        // Declared on the def and not lowered here. Refuse rather than assume it is
        // inert: a recognition-only transform suppresses its value, and a table that
        // produced one anyway would differ from both other engines.
        // FUSE `transform(sequence(...))` — the dominant shape — into one row.
        // Emitted separately it costs two dispatches and two call frames per
        // rule invocation. The inner sequence must not be shared with anything
        // else, or fusing it here would steal it from the other reference.
        const inner = d.parser._def as ParserDef
        if (inner.tag === 'sequence' && !this.memo.has(d.parser) && !this.pending.has(d.parser)) {
          const kids = inner.parsers.map(c => this.node(c).ip)
          const head = this.emitHead(OP_SEQX, 2 + kids.length + (this.rec ? kids.length : 0))
          this.code[head + 1] = this.fn(d.fn, d.fnSrc ?? null)
          this.code[head + 2] = kids.length
          for (let i = 0; i < kids.length; i++) this.code[head + 3 + i] = kids[i]!
          if (this.rec) {
            for (let i = 0; i < kids.length; i++) this.code[head + 3 + kids.length + i] = this.followClass(inner.parsers, i)
          }
          return head
        }
        const child = this.node(d.parser).ip
        return this.emit(OP_XFORM, this.fn(d.fn, d.fnSrc ?? null), child)
      }
      case 'leaf': {
        const child = this.node(d.parser).ip
        return this.emit(OP_LEAF, this.fn(d.fn, d.fnSrc ?? null), child)
      }
      case 'node': {
        // A node legally has NO builder when its value comes from a selection:
        // `project` replaces the builder outright, and `collapse`/`unwrap` make
        // the single captured child the value. A node with none of those and no
        // builder is STRUCTURAL — its value comes from a `ctx.build` host.
        //
        // This USED to refuse, on the belief that the driver had no host. It
        // does: `assemble.ts` reads `ctx.build` once per parse in `begin()` and
        // bakes host-ness into which pieces the assembly holds, and `exec.ts`
        // has the same branch. The refusal was over-broad, not protective —
        // verified by differential against the interpreter, with a host and
        // without, on match and on failure.
        // An AUTHORING error, not a table gap — raise what the other two engines do.
        if (d.type === undefined) missingInferredType()
        const child = this.node(d.parser).ip
        // Capture flags, resolved HERE from the reducer's declared arity using the
        // same analysis codegen runs (`src/compiler/build-arity.ts`). `hostMode:
        // 'cst'` forces them on, exactly as the emitted `cstOut` path does. The
        // driver reads a bit; it re-derives nothing and sees no setting.
        const cstOut = this.settings.hostMode === 'cst'
        // THE THREE DERIVED CAPTURE BITS, mirroring `node.ts:215` term for term:
        //
        //   capturesTrivia = captureTrivia || trailingTrivia
        //                    || (build ? buildReadsTrivia(def) : project === undefined)
        //
        // `cstOut` is the static stand-in for "a CST host is coming", which the
        // interpreter reaches dynamically off `ctx.build`.
        //
        // Two of these terms were MISSING and each was a real divergence:
        //
        //   `captureTrivia` — an explicit request the arity analysis cannot
        //     express (an author can ask for capture on a 3-argument reducer).
        //     This used to REFUSE rather than lower, so a documented option no
        //     grammar could use through the table.
        //   `trailingTrivia` — trivia consumed INSIDE the node's capture scope
        //     lands in THIS node's log. The interpreter counts it; the table did
        //     not, so a node with `trailingTrivia` and a non-trivia-reading
        //     reducer captured under the interpreter and dropped under the table.
        //
        // The `build ? … : project === undefined` split matters now that a
        // STRUCTURAL node lowers: with no builder the interpreter captures unless
        // a `project` replaces the value outright.
        const noBuildCaptures = d.project === undefined
        const derivedTrivia = d.build !== undefined ? buildReadsTrivia(d) : noBuildCaptures
        const derivedState = d.build !== undefined ? buildReadsState(d) : noBuildCaptures
        const derivedFields = d.build !== undefined ? buildReadsFields(d) : noBuildCaptures
        // Field capture additionally requires the body to CONTAIN `field()`
        // captures: a node that reads fields but has none allocates nothing.
        const wantsFields = parserHasOwnFields(d.parser) && (cstOut || derivedFields)
        const flags = (cstOut || d.captureTrivia === true || d.trailingTrivia === true || derivedTrivia ? 4 : 0)
          | (cstOut || derivedState ? 8 : 0)
          | (wantsFields ? 16 : 0)
          | (d.collapse === true ? 32 : 0)
          | (d.unwrap === true ? 64 : 0)
          | (d.trailingTrivia === true ? 128 : 0)
          // Distinguish grammar-owned capture from a structural node's default
          // capture. A runtime host predicate may narrow only the latter.
          | (d.captureTrivia === true ? 1 : 0)
        const body = this.emit(
          this.track ? OP_NODE_TRACK : OP_NODE,
          d.build === undefined ? -1 : this.fn(d.build, d.buildSrc ?? null),
          child, flags,
          d.project ?? -1,
          this.constant(d.type),
          // `tags` reaches a `ctx.build` host as its 8th argument. jess's
          // `cssCstBuildHost` is built with `{ tags: true }` and puts them on
          // every CST node, so this is load-bearing, not reflection trivia.
          d.tags === undefined ? -1 : this.constant(d.tags),
        )
        // The rule's own first-set gate — the emitted code's `_ngc` test, as data.
        // A NULLABLE rule has no gate: it succeeds on input its first set does
        // not contain (including EOF), so gating it would reject a legal empty
        // match. Caught by the ladder's `empty` and `garbage` cases.
        // THE BODY'S first set, not the node's. `node.ts:232` reads
        // `combinator._meta.firstSet` where `combinator` is the BODY; a `node()`
        // reports `any` for itself, so `firstSetOf(p)` was −1 here and NO node
        // ever got the gate the interpreter applies. That is not just a lost
        // fast path: when the guard fires it reports the STATIC
        // `deriveExpected(body)`, which for a body with nullable leading terms
        // names tokens the run would have skipped — `['"@"', '"(", '"x"']` where
        // running the body reports `['"x"']` alone.
        if (matchesEmpty(d.parser)) return body
        const fs = d.parser._meta.firstSet
        if (fs.kind === 'any') return body
        const cls = this.charClass(fs)
        if (cls < 0) return body
        const e = deriveExpected(d.parser)
        return this.emit(OP_GATE, cls, body, this.expected(e.length > 0 ? e : [d.parser._tag]))
      }
      case 'token':
        return this.emit(OP_TOKEN, this.node(d.parser).ip)
      case 'routed':
        return this.emit(OP_ROUTED, d.fallback === undefined ? -1 : this.node(d.fallback).ip)
      case 'dispatch': {
        // A `routed()` in the SELECTOR is a hard error in the interpreter
        // (dispatch.ts:318) — it would ask for a token that has not been read yet.
        if (parserUsesRouted(d.selector as Combinator<unknown>)) {
          throw new UnsupportedConstruct('dispatch(routed() in selector)')
        }
        const sel = this.node(d.selector as Combinator<unknown>).ip
        // `dispatchArmIds` mints ids in RESOLUTION ORDER — every case (one id per
        // case, not per key), then every matcher, then `otherwise` — which is the
        // order the two loops below push arms in, with the fallback last. A
        // running index is what keeps the two in step; taking `ids[armIndex]`
        // inside the key loop would consume one id per KEY and slide every
        // subsequent arm onto somebody else's identity.
        const dispCovIds = this.plan?.dispatches.get(p)
        let dispCov = 0
        const arms: number[] = []
        const routed: number[] = []
        const key: string[] = [], keyArm: number[] = []
        const fold: string[] = [], foldArm: number[] = []
        const match: Array<readonly [number, string, string, number]> = []
        const expected: string[] = []
        // ARM ORDER IS RESOLUTION ORDER: exact key, then ASCII-folded key, then
        // matchers in declaration order, then otherwise. Mirrors dispatch.ts:325.
        for (const c of d.cases) {
          const arm = arms.length
          arms.push(this.covWrap(this.node(c.parser).ip, dispCovIds?.[dispCov++], 1))
          routed.push(branchUsesRouted(c) ? 1 : 0)
          for (const kk of c.keys) {
            expected.push(JSON.stringify(kk))
            if (c.caseInsensitive) { fold.push(asciiFoldKey(kk)); foldArm.push(arm) }
            else { key.push(kk); keyArm.push(arm) }
          }
        }
        const KIND = { startsWith: 0, endsWith: 1, matches: 2 } as const
        for (const m of d.matchers ?? []) {
          const arm = arms.length
          arms.push(this.covWrap(this.node(m.parser).ip, dispCovIds?.[dispCov++], 1))
          routed.push(branchUsesRouted(m) ? 1 : 0)
          // `{ caseInsensitive: true }` ON A MATCHER ARM IS FOLDED INTO THE
          // OPERANDS HERE, not tested per parse in the driver. It was dropped
          // entirely — both drivers built the matcher shape with a hardcoded
          // `caseInsensitive: false` — so `when(startsWith('pre'), …, { caseInsensitive: true })`
          // never claimed `PRElude` and the parse fell through to `otherwise()`.
          // A wrong ARM is a wrong parse, and no key-path test covered it because
          // the folded-KEY path (`fold`/`foldArm` above) is a different mechanism.
          //
          // `matches` folds into the regex's own `i` flag, which is what
          // `matchesDispatchMatcher` does (it tests the RAW value with `i`
          // appended). `startsWith`/`endsWith` fold BOTH sides, so the stored
          // value is pre-folded and kinds 3/4 tell the driver to fold the key.
          if (!m.caseInsensitive) { match.push([KIND[m.kind], m.value, m.flags ?? '', arm]); continue }
          if (m.kind === 'matches') {
            const f = m.flags ?? ''
            match.push([2, m.value, f.includes('i') ? f : `${f}i`, arm])
            continue
          }
          match.push([m.kind === 'startsWith' ? 3 : 4, asciiFoldKey(m.value), '', arm])
        }
        const other = d.otherwise === undefined
          ? -1
          : this.covWrap(this.node(d.otherwise).ip, dispCovIds?.[dispCov++], 1)
        const dspIdx = this.dsp.length
        this.dsp.push({ key, keyArm, fold, foldArm, match, routed, expected })
        const head = this.emitHead(OP_DISPATCH, 5 + arms.length)
        this.code[head + 1] = sel
        this.code[head + 2] = dspIdx
        this.code[head + 3] = other
        // THE FALLBACK'S ROUTED BIT IS WALKED, NOT READ OFF THE DEF.
        //
        // `d.otherwiseUsesRouted` is computed when `otherwise()` is CONSTRUCTED
        // (dispatch.ts:189), and at that moment a `g.X` inside the arm is an
        // unresolved ref whose thunk throws — `parserUsesRouted` catches and
        // answers `false`. The interpreter never reads the stored flag alone: it
        // calls `branchUsesRouted` at PARSE time (dispatch.ts:335), which ORs the
        // flag with a live walk of the now-resolved graph.
        //
        // Reading only the flag here is why `@charset "UTF-8";` — one line of
        // plain CSS — failed under the table with `expected: ["routed()"]`: the
        // fallback ran at the selector's END with no routed token, so the
        // `routed()` inside it had nothing to yield. Every case arm was already
        // walked (`branchUsesRouted(c)` above); the fallback was the one branch
        // that was not.
        const otherRouted = d.otherwise === undefined
          ? false
          : branchUsesRouted({ parser: d.otherwise as Combinator<unknown>, usesRouted: d.otherwiseUsesRouted === true })
        this.code[head + 4] = otherRouted ? 1 : 0
        this.code[head + 5] = arms.length
        for (let i = 0; i < arms.length; i++) this.code[head + 6 + i] = arms[i]!
        return head
      }
      case 'field':
        return this.emit(OP_FIELD, this.constant(d.name), this.node(d.parser).ip)
      case 'lazy': {
        // A named reference is not a hop: it resolves to the target's row.
        // Emitting a trampoline here cost one dispatch per reference for nothing.
        //
        // AN UNDEFINED `ref()` IS TOLERATED, not refused. `ref<T>()` throws from
        // its thunk until `.define()` runs, and codegen catches exactly this and
        // falls back to running the ref live (`emitLazy`'s two `catch` arms ->
        // `emitRuntimeFallback`), so a grammar assembled before every slot is
        // filled still COMPILES and throws only if that slot is actually parsed
        // through. The encoder threw at build time instead, which made the table
        // lowering refuse a grammar the source lowering accepts. Deferring to the
        // ref's own `.parse` reproduces codegen's timing and its message.
        // BY NAME first, when this reference names a rule of the map being
        // encoded — see `winners` for why a thunk is the wrong resolver for a
        // merged (composed) map, and why the identity guard is required.
        const refName = (p as unknown as { _ruleName?: string })._ruleName
        const winner = refName === undefined ? undefined : this.winners?.[refName]
        if (winner !== undefined && !wrapsRef(winner, p)) return this.scopedRef(p, winner)
        let resolved: Combinator<unknown>
        try { resolved = d.thunk() }
        catch {
          this.runtimeOnly.add('ref() used before .define() — the slot is run live')
          return this.emit(OP_LIVE, this.fn(p, null))
        }
        return this.scopedRef(p, resolved)
      }
      // `not.ts:50` fails with EXACTLY `not(<child tag>)`, at the assertion's own
      // position — the same shape `OP_PEEK` below carries. The table emitted no
      // expected operand at all, so a `not()` failure reported `[]` where every
      // other engine reported `['not(literal)']`. It hid because `expected` is a
      // TOP-LEVEL field on `RunResult` and is NOT part of the identity digest.
      case 'not':
        return this.emit(OP_NOT, this.node(d.parser).ip, this.expected([`not(${d.parser._tag})`]))
      case 'guard':
        // `'gate'`, the public name — see gate.ts. The def tag stays `'guard'`.
        return this.emit(OP_GUARD, this.fn(d.predicate, d.predSrc ?? null), this.expected(['gate']))
      case 'adjacency':
        // A `kinds` LIST IS VALIDATED HERE, at encode time, against the trivia
        // table in scope — the same `resolveAdjacencyKindMask` the interpreter
        // calls on first reach and codegen calls while emitting the `_akN` probe
        // (`codegen.ts:1034`). Deferring it to the driver's parse-time resolution
        // left `compile()` accepting a grammar whose kind name no active table
        // declares: an unlabelled table or a typo'd category compiled clean and
        // threw only when an input happened to reach the assertion.
        if (d.kinds !== undefined) resolveAdjacencyKindMask(this.activeTrivia, d.kinds)
        // The expected label is `adjacencyExpected`'s, not `deriveExpected`'s:
        // the interpreter fails with exactly `adjacent` / `notAdjacent` /
        // `notAdjacent(a|b)` (adjacency.ts `adjacencyFail`) and codegen emits the
        // same string, so this is the one the identity sweep compares.
        return this.emit(
          OP_ADJ,
          d.polarity === 'notAdjacent' ? 1 : 0,
          d.kinds === undefined ? -1 : this.kindsSlot(d.kinds),
          this.expected([adjacencyExpected(d)]),
        )
      case 'withCtx': {
        // `extra` is arbitrary user data in the const pool. `emitConst` takes
        // scalars, arrays of scalars, and plain objects of those — anything
        // richer (a class instance, a function value) RUNS fine but cannot be
        // printed into a module. Record it as a runtime-only reason so emit
        // refuses BY NAME rather than throwing a raw TypeError from the printer.
        if (!emittableConst(d.extra)) {
          this.runtimeOnly.add('withCtx(extra) — the state object is not serialisable')
        }
        return this.emit(OP_WITHCTX, this.constant(d.extra), this.node(d.parser).ip)
      }
      case 'peek':
        // The expected set is the ASSERTION's, not the body's: `peek.ts:60`
        // reports `peek(<child tag>)` and DISCARDS what the body wanted — a
        // lookahead's failure is "the guard did not hold", and naming the body's
        // internals offers a token the parse never asked the author for. The
        // table propagated the body's set instead.
        return this.emit(OP_PEEK, this.node(d.parser).ip, this.expected([`peek(${d.parser._tag})`]))
      // A TRANSACTION IS A ROW. See `OP_ATTEMPT` for why the transparent
      // lowering was correct only for a choice arm.
      case 'attempt': {
        const inner = this.emit(OP_ATTEMPT, this.node(d.parser).ip)
        // THE FIRST-SET FAIL-FAST GUARD, lowered as the `OP_GATE` row the `node()`
        // case already uses — it is the same guard, written twice in the
        // interpreter (`attempt.ts:22`, `node.ts:239`). It is NOT merely an
        // optimisation: when it fires it reports the STATIC `deriveExpected` of
        // the inner, which for a body with nullable leading terms names tokens the
        // run itself would have skipped past. Running the inner instead reported a
        // strictly smaller set, so omitting the guard was an observable divergence,
        // not a slower equivalent.
        const fs = d.parser._meta.firstSet
        if (fs.kind === 'any' || matchesEmpty(d.parser)) return inner
        const cls = this.charClass(fs)
        if (cls < 0) return inner
        const e = deriveExpected(d.parser)
        return this.emit(OP_GATE, cls, inner, this.expected(e.length > 0 ? e : [d.parser._tag]))
      }
      // A LABEL IS A ROW — see `OP_LABEL`. It replaces the child's expected set,
      // which is the entire combinator.
      // A LABEL IS CREDITED ON SUCCESS, as `codegen.ts:4530` credits it: its hook
      // is emitted AFTER the child's statements, where a failed child has already
      // broken out of the labelled block.
      case 'label':
        return this.covWrap(
          this.emit(OP_LABEL, this.node(d.parser).ip, this.expected([d.label])),
          this.plan?.labels.get(p)?.[0],
          1,
        )
      // Transparent wrapper: no row of its own, no dispatch at run time.
      case 'trivia':
        return this.node(d.parser).ip
      case 'grammar': {
        // Fail closed on the scope switches this encoder does not carry. `trackLines`
        // is the one field here that is RECONCILED rather than refused: the driver
        // takes it from TableSettings, so a scope asking for something different is a
        // silent disagreement between the grammar and the artifact.
        // `rootCapture: 'opaque'` is INERT for parsing. grammar.ts reads it only
        // inside a `_rootTriviaStrictScopes` validation throw; it declares that
        // this scope's trivia is opaque to root capture, which `run()` consumes.
        // Nothing in the parse changes, so there is nothing for the table to
        // lower — accepting it is not a gap, it is the correct lowering.
        // ONLY `true` IS MEANINGFUL HERE. `grammar.ts:94` stores
        // `opts.trackLines ?? false`, so an UNSET scope and an explicitly-false
        // one are the same value on the def — the distinction is lost. At parse
        // time `:103` reads `opts.trackLines ?? _ctx?.trackLines ?? false`, i.e.
        // unset INHERITS. So stored-false cannot be read as "force off", and
        // comparing it against the setting refused every inner scope of a
        // trackLines:true grammar — all four `*PositionsGrammar`s.
        //
        // A SCOPE THAT ASKS FOR TRACKING NO LONGER REFUSES. `encodeTable` folds
        // every such scope into the table's own `track` before encoding begins
        // (see `hasScopedTrackLines`), exactly as codegen folds them into one
        // `ctx.lineTracking` for the whole compile. The refusal here was reachable
        // only because the table read the SETTING alone, and it made the table
        // lowering reject `parser({ trackLines: true }, …)` — a grammar
        // `compile()` accepts and annotates.
        // A trivia scope is a ROW, not a lowering decision: the scope's trivia
        // combinator goes in the const pool and the driver installs it.
        // `captureTrivia: true` picks the SCOPE_CAP piece. It is an OR with the
        // inherited context in the interpreter (`grammar.ts:129`), never a
        // switch-off, so a scope without it emits plain SCOPE and leaves an
        // outer capture alone. A scope that ONLY asks for capture still needs a
        // row — hence the `cap` branch before the `triviaParser === undefined`
        // shortcut, which would otherwise drop the request on the floor.
        const cap = d.captureTrivia === true
        const op = cap ? OP_SCOPE_CAP : OP_SCOPE
        // ROOT-CAPTURE POLICY, as two bits on the row (ip + 3).
        //
        // `rootCapture: 'opaque'` is NOT inert — that claim was wrong, and it is
        // what let a table parse hand back root markers from a region the grammar
        // declared opaque. `grammar.ts:141` sets `ctx._rootTriviaCapture = false`
        // for the scope, and the scope's ctx is a COPY there, so the flag reverts
        // by construction; the table shares one ctx, so the piece has to restore it.
        //
        // Bit 1 is the STRICT-SCOPE refusal `grammar.ts:98` raises: with selected
        // root trivia active, a local scope whose trivia is not classified and is
        // not declared opaque cannot be reported faithfully, so it throws rather
        // than silently dropping markers. Codegen emits the same throw
        // (codegen.ts:4705); the table emitted nothing at all.
        const flags = (d.rootCapture === 'opaque' ? 1 : 0)
          | (d.triviaParser !== undefined
            && d.triviaParser._meta.rootTriviaClassified !== true
            && d.rootCapture !== 'opaque' ? 2 : 0)
        // THE SCOPE'S TRIVIA IS IN SCOPE FOR ITS BODY. Tracked across the child
        // descent so `case 'adjacency'` can resolve a `kinds` list against the
        // table that will actually be active there, exactly as codegen's
        // `ctx.activeTrivia` does. Saved and restored rather than assigned,
        // because a scope is nestable and an inner one does not leak outward.
        const savedTrivia = this.activeTrivia
        if (d.clearTrivia === true) this.activeTrivia = undefined
        else if (d.triviaParser !== undefined) this.activeTrivia = d.triviaParser
        const bodyIp = this.node(d.parser).ip
        this.activeTrivia = savedTrivia
        if (d.clearTrivia === true) return this.emit(op, -1, bodyIp, flags)
        if (d.triviaParser === undefined) {
          return cap || flags !== 0 ? this.emit(op, -1, bodyIp, flags) : bodyIp
        }
        return this.emit(op, this.triviaSlot(d.triviaParser), bodyIp, flags)
      }
      /**
       * A HAND-WRITTEN COMBINATOR. `_def: { tag: 'unknown' }` is the designated
       * escape for a parser built outside the library, so there is no structure
       * to lower — the behaviour is a closure. Codegen accepts one and delegates
       * to `.parse` at run time (`emitRuntimeFallback`); refusing it here made
       * the table lowering reject a grammar the source lowering compiles.
       *
       * Runtime-only BY NAME, because a live combinator cannot be printed —
       * codegen degrades the same way (`runtimeParsers` non-empty ⇒ no
       * `inlineExpression`).
       */
      case 'unknown':
        this.runtimeOnly.add(`${p._tag} — a hand-written combinator, run live through its own .parse`)
        return this.emit(OP_LIVE, this.fn(p, null))
      default:
        // NOT widened to `OP_LIVE`. A LIBRARY tag reaching here is a missing
        // lowering, and silently running it live would trade a build error for a
        // permanent slow path nobody would ever find.
        throw new UnsupportedConstruct(d.tag)
    }
  }

  /**
   * Peephole: an `OP_RULE` row is pure indirection — a switch dispatch and a
   * call frame to do nothing but jump. Rewrite every child slot that points at
   * one to point at its target instead. Transitive, and cycle-safe by bounding
   * the walk at the number of rows.
   */
  private collapseIndirection(): void {
    const resolve = (ip: number): number => {
      let t = ip
      for (let n = 0; n < this.code.length && this.code[t] === OP_RULE; n++) t = this.code[t + 1]!
      return t
    }
    const slots = (ip: number): number[] => {
      switch (this.code[ip]) {
        case OP_GATE: return [ip + 2]
        case OP_RULE: case OP_OPT: case OP_NOT: case OP_PEEK: case OP_EXPECT: case OP_ATTEMPT: case OP_LABEL: case OP_COV: return [ip + 1]
        case OP_SCOPE: case OP_SCOPE_CAP: case OP_SCOPE_PLAIN: case OP_WITHCTX: case OP_XFORM: case OP_LEAF: case OP_NODE: case OP_NODE_TRACK: return [ip + 2]
        case OP_SEQ: case OP_SEQV: return Array.from({ length: this.code[ip + 1]! }, (_, i) => ip + 2 + i)
        case OP_SEQX: return Array.from({ length: this.code[ip + 2]! }, (_, i) => ip + 3 + i)
        // ARMS START AT ip+4. `ip+3` is the choice's own EXPECTED-SET index, and
        // rewriting it here treated an `fx` index as a code offset: when the row
        // at that offset happened to be `OP_RULE` the index was replaced by that
        // row's target, so a failing choice reported a different expected set —
        // and the bogus "target" was then pushed onto the walk and its operands
        // rewritten as if they were child slots. It also left the LAST arm
        // uncollapsed, which is the only part of this that was merely slow.
        case OP_CHOICE: return Array.from({ length: this.code[ip + 2]! }, (_, i) => ip + 4 + i)
        // GREEDY's operands INTERLEAVE a const index with an arm offset, so only
        // the odd slots are children — rewriting a const-pool index as if it were
        // a code offset is the same class of bug the OP_CHOICE note above records.
        case OP_GREEDY: return [ip + 1, ...Array.from({ length: this.code[ip + 2]! }, (_, i) => ip + 4 + 2 * i)]
        // REJECT's check operands are const/class indices, never offsets.
        case OP_REJECT: return [ip + 1]
        case OP_REP: case OP_REPV: return this.code[ip + 4]! >= 0 ? [ip + 1, ip + 4] : [ip + 1]
        default: return []
      }
    }
    const seen = new Set<number>()
    // Scan subtrees are ROOTS too: a sentinel or skipper is reached through
    // `prog.scans`, not through any code slot, so leaving them out left their
    // interiors uncollapsed and — worse — left the spec's own offset pointing at
    // a trampoline whose target had been rewritten around it.
    const refs: SubtreeRef[] = []
    for (const s of this.scans) {
      if (s.sentinel !== undefined) refs.push(s.sentinel)
      refs.push(...s.skip)
    }
    for (const set of this.scanSkipSets) refs.push(...set)
    const stack = [...Object.values(this.rules), ...refs.map(r => r[0])]
    while (stack.length > 0) {
      const ip = stack.pop()!
      if (seen.has(ip)) continue
      seen.add(ip)
      for (const slot of slots(ip)) {
        const target = resolve(this.code[slot]!)
        this.code[slot] = target
        stack.push(target)
      }
    }
    for (const name of Object.keys(this.rules)) this.rules[name] = resolve(this.rules[name]!)
    const res = (r: SubtreeRef): SubtreeRef => [resolve(r[0]), r[1]]
    this.scans = this.scans.map(s => ({
      ...s,
      skip: s.skip.map(res),
      ...(s.sentinel === undefined ? {} : { sentinel: res(s.sentinel) }),
    }))
    this.scanSkipSets = this.scanSkipSets.map(set => set.map(res))
  }

  finish(): TableProgram {
    if (this.code.length === 0) this.emit(OP_EMPTY)
    this.collapseIndirection()
    return ownTableProgram({
      code: this.code, k: this.k, fns: this.fns, cc: this.cc,
      fx: this.fx, disp: this.disp, dsp: this.dsp, rules: this.rules,
      ...(this.labels === undefined ? {} : { labels: this.labels }),
      ...(this.classified ? { classified: 1 as const } : {}),
      ...(this.scanSkipSets.length === 0
        ? {}
        : { scanSkip: this.scanSkipSets, scanSkipOf: this.scanSkipOf }),
      ...(this.scans.length === 0 ? {} : { scans: this.scans }),
      ...(this.settings.hostMode === undefined ? {} : { hostMode: this.settings.hostMode }),
      ...(this.runtimeOnly.size === 0 ? {} : { runtimeOnly: [...this.runtimeOnly].sort() }),
      ...(this.triviaSpecs.length === 0 ? {} : { triviaSpecs: this.triviaSpecs }),
      ...(this.rec ? { rec: 1 as const } : {}),
      ...(this.cov === undefined ? {} : { cov: this.cov }),
      lines: this.track ? 1 : 0,
    })
  }
}

/**
 * Encode a rule map into ONE table for ONE settings pair.
 *
 * Two settings pairs give two programs and therefore two cached reference
 * tables; the driver that reads them is the same function in both cases and
 * never sees `settings`.
 */
/**
 * Does this grammar ask for line tracking anywhere in its own structure?
 *
 * TRACKING IS A WHOLE-TABLE DECISION, as it is a whole-compile decision for the
 * source lowering: `ctx.lineTracking` is `opts.trackLines || grammarTrackLines ||
 * hasLineTrackingDef(combinator)` (`compiler/codegen.ts`). The table read the
 * SETTING alone and refused any `parser({ trackLines: true }, …)` scope it found
 * underneath, so a grammar that carries its own tracking compiled through
 * codegen and was rejected by the encoder. Same question, same answer.
 *
 * A `lazy` is followed, because a rule reference is how a grammar reaches most of
 * itself; an undefined one answers `false` rather than throwing, as codegen's does.
 */
function hasScopedTrackLines(p: Combinator<unknown>, seen: Set<Combinator<unknown>>): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  if (p._meta.grammarTrackLines === true) return true
  const d = p._def
  switch (d.tag) {
    case 'grammar':
      if (d.trackLines === true) return true
      break
    case 'lazy':
      try { return hasScopedTrackLines(d.thunk(), seen) }
      catch { return false }
    // Neither is covered by the shared `childrenOf`: it drops `dispatch` matcher
    // arms and treats `routed()` as a leaf.
    case 'dispatch':
      for (const m of d.matchers ?? []) if (hasScopedTrackLines(m.parser, seen)) return true
      break
    case 'routed':
      return d.fallback === undefined ? false : hasScopedTrackLines(d.fallback, seen)
    default:
      break
  }
  for (const c of childrenOf(d)) if (hasScopedTrackLines(c, seen)) return true
  return false
}

export function encodeTable(
  ruleMap: Record<string, Combinator<unknown>>,
  settings: TableSettings = {},
): TableProgram {
  return encodeTableProgram(ruleMap, settings).prog
}

/**
 * `encodeTable` PLUS the reducer sources, for a caller that must PRINT the table.
 *
 * The sources are not on `TableProgram` because they are not data the driver
 * reads and must never travel in an emitted artifact; they are the printer's
 * input, in `prog.fns` order. A build that lowers macro-evaluated combinators
 * gets a real source per entry (`fnSrc` / `buildSrc` / `predSrc` / `gateSrcs`,
 * set by the macro evaluator); a runtime caller gets `null`s and must therefore
 * refuse to print rather than emit `() => {}` placeholders.
 */
export function encodeTableProgram(
  ruleMap: Record<string, Combinator<unknown>>,
  settings: TableSettings = {},
): { prog: TableProgram; fnSrcs: (string | null)[] } {
  // Line tracking is decided ONCE for the whole artifact, as codegen does
  // (`opts.trackLines || grammarTrackLines || hasLineTrackingDef(combinator)`).
  // Reading only the SETTING made the table narrower than codegen and refused a
  // `parser({ trackLines: true })` scope that codegen simply accepts.
  const names = Object.keys(ruleMap)
  const seen = new Set<Combinator<unknown>>()
  const track = settings.trackLines === true
    || names.some(n => hasScopedTrackLines(ruleMap[n]!, seen))
  // Same precedence as compileRuleMap/compose: an explicit lowering option wins;
  // otherwise a `rules({ hostMode: 'cst' })` declaration stamped on its entries
  // selects CST. (`'ast'` is the unstamped default.) Reading only `settings`
  // produced two opposite contracts for one grammar: compose refused a hostless
  // run while public encodeTable silently emitted and stamped an AST table.
  const hostMode = settings.hostMode
    ?? names.map(n => ruleMap[n]!._meta.grammarHostMode).find(Boolean)
  const resolvedSettings = {
    ...settings,
    ...(hostMode === undefined ? {} : { hostMode }),
    ...(track ? { trackLines: true } : {}),
  }
  const enc = new Encoder(resolvedSettings)
  enc.winners = ruleMap
  for (const name of names) enc.encodeRule(name, ruleMap[name]!)
  const prog = enc.finish()
  return { prog, fnSrcs: enc.fnSrcs }
}
