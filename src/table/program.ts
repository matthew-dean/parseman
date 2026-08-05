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
  readonly rv?: 0 | 1
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
    ...(p.rv === undefined ? {} : { rec: p.rv }),
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
type FoldClassified = 'code' | 'fns' | 'lines' | 'hostMode' | (typeof SHARED_FIELDS)[number]
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
  const base = programs[baseName]
  if (base === undefined) throw new TypeError(`foldPrograms: no program named ${JSON.stringify(baseName)}`)
  const variants: Record<string, TableDelta> = {}
  for (const name of Object.keys(programs)) {
    const p = programs[name]!
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
  return { base, variants }
}

/** WeakMap-keyed per folded program, so repeated selection is a lookup. */
const _variantCache = new WeakMap<FoldedProgram, Map<string, TableProgram>>()

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
  let byName = _variantCache.get(folded)
  if (byName === undefined) { byName = new Map(); _variantCache.set(folded, byName) }
  const hit = byName.get(name)
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
  const prog: TableProgram = {
    ...base,
    code,
    ...(d.lines === undefined ? {} : { lines: d.lines }),
    ...(d.hostMode === undefined ? {} : { hostMode: d.hostMode }),
  }
  // Seeded from the BASE's resolved table: `cc`, `disp`, `dsp` and the rebuilt
  // trivia are identical by `foldPrograms`' own assertion, so N variants cost
  // ONE of each between them. Only the code stream is per variant.
  _tableCache.set(prog, { ...resolveTable(base), prog, code: Int32Array.from(code) })
  byName.set(name, prog)
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
  return { base: expandCompact(f.b), variants }
}
