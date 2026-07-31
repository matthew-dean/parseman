/**
 * The SECOND world.
 *
 * A type error has one source to point at. A grammar finding has two — the ordered
 * choice whose arms cost the time, and the input that pays for it — and relating them is
 * the whole diagnostic. `gating.ts` owns the first world and is entirely static. This
 * module owns the second, and it is deliberately the smallest honest thing that can be
 * said about a corpus without instrumenting a parse.
 *
 * WHAT IS MEASURED, EXACTLY
 * -------------------------
 * For a choice, every corpus POSITION whose character is in some arm's first set. That
 * is a count of characters, not of times the choice was reached, and the difference
 * matters: a choice nested three rules deep is reached far less often than its first
 * characters occur. So the number is reported as what it is — an upper bound on entries,
 * derived from the same first sets the compiler dispatches on — and never as "this
 * choice ran N times". Naming it precisely is what keeps it useful; a number that
 * overstates itself is worse than no number, because the reader stops trusting all of
 * them.
 *
 * The one thing this DOES settle, exactly and without any modelling: an arm whose first
 * set is ANY is entered at every one of those positions, because no first character can
 * exclude it. That is the cost the fix removes, and it is arithmetic, not a guess.
 *
 * Determinism: counts and the located example are a pure function of (report, corpus).
 * No timings, no paths beyond the caller's own sample names.
 */
import type { Combinator, FirstSet } from '../types.ts'
import { firstSetOf } from '../combinators/first-set.ts'
import type { ChoiceGating } from './gating.ts'

export type CorpusSample = { name: string; text: string }

/** A located input position: the caller's sample name plus 1-based line/column. */
export type CorpusSite = {
  sample: string
  line: number
  column: number
  /** The source line, untrimmed, for a caret rendering. */
  lineText: string
}

export type ArmCorpusCost = {
  index: number
  /** ANY first set — no character excludes this arm. */
  any: boolean
  /**
   * Corpus positions whose character this arm's first set accepts. For an `any` arm this
   * equals the choice total, which is the point.
   */
  positions: number
  /** The first such position, for the two-world rendering. Absent when there are none. */
  firstSite?: CorpusSite
}

export type ChoiceCorpusCost = {
  choiceId: string
  /** Positions whose character SOME arm accepts — the choice's own reach, bounded. */
  positions: number
  /** Every position in the corpus, so a share can be read. */
  corpusPositions: number
  arms: ArmCorpusCost[]
}

const inSet = (fs: FirstSet, cp: number): boolean => {
  if (fs.kind === 'any') return true
  if (fs.kind === 'empty') return false
  for (const r of fs.ranges) if (cp >= r.lo && cp <= r.hi) return true
  return false
}

function siteAt(samples: readonly CorpusSample[], flatIndex: number): CorpusSite {
  let i = flatIndex
  for (const s of samples) {
    if (i < s.text.length) {
      let line = 1
      let lineStart = 0
      for (let j = 0; j < i; j++) if (s.text.charCodeAt(j) === 10) { line++; lineStart = j + 1 }
      let lineEnd = s.text.indexOf('\n', lineStart)
      if (lineEnd === -1) lineEnd = s.text.length
      return { sample: s.name, line, column: i - lineStart + 1, lineText: s.text.slice(lineStart, lineEnd) }
    }
    i -= s.text.length
  }
  return { sample: '<eof>', line: 0, column: 0, lineText: '' }
}

/**
 * Measure one choice against a corpus. `choice.anyArms` already knows which arms are
 * broad; this adds how much input that costs.
 */
export function measureChoiceCost(c: ChoiceGating, samples: readonly CorpusSample[], arms: readonly { firstSet: FirstSet }[]): ChoiceCorpusCost {
  const counts = arms.map(() => 0)
  const first = arms.map<number>(() => -1)
  let positions = 0
  let corpusPositions = 0
  let flat = 0
  for (const s of samples) {
    for (let i = 0; i < s.text.length; i++) {
      const cp = s.text.charCodeAt(i)
      let hitAny = false
      for (let a = 0; a < arms.length; a++) {
        if (inSet(arms[a]!.firstSet, cp)) {
          counts[a]!++
          if (first[a] === -1) first[a] = flat + i
          hitAny = true
        }
      }
      if (hitAny) positions++
    }
    flat += s.text.length
    corpusPositions += s.text.length
  }
  return {
    choiceId: c.id,
    positions,
    corpusPositions,
    arms: arms.map((a, i) => ({
      index: i,
      any: a.firstSet.kind === 'any',
      positions: counts[i]!,
      ...(first[i]! >= 0 ? { firstSite: siteAt(samples, first[i]!) } : {}),
    })),
  }
}

/** The per-arm first sets a choice dispatches on, in arm order. */
export function armFirstSets(choiceArms: readonly Combinator<unknown>[]): { firstSet: FirstSet }[] {
  return choiceArms.map(a => ({ firstSet: firstSetOf(a) }))
}
