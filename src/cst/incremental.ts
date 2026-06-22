import type { ParseContext } from '../types.ts'
import { Parser } from './grammar.ts'
import type { RuleKeys } from './grammar.ts'
import type { CSTLeaf, CSTError, NodeLike } from './types.ts'

// ---------------------------------------------------------------------------
// Tree navigation helpers
// ---------------------------------------------------------------------------

type FoundNode = {
  node: NodeLike
  path: number[]
}

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
// IncrementalParser
// ---------------------------------------------------------------------------

/**
 * Extend this instead of Parser when you need incremental re-parsing.
 * Pass the root rule name to super() in your constructor.
 *
 *   class CssParser extends IncrementalParser {
 *     constructor() { super('Stylesheet') }
 *     ident      = regex(/[a-zA-Z-]+/)
 *     Selector   = (g: Refs<CssParser>) => sequence(g.ident, g.ident)
 *     Stylesheet = (g: Refs<CssParser>) => many(g.Selector)
 *   }
 *
 *   const css = new CssParser()
 *   let tree = css.parse('div p')
 *   tree = css.edit('div  p', 3, 4)   // re-parses only the Selector node
 *
 * On first parse() a full parse runs. Subsequent edit() calls find the
 * smallest node containing the edit, re-parse just that subtree using its
 * saved context, and stop early when the new span end matches the expected
 * position. O(changed region) amortized for typical edits.
 */
export class IncrementalParser<N extends NodeLike = NodeLike> extends Parser<N> {
  private readonly _rootRule: string
  private _tree: N | null = null
  private _input: string = ''

  constructor(rootRule: string) {
    super()
    this._rootRule = rootRule
  }

  parse(input: string): N | null {
    this._input = input
    const ctx: ParseContext = { trackLines: false }
    const r = this.rule(this._rootRule as RuleKeys<this>).parse(input, 0, ctx)
    this._tree = r.ok ? r.value : null
    return this._tree
  }

  /**
   * Incremental re-parse after an edit.
   *
   * @param newInput  The complete new input string.
   * @param editStart Character offset where the edit begins (inclusive).
   * @param editEnd   Character offset where the old text ends (exclusive).
   */
  edit(newInput: string, editStart: number, editEnd: number): N | null {
    if (!this._tree) return this.parse(newInput)

    const delta = newInput.length - this._input.length

    const found = findContaining(this._tree, editStart)
    if (!found) return this.parse(newInput)

    const ancestors = ancestorsAt(this._tree, found.path)
    const candidates: FoundNode[] = [found]
    const pathCopy = [...found.path]
    for (let i = ancestors.length - 2; i >= 0; i--) {
      pathCopy.pop()
      candidates.push({ node: ancestors[i + 1]!, path: [...pathCopy] })
    }

    for (const candidate of candidates) {
      const { node, path } = candidate
      const expectedEnd = node.span.end + delta

      const parser = this.rule(node.type as RuleKeys<this>)
      const ctx: ParseContext = { trackLines: false, user: node.savedContext }
      const r = parser.parse(newInput, node.span.start, ctx)
      if (!r.ok) continue

      if (r.span.end === expectedEnd) {
        this._tree = replaceAtPath(this, this._tree!, path, r.value)
        this._input = newInput
        return this._tree
      }
    }

    return this.parse(newInput)
  }

  get currentTree(): N | null { return this._tree }
  get currentInput(): string { return this._input }
}
