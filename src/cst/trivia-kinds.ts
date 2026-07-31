import type { Combinator, ParseContext } from '../types.ts'
import { pushCstTriviaEntry, pushTriviaLogEntry } from './capture-buffer.ts'
import { startsFirstSet } from '../combinators/first-set.ts'

export type TriviaChunk = { start: number; end: number; kindIndex: number }

export type LabeledTriviaSpec = {
  readonly labels: readonly string[]
  readonly arms: ReadonlyArray<{ label: string; kindIndex: number; parser: Combinator<unknown> }>
  readonly minRepeats: number
}

const labeledTriviaSpecs = new WeakMap<Combinator<unknown>, LabeledTriviaSpec | null>()

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
  const cached = labeledTriviaSpecs.get(trivia)
  if (cached !== undefined) return cached

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
      if (!peeled) {
        labeledTriviaSpecs.set(trivia, null)
        return null
      }
      arms.push({ label: peeled.label, kindIndex: i, parser: peeled.parser })
    }
  } else {
    const peeled = peelLabel(core)
    if (!peeled) {
      labeledTriviaSpecs.set(trivia, null)
      return null
    }
    arms.push({ label: peeled.label, kindIndex: 0, parser: peeled.parser })
  }

  const spec = {
    labels: arms.map(a => a.label),
    arms,
    minRepeats,
  }
  labeledTriviaSpecs.set(trivia, spec)
  return spec
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
  state: unknown,
): { end: number } | null {
  // The first-set check is structural Parseman metadata. It neither assigns
  // meaning to a label nor recognizes a particular comment form; it avoids
  // entering arms whose own grammar proves they cannot start at this offset.
  if (!startsFirstSet(arm, input, pos)) return null
  const r = arm.parse(input, pos, { trackLines: false, state })
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
  state?: unknown,
): { end: number; chunks: TriviaChunk[] } {
  const chunks: TriviaChunk[] = []
  let pos = cur

  while (pos < input.length) {
    let matched: { end: number; kindIndex: number } | null = null
    for (const arm of spec.arms) {
      const m = matchArmAt(input, pos, arm.parser, state)
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

/**
 * Scan labeled trivia when no caller will retain individual chunks. This is the
 * ordinary skip path for a classified grammar: labels remain available for an
 * explicit capture request, but merely having labels must not allocate one
 * `{ start, end, kindIndex }` object per whitespace/comment run.
 */
export function scanLabeledTriviaEnd(
  input: string,
  cur: number,
  spec: LabeledTriviaSpec,
  state?: unknown,
): number {
  let pos = cur
  let count = 0

  while (pos < input.length) {
    let matched: { end: number } | null = null
    for (const arm of spec.arms) {
      matched = matchArmAt(input, pos, arm.parser, state)
      if (matched) break
    }
    if (!matched) break
    pos = matched.end
    count++
  }

  return count < spec.minRepeats ? cur : pos
}

/**
 * Visit classified trivia matches without constructing per-match objects. The
 * visitor is only invoked after one or more arms matched, which is the shape
 * used by `classifiedTrivia()`; callers with a stronger repeat minimum keep
 * the buffered scanner so an unsuccessful minimum cannot leak a partial run.
 */
export function visitLabeledTrivia(
  input: string,
  cur: number,
  spec: LabeledTriviaSpec,
  state: unknown | undefined,
  visit: (start: number, end: number, kindIndex: number) => void,
): number | undefined {
  if (spec.minRepeats > 1) return undefined
  let pos = cur
  let count = 0

  while (pos < input.length) {
    let matched: { end: number; kindIndex: number } | null = null
    for (const arm of spec.arms) {
      const match = matchArmAt(input, pos, arm.parser, state)
      if (match) {
        matched = { end: match.end, kindIndex: arm.kindIndex }
        break
      }
    }
    if (!matched) break
    visit(pos, matched.end, matched.kindIndex)
    pos = matched.end
    count++
  }

  return count < spec.minRepeats ? cur : pos
}

export function recordTriviaChunks(ctx: ParseContext, chunks: readonly TriviaChunk[]): void {
  const kinds = ctx.triviaKindLabels
  const mask = ctx._triviaCaptureMask
  const rootLog = ctx._rootTriviaLog
  const rootKinds = ctx._rootTriviaKindIndex
  const rootMark = rootLog?.length ?? 0
  for (const ch of chunks) {
    // Global trivia log: always complete (never kind-filtered).
    pushTriviaLogEntry(ctx, ch.start, ch.end, kinds ? ch.kindIndex : undefined)
    const rootKindIndex = ctx._rootTriviaCapture === false || rootLog === undefined || rootKinds === undefined || kinds === undefined
      ? -1
      : (rootKinds[kinds[ch.kindIndex] ?? ''] ?? -1)
    if (rootKindIndex >= 0) {
      // Fill the enclosing committed gap after the scanner has consumed every
      // chunk. A selected marker therefore carries its exact authored context
      // without recording any whitespace-only chunk.
      rootLog!.push(0, 0, ch.start, ch.end, rootKindIndex)
    }
    // Per-node CST log: honour the kind mask when both a mask and labels are
    // present, so a host can capture (e.g.) comments only without logging every
    // whitespace run. No mask / no labels → capture everything, as before.
    if (ctx.captureTrivia && (ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined)) {
      if (mask === undefined || kinds === undefined || (mask & (1 << ch.kindIndex)) !== 0) {
        pushCstTriviaEntry(ctx, ch.start, ch.end, kinds ? ch.kindIndex : undefined)
      }
    }
  }
  if (rootLog !== undefined && rootLog.length !== rootMark && chunks.length > 0) {
    const start = chunks[0]!.start
    const end = chunks[chunks.length - 1]!.end
    for (let offset = rootMark; offset < rootLog.length; offset += 5) {
      rootLog[offset] = start
      rootLog[offset + 1] = end
    }
  }
}

/**
 * Resolve a per-node trivia capture mask (`ctx._triviaCaptureMask`) from a trivia
 * label table and the kind names a host wants to keep. Returns `undefined` when
 * `labels` is absent (nothing to key on → capture everything).
 *
 * Names in `keep` that aren't in `labels` are **ignored by design**: `keep` is
 * often a dialect-independent list (e.g. `['blockComment', 'lineComment']`) applied
 * to a grammar whose trivia only defines some of them (CSS has no `lineComment`) —
 * so an unknown name is a normal cross-dialect no-op, not necessarily a typo, and
 * is not worth a warning that would cry wolf on legitimate superset lists. An empty
 * `keep` (or one where nothing matches) yields `0`, which means "capture NO trivia
 * into per-node logs" — an intentional, valid state (the global `_triviaLog` is
 * unaffected either way). If you expect comments and get an empty per-node log,
 * check the name against the grammar's `triviaKindLabels`.
 */
/**
 * Resolve an ADJACENCY kind filter against the ACTIVE trivia table — the strict
 * counterpart of `triviaKindMask` below.
 *
 * Deliberately NOT lenient. `triviaKindMask` is a capture preference, where an
 * unknown name is a legitimate cross-dialect no-op; this is a RECOGNITION
 * constraint, and a silently-dropped name turns `notAdjacent({kinds:['whitespace']})`
 * into a bare `notAdjacent()` — i.e. `calc()` quietly accepting a comment where
 * css-values-4 10.1 demands real whitespace, the exact defect the filter exists to
 * prevent. Both failure modes are hard errors.
 */
export function resolveAdjacencyKindMask(
  trivia: Combinator<unknown> | undefined,
  kinds: readonly string[],
): number {
  const spec = trivia ? analyzeLabeledTrivia(trivia) : null
  if (!spec) {
    throw new TypeError(
      `notAdjacent({ kinds: [${kinds.map(k => JSON.stringify(k)).join(', ')}] }) requires classified trivia: `
      + 'the active trivia table has no category labels. Build it with classifiedTrivia({ whitespace: …, comment: … }).',
    )
  }
  let mask = 0
  for (const name of kinds) {
    const idx = spec.labels.indexOf(name)
    if (idx < 0) {
      throw new TypeError(
        `notAdjacent(): unknown trivia kind ${JSON.stringify(name)}. `
        + `The active trivia table declares: ${spec.labels.map(l => JSON.stringify(l)).join(', ')}.`,
      )
    }
    mask |= 1 << idx
  }
  return mask
}

/**
 * Bitmask of the trivia CATEGORIES occurring in the run starting at `pos`
 * (`1 << kindIndex` per matched chunk); `0` when no trivia is there at all.
 * The single source of truth for the interpreter's adjacency kind test — the
 * compiled probe (`_akN`) mirrors this loop arm for arm.
 */
export function triviaKindMaskAt(
  input: string,
  pos: number,
  spec: LabeledTriviaSpec,
  state?: unknown,
): number {
  let cur = pos
  let mask = 0
  while (cur < input.length) {
    let matched: { end: number; kindIndex: number } | null = null
    for (const arm of spec.arms) {
      const m = matchArmAt(input, cur, arm.parser, state)
      if (m) {
        matched = { end: m.end, kindIndex: arm.kindIndex }
        break
      }
    }
    if (!matched) break
    mask |= 1 << matched.kindIndex
    cur = matched.end
  }
  return mask
}

export function triviaKindMask(
  labels: readonly string[] | undefined,
  keep: readonly string[],
): number | undefined {
  if (!labels) return undefined
  let mask = 0
  for (const name of keep) {
    const idx = labels.indexOf(name)
    if (idx >= 0) mask |= 1 << idx
  }
  return mask
}
