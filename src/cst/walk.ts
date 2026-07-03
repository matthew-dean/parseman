/**
 * Tree traversal for the CST/AST a grammar produces. Parséman hands back a plain
 * object tree, so you *can* recurse it yourself — these helpers save you from
 * re-writing the same recursion for diagnostics, folding, or lowering a tree.
 *
 * Two entry points:
 *   - `walk`          — imperative depth-first traversal with enter/leave hooks.
 *   - `createVisitor` — Chevrotain-style dispatch keyed on each node's `type`.
 *
 * Both default to the built-in CST shape (`CSTChild` — the `node()` / leaf / error
 * union), so with no annotation you get precise typing out of the box. Parsing to
 * a custom AST? Pass your node type as a generic: `walk<MyNode>(root, …)`.
 */
import type { CSTChild } from './types.ts'

/**
 * The minimal shape these helpers traverse: a `_tag`, an optional rule `type`,
 * and optional structural `children`. The built-in `CSTChild` satisfies it, and
 * so does any custom AST node (that's what the generic override targets).
 */
export type Walkable = {
  readonly _tag: string
  readonly type?: string
  readonly children?: ReadonlyArray<Walkable>
}

export interface WalkVisitor<N extends Walkable = CSTChild, C = undefined> {
  /**
   * Called on entering a node, before its children. Return `false` to skip
   * descending into this node's children (`leave` still runs).
   */
  enter?(node: N, parent: N | null, ctx: C): boolean | void
  /** Called on leaving a node, after its children. */
  leave?(node: N, parent: N | null, ctx: C): void
}

/**
 * Depth-first traversal. Visits `root`, then each structural child in order.
 * `ctx` is threaded to both hooks unchanged (use it as an accumulator).
 *
 * Defaults to the CST shape; override with `walk<MyNode>(root, …)`:
 *
 *   const idents: string[] = []
 *   walk(tree, {
 *     enter(node) {
 *       if (node._tag === 'leaf') idents.push(node.value)
 *     },
 *   })
 */
export function walk<N extends Walkable = CSTChild, C = undefined>(
  root: N,
  visitor: WalkVisitor<N, C>,
  ctx: C = undefined as C,
): void {
  const go = (node: N, parent: N | null): void => {
    const descend = visitor.enter ? visitor.enter(node, parent, ctx) : undefined
    const children = node.children as ReadonlyArray<N> | undefined
    if (descend !== false && Array.isArray(children)) {
      for (const child of children) go(child, node)
    }
    visitor.leave?.(node, parent, ctx)
  }
  go(root, null)
}

export interface VisitApi<R, N extends Walkable = CSTChild> {
  /** Dispatch a node to its handler (by `type`); returns the handler's result. */
  visit(node: N): R | undefined
  /** Visit every structural child, collecting the defined results in order. */
  visitChildren(node: N): R[]
}

export type VisitorHandlers<R, N extends Walkable = CSTChild> = Record<
  string,
  (node: N, api: VisitApi<R, N>) => R
>

/**
 * Build a visitor that dispatches on each node's `type` — the direct analog of a
 * generated CST-visitor base class. Handlers are keyed by rule name and receive
 * an `api` with `visit` / `visitChildren` to recurse:
 *
 *   const evalExpr = createVisitor<number>({
 *     Num: (n) => Number((n as NumNode).value),
 *     Add: (n, api) => api.visitChildren(n).reduce((a, b) => a + b, 0),
 *   })
 *   const total = evalExpr(tree)
 *
 * Defaults to the CST shape; override the return type and node type together with
 * `createVisitor<number, MyNode>({ … })`. A node whose `type` has no handler
 * falls through to visiting its children (results discarded), so partial visitors
 * work without listing every rule.
 */
export function createVisitor<R = void, N extends Walkable = CSTChild>(
  handlers: VisitorHandlers<R, N>,
): (node: N) => R | undefined {
  const api: VisitApi<R, N> = {
    visit(node) {
      const handler = node.type !== undefined ? handlers[node.type] : undefined
      if (handler) return handler(node, api)
      api.visitChildren(node)
      return undefined
    },
    visitChildren(node) {
      const out: R[] = []
      const children = node.children as ReadonlyArray<N> | undefined
      if (Array.isArray(children)) {
        for (const child of children) {
          const r = api.visit(child)
          if (r !== undefined) out.push(r)
        }
      }
      return out
    },
  }
  return (node) => api.visit(node)
}
