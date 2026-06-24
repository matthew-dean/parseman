import type { Combinator, ParseContext, ParseFail } from '../types.ts'
import type { Parser, RuleKeys } from './grammar.ts'
import type { CSTLeaf, CSTError, NodeLike } from './types.ts'

// ---------------------------------------------------------------------------
// ParseDoc
// ---------------------------------------------------------------------------

/**
 * The result of Parser.parse() — holds the current tree and supports
 * incremental re-parsing via edit().
 *
 *   const doc = css.parse('Stylesheet', src)
 *   doc.tree    // CSTNode (or your N), null if parse failed
 *   doc.errors  // ParseFail[], empty on success
 *   doc.input   // the source string that produced this tree
 *
 *   const doc2 = doc.edit(changeStart, changeEnd, newText)  // "select from→to, type newText"
 */
export interface ParseDoc<N extends NodeLike = NodeLike> {
  readonly tree: N | null
  readonly errors: ParseFail[]
  readonly input: string
  /** Offset reached by the top-level rule. < input.length means input was left unconsumed. */
  readonly consumedEnd: number
  /**
   * Incrementally re-parse after a text change.
   *
   * Think of it as "select from → to, replace with replacement": both `from`
   * and `to` are byte offsets in the OLD input. `replacement` is what fills
   * that range in the new text.
   *
   *   doc.edit(3, 7, 'hi')  →  old: "foo [XXXX] bar"   new: "foo hi bar"
   *                                       ↑    ↑
   *                                      from  to   (both in old text)
   *
   * Maps directly to editor change events:
   *   VSCode / Monaco:  doc.edit(change.rangeOffset, change.rangeOffset + change.rangeLength, change.text)
   *   CodeMirror 6:     doc.edit(change.from, change.to, change.insert)
   *   LSP:              doc.edit(startByte, endByte, change.text)  // after line/col → byte offset
   */
  edit(from: number, to: number, replacement: string): ParseDoc<N>
}

// ---------------------------------------------------------------------------
// Tree navigation helpers
// ---------------------------------------------------------------------------

type FoundNode = { node: NodeLike; path: number[] }

function isNode(x: unknown): x is NodeLike {
  return typeof x === 'object' && x !== null && (x as { _tag?: string })._tag === 'node'
}

function findContaining(node: NodeLike, pos: number, path: number[] = []): FoundNode | null {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    if (!isNode(child)) continue
    if (child.span.start <= pos && pos < child.span.end) {
      return findContaining(child, pos, [...path, i]) ?? { node: child, path: [...path, i] }
    }
  }
  return null
}

function ancestorsAt(root: NodeLike, path: number[]): NodeLike[] {
  const ancestors: NodeLike[] = [root]
  let cur: NodeLike = root
  for (const idx of path.slice(0, -1)) {
    const child = cur.children[idx]
    if (!child || !isNode(child)) break
    ancestors.push(child)
    cur = child
  }
  return ancestors
}

type Rebuilder<N extends NodeLike> = {
  rebuild(node: N, children: ReadonlyArray<N | CSTLeaf | CSTError>): N
}

function replaceAtPath<N extends NodeLike>(
  grammar: Rebuilder<N>,
  root: N,
  path: number[],
  newNode: N,
): N {
  if (path.length === 0) return newNode
  const [idx, ...rest] = path as [number, ...number[]]
  const newChildren = [...root.children] as unknown[] as Array<N | CSTLeaf | CSTError>
  newChildren[idx] = rest.length === 0
    ? newNode
    : replaceAtPath(grammar, root.children[idx] as N, rest, newNode)
  return grammar.rebuild(root, newChildren)
}

// ---------------------------------------------------------------------------
// ParseDoc implementation
// ---------------------------------------------------------------------------

class ParseDocImpl<N extends NodeLike> implements ParseDoc<N> {
  private readonly _parser: Parser<N>
  private readonly _ruleName: string
  private readonly _trivia: Combinator<unknown> | undefined
  private readonly _captureTrivia: boolean | undefined
  readonly tree: N | null
  readonly errors: ParseFail[]
  readonly input: string
  /** Offset reached by the top-level rule. < input.length means input was left unconsumed. */
  readonly consumedEnd: number

  constructor(parser: Parser<N>, ruleName: string, tree: N | null, errors: ParseFail[], input: string, trivia?: Combinator<unknown>, captureTrivia?: boolean, consumedEnd = 0) {
    this._parser        = parser
    this._ruleName      = ruleName
    this._trivia        = trivia
    this._captureTrivia = captureTrivia
    this.tree           = tree
    this.errors         = errors
    this.input          = input
    this.consumedEnd    = consumedEnd
  }

  edit(from: number, to: number, replacement: string): ParseDoc<N> {
    const newInput = this.input.slice(0, from) + replacement + this.input.slice(to)

    if (!this.tree) return makeParseDoc(this._parser, this._ruleName, newInput, this._trivia, this._captureTrivia)

    const delta = replacement.length - (to - from)
    const found = findContaining(this.tree, from)
    if (!found) return makeParseDoc(this._parser, this._ruleName, newInput, this._trivia, this._captureTrivia)

    const ancestors = ancestorsAt(this.tree, found.path)
    const candidates: FoundNode[] = [found]
    const pathCopy = [...found.path]
    for (let i = ancestors.length - 2; i >= 0; i--) {
      pathCopy.pop()
      candidates.push({ node: ancestors[i + 1]!, path: [...pathCopy] })
    }

    for (const candidate of candidates) {
      const { node, path } = candidate
      const expectedEnd = node.span.end + delta
      const parser = this._parser.rule(node.type as RuleKeys<typeof this._parser>)
      const ctx: ParseContext = { trackLines: false, state: node.state, ...(this._trivia !== undefined ? { trivia: this._trivia } : {}), ...(this._captureTrivia ? { captureTrivia: true } : {}) }
      const r = parser.parse(newInput, node.span.start, ctx)
      if (!r.ok) continue
      if (r.span.end === expectedEnd) {
        const newTree = replaceAtPath(this._parser, this.tree!, path, r.value)
        return new ParseDocImpl(this._parser, this._ruleName, newTree, [], newInput, this._trivia, this._captureTrivia)
      }
    }

    return makeParseDoc(this._parser, this._ruleName, newInput, this._trivia, this._captureTrivia)
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeParseDoc<N extends NodeLike>(
  parser: Parser<N>,
  ruleName: string,
  input: string,
  trivia?: Combinator<unknown>,
  captureTrivia?: boolean,
  triviaLog?: number[]
): ParseDoc<N> {
  const ctx: ParseContext = {
    trackLines: false,
    ...(trivia !== undefined ? { trivia } : {}),
    ...(captureTrivia ? { captureTrivia: true } : {}),
    ...(triviaLog !== undefined ? { _triviaLog: triviaLog } : {}),
  }
  const r = parser.rule(ruleName as RuleKeys<typeof parser>).parse(input, 0, ctx)
  if (r.ok) {
    return new ParseDocImpl(parser, ruleName, r.value, [], input, trivia, captureTrivia, r.span.end)
  }
  return new ParseDocImpl(parser, ruleName, null, [{ ok: false, expected: r.expected, span: r.span }], input, trivia, captureTrivia, r.span.start)
}
