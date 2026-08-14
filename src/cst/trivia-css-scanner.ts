export type CssTriviaScanner = (input: string, cur: number) => number
export type CssTriviaVisitor = (
  input: string,
  cur: number,
  visit: (start: number, end: number, kindIndex: number) => void,
) => number

const CSS_WS_SOURCE = '[ \\t\\n\\r\\f]+'
const CSS_LINE_COMMENT_SOURCE = '\\/\\/[^\\n\\r]*'
const CSS_BLOCK_COMMENT_SOURCE = '\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\/'

function scanWhitespace(input: string, cur: number): number {
  let pos = cur
  while (pos < input.length) {
    const c = input.charCodeAt(pos)
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) break
    pos++
  }
  return pos
}

function scanLineComment(input: string, cur: number): number {
  if (input.charCodeAt(cur) !== 47 || input.charCodeAt(cur + 1) !== 47) return cur
  let pos = cur + 2
  while (pos < input.length) {
    const c = input.charCodeAt(pos)
    if (c === 10 || c === 13) break
    pos++
  }
  return pos
}

function scanBlockComment(input: string, cur: number): number {
  if (input.charCodeAt(cur) !== 47 || input.charCodeAt(cur + 1) !== 42) return cur
  const close = input.indexOf('*/', cur + 2)
  return close < 0 ? cur : close + 2
}

function scanWsLineBlockTrivia(input: string, cur: number): number {
  let pos = cur
  for (;;) {
    const ws = scanWhitespace(input, pos)
    if (ws !== pos) { pos = ws; continue }
    const line = scanLineComment(input, pos)
    if (line !== pos) { pos = line; continue }
    const block = scanBlockComment(input, pos)
    if (block !== pos) { pos = block; continue }
    return pos
  }
}

function scanWsBlockTrivia(input: string, cur: number): number {
  let pos = cur
  for (;;) {
    const ws = scanWhitespace(input, pos)
    if (ws !== pos) { pos = ws; continue }
    const block = scanBlockComment(input, pos)
    if (block !== pos) { pos = block; continue }
    return pos
  }
}

function scanLineBlockTrivia(input: string, cur: number): number {
  let pos = cur
  for (;;) {
    const line = scanLineComment(input, pos)
    if (line !== pos) { pos = line; continue }
    const block = scanBlockComment(input, pos)
    if (block !== pos) { pos = block; continue }
    return pos
  }
}

function scanBlockTrivia(input: string, cur: number): number {
  let pos = cur
  for (;;) {
    const block = scanBlockComment(input, pos)
    if (block === pos) return pos
    pos = block
  }
}

function visitWsLineBlock(input: string, cur: number, visit: (start: number, end: number, kindIndex: number) => void): number {
  let pos = cur
  for (;;) {
    let end = scanWhitespace(input, pos)
    if (end !== pos) { visit(pos, end, 0); pos = end; continue }
    end = scanLineComment(input, pos)
    if (end !== pos) { visit(pos, end, 1); pos = end; continue }
    end = scanBlockComment(input, pos)
    if (end !== pos) { visit(pos, end, 2); pos = end; continue }
    return pos
  }
}

function visitWsBlock(input: string, cur: number, visit: (start: number, end: number, kindIndex: number) => void): number {
  let pos = cur
  for (;;) {
    let end = scanWhitespace(input, pos)
    if (end !== pos) { visit(pos, end, 0); pos = end; continue }
    end = scanBlockComment(input, pos)
    if (end !== pos) { visit(pos, end, 1); pos = end; continue }
    return pos
  }
}

function visitLineBlock(input: string, cur: number, visit: (start: number, end: number, kindIndex: number) => void): number {
  let pos = cur
  for (;;) {
    let end = scanLineComment(input, pos)
    if (end !== pos) { visit(pos, end, 0); pos = end; continue }
    end = scanBlockComment(input, pos)
    if (end !== pos) { visit(pos, end, 1); pos = end; continue }
    return pos
  }
}

function visitBlock(input: string, cur: number, visit: (start: number, end: number, kindIndex: number) => void): number {
  let pos = cur
  for (;;) {
    const end = scanBlockComment(input, pos)
    if (end === pos) return pos
    visit(pos, end, 0)
    pos = end
  }
}

export function commonCssTriviaScanner(sources: readonly (string | null)[]): CssTriviaScanner | null {
  if (sources.length === 3 && sources[0] === CSS_WS_SOURCE && sources[1] === CSS_LINE_COMMENT_SOURCE && sources[2] === CSS_BLOCK_COMMENT_SOURCE) return scanWsLineBlockTrivia
  if (sources.length === 2 && sources[0] === CSS_WS_SOURCE && sources[1] === CSS_BLOCK_COMMENT_SOURCE) return scanWsBlockTrivia
  if (sources.length === 2 && sources[0] === CSS_LINE_COMMENT_SOURCE && sources[1] === CSS_BLOCK_COMMENT_SOURCE) return scanLineBlockTrivia
  if (sources.length === 1 && sources[0] === CSS_BLOCK_COMMENT_SOURCE) return scanBlockTrivia
  return null
}

export function commonCssTriviaVisitor(sources: readonly (string | null)[]): CssTriviaVisitor | null {
  if (sources.length === 3 && sources[0] === CSS_WS_SOURCE && sources[1] === CSS_LINE_COMMENT_SOURCE && sources[2] === CSS_BLOCK_COMMENT_SOURCE) return visitWsLineBlock
  if (sources.length === 2 && sources[0] === CSS_WS_SOURCE && sources[1] === CSS_BLOCK_COMMENT_SOURCE) return visitWsBlock
  if (sources.length === 2 && sources[0] === CSS_LINE_COMMENT_SOURCE && sources[1] === CSS_BLOCK_COMMENT_SOURCE) return visitLineBlock
  if (sources.length === 1 && sources[0] === CSS_BLOCK_COMMENT_SOURCE) return visitBlock
  return null
}
