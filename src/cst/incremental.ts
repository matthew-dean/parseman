import type { ParseContext } from '../types.ts'
import type { Parser, RuleKeys } from './grammar.ts'
import type { CSTLeaf, CSTError, NodeLike } from './types.ts'

// ---------------------------------------------------------------------------
// Tree navigation helpers (work with any NodeLike)
// ---------------------------------------------------------------------------

type FoundNode = {
  node: NodeLike
  path: number[]
}

function isNode(x: unknown): x is NodeLike {
  return typeof x === 'object' && x !== null && (x as { _tag?: string })._tag === 'node'
}

/** Find the deepest NodeLike whose span contains `pos`. */
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

/** Walk up the path, collecting ancestor nodes root → target. */
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

/** Minimal interface needed to reconstruct nodes during tree replacement. */
type Rebuilder<N extends NodeLike> = {
  rebuild(node: N, children: ReadonlyArray<N | CSTLeaf | CSTError>): N
}

/**
 * Immutable replacement: rebuild ancestor nodes up the path via grammar.rebuild(),
 * leaving siblings and the rest of the tree untouched.
 * Delegating to rebuild() means custom buildNode() overrides are honoured —
 * class-instance nodes survive re-rooting correctly.
 */
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

/** Extract the node type N from a Parser<N>. */
type NodeOf<G> = G extends Parser<infer N> ? N : never

/**
 * Wraps a Parser with incremental re-parsing.
 *
 * On the first `parse()` call a full parse is performed. Subsequent `edit()`
 * calls find the smallest node that contains the edit, re-parse just that
 * node using its saved context, and stop early if the new node ends at the
 * same position as the old node (adjusted for the edit delta). This is
 * O(changed region) amortized for typical edits.
 *
 * Supports context-sensitive grammars via savedContext: each node records a
 * clone of ctx.user at parse time, so re-parsing starts from the exact same
 * context state — something tree-sitter cannot do.
 *
 *   const ip = new IncrementalParser(new CssParser(), 'Stylesheet')
 *   let tree = ip.parse(source)
 *   tree = ip.edit(source.slice(0, 42) + newText + source.slice(50), 42, 50)
 */
export class IncrementalParser<G extends Parser<any>> {
  private grammar: G
  private rootName: RuleKeys<G>
  private tree: NodeOf<G> | null = null
  private input: string = ''

  constructor(grammar: G, rootRule: RuleKeys<G>) {
    this.grammar = grammar
    this.rootName = rootRule
  }

  /** Full parse — always used the first time. Returns null if parse fails. */
  parse(input: string): NodeOf<G> | null {
    this.input = input
    const ctx: ParseContext = { trackLines: false }
    const r = this.grammar.rule(this.rootName).parse(input, 0, ctx)
    this.tree = r.ok ? r.value as NodeOf<G> : null
    return this.tree
  }

  /**
   * Incremental re-parse after an edit.
   *
   * @param newInput  The complete new input string.
   * @param editStart Character offset where the edit begins (inclusive).
   * @param editEnd   Character offset where the old text ends (exclusive).
   */
  edit(newInput: string, editStart: number, editEnd: number): NodeOf<G> | null {
    if (!this.tree) return this.parse(newInput)

    const delta = newInput.length - this.input.length

    const found = findContaining(this.tree, editStart)
    if (!found) return this.parse(newInput)

    // Walk from deepest containing node up toward root, trying each level.
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

      const parser = this.grammar.rule(node.type as RuleKeys<G>)
      const ctx: ParseContext = { trackLines: false, user: node.savedContext }
      const r = parser.parse(newInput, node.span.start, ctx)
      if (!r.ok) continue

      if (r.span.end === expectedEnd) {
        // Early termination: the rest of the tree is structurally unaffected.
        this.tree = replaceAtPath(this.grammar, this.tree!, path, r.value as NodeOf<G>)
        this.input = newInput
        return this.tree
      }
      // End position shifted — the edit affects more than this node; try parent.
    }

    return this.parse(newInput)
  }

  /** The current tree, or null if not yet parsed / last parse failed. */
  get currentTree(): NodeOf<G> | null { return this.tree }

  /** The input string that produced currentTree. */
  get currentInput(): string { return this.input }
}
