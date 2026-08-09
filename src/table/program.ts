import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { classifiedTrivia, trivia as triviaOf } from '../combinators/map.ts'
import { fastTriviaScanner, type FastTriviaScanner } from '../combinators/trivia-skip.ts'
import { regex } from '../combinators/regex.ts'
import { choice } from '../combinators/choice.ts'
import { many } from '../combinators/repeat.ts'
import type { EmittedFactory, PoolPlan } from './emit-assembly.ts'

/**
 * One assembly the BUILD already compiled, so the run does not have to.
 *
 * `key` is `cfgKey(RunCfg)` — the scalar option bits an assembly is specialised
 * for. `factory` is the emitted scope as a real function literal, taking
 * `EMITTED_PARAMS` in order. `plan` rebuilds the three data pools the factory
 * expects (see `PoolPlan`), and `reached` is the emitter's site set, which
 * `Assembly.reached` publishes and `test/unit/table-assemble.test.ts`
 * asserts on.
 */
export type PrecompiledAssembly = {
  readonly key: number
  readonly factory: EmittedFactory
  readonly plan: PoolPlan
  readonly reached: readonly number[]
}

/**
 * The emitted form of a grammar under the table lowering.
 *
 * This object is ALL a grammar contributes to a bundle. Every line of
 * recognition logic lives in `exec.ts`, which ships once in the runtime and is
 * shared by every grammar and every variant. A rule costs its row, not a
 * function.
 *
 * Serialized shape is deliberately JSON-ish (numbers, strings, and a pool of
 * author callbacks) so the emitter can print it as a literal.
 */
export type TableProgram = {
  /** Flat instruction stream. See `ops.ts` for operand layouts. */
  readonly code: readonly number[]
  /** Const pool: literal strings and STICKY regexes. */
  readonly k: readonly unknown[]
  /** Author callbacks: `transform`/`leaf` reducers and `node()` builders. */
  readonly fns: readonly unknown[]
  /**
   * Char classes, one string per class, as consecutive `[lo, hi]` code-point
   * pairs. Compact in source and expanded to an ASCII lookup at load.
   */
  readonly cc: readonly string[]
  /** Expected-set pool for failure reporting; indices appear on terminals. */
  readonly fx: readonly (readonly string[])[]
  /** Dispatch tables: per choice, the arms' char-class indices (−1 = no gate). */
  readonly disp: readonly (readonly number[])[]
  /**
   * `dispatch()` tables. Deliberately plain arrays of strings and numbers rather
   * than prepared `Map`s: the emitted module has to be able to PRINT this, and a
   * Map in the const pool would fail `emitConst` closed. The Maps are built once
   * at `resolveTable`, exactly like the char-class ASCII lookups.
   */
  readonly dsp: readonly DispatchSpec[]
  /** Rule name → entry offset in `code`. */
  readonly rules: Readonly<Record<string, number>>
  /**
   * 1 when this table's terminals are the line-tracking rows. It is TABLE DATA,
   * read once when the rule map is built, so the entry wrapper is chosen at load
   * rather than branched on per parse.
   */
  readonly lines?: 0 | 1
  /**
   * The grammar trivia's kind labels, and whether it is root-classified.
   *
   * `run()` reads these off the ENTRY (`triviaKindLabelsFromRunnable`,
   * run.ts:220) and takes the `typeof r === 'function'` branch for a compiled
   * entry, which codegen stamps with `_meta`. A table entry is also a function,
   * so without carrying and stamping these, `run({ rootTrivia })` throws
   * "requires labeled grammar trivia" for a grammar that plainly has them.
   */
  readonly labels?: readonly string[]
  readonly classified?: 0 | 1
  /**
   * Grammar-level ambient `scanSkip` sets, as SUBTREE REFERENCES. Same
   * entry-metadata trap as `labels`: `run.ts:270` reads
   * `entry._meta.grammarScanSkip` only for a NON-function entry, so a table entry
   * never got it and `ctx.scanSkip` stayed empty — silently changing what
   * `scanTo`/`balanced` skip over.
   *
   * WAS a list of live combinators: unemittable, and not even listed in
   * `runtimeOnly`, so a module would have parsed with an empty skip list. It was
   * sound only because `scanTo()`/`balanced()` — the sole readers of
   * `ctx.scanSkip` — were themselves emit-blocked. They no longer are, so this is
   * data.
   *
   * A POOL, not one set, and `scanSkipOf` says which rules carry which. The set is
   * a property of the RULE, not of the program: `rules({ scanSkip }, …)` stamps
   * `_meta.grammarScanSkip` on each of ITS rules
   * (`src/combinators/parser.ts:210`), a `parser()` scope has no `scanSkip` field
   * at all, and `run()` installs the set belonging to the ENTRY rule
   * (`src/combinators/grammar.ts:203`). In a `composeLeaf` grammar the pieces do
   * not agree — 67 of jess's 195 css rules carry no ambient set — so installing
   * one program-wide set gave those entries a skip list the interpreter does not
   * give them.
   */
  readonly scanSkip?: readonly (readonly SubtreeRef[])[]
  /**
   * Per rule, the index into `scanSkip` its entry installs, or −1. Parallel to
   * `Object.keys(rules)`.
   */
  readonly scanSkipOf?: readonly number[]
  /** Scan specs, referenced by index from `OP_SCAN`. */
  readonly scans?: readonly ScanSpec[]
  /**
   * The host mode this table was BUILT for.
   *
   * `run()` reads it off the entry via `FUSED_HOST_MODE` and
   * `assertHostModeCompatible` throws when a `'cst'` artifact is run without a
   * CST host. Without the stamp a `hostMode: 'cst'` table returned the
   * grammar's own AST objects with `ok: true` while paying full CST capture —
   * the compiled engine throws on the same input.
   */
  readonly hostMode?: 'ast' | 'cst'
  /**
   * Why this program cannot be EMITTED, if it cannot. Populated at encode time
   * so the failure names the construct instead of surfacing as a generic
   * "cannot serialise [object Object]" from deep inside the printer.
   */
  readonly runtimeOnly?: readonly string[]
  /**
   * Trivia specs, referenced by index from `OP_SCOPE`, `OP_SCOPE_CAP` and
   * `OP_SCOPE_PLAIN` rule/restoration entries.
   *
   * `classifiedTrivia()` is `trivia(oneOrMore(choice(label(name, arm)…)))` with
   * regex arms — entirely structural, so it lowers to DATA and is rebuilt at
   * load with the shared `classifiedTrivia`/`trivia`/`regex`. That keeps the one
   * trivia implementation (labels, root log, cst log, masks, the fast scanner)
   * instead of growing a second one over the table, while making the program
   * printable. Pooling the live combinator was what broke emit for every
   * `rules({ trivia }, …)` grammar.
   */
  readonly triviaSpecs?: readonly TriviaSpec[]
  /**
   * 1 when this table was encoded with `TableSettings.recovery` — the sequences
   * carry their inferred follow-set classes and the repetitions their item
   * expected-set and separator sentinel class.
   *
   * TABLE DATA, read once when the driver/assembly is built. It selects the
   * recovery pieces; it is not a per-parse option, and a recovery table still
   * recovers only when a parse sets `ctx._tolerant`.
   */
  readonly rec?: 0 | 1
  /**
   * THE GRAMMAR-COVERAGE DEFINITION POOL, present only on a table encoded with
   * `TableSettings.coverage`. `[id, kind]` per definition, in the order
   * `buildGrammarPlan` produces (sorted by id), and `OP_COV`'s `id` operand
   * indexes it.
   *
   * DEFINITIONS SHIP AS TABLE DATA rather than being scraped back out of the
   * emitted text. The source lowering's macro path recovers its denominator by
   * regex-scanning the generated hooks (`plugin/index.ts` `emittedCoverageDefinitions`),
   * which it has to do because its IDs only exist inside generated statements. A
   * table has no statements, so there is nothing to scan — and an empty scrape is
   * NO MEASUREMENT reported as 100% coverage, which is the exact failure
   * `'coverage-definitions-unavailable'` was declared for. Carrying the pool is
   * what lets `compileRuleMap` hand back `coverageDefinitions` directly.
   *
   * THE POOL IS THE WHOLE DENOMINATOR, not merely the instrumented sites. A
   * definition with no `OP_COV` row can never be hit, so it drags the ratio DOWN.
   * That is the direction this project requires an instrumentation gap to fail in.
   */
  readonly cov?: readonly (readonly [id: string, kind: 0 | 1 | 2 | 3])[]
  /**
   * Optional emitted-factory inventory, keyed by `cfgKey(RunCfg)`.
   *
   * Normal `compile()` and macro output both carry an explicit empty inventory
   * (`a:[]`) and select the compact closure assembler. Presence of this field
   * permanently disables runtime `Function` construction: an unserved option
   * set uses closures. A missing field is reserved for an explicit low-level
   * hand-built `tableRules(program)` caller, never a compiler-created artifact.
   */
  readonly asm?: readonly PrecompiledAssembly[]
}

/**
 * The one compact artifact shape produced by the table compiler.
 *
 * Compiler and macro artifacts are explicitly closure-backed: an empty
 * inventory is materially different from an absent one, which is reserved for
 * a caller that deliberately hands `tableRules()` a live runtime program.
 */
export function closureArtifact(prog: TableProgram): TableProgram {
  return { ...prog, asm: [] }
}

/**
 * `GrammarCoverageDefinition['kind']` as the small integer `prog.cov` carries,
 * and back. Two functions rather than a shared array literal so the mapping is
 * exhaustive over the union in BOTH directions — a fifth kind added to
 * `grammar-coverage-ids.ts` fails to compile here instead of silently encoding
 * as `undefined` and reading back as `'rule'`.
 */
export function covKindCode(kind: 'rule' | 'choice-arm' | 'dispatch-arm' | 'label'): 0 | 1 | 2 | 3 {
  switch (kind) {
    case 'rule': return 0
    case 'choice-arm': return 1
    case 'dispatch-arm': return 2
    case 'label': return 3
  }
}

export function covKindName(code: 0 | 1 | 2 | 3): 'rule' | 'choice-arm' | 'dispatch-arm' | 'label' {
  switch (code) {
    case 0: return 'rule'
    case 1: return 'choice-arm'
    case 2: return 'dispatch-arm'
    case 3: return 'label'
  }
}

/** The pool read back as the public definition shape `compiledGrammarCoverageDefinitions` validates. */
export function covDefinitions(prog: TableProgram): readonly { id: string; kind: 'rule' | 'choice-arm' | 'dispatch-arm' | 'label' }[] {
  return (prog.cov ?? []).map(([id, kind]) => ({ id, kind: covKindName(kind) }))
}

/**
 * A reference to a table SUBTREE, standing in for a combinator.
 *
 * `[ip, cls]`: `ip` is the subtree's offset in `code`; `cls` indexes its first set
 * in `cc`, −1 for `any` and −2 for `empty`. The first set is carried because
 * `buildBalancedInterior` reads each skipper's own first set to decide whether its
 * content run can be a bounded regex (`src/combinators/scanTo.ts:280`) — a
 * reference that reported `any` would silently rebuild a DIFFERENT, slower
 * interior than the grammar's own.
 */
export type SubtreeRef = readonly [ip: number, cls: number]

/**
 * A scanning construct as its CONSTRUCTOR ARGUMENTS.
 *
 * `kind` 0 is `scanTo`, 1 is `balanced`. `flags` bit 0 = `raw`, bit 1 = `orEOF`
 * (scanTo), bit 2 = `strict` (balanced). `sent` is the sentinel's literal text
 * when it is a `literal()`, so the rebuilt scan reports the same expected set as
 * the interpreter, and `null` otherwise (which reports `"sentinel"`).
 */
export type ScanSpec = {
  readonly kind: 0 | 1
  readonly flags: number
  readonly skip: readonly SubtreeRef[]
  readonly sentinel?: SubtreeRef
  readonly sent?: string | null
  readonly open?: string
  readonly close?: string
}

/** A trivia combinator as data. `arms` empty means a plain `trivia(regex)`. */
export type TriviaSpec = {
  /** `[label, regexSource, regexFlags]` per classified arm. */
  readonly arms: readonly (readonly [string, string, string])[]
  /** Set for a plain `trivia(regex)`: `[source, flags]`. */
  readonly plain?: readonly [string, string]
  /**
   * Set for an UNLABELLED alternation body — `trivia(oneOrMore(choice(ws,
   * comment)))`, which is what a grammar that does not need trivia CATEGORIES
   * writes and what `examples/css/parser.ts` has always written. `[source,
   * flags]` per arm, in order, because a PEG choice is ordered.
   *
   * Distinct from `arms` rather than folded into it with a synthetic label:
   * `classifiedTrivia()` puts its labels in the CST trivia log, so a made-up name
   * would appear in a consumer's tree for a category the grammar never declared.
   */
  readonly alts?: readonly (readonly [string, string])[]
  /** The `alts` repetition floor — 1 for `oneOrMore`, 0 for `many`. */
  readonly min?: number
  /**
   * A trivia combinator whose shape this encoder cannot express as data, kept
   * live so the program still RUNS. Its presence is recorded in `runtimeOnly`,
   * so emit refuses and names it rather than failing inside the printer.
   */
  readonly live?: unknown
}

/**
 * The wire form an artifact actually prints — same table, short keys. Kept
 * separate from `TableProgram` so the encoder stays readable and the emitted
 * module stays small.
 */
export type CompactProgram = {
  readonly c: readonly number[]
  readonly k: readonly unknown[]
  readonly x: readonly string[]
  readonly e: readonly (readonly string[])[]
  readonly d: readonly (readonly number[])[]
  readonly r: Readonly<Record<string, number>>
  readonly f: readonly unknown[]
  readonly l?: 0 | 1
  readonly p?: readonly DispatchSpec[]
  readonly lb?: readonly string[]
  readonly rc?: 0 | 1
  readonly h?: 'ast' | 'cst'
  readonly tv?: readonly TriviaSpec[]
  readonly sc?: readonly ScanSpec[]
  readonly ss?: readonly (readonly SubtreeRef[])[]
  readonly so?: readonly number[]
  readonly rv?: 0 | 1
  readonly cv?: readonly (readonly [string, 0 | 1 | 2 | 3])[]
  /** Pre-compiled assemblies — see `TableProgram.asm`. */
  readonly a?: readonly PrecompiledAssembly[]
}

export function expandCompact(p: TableProgram | CompactProgram): TableProgram {
  if ('code' in p) return p
  return ownTableProgram({
    code: p.c, k: p.k, cc: p.x, fx: p.e, disp: p.d, rules: p.r, fns: p.f,
    lines: p.l ?? 0, dsp: p.p ?? [],
    ...(p.lb === undefined ? {} : { labels: p.lb }),
    ...(p.rc === undefined ? {} : { classified: p.rc }),
    ...(p.h === undefined ? {} : { hostMode: p.h }),
    ...(p.tv === undefined ? {} : { triviaSpecs: p.tv }),
    ...(p.sc === undefined ? {} : { scans: p.sc }),
    ...(p.ss === undefined ? {} : { scanSkip: p.ss }),
    ...(p.so === undefined ? {} : { scanSkipOf: p.so }),
    ...(p.rv === undefined ? {} : { rec: p.rv }),
    ...(p.cv === undefined ? {} : { cov: p.cv }),
    ...(p.a === undefined ? {} : { asm: p.a }),
  })
}

/** One `dispatch()`'s routing tables, in serialisable form. */
export type DispatchSpec = {
  /** Exact keys, parallel to `keyArm`. */
  readonly key: readonly string[]
  readonly keyArm: readonly number[]
  /** ASCII-folded keys for case-insensitive cases, parallel to `foldArm`. */
  readonly fold: readonly string[]
  readonly foldArm: readonly number[]
  /**
   * `[kind, value, flags, arm]` per matcher. `kind` is 0/1/2 for
   * startsWith/endsWith/matches, and 3/4 for the ASCII-FOLDED startsWith/endsWith
   * a `{ caseInsensitive: true }` matcher arm encodes to — `value` is pre-folded
   * for those and the driver folds the selector key before comparing. A
   * case-insensitive `matches` needs no kind of its own: it folds into the
   * regex's own `i` flag.
   */
  readonly match: readonly (readonly [number, string, string, number])[]
  /** 1 when that arm consumes the routed token. */
  readonly routed: readonly number[]
  /** Expected set when nothing matches — every case key, JSON-quoted. */
  readonly expected: readonly string[]
}

export type ResolvedDispatchSpec = {
  readonly byKey: ReadonlyMap<string, number>
  readonly byFold: ReadonlyMap<string, number>
  readonly match: readonly (readonly [number, string, string, number])[]
  readonly routed: readonly number[]
  readonly expected: readonly string[]
}

/** Refuse malformed fixed arm references before closure or emitted linking. */
export function validateDispatchSpec(spec: ResolvedDispatchSpec, arity: number): void {
  const invalid = (arms: Iterable<number>): boolean => {
    for (const arm of arms) if (!Number.isInteger(arm) || arm < 0 || arm >= arity) return true
    return false
  }
  if (!Number.isInteger(arity) || arity < 0 || spec.routed.length !== arity
    || invalid(spec.byKey.values()) || invalid(spec.byFold.values())
    || spec.match.some(matcher => invalid([matcher[3]]))) {
    throw new TypeError('table: malformed dispatch')
  }
}

/** A char class expanded for execution: O(1) for ASCII, ranges above it. */
export type ResolvedClass = {
  readonly ascii: Uint8Array
  readonly hi: readonly number[]
}

/** A dispatch table expanded for execution. */
export type ResolvedDispatch = {
  /** charCode → arm index + 1, 0 = no arm claims it. Read only when `exclusive`. */
  readonly ascii: Uint8Array
  /** `[lo, hi, arm]` triples for code points ≥ 128. Read only when `exclusive`. */
  readonly hi: readonly number[]
  /** Arms with no gate at all — tried in order after a dispatch miss. */
  readonly open: readonly number[]
  /**
   * The arms' OWN classes, positionally — `null` where the arm is nullable or
   * its first set does not map to a class, and so cannot be gated.
   *
   * This is the per-arm gate, and it is what the compiled engine has always had:
   * `emitFirstMatch` guards each arm on its own first set, which is sound
   * whatever the other arms do. The table used to demand that ALL arms be
   * disjoint, non-nullable and mappable before it would gate ANY of them, so a
   * single unmappable arm made the whole site speculative — 98.6% of arm entries
   * on `benchmark.less` were at such sites, and 88.8% of those failed.
   */
  readonly armCls: readonly (ResolvedClass | null)[]
  /**
   * True when the arms' classes are pairwise disjoint and every arm has one, so
   * "the first arm whose class holds this char" IS "the first arm that matches"
   * and the O(1) `ascii`/`hi` selection is sound. When false the arms are tried
   * in order, each skipped by its own `armCls` entry — same order, same result,
   * fewer entries.
   *
   * Computed from the RESOLVED classes rather than read off the encoder's
   * `disjointSets` on first sets: the classes are what selection actually reads,
   * so testing them is both tighter and the property that has to hold.
   */
  readonly exclusive: boolean
}

/**
 * The `(grammar, settings)` reference table, built ONCE and cached.
 *
 * This is the object G5 names: the run path reads it and never branches on an
 * option. Two settings pairs produce two of these; the driver is the same code.
 */
export type ResolvedTable = {
  readonly prog: TableProgram
  readonly code: Int32Array
  readonly k: readonly unknown[]
  readonly fns: readonly unknown[]
  readonly cc: readonly ResolvedClass[]
  readonly fx: readonly (readonly string[])[]
  readonly disp: readonly ResolvedDispatch[]
  readonly dsp: readonly ResolvedDispatchSpec[]
  /** Trivia combinators rebuilt from `triviaSpecs`, once per table. */
  readonly trivia: readonly Combinator<unknown>[]
  /**
   * THE TRIVIA LEAF SWAP (G5: "some swaps on rules or sub-rules (leafs)").
   *
   * Each trivia entry's SPECIALISED scanner, resolved here rather than looked up
   * per sequence term, and `null` where the shape has no lowering. Parallel to
   * `trivia`, so a scope installs both by the same index.
   */
  readonly triviaScan: readonly (FastTriviaScanner | null)[]
  /** Per trivia entry: does it carry kind labels? Decided here, never per parse. */
  readonly triviaLabelled: readonly boolean[]
  readonly rules: Readonly<Record<string, number>>
}

/**
 * Runtime state owned by a table object from the moment that object is made.
 * The symbol stays out of wire data; the nested cell lets resolution fill the
 * cache without changing the program object's V8 shape.
 */
const TABLE_RUNTIME = Symbol('parseman.tableRuntime')
type RuntimeTableProgram = TableProgram & {
  readonly [TABLE_RUNTIME]?: { resolved: ResolvedTable | undefined }
}

/** Give an internally-created program its fixed-shape runtime owner. */
export function ownTableProgram(prog: TableProgram, resolved?: ResolvedTable): TableProgram {
  return { ...prog, [TABLE_RUNTIME]: { resolved } } as RuntimeTableProgram
}

/** A compiled entry, shaped exactly like a codegen rule function. */
export type TableRule = (input: string, pos: number, ctx: ParseContext) => ParseResult<unknown>

// A valid range always has lo <= hi, so this pair cannot be the first encoded
// range. It marks the wide format without stealing or escaping any BMP code
// point (notably U+FFFF, which appears often in generated negated classes).
const WIDE_CLASS_PREFIX_LO = 0xffff
const WIDE_CLASS_PREFIX_HI = 0

/** Fail closed on a class range before it reaches either wire format. */
function validateClassRange(lo: number, hi: number): void {
  for (const cp of [lo, hi]) {
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) {
      throw new TypeError(`table char-class endpoint is outside Unicode: ${cp}`)
    }
  }
  if (lo > hi) {
    throw new TypeError(`table char-class range is descending: ${lo} > ${hi}`)
  }
}

/** Encode consecutive `[lo, hi]` code-point pairs without truncating astral endpoints. */
export function encodeClassSpec(ranges: readonly { lo: number; hi: number }[]): string {
  let wide = false
  for (const range of ranges) {
    validateClassRange(range.lo, range.hi)
    if (range.hi > 0xffff) wide = true
  }
  if (!wide) {
    let spec = ''
    for (const range of ranges) spec += String.fromCharCode(range.lo, range.hi)
    return spec
  }

  let spec = String.fromCharCode(WIDE_CLASS_PREFIX_LO, WIDE_CLASS_PREFIX_HI)
  for (const range of ranges) {
    spec += String.fromCharCode(
      range.lo >>> 16, range.lo & 0xffff,
      range.hi >>> 16, range.hi & 0xffff,
    )
  }
  return spec
}

/** Decode the consecutive `[lo, hi]` code-point pairs in a class spec. */
export function decodeClassSpec(spec: string): Array<{ lo: number; hi: number }> {
  if (spec.charCodeAt(0) === WIDE_CLASS_PREFIX_LO && spec.charCodeAt(1) === WIDE_CLASS_PREFIX_HI) {
    if ((spec.length - 2) % 4 !== 0) throw new TypeError('table char-class spec has a truncated wide range')
    if (spec.length === 2) throw new TypeError('table char-class spec has a wide prefix but no ranges')
    const ranges: Array<{ lo: number; hi: number }> = []
    for (let i = 2; i < spec.length; i += 4) {
      const lo = spec.charCodeAt(i) * 0x10000 + spec.charCodeAt(i + 1)
      const hi = spec.charCodeAt(i + 2) * 0x10000 + spec.charCodeAt(i + 3)
      validateClassRange(lo, hi)
      ranges.push({ lo, hi })
    }
    return ranges
  }

  if (spec.length % 2 !== 0) throw new TypeError('table char-class spec has an unmatched range endpoint')
  const ranges: Array<{ lo: number; hi: number }> = []
  for (let i = 0; i < spec.length; i += 2) {
    const lo = spec.charCodeAt(i)
    const hi = spec.charCodeAt(i + 1)
    validateClassRange(lo, hi)
    ranges.push({ lo, hi })
  }
  return ranges
}

export function resolveClass(spec: string): ResolvedClass {
  const ascii = new Uint8Array(128)
  const hi: number[] = []
  for (const { lo, hi: up } of decodeClassSpec(spec)) {
    if (lo < 128) for (let c = lo; c <= Math.min(up, 127); c++) ascii[c] = 1
    if (up >= 128) hi.push(Math.max(lo, 128), up)
  }
  return { ascii, hi }
}

export function classHas(cls: ResolvedClass, code: number): boolean {
  if (code < 0) return false
  if (code < 128) return cls.ascii[code] === 1
  const hi = cls.hi
  for (let i = 0; i < hi.length; i += 2) if (code >= hi[i]! && code <= hi[i + 1]!) return true
  return false
}

function resolveDispatch(arms: readonly number[], cc: readonly ResolvedClass[]): ResolvedDispatch {
  const ascii = new Uint8Array(128)
  const hi: number[] = []
  const open: number[] = []
  const armCls: (ResolvedClass | null)[] = []
  // Disjointness over the ASCII plane, accumulated as the arms are laid in: a
  // second arm claiming a char another already claims makes O(1) selection
  // unsound, because "first class that holds c" stops being "first arm that
  // matches". Above ASCII the `hi` ranges are not indexed, so any arm with a
  // high range beyond the first is treated as overlapping — conservative, and
  // the per-arm path below is correct for it either way.
  let exclusive = true
  let hiOwners = 0
  for (let a = 0; a < arms.length; a++) {
    const ci = arms[a]!
    if (ci < 0) { open.push(a); armCls.push(null); exclusive = false; continue }
    const cls = cc[ci]!
    armCls.push(cls)
    for (let c = 0; c < 128; c++) {
      if (cls.ascii[c] !== 1) continue
      if (ascii[c] === 0) ascii[c] = a + 1
      else exclusive = false
    }
    if (cls.hi.length > 0 && ++hiOwners > 1) exclusive = false
    for (let i = 0; i < cls.hi.length; i += 2) hi.push(cls.hi[i]!, cls.hi[i + 1]!, a)
  }
  return { ascii, hi, open, armCls, exclusive }
}

/**
 * Build the reference table for a program. Memoized per program OBJECT, which
 * is the `(grammar, settings)` pair: the emitter produces one program per pair,
 * so two variants are two cache entries and the run path never sees an option.
 */
/** Rebuild a trivia combinator from its spec using the SHARED constructors. */
function buildTrivia(spec: TriviaSpec): Combinator<unknown> {
  if (spec.live !== undefined) return spec.live as Combinator<unknown>
  if (spec.plain !== undefined) return triviaOf(regex(new RegExp(spec.plain[0], spec.plain[1])))
  if (spec.alts !== undefined) {
    const [head, ...rest] = spec.alts.map(([source, flags]) => regex(new RegExp(source, flags)))
    if (head === undefined) throw new TypeError('trivia spec has an EMPTY alternation, which matches nothing')
    const body = rest.length === 0 ? head : choice(head, ...rest)
    // `many(x, { min: 1 })` and `oneOrMore(x)` are the IDENTICAL combinator, not
    // merely equivalent — min>=1 routes to the same `atLeast` implementation
    // (combinators/repeat.ts:126-131). So this rebuilds the source shape exactly
    // for both floors and there is no second constructor to keep in step.
    return triviaOf(many(body, { min: spec.min ?? 1 }))
  }
  const arms: Record<string, Combinator<unknown>> = {}
  for (const [name, source, flags] of spec.arms) arms[name] = regex(new RegExp(source, flags))
  return classifiedTrivia(arms)
}

export function resolveTable(prog: TableProgram): ResolvedTable {
  const owner = (prog as RuntimeTableProgram)[TABLE_RUNTIME]
  const hit = owner?.resolved
  if (hit !== undefined) return hit
  const cc = prog.cc.map(resolveClass)
  const triviaBuilt = (prog.triviaSpecs ?? []).map(buildTrivia)
  const built: ResolvedTable = {
    prog,
    code: Int32Array.from(prog.code),
    k: prog.k,
    fns: prog.fns,
    cc,
    fx: prog.fx,
    disp: prog.disp.map(d => resolveDispatch(d, cc)),
    trivia: triviaBuilt,
    triviaScan: triviaBuilt.map(fastTriviaScanner),
    triviaLabelled: triviaBuilt.map(t => t._meta.triviaKindLabels !== undefined),
    dsp: prog.dsp.map(d => ({
      byKey: new Map(d.key.map((x, i) => [x, d.keyArm[i]!])),
      byFold: new Map(d.fold.map((x, i) => [x, d.foldArm[i]!])),
      match: d.match,
      routed: d.routed,
      expected: d.expected,
    })),
    rules: prog.rules,
  }
  if (owner !== undefined) owner.resolved = built
  return built
}

/* ── THE VARIANT FOLD (ledger row G4) ────────────────────────────────────── */

/**
 * One variant's whole difference from the base table, as SPARSE ROW EDITS.
 *
 * G5 says the variants *"differ in table contents, not in code"*, and G4 asks
 * for ONE compiled output per input grammar. Measured across jess's four
 * dialects, the four `trackLines` x `hostMode` tables differ in `code` and in
 * two scalars and in NOTHING else — `k`, `cc`, `fx`, `disp`, `dsp`, `rules`,
 * `fns`, `labels`, `classified`, `scanSkip`, `scanSkipOf`, `scans` and
 * `triviaSpecs` are byte-identical in all four, and the code streams are the
 * same LENGTH. So a variant is not another table. It is a list of words to
 * overwrite.
 *
 * `at` is stored as ASCENDING GAPS, not absolute offsets: the edits are dense
 * enough (mean gap under 10 on every dialect) that gaps are one or two digits
 * where offsets are four, and the load-time cost of the difference is one `+=`.
 */
export type TableDelta = {
  /** Gaps between successive edited word offsets; the first is absolute. */
  readonly at: readonly number[]
  /** Replacement words, parallel to `at`. */
  readonly to: readonly number[]
  readonly lines?: 0 | 1
  readonly hostMode?: 'ast' | 'cst'
}

/** A base table plus the row edits that turn it into each named variant. */
export type FoldedProgram = {
  readonly base: TableProgram
  /** Variant name → its edits. The base's own name maps to an empty delta. */
  readonly variants: Readonly<Record<string, TableDelta>>
}

const FOLDED_RUNTIME = Symbol('parseman.foldedRuntime')
type RuntimeFoldedProgram = FoldedProgram & {
  readonly [FOLDED_RUNTIME]?: { byName: Map<string, TableProgram> }
}

function ownFoldedProgram(
  base: TableProgram,
  variants: Readonly<Record<string, TableDelta>>,
): FoldedProgram {
  return { base, variants, [FOLDED_RUNTIME]: { byName: new Map() } } as RuntimeFoldedProgram
}

/** The wire form a folded artifact prints — short keys, as `CompactProgram`. */
export type CompactFolded = {
  readonly b: CompactProgram
  readonly v: Readonly<Record<string, { a?: readonly number[]; t?: readonly number[]; l?: 0 | 1; h?: 'ast' | 'cst' }>>
}

/**
 * The fields a fold requires to be IDENTICAL across every variant.
 *
 * Named rather than derived so the refusal can say which one broke.
 */
const SHARED_FIELDS = [
  'k', 'cc', 'fx', 'disp', 'dsp', 'rules', 'labels', 'classified',
  'scanSkip', 'scanSkipOf', 'scans', 'triviaSpecs', 'runtimeOnly',
  // `rec` is a property of the GRAMMAR BUILD, not of the trackLines/hostMode
  // axis a fold varies — every variant of one export is encoded with the same
  // recovery setting, and a mismatch is two tables, which is what the refusal says.
  'rec',
  // `cov` is a property of the GRAMMAR and its coverage plan, for the same reason
  // `rec` is a property of the build: the plan is built from the rule map, which
  // every variant of one export shares. It ships ONCE, and a variant that
  // disagrees is two tables — which is what the refusal says.
  'cov',
] as const satisfies readonly (keyof TableProgram)[]

/**
 * Every field of `TableProgram`, classified: shared once, compared by identity
 * (`fns`), overwritten per variant (`code`), or carried on the delta as a
 * scalar (`lines`, `hostMode`).
 *
 * `FoldExhaustive` fails to COMPILE the moment a field is added to
 * `TableProgram` without a decision, which is the only way this list can be kept
 * honest. A new variant-dependent field landing in `SHARED_FIELDS`' blind spot
 * would ship one variant's data under every variant's name, and every parse
 * would succeed.
 */
/**
 * `asm` is classified as DROPPED, and it is the only field in that class.
 *
 * A pre-compiled assembly is emitted FROM a `code` stream, and `code` is exactly
 * what a fold overwrites per variant — so a base assembly is wrong for every
 * variant but the base, and silently so: it would parse, and parse the base
 * grammar. Folding therefore happens BEFORE pre-compiling, and `foldPrograms`
 * refuses an input that already carries one rather than dropping it quietly.
 */
type FoldDropped = 'asm'
type FoldClassified = 'code' | 'fns' | 'lines' | 'hostMode' | FoldDropped | (typeof SHARED_FIELDS)[number]
type AssertNever<T extends never> = T
export type FoldExhaustive = AssertNever<Exclude<keyof TableProgram, FoldClassified>>

/**
 * Fold N encoded programs into ONE table plus per-variant row edits.
 *
 * FAILS CLOSED, and that is the point. Every assumption the fold rests on is
 * asserted here against the actual programs, so a grammar or a setting that
 * breaks one produces a build error naming the field — not an artifact that
 * loads and parses with the wrong table. The alternative, trusting a measurement
 * taken once on four grammars, is how a variant axis acquires a silent third
 * dimension.
 *
 * `fns` is compared by IDENTITY, not by source text. Two closures can print the
 * same and capture different scopes; sharing one pool between variants is only
 * sound when they are literally the same functions, which they are when the
 * variants are encodings of ONE grammar export.
 */
export function foldPrograms(
  programs: Readonly<Record<string, TableProgram>>,
  baseName: string,
): FoldedProgram {
  const suppliedBase = programs[baseName]
  if (suppliedBase === undefined) throw new TypeError(`foldPrograms: no program named ${JSON.stringify(baseName)}`)
  // The in-memory fold and its emitted form must be the same artifact: the
  // emitter prints `a:[]`, so preserve that policy when a caller folds tables
  // directly instead of loading a module.
  const base = closureArtifact(suppliedBase)
  const variants: Record<string, TableDelta> = {}
  for (const name of Object.keys(programs)) {
    const p = programs[name]!
    // See `FoldDropped`. Refused rather than dropped: a base assembly carried
    // onto a variant parses the BASE grammar under the variant's name, which no
    // test that only asks "did it parse" would ever see.
    if (p.asm !== undefined && p.asm.length > 0) {
      throw new TypeError(
        `foldPrograms: program ${JSON.stringify(name)} already carries pre-compiled assemblies. `
        + 'An assembly is emitted from a `code` stream and a fold overwrites `code` per variant, so '
        + 'pre-compiling must happen AFTER the fold, per variant — not before it.',
      )
    }
    /**
     * AN EMPTY `asm` IS NOT AN ASSEMBLY, it is the artifact saying "a build made
     * me" — the flag that switches the runtime `Function` constructor off. It
     * carries through the fold, because a folded artifact is no less a build
     * product than an unfolded one. `unfoldVariant` spreads the base, so the
     * variant inherits it.
     *
     * This mattered the moment `65fc9a4` moved `fold.ts` off the bytecode
     * interpreter onto `tableRules`: the interpreter never evaluated
     * anything, so the fold path was trivially clean, and swapping the driver
     * silently handed every folded artifact a `new Function` on its first parse.
     * `test/unit/no-function-constructor.test.ts` caught it on the merge.
     */
    if (p.code.length !== base.code.length) {
      throw new TypeError(
        `foldPrograms: variant ${JSON.stringify(name)} has ${p.code.length} code words, base `
        + `${JSON.stringify(baseName)} has ${base.code.length}. A fold overwrites words; it cannot `
        + 'resize the stream. These are two different tables, not one table and its edits.',
      )
    }
    for (const f of SHARED_FIELDS) {
      if (JSON.stringify(p[f]) !== JSON.stringify(base[f])) {
        throw new TypeError(
          `foldPrograms: variant ${JSON.stringify(name)} differs from base ${JSON.stringify(baseName)} `
          + `in ${JSON.stringify(f)}, which the fold ships ONCE. Either the variants are not encodings `
          + 'of one grammar, or this field has become variant-dependent and needs its own delta.',
        )
      }
    }
    if (p.fns.length !== base.fns.length || p.fns.some((f, i) => f !== base.fns[i])) {
      throw new TypeError(
        `foldPrograms: variant ${JSON.stringify(name)} does not share the base's reducer pool BY `
        + 'IDENTITY. Equal source text is not enough — two closures can print alike and capture '
        + 'different scopes. Encode every variant from ONE grammar export.',
      )
    }
    const at: number[] = []
    const to: number[] = []
    let prev = 0
    for (let i = 0; i < p.code.length; i++) {
      if (p.code[i] === base.code[i]) continue
      at.push(i - prev)
      to.push(p.code[i]!)
      prev = i
    }
    variants[name] = {
      at, to,
      ...(p.lines === undefined ? {} : { lines: p.lines }),
      ...(p.hostMode === undefined ? {} : { hostMode: p.hostMode }),
    }
  }
  return ownFoldedProgram(base, variants)
}

/**
 * Materialise ONE variant of a folded table, at load, when it is selected.
 *
 * Every field but `code` is shared BY REFERENCE with the base — no copying, no
 * re-parsing. The resolved table is derived from the base's, so N variants cost
 * ONE char-class expansion, ONE dispatch build and ONE trivia rebuild between
 * them instead of N. Selecting a variant is strictly LESS load work than
 * building an Nth independent table, which is the opposite of the usual
 * size-versus-load-time trade.
 *
 * The driver still sees nothing but a `TableProgram`. There is no variant flag
 * on the parse path and nothing here is consulted again after load — the option
 * half of G5 is untouched.
 */
export function unfoldVariant(folded: FoldedProgram, name: string): TableProgram {
  const byName = (folded as RuntimeFoldedProgram)[FOLDED_RUNTIME]?.byName
  const hit = byName?.get(name)
  if (hit !== undefined) return hit
  const d = folded.variants[name]
  if (d === undefined) {
    throw new TypeError(
      `unfoldVariant: no variant ${JSON.stringify(name)}. This table carries: `
      + `${Object.keys(folded.variants).map(n => JSON.stringify(n)).join(', ')}.`,
    )
  }
  const base = folded.base
  const code = [...base.code]
  let ip = 0
  for (let i = 0; i < d.at.length; i++) { ip += d.at[i]!; code[ip] = d.to[i]! }
  const raw: TableProgram = {
    ...base,
    code,
    ...(d.lines === undefined ? {} : { lines: d.lines }),
    ...(d.hostMode === undefined ? {} : { hostMode: d.hostMode }),
  }
  // Seeded from the BASE's resolved table: `cc`, `disp`, `dsp` and the rebuilt
  // trivia are identical by `foldPrograms`' own assertion, so N variants cost
  // ONE of each between them. Only the code stream is per variant.
  const prog = ownTableProgram(raw)
  const owner = (prog as RuntimeTableProgram)[TABLE_RUNTIME]!
  owner.resolved = { ...resolveTable(base), prog, code: Int32Array.from(code) }
  byName?.set(name, prog)
  return prog
}

export function expandCompactFolded(f: CompactFolded): FoldedProgram {
  const variants: Record<string, TableDelta> = {}
  for (const name of Object.keys(f.v)) {
    const d = f.v[name]!
    variants[name] = {
      at: d.a ?? [], to: d.t ?? [],
      ...(d.l === undefined ? {} : { lines: d.l }),
      ...(d.h === undefined ? {} : { hostMode: d.h }),
    }
  }
  return ownFoldedProgram(expandCompact(f.b), variants)
}
