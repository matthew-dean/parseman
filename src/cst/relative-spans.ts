/**
 * Relative span model for incremental edits.
 *
 * Absolute source offsets are simple but fragile: an insertion at offset `at`
 * shifts EVERY downstream offset, so a whole-tree renumber is O(nodes-after-edit).
 * Storing each node's span RELATIVE to its parent's start makes edits local: an
 * insertion inside child k of a node only changes
 *   (a) child k's relative end,
 *   (b) the relative start of siblings after k,
 * and leaves the *children* of those shifted siblings untouched — they move with
 * their parent for free. So the mutation count is O(depth + trailing siblings),
 * not O(all following nodes), and every unaffected subtree is shared by identity.
 *
 * An absolute view is recovered on query by accumulating the parent base as you
 * descend (the `absolutize` / `absoluteSpanAt` cursor) — one source of truth,
 * two manifestations.
 */

/** A node with an ABSOLUTE source span and ordered children. */
export type AbsNode = {
  readonly start: number
  readonly end: number
  readonly children: readonly AbsNode[]
}

/** A node whose `start`/`end` are RELATIVE to its parent's start (root base = 0). */
export type RelNode = {
  readonly start: number
  readonly end: number
  readonly children: readonly RelNode[]
}

/** Convert an absolute tree to parent-relative spans. */
export function relativize(node: AbsNode, parentBase = 0): RelNode {
  return {
    start: node.start - parentBase,
    end: node.end - parentBase,
    children: node.children.map((c) => relativize(c, node.start)),
  }
}

/** Reconstruct absolute spans from a relative tree. Inverse of `relativize`. */
export function absolutize(node: RelNode, parentBase = 0): AbsNode {
  const start = parentBase + node.start
  return {
    start,
    end: parentBase + node.end,
    children: node.children.map((c) => absolutize(c, start)),
  }
}

/**
 * Absolute span of the node at `path` (child indices from the root), accumulating
 * the base as it descends — O(path length), no full absolutize. The relative-form
 * cursor: query any node's absolute position without materializing the whole tree.
 */
export function absoluteSpanAt(root: RelNode, path: readonly number[]): { start: number; end: number } {
  let base = 0
  let node = root
  for (const idx of path) {
    base += node.start
    const child = node.children[idx]
    if (!child) throw new RangeError(`absoluteSpanAt: no child ${idx} on path ${path.join('.')}`)
    node = child
  }
  return { start: base + node.start, end: base + node.end }
}

// ---------------------------------------------------------------------------
// CST-shaped projection (parseDoc incremental trees)
//
// The bare Abs/RelNode helpers above are the reference model. The functions
// below apply the same relative-span algebra to real CST children — nodes,
// leaves, and error nodes — where the span is a nested `{ start, end }` and
// children are heterogeneous (leaves carry a span but no `children`). Trivia
// never appears in structural `children`, so every child has a span.
// ---------------------------------------------------------------------------

/**
 * A CST child as far as span projection cares: a nested span + optional children.
 * `children` is typed loosely (`unknown[]`) so the real heterogeneous CST unions
 * (nodes, leaves, error nodes — a leaf has no `children`) satisfy it directly.
 */
type Spanned = {
  readonly span: { readonly start: number; readonly end: number }
  readonly children?: readonly unknown[]
}

/**
 * Rewrite a CST subtree's spans to be RELATIVE to `parentBase` (the absolute
 * start of the node's parent; root base = 0). Each child's own children are
 * relativized against *this* node's absolute start. Preserves every other field
 * (`_tag`, `type`, `state`, leaf `value`, …) by shallow spread.
 */
export function relativizeCST<T extends Spanned>(node: T, parentBase = 0): T {
  const span = { start: node.span.start - parentBase, end: node.span.end - parentBase }
  if (node.children) {
    const base = node.span.start
    return { ...node, span, children: node.children.map((c) => relativizeCST(c as Spanned, base)) } as T
  }
  return { ...node, span } as T
}

/** Reconstruct absolute CST spans from a relative subtree. Inverse of `relativizeCST`. */
export function absolutizeCST<T extends Spanned>(node: T, parentBase = 0): T {
  const start = parentBase + node.span.start
  const span = { start, end: parentBase + node.span.end }
  if (node.children) {
    return { ...node, span, children: node.children.map((c) => absolutizeCST(c as Spanned, start)) } as T
  }
  return { ...node, span } as T
}

/**
 * Absolute span of the CST node at `path` (child indices from the root),
 * accumulating the base as it descends — O(path length), no full absolutize.
 * The relative-form cursor for a positioned CST: query one node's absolute
 * position without materializing the whole tree.
 */
export function absoluteSpanCST(root: Spanned, path: readonly number[]): { start: number; end: number } {
  let base = 0
  let node: Spanned = root
  for (const idx of path) {
    base += node.span.start
    const child = node.children?.[idx] as Spanned | undefined
    if (!child) throw new RangeError(`absoluteSpanCST: no child ${idx} on path ${path.join('.')}`)
    node = child
  }
  return { start: base + node.span.start, end: base + node.span.end }
}

/** Naive absolute reshift (baseline): shift every offset >= `at` by `delta`. */
export function shiftAbsolute(node: AbsNode, at: number, delta: number): AbsNode {
  const s = node.start >= at ? node.start + delta : node.start
  const e = node.end >= at ? node.end + delta : node.end
  return {
    start: s,
    end: e,
    children: node.children.map((c) => shiftAbsolute(c, at, delta)),
  }
}

/**
 * Apply an edit of `delta` characters at absolute offset `at` to a RELATIVE tree.
 * Returns a new relative tree; every subtree that ends at/before `at` (in absolute
 * terms) is returned by IDENTITY (unchanged), so the result structurally shares
 * all unaffected subtrees with the input.
 *
 * `stats.allocated` counts nodes that had to be re-created — the incremental cost.
 */
export function applyEdit(
  root: RelNode,
  at: number,
  delta: number,
  stats?: { allocated: number },
): RelNode {
  // The root has no parent; its base never shifts (base 0).
  return editNode(root, at, delta, 0, 0, stats)
}

function editNode(
  node: RelNode,
  at: number,
  delta: number,
  parentBase: number,
  parentShift: number, // how much this node's parent base moved (0 or delta)
  stats?: { allocated: number },
): RelNode {
  const absStart = parentBase + node.start
  const absEnd = parentBase + node.end

  // Strictly before the edit → unchanged (its parent base is also unshifted).
  // Uses `< at` (not `<=`) to match the shift convention: offsets `>= at` move,
  // so a node ending exactly at `at` grows and must be rewritten.
  if (absEnd < at) return node

  // Fully after the edit AND the parent moved by `delta` too → this node moves as
  // one unit with its parent, so its parent-relative offsets are identical. Share
  // the ENTIRE subtree by identity — this is the O(depth) locality win.
  const startShifts = absStart >= at
  if (startShifts && parentShift === delta) return node

  if (stats) stats.allocated++

  const newAbsStart = startShifts ? absStart + delta : absStart
  const newAbsEnd = absEnd + delta // absEnd > at here (fully-before returned above)
  const newParentBase = parentBase + parentShift
  const newStart = newAbsStart - newParentBase
  const newEnd = newAbsEnd - newParentBase

  // Children are relative to this node's absolute start. Our own shift (0 or delta)
  // becomes their parentShift.
  const ownShift = newAbsStart - absStart
  let changed = false
  const newChildren: RelNode[] = []
  for (const c of node.children) {
    const nc = editNode(c, at, delta, absStart, ownShift, stats)
    if (nc !== c) changed = true
    newChildren.push(nc)
  }

  return {
    start: newStart,
    end: newEnd,
    children: changed ? newChildren : node.children,
  }
}
