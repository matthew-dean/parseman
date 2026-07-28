import type { Span } from './types.ts'

/**
 * Precomputed index of newline positions for O(log n) offset->line/col lookup.
 * lineStarts[i] is the byte offset of the first character on line i+1.
 */
export type LineIndex = { lineStarts: number[] }
type LineTrackingContext = {
  trackLines?: boolean | undefined
  _lineIndex?: LineIndex | undefined
  _lineStarts?: number[] | undefined
  _lineScannedTo?: number | undefined
}

export function createLineIndex(): LineIndex {
  return { lineStarts: [0] }
}

export function buildLineIndex(input: string): LineIndex {
  const lineStarts = [0]
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) === 10) lineStarts.push(i + 1)
  }
  return { lineStarts }
}

/**
 * Record newline offsets for a matched range. Intended for optional parsers that
 * collect line starts while they consume terminals. The collector is deliberately
 * append-only: speculative parses never roll it back. Normalize once at the
 * driver boundary before doing offset->line/column lookup.
 */
export function recordLineRange(index: LineIndex, input: string, start: number, end: number): void {
  const lineStarts = index.lineStarts
  for (let i = start; i < end; i++) {
    if (input.charCodeAt(i) === 10) lineStarts.push(i + 1)
  }
}

export function recordLineRangeFromContext(
  ctx: LineTrackingContext,
  input: string,
  start: number,
  end: number,
): void {
  if (!ctx.trackLines) return
  const from = ctx._lineScannedTo ?? 0
  if (end <= from) return
  const index = ctx._lineIndex ?? (ctx._lineStarts ? { lineStarts: ctx._lineStarts } : undefined)
  if (!index) return
  recordLineRange(index, input, from, end)
  ctx._lineScannedTo = end
}

export function normalizeLineIndex(index: LineIndex): LineIndex {
  const starts = index.lineStarts
  starts.sort((a, b) => a - b)
  let write = 0
  for (let read = 0; read < starts.length; read++) {
    const value = starts[read]!
    if (write === 0 || starts[write - 1] !== value) starts[write++] = value
  }
  starts.length = write
  if (starts.length === 0 || starts[0] !== 0) starts.unshift(0)
  return index
}

export function offsetToLineCol(
  index: LineIndex,
  offset: number
): { line: number; col: number } {
  const { lineStarts } = index
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, col: offset - lineStarts[lo]! + 1 }
}

/** Fills startLine/startColumn/endLine/endColumn on a span in-place. */
export function annotateSpan(span: Span, index: LineIndex): Span {
  const s = offsetToLineCol(index, span.start)
  const e = offsetToLineCol(index, span.end)
  return {
    ...span,
    startLine: s.line,
    startColumn: s.col,
    endLine: e.line,
    endColumn: e.col,
  }
}

export function annotateSpanFromLineContext(
  span: Span,
  ctx: LineTrackingContext,
): Span {
  if (!ctx.trackLines) return span
  const index = ctx._lineIndex ?? (ctx._lineStarts ? { lineStarts: ctx._lineStarts } : undefined)
  return index ? annotateSpan(span, index) : span
}

function isSpan(value: unknown): value is Span {
  return !!value
    && typeof value === 'object'
    && typeof (value as { start?: unknown }).start === 'number'
    && typeof (value as { end?: unknown }).end === 'number'
}

/** Annotate every span-shaped object reachable from a parse result value. */
export function annotateTreeSpans<T>(value: T, index: LineIndex, seen: WeakSet<object> = new WeakSet()): T {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)

  const obj = value as Record<string, unknown>
  if (isSpan(obj.span)) obj.span = annotateSpan(obj.span, index)

  for (const key of Object.keys(obj)) {
    const child = obj[key]
    if (child && typeof child === 'object') annotateTreeSpans(child, index, seen)
  }
  return value
}
