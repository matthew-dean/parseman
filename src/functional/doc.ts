/**
 * Incremental parse document — incremental re-parse over a rules() registry.
 */
import type { ParseContext, ParseFail, ParseResult } from '../types.ts'
import type { NodeLike, CSTLeaf, CSTError } from '../cst/types.ts'

/** A single compiled (or interpreted) rule: parse from `pos`, producing node `N`. */
export type RuleFn<N> = (input: string, pos: number, ctx: ParseContext) => ParseResult<N>

/** Rule name → parser function. This is exactly the shape `rules()` returns. */
export type Registry<N> = Record<string, RuleFn<N>>

export type ParseDocOptions<N extends NodeLike> = {
  /** Initial grammar state threaded into ctx.state for the root parse. */
  state?: unknown
  /**
   * Reconstruct a parent node with one child replaced (used when grafting a
   * re-parsed subtree into its ancestors). Defaults to a shallow spread, which
   * works for plain-object nodes; class-instance ASTs should supply their own.
   */
  rebuild?: (node: N, children: ReadonlyArray<N | CSTLeaf | CSTError>) => N
}

export interface ParseDoc<N extends NodeLike> {
  readonly tree: N | null
  readonly errors: ParseFail[]
  readonly input: string
  /**
   * Incrementally re-parse after a text change. `from`/`to` are byte offsets in
   * the OLD input; `replacement` fills that range (editor change-event shape).
   */
  edit(from: number, to: number, replacement: string): ParseDoc<N>
}

// ---------------------------------------------------------------------------
// Tree navigation (generic over NodeLike — no class, no CST assumptions)
// ---------------------------------------------------------------------------

type FoundNode<N extends NodeLike> = { node: N; path: number[] }

function isNode(x: unknown): x is NodeLike {
  return typeof x === 'object' && x !== null && (x as { _tag?: string })._tag === 'node'
}

function findContaining<N extends NodeLike>(node: N, pos: number, path: number[] = []): FoundNode<N> | null {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    if (!isNode(child)) continue
    if (child.span.start <= pos && pos < child.span.end) {
      const inner = findContaining(child as N, pos, [...path, i])
      return inner ?? { node: child as N, path: [...path, i] }
    }
  }
  return null
}

function ancestorsAt<N extends NodeLike>(root: N, path: number[]): N[] {
  const ancestors: N[] = [root]
  let cur: N = root
  for (const idx of path.slice(0, -1)) {
    const child = cur.children[idx]
    if (!child || !isNode(child)) break
    ancestors.push(child as N)
    cur = child as N
  }
  return ancestors
}

function replaceAtPath<N extends NodeLike>(
  rebuild: NonNullable<ParseDocOptions<N>['rebuild']>,
  root: N,
  path: number[],
  newNode: N,
): N {
  if (path.length === 0) return newNode
  const [idx, ...rest] = path as [number, ...number[]]
  const newChildren = [...root.children] as Array<N | CSTLeaf | CSTError>
  newChildren[idx] = rest.length === 0
    ? newNode
    : replaceAtPath(rebuild, root.children[idx] as N, rest, newNode)
  return rebuild(root, newChildren)
}

function defaultRebuild<N extends NodeLike>(node: N, children: ReadonlyArray<N | CSTLeaf | CSTError>): N {
  return { ...node, children } as N
}

type SpanChild = { span: { start: number; end: number }; children?: readonly unknown[] }

/**
 * Deep-shift every absolute span in a subtree by `delta`. Used for nodes that
 * sit *after* a length-changing edit: their content didn't change but their
 * offsets moved. Plain-object path only (see `graftAndShift`).
 */
function shiftSpans<T>(child: T, delta: number): T {
  const c = child as unknown as SpanChild
  const span = { start: c.span.start + delta, end: c.span.end + delta }
  if (Array.isArray(c.children)) {
    return { ...(c as object), span, children: c.children.map((g) => shiftSpans(g, delta)) } as unknown as T
  }
  return { ...(c as object), span } as unknown as T
}

/**
 * Graft `newNode` at `path` for a length-changing edit (`delta !== 0`):
 * children before the edit are shared by reference, the edited child is
 * replaced, children after it are span-shifted by `delta`, and each ancestor's
 * `span.end` grows by `delta`. Absolute-offset trees must touch every node after
 * the edit — that's inherent — but everything before it is still shared.
 */
function graftAndShift<N extends NodeLike>(root: N, path: number[], newNode: N, delta: number): N {
  if (path.length === 0) return newNode
  const [idx, ...rest] = path as [number, ...number[]]
  const oldChildren = root.children as ReadonlyArray<N | CSTLeaf | CSTError>
  const newChildren = oldChildren.map((child, i) => {
    if (i < idx) return child
    if (i === idx) {
      return rest.length === 0 ? newNode : graftAndShift(child as N, rest, newNode, delta)
    }
    return shiftSpans(child, delta)
  })
  return {
    ...root,
    span: { start: root.span.start, end: root.span.end + delta },
    children: newChildren,
  } as N
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

class ParseDocImpl<N extends NodeLike> implements ParseDoc<N> {
  private readonly _registry: Registry<N>
  private readonly _rootRule: string
  private readonly _opts: ParseDocOptions<N>
  readonly tree: N | null
  readonly errors: ParseFail[]
  readonly input: string

  constructor(
    registry: Registry<N>,
    rootRule: string,
    opts: ParseDocOptions<N>,
    tree: N | null,
    errors: ParseFail[],
    input: string,
  ) {
    this._registry = registry
    this._rootRule = rootRule
    this._opts = opts
    this.tree = tree
    this.errors = errors
    this.input = input
  }

  edit(from: number, to: number, replacement: string): ParseDoc<N> {
    const newInput = this.input.slice(0, from) + replacement + this.input.slice(to)
    const reparse = () => parseDoc(this._registry, this._rootRule, newInput, this._opts)

    if (!this.tree) return reparse()

    const delta = replacement.length - (to - from)
    const found = findContaining(this.tree, from)
    if (!found) return reparse()

    // Try the innermost containing rule first, then widen outward.
    const ancestors = ancestorsAt(this.tree, found.path)
    const candidates: FoundNode<N>[] = [found]
    const pathCopy = [...found.path]
    for (let i = ancestors.length - 2; i >= 0; i--) {
      pathCopy.pop()
      candidates.push({ node: ancestors[i + 1]!, path: [...pathCopy] })
    }

    const rebuild = this._opts.rebuild ?? defaultRebuild
    for (const { node, path } of candidates) {
      const ruleFn = this._registry[node.type]
      if (!ruleFn) continue
      const ctx: ParseContext = { trackLines: false, state: node.state }
      const r = ruleFn(newInput, node.span.start, ctx)
      if (!r.ok) continue
      if (r.span.end === node.span.end + delta) {
        // delta === 0: spans are unchanged, so the spine graft (sharing every
        // untouched sibling by reference) is already correct.
        if (delta === 0) {
          const newTree = replaceAtPath(rebuild, this.tree, path, r.value)
          return new ParseDocImpl(this._registry, this._rootRule, this._opts, newTree, [], newInput)
        }
        // Length-changing edit: nodes after the edit must have their absolute
        // spans shifted. A custom `rebuild` can't have its spans shifted safely
        // (it may be a class instance), so fall back to a full, correct reparse.
        if (this._opts.rebuild) return reparse()
        const newTree = graftAndShift(this.tree, path, r.value, delta)
        return new ParseDocImpl(this._registry, this._rootRule, this._opts, newTree, [], newInput)
      }
    }

    return reparse()
  }
}

/**
 * Parse `input` from `rootRule` and wrap the result in a ParseDoc that can
 * be incrementally re-parsed via `.edit()`.
 */
export function parseDoc<N extends NodeLike>(
  registry: Registry<N>,
  rootRule: string,
  input: string,
  opts: ParseDocOptions<N> = {},
): ParseDoc<N> {
  const ruleFn = registry[rootRule]
  if (!ruleFn) throw new Error(`No rule '${rootRule}' in registry`)
  const ctx: ParseContext = { trackLines: false, state: opts.state }
  const r: ParseResult<N> = ruleFn(input, 0, ctx)
  if (r.ok) {
    return new ParseDocImpl(registry, rootRule, opts, r.value, [], input)
  }
  return new ParseDocImpl(registry, rootRule, opts, null, [{ ok: false, expected: r.expected, span: r.span }], input)
}
