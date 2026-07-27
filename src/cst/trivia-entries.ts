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
  /** Lazy entry-level view over the same root `_triviaLog`. */
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
