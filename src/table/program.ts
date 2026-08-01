import type { ParseContext, ParseResult } from '../types.ts'

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
}

export function expandCompact(p: TableProgram | CompactProgram): TableProgram {
  if ('code' in p) return p
  return {
    code: p.c, k: p.k, cc: p.x, fx: p.e, disp: p.d, rules: p.r, fns: p.f,
    lines: p.l ?? 0, dsp: p.p ?? [],
    ...(p.lb === undefined ? {} : { labels: p.lb }),
    ...(p.rc === undefined ? {} : { classified: p.rc }),
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
const _tableCache = new WeakMap<TableProgram, ResolvedTable>()

export function resolveTable(prog: TableProgram): ResolvedTable {
  const hit = _tableCache.get(prog)
  if (hit !== undefined) return hit
  const cc = prog.cc.map(resolveClass)
  const built: ResolvedTable = {
    prog,
    code: Int32Array.from(prog.code),
    k: prog.k,
    fns: prog.fns,
    cc,
    fx: prog.fx,
    disp: prog.disp.map(d => resolveDispatch(d, cc)),
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
