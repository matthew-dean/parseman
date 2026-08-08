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
  return { start, end, startLine: s[0], startColumn: s[1], endLine: e[0], endColumn: e[1] }
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
  return {
    _tag: 'leaf',
    value: typeof v === 'string' ? v : (typeof v === 'object' && v !== null ? input.slice(s, e) : ''),
    span: { start: s, end: e },
  }
}

/** `input`'s code point at `pos`, or −1 at EOF. Surrogate-pair aware. */
export function lead(input: string, pos: number): number {
  if (pos >= input.length) return -1
  const c = input.charCodeAt(pos)
  if (c < 0xd800 || c > 0xdbff) return c
  return input.codePointAt(pos) ?? c
}
