/** View over a flat trivia log (`_triviaLog` or per-node `triviaLog`). */
export type TriviaEntriesView = {
  readonly length: number
  readonly labels: readonly string[] | undefined
  readonly stride: number
  start(i: number): number
  end(i: number): number
  kindIndex(i: number): number | undefined
  kind(i: number): string | undefined
  text(i: number, input: string): string
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
