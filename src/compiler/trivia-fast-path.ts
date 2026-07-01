import type { Combinator } from '../types.ts'
import { getCoreRegexDef } from '../combinators/choice.ts'
import type { LabeledTriviaSpec } from '../cst/trivia-kinds.ts'
import { analyzeLabeledTrivia } from '../cst/trivia-kinds.ts'

/**
 * Which scannable trivia shapes a fast-path loop must handle. Every shape here
 * is recognizable by a cheap 1–2 char test at the current position and is
 * mutually disjoint from the others on those chars, so a single char-scan loop
 * carries one branch per shape PRESENT — any combination, no arm-count limit.
 * `ws` is always required (there is no comment-only trivia).
 */
export type TriviaFastShapes = { ws: true; blockComment: boolean; lineComment: boolean }

const BLOCK_COMMENT = String.raw`\/\*(?:[^*]|\*(?!\/))*\*\/`

/** `//`-to-end-of-line comment sources (both `[^\n\r]` orderings). */
const LINE_COMMENT_SOURCES = new Set([
  String.raw`\/\/[^\n\r]*`,
  String.raw`\/\/[^\r\n]*`,
])

/** Regex sources for ASCII whitespace runs (incl. regexp-tree reorderings). */
const WS_CLASS_SOURCES = new Set([
  String.raw`[ \t\n\r\f]+`,
  String.raw`[ \t\n]+`,
  String.raw`[ \t]+`,
  String.raw`[\t\n\f\r ]+`,
])

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

function isWsClassSource(source: string): boolean {
  return WS_CLASS_SOURCES.has(source)
}

function isBlockCommentSource(source: string): boolean {
  return source === BLOCK_COMMENT
}

function isLineCommentSource(source: string): boolean {
  return LINE_COMMENT_SOURCES.has(source)
}

/**
 * Detect trivia shapes safe to lower to a hand-rolled char-scan loop in compiled
 * output. Accepts `oneOrMore(choice(ws, …))` where every arm is a scannable
 * shape (whitespace, `/* *​/` block comment, `//` line comment) — ANY count and
 * order, since those shapes are mutually disjoint on their first 1–2 chars so
 * one loop can branch per shape present. Also accepts a bare ws-class regex.
 * A single alternation regex is NOT one of these (one exec matches one arm per
 * call, defeating the loop) and returns null → the caller falls back to the
 * regex/generic trivia path.
 */
export function analyzeTriviaFastPath(trivia: Combinator<unknown>): TriviaFastShapes | null {
  const core = unwrapTrivia(trivia)

  const direct = getCoreRegexDef(core)?.source
  if (direct) {
    if (isWsClassSource(direct)) return { ws: true, blockComment: false, lineComment: false }
    return null
  }

  const inner = oneOrMoreInner(core)
  if (!inner) return null

  const innerSrc = getCoreRegexDef(inner)?.source
  if (innerSrc && isWsClassSource(innerSrc)) return { ws: true, blockComment: false, lineComment: false }

  const arms = choiceArms(inner)
  if (!arms || arms.length < 2) return null

  let hasWs = false
  let blockComment = false
  let lineComment = false
  for (const arm of arms) {
    const src = getCoreRegexDef(arm)?.source
    if (!src) return null
    if (isWsClassSource(src)) hasWs = true
    else if (isBlockCommentSource(src)) blockComment = true
    else if (isLineCommentSource(src)) lineComment = true
    else return null
  }
  // Whitespace is the base; a comment-only choice never occurs and the loop
  // below assumes ws is present as its first branch.
  if (!hasWs) return null
  return { ws: true, blockComment, lineComment }
}

const CAP_RECORD = [
  `  if (_cap && _e > _pos) {`,
  `    if (_ctx._triviaLog !== undefined) _ctx._triviaLog.push(_pos, _e)`,
  `    if (_ctx._cstTriviaLog !== undefined) _ctx._cstTriviaLog.push(_pos, _e, _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0)`,
  `  }`,
].join('\n')

// Per-shape scan branches, each dispatched on the current char `c`. Composed
// into one loop by `composeFastLoop` — one branch per shape present.
const WS_BRANCH = `    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) { _e++; continue }`
const BLOCK_BRANCH = [
  `    if (c === 47 && input.charCodeAt(_e + 1) === 42) {`,
  `      let j = _e + 2`,
  `      while (j + 1 < input.length && !(input.charCodeAt(j) === 42 && input.charCodeAt(j + 1) === 47)) j++`,
  `      _e = j + 2 <= input.length ? j + 2 : input.length`,
  `      continue`,
  `    }`,
].join('\n')
// `//` to end-of-line: stop at CR or LF (matches `\/\/[^\n\r]*`).
const LINE_BRANCH = [
  `    if (c === 47 && input.charCodeAt(_e + 1) === 47) {`,
  `      let j = _e + 2`,
  `      while (j < input.length && input.charCodeAt(j) !== 10 && input.charCodeAt(j) !== 13) j++`,
  `      _e = j`,
  `      continue`,
  `    }`,
].join('\n')

/** One char-scan loop carrying a branch per present shape (ws always first). */
function composeFastLoop(shapes: TriviaFastShapes): string {
  const branches = [
    WS_BRANCH,
    shapes.blockComment ? BLOCK_BRANCH : '',
    shapes.lineComment ? LINE_BRANCH : '',
  ].filter(Boolean)
  return [
    `  while (_e < input.length) {`,
    `    const c = input.charCodeAt(_e)`,
    ...branches,
    `    break`,
    `  }`,
  ].join('\n')
}

const CAP_CHUNK = (wsKind: number, commentKind: number) => [
  `    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) {`,
  `      const _cs = _e`,
  `      _e++`,
  `      while (_e < input.length) {`,
  `        const c2 = input.charCodeAt(_e)`,
  `        if (c2 === 32 || c2 === 9 || c2 === 10 || c2 === 13 || c2 === 12) _e++`,
  `        else break`,
  `      }`,
  `      if (_cap) {`,
  `        if (_ctx._triviaLog !== undefined) _ctx._triviaLog.push(_cs, _e, ${wsKind})`,
  `        if (_ctx._cstTriviaLog !== undefined) _ctx._cstTriviaLog.push(_cs, _e, _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0, ${wsKind})`,
  `      }`,
  `      continue`,
  `    }`,
  `    if (c === 47 && input.charCodeAt(_e + 1) === 42) {`,
  `      const _cs = _e`,
  `      let j = _e + 2`,
  `      while (j + 1 < input.length && !(input.charCodeAt(j) === 42 && input.charCodeAt(j + 1) === 47)) j++`,
  `      _e = j + 2 <= input.length ? j + 2 : input.length`,
  `      if (_cap) {`,
  `        if (_ctx._triviaLog !== undefined) _ctx._triviaLog.push(_cs, _e, ${commentKind})`,
  `        if (_ctx._cstTriviaLog !== undefined) _ctx._cstTriviaLog.push(_cs, _e, _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0, ${commentKind})`,
  `      }`,
  `      continue`,
  `    }`,
].join('\n')

const WS_COMMENTS_LOOP_LABELED = (wsKind: number, commentKind: number) => [
  `  while (_e < input.length) {`,
  `    const c = input.charCodeAt(_e)`,
  CAP_CHUNK(wsKind, commentKind),
  `    break`,
  `  }`,
].join('\n')

/** Emit a specialized `_tfN` that skips trivia without regex / combinator dispatch. */
export function buildFastTriviaFnDecl(
  fnName: string,
  shapes: TriviaFastShapes,
  kindIndices?: { ws: number; comment: number },
): string {
  // Labeled path: only the ws + block-comment shape emits per-chunk kind
  // indices today (the labeled kind analysis is 2-arm; a labeled 3-arm trivia
  // never reaches here — the caller keeps it on the labeled-regex path). Every
  // other shape uses the non-labeled composed loop + whole-run CAP_RECORD.
  const useLabeled = !!kindIndices && shapes.blockComment && !shapes.lineComment
  const loop = useLabeled
    ? WS_COMMENTS_LOOP_LABELED(kindIndices!.ws, kindIndices!.comment)
    : composeFastLoop(shapes)
  const cap = useLabeled ? '' : CAP_RECORD
  const lines = [
    `function ${fnName}(input, _pos, _ctx, _cap) {`,
    `  let _e = _pos`,
    loop,
  ]
  if (cap) lines.push(cap)
  lines.push(`  return _e`, `}`)
  return lines.join('\n')
}

function regexArmIndex(spec: LabeledTriviaSpec, isComment: boolean): number | null {
  for (const arm of spec.arms) {
    const src = getCoreRegexDef(arm.parser)?.source
    if (!src) return null
    const comment = src.includes('\\*') || src.startsWith('\\/\\/')
    if (comment === isComment) return arm.kindIndex
  }
  return null
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

export function labeledTriviaKindIndices(trivia: Combinator<unknown>): { ws: number; comment: number } | null {
  const spec = analyzeLabeledTrivia(trivia)
  if (!spec || spec.arms.length !== 2) return null
  const ws = regexArmIndex(spec, false)
  const comment = regexArmIndex(spec, true)
  if (ws === null || comment === null) return null
  return { ws, comment }
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
