import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { classifiedTrivia, trivia as triviaOf } from '../combinators/map.ts'
import { fastTriviaScanner, type FastTriviaScanner } from '../combinators/trivia-skip.ts'
import { regex } from '../combinators/regex.ts'

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
   * Trivia specs, referenced by index from `OP_SCOPE` and from the rule entries.
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
}

export function expandCompact(p: TableProgram | CompactProgram): TableProgram {
  if ('code' in p) return p
  return {
    code: p.c, k: p.k, cc: p.x, fx: p.e, disp: p.d, rules: p.r, fns: p.f,
    lines: p.l ?? 0, dsp: p.p ?? [],
    ...(p.lb === undefined ? {} : { labels: p.lb }),
    ...(p.rc === undefined ? {} : { classified: p.rc }),
    ...(p.h === undefined ? {} : { hostMode: p.h }),
    ...(p.tv === undefined ? {} : { triviaSpecs: p.tv }),
    ...(p.sc === undefined ? {} : { scans: p.sc }),
    ...(p.ss === undefined ? {} : { scanSkip: p.ss }),
    ...(p.so === undefined ? {} : { scanSkipOf: p.so }),
  }
}

/** One `dispatch()`'s routing tables, in serialisable form. */
export type DispatchSpec = {
  /** Exact keys, parallel to `keyArm`. */
  readonly key: readonly string[]
  readonly keyArm: readonly number[]
  /** ASCII-folded keys for case-insensitive cases, parallel to `foldArm`. */
  readonly fold: readonly string[]
  readonly foldArm: readonly number[]
  /** `[kind, value, flags, arm]` per matcher; `kind` is 0/1/2 for startsWith/endsWith/matches. */
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

/** A char class expanded for execution: O(1) for ASCII, ranges above it. */
export type ResolvedClass = {
  readonly ascii: Uint8Array
  readonly hi: readonly number[]
}

/** A dispatch table expanded for execution. */
export type ResolvedDispatch = {
  /** charCode → arm index + 1, 0 = no arm claims it. */
  readonly ascii: Uint8Array
  /** `[lo, hi, arm]` triples for code points ≥ 128. */
  readonly hi: readonly number[]
  /** Arms with no gate at all — tried in order after a dispatch miss. */
  readonly open: readonly number[]
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

/** A compiled entry, shaped exactly like a codegen rule function. */
export type TableRule = (input: string, pos: number, ctx: ParseContext) => ParseResult<unknown>

export function resolveClass(spec: string): ResolvedClass {
  const ascii = new Uint8Array(128)
  const hi: number[] = []
  for (let i = 0; i < spec.length; i += 2) {
    const lo = spec.charCodeAt(i)
    const up = spec.charCodeAt(i + 1)
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
  for (let a = 0; a < arms.length; a++) {
    const ci = arms[a]!
    if (ci < 0) { open.push(a); continue }
    const cls = cc[ci]!
    for (let c = 0; c < 128; c++) if (cls.ascii[c] === 1 && ascii[c] === 0) ascii[c] = a + 1
    for (let i = 0; i < cls.hi.length; i += 2) hi.push(cls.hi[i]!, cls.hi[i + 1]!, a)
  }
  return { ascii, hi, open }
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
  const arms: Record<string, Combinator<unknown>> = {}
  for (const [name, source, flags] of spec.arms) arms[name] = regex(new RegExp(source, flags))
  return classifiedTrivia(arms)
}

const _tableCache = new WeakMap<TableProgram, ResolvedTable>()

export function resolveTable(prog: TableProgram): ResolvedTable {
  const hit = _tableCache.get(prog)
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
  _tableCache.set(prog, built)
  return built
}
