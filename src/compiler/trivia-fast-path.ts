import type { Combinator } from '../types.ts'
import { getCoreRegexDef } from '../combinators/choice.ts'
import type { LabeledTriviaSpec } from '../cst/trivia-kinds.ts'
import { analyzeLabeledTrivia } from '../cst/trivia-kinds.ts'
import { type ScanShape, type Mint, scanShapeFromRegex, scanBranch, scanBranchLabeled } from './scannable-run.ts'

/** Fresh, collision-free local names for one generated scan function. */
function makeMint(): Mint {
  let n = 0
  return (prefix = '_v') => `${prefix}${n++}`
}

function unwrapTrivia(p: Combinator<unknown>): Combinator<unknown> {
  let cur = p
  while (cur._def.tag === 'trivia') cur = cur._def.parser
  return cur
}

function oneOrMoreInner(p: Combinator<unknown>): Combinator<unknown> | null {
  const d = p._def
  if (d.tag === 'oneOrMore') return d.parser
  if (d.tag === 'many' && d.min >= 1) return d.parser
  return null
}

function choiceArms(p: Combinator<unknown>): Combinator<unknown>[] | null {
  if (p._def.tag === 'choice') return p._def.parsers
  return null
}

/** The scannable shape of one arm (a regex), or null if it isn't scannable. */
function armShape(arm: Combinator<unknown>): ScanShape | null {
  const d = getCoreRegexDef(arm)
  return d ? scanShapeFromRegex(d.source, d.flags) : null
}

/**
 * A trivia parser that lowers to a hand-rolled char-scan loop: `oneOrMore(choice(
 * …))` (or `many`, min≥1) where EVERY arm is a scannable shape (a `[X]+` run, a
 * `<lit>[^X]*` open-until-terminator, or a `<open>(?:…)*<close>` delimited token
 * — see scannable-run.ts). Returns the per-arm shapes, or a single-element list
 * for a bare scannable regex, or null (→ caller falls back to the regex/generic
 * trivia path). A single alternation regex is NOT scannable (one exec matches one
 * arm per call, defeating the loop).
 */
export function analyzeTriviaFastPath(trivia: Combinator<unknown>): ScanShape[] | null {
  const core = unwrapTrivia(trivia)

  const directDef = getCoreRegexDef(core)
  if (directDef) {
    const shape = scanShapeFromRegex(directDef.source, directDef.flags)
    return shape && shape.kind === 'chars' ? [shape] : null
  }

  const inner = oneOrMoreInner(core)
  if (!inner) return null

  const innerShape = armShape(inner)
  if (innerShape) return innerShape.kind === 'chars' ? [innerShape] : null

  const arms = choiceArms(inner)
  if (!arms || arms.length < 2) return null

  const shapes: ScanShape[] = []
  for (const arm of arms) {
    const shape = armShape(arm)
    if (!shape) return null
    shapes.push(shape)
  }
  return shapes
}

const CAP_RECORD = [
  `  if (_cap && _e > _pos) {`,
  `    if (_ctx._triviaLog !== undefined) _ctx._triviaLog.push(_pos, _e)`,
  `    if (_ctx._cstTriviaLog !== undefined) _ctx._cstTriviaLog.push(_pos, _e, _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0)`,
  `  }`,
].join('\n')

/** One char-scan loop carrying a branch per scannable shape, dispatched on `c`. */
function composeFastLoop(shapes: ScanShape[]): string {
  const mint = makeMint()
  return [
    `  while (_e < input.length) {`,
    `    const c = input.charCodeAt(_e)`,
    ...shapes.map(s => scanBranch(s, mint)),
    `    break`,
    `  }`,
  ].join('\n')
}

/** Emit a specialized `_tfN` that skips (unlabeled) trivia via a char-scan loop. */
export function buildFastTriviaFnDecl(fnName: string, shapes: ScanShape[]): string {
  return [
    `function ${fnName}(input, _pos, _ctx, _cap) {`,
    `  let _e = _pos`,
    composeFastLoop(shapes),
    CAP_RECORD,
    `  return _e`,
    `}`,
  ].join('\n')
}

/**
 * A LABELED trivia parser whose every arm is scannable → per-arm shape + kind
 * index, or null. Same recognition as analyzeTriviaFastPath, but keyed by the
 * labeled arm kinds so the fast loop can log each chunk's kind. Generalizes what
 * used to be a hardcoded ws-run + block-comment special case to any scannable
 * shape set / arm count.
 */
export function analyzeLabeledScannableRun(
  trivia: Combinator<unknown>,
): Array<{ shape: ScanShape; kindIndex: number }> | null {
  const spec = analyzeLabeledTrivia(trivia)
  if (!spec) return null
  const out: Array<{ shape: ScanShape; kindIndex: number }> = []
  for (const arm of spec.arms) {
    const d = getCoreRegexDef(arm.parser)
    const shape = d ? scanShapeFromRegex(d.source, d.flags) : null
    if (!shape) return null
    out.push({ shape, kindIndex: arm.kindIndex })
  }
  return out
}

/** Emit a labeled scannable trivia `_tfN`: char-scan loop with per-chunk kind capture. */
export function buildLabeledScannableTriviaFnDecl(
  fnName: string,
  arms: ReadonlyArray<{ shape: ScanShape; kindIndex: number }>,
): string {
  const mint = makeMint()
  return [
    `function ${fnName}(input, _pos, _ctx, _cap) {`,
    `  let _e = _pos`,
    `  while (_e < input.length) {`,
    `    const c = input.charCodeAt(_e)`,
    ...arms.map(a => scanBranchLabeled(a.shape, a.kindIndex, mint)),
    `    break`,
    `  }`,
    `  return _e`,
    `}`,
  ].join('\n')
}

/** Labeled trivia with regex arms — per-chunk kind capture in compiled output. */
export function buildLabeledRegexTriviaFnDecl(
  fnName: string,
  spec: LabeledTriviaSpec,
  reNames: string[],
): string {
  const tryArms = spec.arms.map((arm, i) => {
    const re = reNames[i]!
    const k = arm.kindIndex
    return [
      `    ${re}.lastIndex = _e`,
      `    const _m${i} = ${re}.exec(input)`,
      `    if (_m${i} && _m${i}.index === _e) {`,
      `      const _ce = _e + _m${i}[0].length`,
      `      if (_cap) {`,
      `        if (_ctx._triviaLog !== undefined) _ctx._triviaLog.push(_e, _ce, ${k})`,
      `        if (_ctx._cstTriviaLog !== undefined) _ctx._cstTriviaLog.push(_e, _ce, _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0, ${k})`,
      `      }`,
      `      _e = _ce`,
      `      _matched = true`,
      `      continue`,
      `    }`,
    ].join('\n')
  }).join('\n')

  return [
    `function ${fnName}(input, _pos, _ctx, _cap) {`,
    `  let _e = _pos`,
    `  while (_e < input.length) {`,
    `    let _matched = false`,
    tryArms,
    `    if (!_matched) break`,
    `  }`,
    `  return _e`,
    `}`,
  ].join('\n')
}

export function labeledTriviaRegexArms(trivia: Combinator<unknown>): LabeledTriviaSpec | null {
  const spec = analyzeLabeledTrivia(trivia)
  if (!spec) return null
  for (const arm of spec.arms) {
    if (!getCoreRegexDef(arm.parser)) return null
  }
  return spec
}

/** Labeled trivia via per-arm runtime parsers (non-regex or mixed arms). */
export function buildLabeledRuntimeTriviaFnDecl(
  fnName: string,
  spec: LabeledTriviaSpec,
  rpStartIndex: number,
): string {
  const tryArms = spec.arms.map((arm, i) => {
    const k = arm.kindIndex
    const ri = rpStartIndex + i
    return [
      `    const _r${i} = _rp[${ri}].parse(input, _e, _ctx)`,
      `    if (_r${i}.ok && _r${i}.span.end > _e) {`,
      `      const _ce = _r${i}.span.end`,
      `      if (_cap) {`,
      `        if (_ctx._triviaLog !== undefined) _ctx._triviaLog.push(_e, _ce, ${k})`,
      `        if (_ctx._cstTriviaLog !== undefined) _ctx._cstTriviaLog.push(_e, _ce, _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0, ${k})`,
      `      }`,
      `      _e = _ce`,
      `      _matched = true`,
      `      continue`,
      `    }`,
    ].join('\n')
  }).join('\n')

  return [
    `function ${fnName}(input, _pos, _ctx, _cap) {`,
    `  let _e = _pos`,
    `  while (_e < input.length) {`,
    `    let _matched = false`,
    tryArms,
    `    if (!_matched) break`,
    `  }`,
    `  return _e`,
    `}`,
  ].join('\n')
}
