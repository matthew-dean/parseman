import type { Combinator, ParseContext } from '../types.ts'
import { getCoreRegexDef } from '../combinators/choice.ts'
import { pushCstTriviaEntry, pushTriviaLogEntry } from './capture-buffer.ts'

export type TriviaChunk = { start: number; end: number; kindIndex: number }

export type LabeledTriviaSpec = {
  readonly labels: readonly string[]
  readonly arms: ReadonlyArray<{ label: string; kindIndex: number; parser: Combinator<unknown> }>
  readonly minRepeats: number
}

function unwrapTrivia(p: Combinator<unknown>): Combinator<unknown> {
  let cur = p
  while (cur._def.tag === 'trivia') cur = cur._def.parser
  return cur
}

/** Strip `label()` wrapper; returns inner parser for matching. */
export function peelLabel(p: Combinator<unknown>): { label: string; parser: Combinator<unknown> } | null {
  if (p._def.tag === 'label') return { label: p._def.label, parser: p._def.parser }
  return null
}

/**
 * When every trivia arm is `label(name, parser)` inside `oneOrMore(choice(…))`
 * (or a single labeled arm), return the label table and matchers.
 */
export function analyzeLabeledTrivia(trivia: Combinator<unknown>): LabeledTriviaSpec | null {
  let core = unwrapTrivia(trivia)
  let minRepeats = 1

  if (core._def.tag === 'oneOrMore') {
    core = core._def.parser
    minRepeats = 1
  } else if (core._def.tag === 'many') {
    core = core._def.parser
    minRepeats = 0
  }

  const arms: LabeledTriviaSpec['arms'][number][] = []

  if (core._def.tag === 'choice') {
    for (let i = 0; i < core._def.parsers.length; i++) {
      const peeled = peelLabel(core._def.parsers[i]!)
      if (!peeled) return null
      arms.push({ label: peeled.label, kindIndex: i, parser: peeled.parser })
    }
  } else {
    const peeled = peelLabel(core)
    if (!peeled) return null
    arms.push({ label: peeled.label, kindIndex: 0, parser: peeled.parser })
  }

  return { labels: arms.map(a => a.label), arms, minRepeats }
}

/** Label table on a `trivia()` combinator, if all arms are labeled. */
export function triviaKindLabels(trivia: Combinator<unknown> | undefined): readonly string[] | undefined {
  if (!trivia) return undefined
  const fromMeta = trivia._meta.triviaKindLabels
  if (fromMeta) return fromMeta
  return analyzeLabeledTrivia(trivia)?.labels
}

function matchArmAt(
  input: string,
  pos: number,
  arm: Combinator<unknown>,
): { end: number } | null {
  const r = arm.parse(input, pos, { trackLines: false })
  if (!r.ok || r.span.end <= pos) return null
  return { end: r.span.end }
}

/**
 * Scan maximal labeled trivia chunks (PEG `oneOrMore(choice(…))` semantics).
 * Each successful arm match becomes one entry with that arm's kind index.
 */
export function scanLabeledTriviaChunks(
  input: string,
  cur: number,
  spec: LabeledTriviaSpec,
): { end: number; chunks: TriviaChunk[] } {
  const chunks: TriviaChunk[] = []
  let pos = cur

  while (pos < input.length) {
    let matched: { end: number; kindIndex: number } | null = null
    for (const arm of spec.arms) {
      const m = matchArmAt(input, pos, arm.parser)
      if (m) {
        matched = { end: m.end, kindIndex: arm.kindIndex }
        break
      }
    }
    if (!matched) break
    chunks.push({ start: pos, end: matched.end, kindIndex: matched.kindIndex })
    pos = matched.end
  }

  if (chunks.length < spec.minRepeats) {
    return { end: cur, chunks: [] }
  }
  return { end: pos, chunks }
}

/** Hand-rolled ws / block-comment scan with per-chunk kind indices (interpreter). */
export function scanFastWsCommentsChunks(
  input: string,
  cur: number,
  wsKind: number,
  commentKind: number,
): { end: number; chunks: TriviaChunk[] } {
  const chunks: TriviaChunk[] = []
  let pos = cur

  while (pos < input.length) {
    const c = input.charCodeAt(pos)
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) {
      const start = pos
      pos++
      while (pos < input.length) {
        const c2 = input.charCodeAt(pos)
        if (c2 === 32 || c2 === 9 || c2 === 10 || c2 === 13 || c2 === 12) pos++
        else break
      }
      chunks.push({ start, end: pos, kindIndex: wsKind })
      continue
    }
    if (c === 47 && input.charCodeAt(pos + 1) === 42) {
      const start = pos
      let j = pos + 2
      while (j + 1 < input.length && !(input.charCodeAt(j) === 42 && input.charCodeAt(j + 1) === 47)) j++
      pos = j + 2 <= input.length ? j + 2 : input.length
      chunks.push({ start, end: pos, kindIndex: commentKind })
      continue
    }
    break
  }

  return { end: pos, chunks }
}

/** Fast scan when trivia is labeled ws + block-comment (CSS `rw`). */
export function tryFastLabeledScan(
  input: string,
  cur: number,
  trivia: Combinator<unknown>,
): { end: number; chunks: TriviaChunk[] } | null {
  const spec = analyzeLabeledTrivia(trivia)
  if (!spec || spec.arms.length !== 2) return null

  const wsArm = spec.arms.find(a => {
    const src = getCoreRegexDef(a.parser)?.source
    return src != null && !src.includes('\\*')
  })
  const commentArm = spec.arms.find(a => {
    const src = getCoreRegexDef(a.parser)?.source
    return src != null && src.includes('\\*')
  })
  if (!wsArm || !commentArm) return null

  const { chunks } = scanFastWsCommentsChunks(input, cur, wsArm.kindIndex, commentArm.kindIndex)
  if (chunks.length < spec.minRepeats) return { end: cur, chunks: [] }
  return scanFastWsCommentsChunks(input, cur, wsArm.kindIndex, commentArm.kindIndex)
}

export function recordTriviaChunks(ctx: ParseContext, chunks: readonly TriviaChunk[]): void {
  const kinds = ctx.triviaKindLabels
  for (const ch of chunks) {
    pushTriviaLogEntry(ctx, ch.start, ch.end, kinds ? ch.kindIndex : undefined)
    if (ctx.captureTrivia && (ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined)) {
      pushCstTriviaEntry(ctx, ch.start, ch.end, kinds ? ch.kindIndex : undefined)
    }
  }
}
