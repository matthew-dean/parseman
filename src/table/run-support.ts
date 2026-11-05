/**
 * Assembly helpers that touch NO assembly state.
 *
 * They lived inside `assemble()`'s closure, where they captured nothing but were
 * re-created per assembly. The emitted engine (`emit-assembly.ts`) needs the
 * same three answers and must not carry a second copy of them — a second copy of
 * `rawEntry` is how a CST leaf's span drifts between two engines that are gated
 * against each other precisely so it cannot. Hoisted here so both engines call
 * ONE definition.
 *
 * Nothing here reads configuration: `spanLines` reads `ctx._lineStarts`, which
 * is per-parse STATE that the line-tracking assembly populates, and `rawEntry`
 * reads only its arguments.
 */
import type { ParseContext } from '../types.ts'
import { popCstChild, pushCstChild } from '../cst/capture-buffer.ts'
import { PlainLeaf, PlainLineSpan, PlainSpan } from '../cst/plain.js'
import type { EndCell } from './cell.ts'
import { fastTriviaScanner } from '../combinators/trivia-skip.ts'

export type Span = { start: number; end: number }
export type LineSpan = Span & {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

/** Binary search of `ctx._lineStarts` — `[line, column]`, both 1-based. */
export function lineCol(ctx: ParseContext, offset: number): [number, number] {
  const starts = ctx._lineStarts ?? [0]
  let lo = 0, hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return [lo + 1, offset - starts[lo]! + 1]
}

export function spanLines(ctx: ParseContext, start: number, end: number): LineSpan {
  const s = lineCol(ctx, start), e = lineCol(ctx, end)
  return new PlainLineSpan(start, end, s[0], s[1], e[0], e[1])
}

/**
 * The RAW child entry a node publishes beside its projected value.
 *
 * An already-shaped node/leaf/parseError passes through; anything else is
 * wrapped as a leaf over the source text it spanned.
 */
export function rawEntry(v: unknown, input: string, s: number, e: number): unknown {
  if (typeof v === 'object' && v !== null) {
    const tg = (v as { _tag?: string })._tag
    if (tg === 'node' || tg === 'leaf' || tg === 'parseError') return v
  }
  return new PlainLeaf(typeof v === 'string' ? v : (typeof v === 'object' && v !== null ? input.slice(s, e) : ''), new PlainSpan(s, e))
}

/** `input`'s code point at `pos`, or −1 at EOF. Surrogate-pair aware. */
export function lead(input: string, pos: number): number {
  if (pos >= input.length) return -1
  const c = input.charCodeAt(pos)
  if (c < 0xd800 || c > 0xdbff) return c
  return input.codePointAt(pos) ?? c
}

/**
 * `OP_CONT`, when the tail may start: the corner's publication to the parent is taken
 * back and it is held for the frame about to open. Its `EC.e` stays the corner's end.
 */
export function holdCorner(cell: EndCell, ctx: ParseContext, v: unknown, start: number, end: number): void {
  if (ctx._cstBuf !== undefined || ctx._cstChildren !== undefined || ctx._cstLeaves !== undefined) popCstChild(ctx)
  cell.sv = v
  cell.ss = start
  cell.se = end
}

/**
 * Where a sequence's next term would start, read without recording anything, in a
 * scope whose trivia the labels cannot name: `OP_CONT` looks past it and, where the
 * tail cannot start, a sequence would have rolled that gap back. −1: no scanner, so
 * no answer.
 */
export function pastTrivia(input: string, end: number, ctx: ParseContext): number {
  const t = ctx.trivia
  if (t === undefined) return end
  const s = fastTriviaScanner(t)
  return s === null ? -1 : s(input, end)
}

/**
 * `OP_SEED`: the corner `OP_CONT` holds, published into the frame it just opened,
 * with the raw entry the corner published to the parent. Runs first in that frame.
 */
export function publishSeed(cell: EndCell, ctx: ParseContext, input: string): unknown {
  const v = cell.sv
  const b = ctx._cstBuf
  pushCstChild(ctx, v, (b !== undefined ? b.noRaw === true : ctx._cstRawChildren === undefined)
    ? undefined
    : rawEntry(v, input, cell.ss, cell.se))
  cell.sv = undefined
  cell.e = cell.se
  return v
}

const EMPTY_KIDS: readonly unknown[] = Object.freeze([])
const EMPTY_TRIVIA: readonly number[] = Object.freeze([])

type CollapseBuild = (
  children: readonly unknown[], fields: undefined, span: { start: number; end: number },
  rawChildren: readonly unknown[], triviaLog: readonly number[], state: undefined,
) => unknown

/**
 * A PASS-THROUGH COLLAPSE whose one child built `undefined` (`site-labels.ts`
 * `passCollapse`).
 *
 * A collapse over a single node is that node: the node publishes its value into
 * the collector the collapse's parent opened, exactly where the collapse would
 * have published it, over the same span. So both engines run the body with no
 * frame of the collapse's own and hand its value up. The one value a frame would
 * have treated differently is `undefined`, which a frame does not count as a
 * child: the collapse then builds from no children. This is that case — take the
 * child's publication back and publish the build instead, as the frame would
 * have. The caller has already set `EC.e`.
 */
export function collapseEmpty(
  ctx: ParseContext, build: CollapseBuild, input: string, pos: number, end: number, readsRaw: boolean,
): unknown {
  const collected = ctx._cstBuf !== undefined || ctx._cstChildren !== undefined
  if (collected) popCstChild(ctx)
  // A frame keeps the raw entry of the child it does not count, for a reducer
  // that reads `rawChildren`.
  const raw = readsRaw ? [rawEntry(undefined, input, pos, end)] : EMPTY_KIDS
  const nd = build(EMPTY_KIDS, undefined, new PlainSpan(pos, end), raw, EMPTY_TRIVIA, undefined)
  if (collected) pushCstChild(ctx, nd, ctx._cstBuf?.noRaw === true ? undefined : rawEntry(nd, input, pos, end))
  return nd
}
