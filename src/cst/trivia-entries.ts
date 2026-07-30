/** View over a flat trivia log (`_triviaLog` or per-node `triviaLog`). */
export type TriviaEntriesView = {
  readonly length: number
  readonly labels: readonly string[] | undefined
  readonly stride: number
  start(i: number): number
  end(i: number): number
  /** Raw-child insertion boundary; defined only for a per-node trivia log. */
  insertIndex(i: number): number | undefined
  kindIndex(i: number): number | undefined
  kind(i: number): string | undefined
  text(i: number, input: string): string
}

export type RootTriviaGap = {
  /** Start offset of the contiguous trivia gap. */
  readonly start: number
  /** End offset of the contiguous trivia gap. */
  readonly end: number
  /** Entry indices into `entries` that make up this gap. */
  readonly entryIndices: readonly number[]
  /** True when any entry in the gap has the requested labeled trivia kind. */
  hasKind(kind: string): boolean
  /** Slice the full contiguous gap text from the original input. */
  text(input: string): string
}

export type RootTriviaIndex = {
  /** Whether entry spans are complete root gaps or selected markers within one. */
  readonly rootCaptureMode: 'allEntries' | 'selectedKinds'
  /** Lazy entry-level view over the root capture representation. */
  readonly entries: TriviaEntriesView
  /** Trivia kind labels, when the grammar labels trivia arms. */
  readonly labels: readonly string[] | undefined
  /**
   * Contiguous trivia gaps keyed by the following content offset. Values are
   * entry indices into `entries`, not materialized `{ value, span }` objects.
   */
  readonly before: ReadonlyMap<number, readonly number[]>
  /**
   * Contiguous trivia gaps keyed by the preceding content offset. Values are
   * entry indices into `entries`, not materialized `{ value, span }` objects.
   */
  readonly after: ReadonlyMap<number, readonly number[]>
  entryIndicesBefore(offset: number): readonly number[]
  entryIndicesAfter(offset: number): readonly number[]
  /**
   * Contiguous trivia gap immediately before `offset`, keyed by the following
   * content offset. Returns undefined when no gap sits at that boundary.
   */
  gapBefore(offset: number): RootTriviaGap | undefined
  /**
   * Contiguous trivia gap immediately after `offset`, keyed by the preceding
   * content offset. Returns undefined when no gap sits at that boundary.
   */
  gapAfter(offset: number): RootTriviaGap | undefined
  /** All contiguous trivia gaps in source order. */
  gaps(): readonly RootTriviaGap[]
  /** Source-ordered gaps containing at least one entry with the given label. */
  gapsWithKind(kind: string | readonly string[]): readonly RootTriviaGap[]
}

const EMPTY_INDICES: readonly number[] = Object.freeze([])
const EMPTY_GAPS: readonly RootTriviaGap[] = Object.freeze([])
const SELECTED_ROOT_STRIDE = 5

type RootTriviaMaps = {
  before: Map<number, number[]>
  after: Map<number, number[]>
  beforeGaps: Map<number, RootTriviaGap>
  afterGaps: Map<number, RootTriviaGap>
  gaps: RootTriviaGap[]
}

function entryOffset(i: number, stride: number): number {
  return i * stride
}

/**
 * Wrap a flat trivia log. Stride is inferred from `labels`:
 * - root `_triviaLog`: 2 (start, end) or 3 (+ kindIndex)
 * - node `triviaLog`: 3 (start, end, insertIdx) or 4 (+ kindIndex)
 */
export function triviaEntries(
  log: readonly number[],
  labels?: readonly string[],
  opts?: { nodeLog?: boolean },
): TriviaEntriesView {
  const baseStride = opts?.nodeLog ? 3 : 2
  const stride = labels ? baseStride + 1 : baseStride
  const length = Math.floor(log.length / stride)

  return {
    length,
    labels,
    stride,
    start(i) {
      return log[entryOffset(i, stride)]!
    },
    end(i) {
      return log[entryOffset(i, stride) + 1]!
    },
    insertIndex(i) {
      return opts?.nodeLog ? log[entryOffset(i, stride) + 2] : undefined
    },
    kindIndex(i) {
      if (!labels) return undefined
      return log[entryOffset(i, stride) + baseStride]
    },
    kind(i) {
      const ki = labels ? log[entryOffset(i, stride) + baseStride] : undefined
      return ki !== undefined ? labels![ki] : undefined
    },
    text(i, input) {
      const s = log[entryOffset(i, stride)]!
      const e = log[entryOffset(i, stride) + 1]!
      return input.slice(s, e)
    },
  }
}

function appendEntryRange(map: Map<number, number[]>, key: number, first: number, last: number): void {
  let indices = map.get(key)
  if (!indices) {
    indices = []
    map.set(key, indices)
  }
  for (let i = first; i <= last; i++) indices.push(i)
}

function buildGap(entries: TriviaEntriesView, start: number, end: number, first: number, last: number): RootTriviaGap {
  const entryIndices: number[] = []
  for (let i = first; i <= last; i++) entryIndices.push(i)

  return {
    start,
    end,
    entryIndices,
    hasKind(kind) {
      for (const i of entryIndices) {
        if (entries.kind(i) === kind) return true
      }
      return false
    },
    text(input) {
      return input.slice(start, end)
    },
  }
}

function buildRootMaps(entries: TriviaEntriesView): RootTriviaMaps {
  const before = new Map<number, number[]>()
  const after = new Map<number, number[]>()
  const beforeGaps = new Map<number, RootTriviaGap>()
  const afterGaps = new Map<number, RootTriviaGap>()
  const gaps: RootTriviaGap[] = []
  if (entries.length === 0) return { before, after, beforeGaps, afterGaps, gaps }

  const appendGap = (first: number, last: number, start: number, end: number): void => {
    const gap = buildGap(entries, start, end, first, last)
    gaps.push(gap)
    afterGaps.set(start, gap)
    beforeGaps.set(end, gap)
    appendEntryRange(after, start, first, last)
    appendEntryRange(before, end, first, last)
  }

  let first = 0
  let start = entries.start(0)
  let end = entries.end(0)

  for (let i = 1; i < entries.length; i++) {
    const nextStart = entries.start(i)
    const nextEnd = entries.end(i)
    if (nextStart === end) {
      end = nextEnd
      continue
    }
    appendGap(first, i - 1, start, end)
    first = i
    start = nextStart
    end = nextEnd
  }

  appendGap(first, entries.length - 1, start, end)
  return { before, after, beforeGaps, afterGaps, gaps }
}

/**
 * Build a lazy sparse index over a root `_triviaLog` as returned by `run()`.
 * Labeled trivia logs may split one gap into several adjacent chunks; this view
 * groups contiguous chunks so `before.get(nodeStart)` and `after.get(nodeEnd)`
 * return the full gap as entry indices. Text is still sliced only on demand via
 * `index.entries.text(i, input)`.
 */
export function buildRootTriviaIndex(
  log: readonly number[],
  labels?: readonly string[],
): RootTriviaIndex {
  const entries = triviaEntries(log, labels)
  let maps: RootTriviaMaps | undefined
  const getMaps = () => {
    maps ??= buildRootMaps(entries)
    return maps
  }

  return {
    rootCaptureMode: 'allEntries',
    entries,
    labels,
    get before() {
      return getMaps().before
    },
    get after() {
      return getMaps().after
    },
    entryIndicesBefore(offset) {
      return getMaps().before.get(offset) ?? EMPTY_INDICES
    },
    entryIndicesAfter(offset) {
      return getMaps().after.get(offset) ?? EMPTY_INDICES
    },
    gapBefore(offset) {
      return getMaps().beforeGaps.get(offset)
    },
    gapAfter(offset) {
      return getMaps().afterGaps.get(offset)
    },
    gaps() {
      return getMaps().gaps
    },
    gapsWithKind(kind) {
      const kinds = typeof kind === 'string' ? [kind] : kind
      const matches: RootTriviaGap[] = []
      for (const gap of getMaps().gaps) {
        for (const k of kinds) {
          if (gap.hasKind(k)) {
            matches.push(gap)
            break
          }
        }
      }
      return matches.length === 0 ? EMPTY_GAPS : matches
    },
  }
}

/**
 * Build a root view over selected-kind rows captured as
 * `[ownedRangeStart, ownedRangeEnd, markerStart, markerEnd, kindIndex]`.
 *
 * This is intentionally a different input shape from `triviaLog`: each row is
 * one selected marker, while the first pair names the complete committed trivia
 * range around it. Thus a whitespace / block-comment / whitespace run costs one
 * five-number row, not three
 * legacy trivia entries. Rows are source ordered and equal gap pairs are
 * contiguous, which lets singleton boundary lookups binary-search the sparse
 * rows without constructing document-wide maps.
 */
export function buildSelectedRootTriviaIndex(
  log: readonly number[],
  labels: readonly string[],
): RootTriviaIndex {
  const length = Math.floor(log.length / SELECTED_ROOT_STRIDE)
  const markerOffset = (i: number) => i * SELECTED_ROOT_STRIDE
  const ownedRangeStart = (i: number) => log[markerOffset(i)]!
  const ownedRangeEnd = (i: number) => log[markerOffset(i) + 1]!
  const markerStart = (i: number) => log[markerOffset(i) + 2]!
  const markerEnd = (i: number) => log[markerOffset(i) + 3]!
  const markerKind = (i: number) => log[markerOffset(i) + 4]!

  const entries: TriviaEntriesView = {
    length,
    labels,
    stride: SELECTED_ROOT_STRIDE,
    start: markerStart,
    end: markerEnd,
    insertIndex: () => undefined,
    kindIndex: markerKind,
    kind(i) {
      return labels[markerKind(i)]
    },
    text(i, input) {
      return input.slice(markerStart(i), markerEnd(i))
    },
  }

  const lowerBound = (offset: number, by: (i: number) => number): number => {
    let lo = 0
    let hi = length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (by(mid) < offset) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const gapRowsAt = (offset: number, direction: 'before' | 'after'): [number, number] | undefined => {
    const edge = direction === 'before' ? ownedRangeEnd : ownedRangeStart
    let first = lowerBound(offset, edge)
    if (first === length || edge(first) !== offset) return undefined
    const start = ownedRangeStart(first)
    const end = ownedRangeEnd(first)
    while (first > 0 && ownedRangeStart(first - 1) === start && ownedRangeEnd(first - 1) === end) first--
    let last = first + 1
    while (last < length && ownedRangeStart(last) === start && ownedRangeEnd(last) === end) last++
    return [first, last]
  }

  const indices = (first: number, last: number): readonly number[] => {
    const out: number[] = []
    for (let i = first; i < last; i++) out.push(i)
    return out
  }

  const makeGap = (first: number, last: number): RootTriviaGap => {
    const start = ownedRangeStart(first)
    const end = ownedRangeEnd(first)
    const entryIndices = indices(first, last)
    return {
      start,
      end,
      entryIndices,
      hasKind(kind) {
        for (let i = first; i < last; i++) {
          if (labels[markerKind(i)] === kind) return true
        }
        return false
      },
      text(input) {
        return input.slice(start, end)
      },
    }
  }

  let maps: RootTriviaMaps | undefined
  const getMaps = () => {
    if (maps !== undefined) return maps
    const before = new Map<number, number[]>()
    const after = new Map<number, number[]>()
    const beforeGaps = new Map<number, RootTriviaGap>()
    const afterGaps = new Map<number, RootTriviaGap>()
    const gaps: RootTriviaGap[] = []
    for (let first = 0; first < length;) {
      let last = first + 1
      while (last < length && ownedRangeStart(last) === ownedRangeStart(first) && ownedRangeEnd(last) === ownedRangeEnd(first)) last++
      const gap = makeGap(first, last)
      gaps.push(gap)
      afterGaps.set(gap.start, gap)
      beforeGaps.set(gap.end, gap)
      after.set(gap.start, [...gap.entryIndices])
      before.set(gap.end, [...gap.entryIndices])
      first = last
    }
    maps = { before, after, beforeGaps, afterGaps, gaps }
    return maps
  }

  return {
    rootCaptureMode: 'selectedKinds',
    entries,
    labels,
    get before() { return getMaps().before },
    get after() { return getMaps().after },
    entryIndicesBefore(offset) {
      const rows = gapRowsAt(offset, 'before')
      return rows ? indices(rows[0], rows[1]) : EMPTY_INDICES
    },
    entryIndicesAfter(offset) {
      const rows = gapRowsAt(offset, 'after')
      return rows ? indices(rows[0], rows[1]) : EMPTY_INDICES
    },
    gapBefore(offset) {
      const rows = gapRowsAt(offset, 'before')
      return rows ? makeGap(rows[0], rows[1]) : undefined
    },
    gapAfter(offset) {
      const rows = gapRowsAt(offset, 'after')
      return rows ? makeGap(rows[0], rows[1]) : undefined
    },
    gaps() {
      return getMaps().gaps
    },
    gapsWithKind(kind) {
      const kinds = typeof kind === 'string' ? [kind] : kind
      const matches: RootTriviaGap[] = []
      for (let first = 0; first < length;) {
        let last = first + 1
        while (last < length && ownedRangeStart(last) === ownedRangeStart(first) && ownedRangeEnd(last) === ownedRangeEnd(first)) last++
        for (let i = first; i < last; i++) {
          if (kinds.includes(labels[markerKind(i)]!)) {
            matches.push(makeGap(first, last))
            break
          }
        }
        first = last
      }
      return matches.length === 0 ? EMPTY_GAPS : matches
    },
  }
}
