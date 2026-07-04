import type { Span } from '../types.ts'

/**
 * Trivia-offset-inference model.
 *
 * The premise (see docs): most trivia carries nothing that isn't already implied
 * by the source offsets of the tokens around it. A gap between a slot ending at
 * 100 and the next starting at 103 IS three characters of trivia — known without
 * storing anything. So we store only the slot boundaries (which the tree already
 * has) and reconstruct trivia from them:
 *
 *   - exact printing: slice the source between two slots (`gapText`);
 *   - inference: widths / indents / alignment / blank-lines are subtraction;
 *   - positional queries: binary search over the sorted slot array (O(log n)),
 *     collapsing the old double-indexed before/after maps into one index.
 *
 * A "slot" is a leaf token's source span. Trivia lives in the GAPS between
 * consecutive slots (plus the leading gap before the first slot and the trailing
 * gap after the last). Gaps are fully determined by the sorted slot list, so
 * there is no separate trivia store for whitespace at all.
 */

/** A leaf token's source span — the anchor points; trivia is between them. */
export type Slot = { readonly start: number; readonly end: number }

/** A trivia region between two slots (or a document boundary). Half-open `[start, end)`. */
export type Gap = { readonly start: number; readonly end: number }

const { isFinite } = Number

/** Binary search: greatest index `i` in `arr[0..len)` with `arr[i] <= x`, or -1. */
function floorIndex(arr: readonly number[], len: number, x: number): number {
  let lo = 0
  let hi = len - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]! <= x) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * A positional index over an ordered set of slots (leaf spans) within a source
 * of length `docEnd`. Answers "what trivia is before/after/around this offset"
 * by binary search, and reconstructs the exact trivia text by slicing `source`.
 *
 * Slots must be non-overlapping. They are sorted by `start` on construction;
 * out-of-order or overlapping input throws (the caller's spans are wrong).
 */
export class OffsetIndex {
  /** Slot starts, sorted ascending. Parallel to `_ends`. */
  private readonly _starts: number[]
  private readonly _ends: number[]
  readonly count: number
  readonly docStart: number
  readonly docEnd: number

  constructor(slots: readonly Slot[], docStart = 0, docEnd?: number) {
    const sorted = [...slots].sort((a, b) => a.start - b.start)
    const starts: number[] = []
    const ends: number[] = []
    let prevEnd = docStart
    for (const s of sorted) {
      if (!isFinite(s.start) || !isFinite(s.end) || s.end < s.start) {
        throw new RangeError(`OffsetIndex: invalid slot [${s.start}, ${s.end}]`)
      }
      if (s.start < prevEnd) {
        throw new RangeError(`OffsetIndex: overlapping/out-of-order slot [${s.start}, ${s.end}] after end ${prevEnd}`)
      }
      starts.push(s.start)
      ends.push(s.end)
      prevEnd = s.end
    }
    this._starts = starts
    this._ends = ends
    this.count = starts.length
    this.docStart = docStart
    this.docEnd = docEnd ?? (this.count ? Math.max(prevEnd, ends[ends.length - 1]!) : docStart)
  }

  /** The slot at index `i` (0-based, source order), or undefined. */
  slot(i: number): Slot | undefined {
    if (i < 0 || i >= this.count) return undefined
    return { start: this._starts[i]!, end: this._ends[i]! }
  }

  /**
   * Index of the gap that CONTAINS `offset`, in `[0, count]`. Gap `i` spans
   * `[endOf(i-1), startOf(i))` where `endOf(-1)=docStart` and `startOf(count)=docEnd`.
   * An offset that lands inside a slot returns that slot's TRAILING gap index
   * (i.e. the gap after it) — callers querying at slot boundaries get the
   * intuitive answer via `gapBefore`/`gapAfter`.
   */
  gapIndexAt(offset: number): number {
    // Find the last slot whose start <= offset.
    const i = floorIndex(this._starts, this.count, offset)
    if (i < 0) return 0 // before the first slot → leading gap
    // offset is at or past slot i's start. If it's before slot i's end, it's
    // inside slot i → the gap after slot i is index i+1.
    if (offset < this._ends[i]!) return i + 1
    // offset is at/after slot i's end → in the gap after slot i (index i+1),
    // unless there's a later slot it precedes; either way that's gap i+1.
    return i + 1
  }

  /** The gap at index `i` in `[0, count]`. */
  gap(i: number): Gap | undefined {
    if (i < 0 || i > this.count) return undefined
    const start = i === 0 ? this.docStart : this._ends[i - 1]!
    const end = i === this.count ? this.docEnd : this._starts[i]!
    return { start, end }
  }

  /**
   * The trivia gap immediately BEFORE `offset` (`[prevSlotEnd, offset)`), where
   * `prevSlotEnd` is the end of the last slot ending at or before `offset` (or
   * `docStart`). For a real slot start this is the gap preceding that slot; for an
   * adjacent slot the gap is empty and agrees with `gapAfter` on the same seam.
   */
  gapBefore(offset: number): Gap | undefined {
    const e = floorIndex(this._ends, this.count, offset) // last slot end <= offset
    const start = e >= 0 ? this._ends[e]! : this.docStart
    return { start, end: offset }
  }

  /**
   * The trivia gap immediately AFTER `offset` (`[offset, nextSlotStart)`), where
   * `nextSlotStart` is the least slot start at or after `offset` (or `docEnd`).
   */
  gapAfter(offset: number): Gap | undefined {
    return { start: offset, end: this._ceilStart(offset) }
  }

  /** Least slot start `>= offset`, else `docEnd`. */
  private _ceilStart(offset: number): number {
    let lo = 0
    let hi = this.count - 1
    let ans = this.docEnd
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (this._starts[mid]! >= offset) {
        ans = this._starts[mid]!
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    return ans
  }

  /** Is this gap empty (adjacent slots, no trivia)? */
  isEmpty(gap: Gap): boolean {
    return gap.end <= gap.start
  }
}

// ---------------------------------------------------------------------------
// Reconstruction algebra: everything spatial is a subtraction over slot offsets
// plus the source (for exact printing) or the sparse marks (for inference).
// ---------------------------------------------------------------------------

const NL = 10 // '\n'
const CR = 13 // '\r'
const SP = 32 // ' '
const TAB = 9 // '\t'

/** Exact trivia text of a gap: `source.slice(gap.start, gap.end)`. */
export function gapText(source: string, gap: Gap): string {
  return gap.end > gap.start ? source.slice(gap.start, gap.end) : ''
}

/** Count of line breaks (`\n`, with `\r\n` counted once) within a gap. */
export function lineBreaksIn(source: string, gap: Gap): number {
  let n = 0
  for (let i = gap.start; i < gap.end; i++) {
    const c = source.charCodeAt(i)
    if (c === NL) n++
    else if (c === CR && source.charCodeAt(i + 1) !== NL) n++ // lone CR
  }
  return n
}

/** Blank lines in a gap = breaks - 1 (a single break is just a line end, not a blank line). */
export function blankLinesIn(source: string, gap: Gap): number {
  return Math.max(0, lineBreaksIn(source, gap) - 1)
}

/**
 * Offset just after the last line break in the gap (the start of the final
 * line's indent), or `gap.start` if the gap has no break. This is the ONE
 * non-inferable position; every indent quantity derives from it by subtraction.
 */
export function lineStartWithin(source: string, gap: Gap): number {
  for (let i = gap.end - 1; i >= gap.start; i--) {
    const c = source.charCodeAt(i)
    if (c === NL || c === CR) return i + 1
  }
  return gap.start
}

/**
 * Indent width of the line the NEXT slot sits on: `nextStart - lineStart`.
 * `nextStart` is `gap.end` (the following slot's start). Zero if the gap has no
 * line break (the next slot is on the same line).
 */
export function indentWidth(source: string, gap: Gap): number {
  const ls = lineStartWithin(source, gap)
  if (ls === gap.start) return 0 // same line, no break
  return gap.end - ls
}

/** True if the final line's indent mixes tabs and spaces (the one case width can't capture). */
export function indentMixed(source: string, gap: Gap): boolean {
  const ls = lineStartWithin(source, gap)
  let sawSpace = false
  let sawTab = false
  for (let i = ls; i < gap.end; i++) {
    const c = source.charCodeAt(i)
    if (c === SP) sawSpace = true
    else if (c === TAB) sawTab = true
  }
  return sawSpace && sawTab
}

/** Comment spans within a gap (absolute offsets), tokenized by `comment`. */
export function commentsIn(source: string, gap: Gap, comment: RegExp): Span[] {
  const re = new RegExp(comment.source, comment.flags.replace(/[gy]/g, '') + 'g')
  re.lastIndex = gap.start
  const out: Span[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) && m.index < gap.end) {
    if (m[0].length === 0) { re.lastIndex++; continue }
    if (m.index + m[0].length > gap.end) break
    out.push({ start: m.index, end: m.index + m[0].length })
  }
  return out
}

/**
 * Does the gap carry anything a normalizing printer must preserve? True if it
 * contains a comment or a line break; a pure inline-whitespace gap returns false
 * and needs no record at all (the printer re-derives canonical spacing).
 */
export function gapIsSignificant(source: string, gap: Gap, comment?: RegExp): boolean {
  if (gap.end <= gap.start) return false
  if (lineBreaksIn(source, gap) > 0) return true
  if (comment && commentsIn(source, gap, comment).length > 0) return true
  return false
}

// ---------------------------------------------------------------------------
// CST adapter: the positioned tree IS the index. Flatten a parseman CST to its
// leaf (terminal) slots in source order; the gaps between them are the trivia —
// no separate trivia store needed.
// ---------------------------------------------------------------------------

type AnyCstChild = {
  readonly _tag?: string
  readonly span?: { readonly start: number; readonly end: number }
  readonly children?: ReadonlyArray<unknown>
}

/**
 * Collect the leaf-token spans of a CST in source order. Nodes/errors (which
 * carry `children`) are descended into; only childless spanned items (terminals)
 * become slots. Node spans are skipped — they overlap their children and would
 * double-cover the gaps.
 */
export function collectLeafSlots(root: unknown): Slot[] {
  const slots: Slot[] = []
  const visit = (n: AnyCstChild): void => {
    const kids = n.children
    if (kids && kids.length) {
      for (const c of kids) visit(c as AnyCstChild)
    } else if (n.span) {
      slots.push({ start: n.span.start, end: n.span.end })
    }
  }
  if (root) visit(root as AnyCstChild)
  return slots
}

/**
 * Build an `OffsetIndex` directly from a parseman CST root and its source. This
 * is the drop-in replacement for the double-indexed `buildTriviaIndex`: the same
 * before/after trivia is recovered by `gapBefore`/`gapAfter` + `gapText`, and it
 * additionally supports arbitrary positional queries and inference — with nothing
 * stored per whitespace gap.
 */
export function buildOffsetIndex(root: unknown, input = ''): OffsetIndex {
  return new OffsetIndex(collectLeafSlots(root), 0, input.length)
}
