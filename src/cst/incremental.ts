/**
 * Incremental reparse-and-resync for Parséman.
 *
 * After a source edit, reparse only the affected region and reuse untouched
 * subtrees from the previous parse instead of a full reparse. The correctness
 * oracle is absolute: for any source + any edit, the incremental result is
 * structurally identical (deep-equal: types, spans, leaf values) to a fresh
 * full `parse(newSource)`.
 *
 * ── What the driver can and cannot do (the honest constraint) ────────────────
 * Parséman's driver has NO reified continuation stack. A combinator's `parse`
 * runs to completion on the native JS call stack, so there is no way to resume
 * in the *middle* of a rule's continuation (e.g. after term 2 of a 5-term
 * sequence) — the remaining terms live on the call stack, not in `node.state`.
 * `node.state` snapshots only `ctx.state` (grammar-author data), not the parse
 * continuation.
 *
 * The finest re-entry the driver DOES support is a *rule boundary*: a `node()`
 * rule is a complete, self-contained combinator that can be re-run at any
 * position with a restored `ctx.state`. So "resume mid-stream" here means
 * "resume at the deepest rule boundary at/around the edit", which is exactly
 * what `parseDoc` already exploits for a rules() registry. This module brings
 * that to the raw `parse(combinator, source)` CST, and adds the backtracking /
 * lookahead reuse-validity guard (Stage 2) that a bare end-offset convergence
 * check is missing.
 */
import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import type { CSTNode, CSTLeaf, CSTError, CSTChild } from './types.ts'
import { parse } from '../combinators/grammar.ts'

export type Edit = { start: number; deleted: number; inserted: string }

export type IncrementalResult = {
  /** The new CST — structurally identical to parse(newSource). */
  tree: CSTChild
  /** Count of nodes+leaves reused from the old parse (shared by identity). */
  reusedNodes: number
  /** Total nodes+leaves in the new tree. */
  totalNodes: number
  /** [start, end) region of newSource that was actually reparsed. */
  reparsedRange: { start: number; end: number }
  /** How reuse was achieved — for tests / telemetry. */
  strategy: 'reentry' | 'full'
}

// ── Tree helpers ────────────────────────────────────────────────────────────

function isNode(x: unknown): x is CSTNode {
  return typeof x === 'object' && x !== null && (x as { _tag?: string })._tag === 'node'
}
function isLeaf(x: unknown): x is CSTLeaf {
  return typeof x === 'object' && x !== null && (x as { _tag?: string })._tag === 'leaf'
}
function hasChildren(x: unknown): x is { children: readonly CSTChild[] } {
  return (isNode(x) || (x as { _tag?: string })?._tag === 'error') && Array.isArray((x as { children?: unknown }).children)
}

function countNodes(child: CSTChild): number {
  let n = 1
  if (hasChildren(child)) for (const c of child.children) n += countNodes(c)
  return n
}

/** Deep structural equality: _tag, type, span, leaf value, recursive children. */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const at = (a as { _tag?: string })._tag
  const bt = (b as { _tag?: string })._tag
  if (at !== bt) return false
  const as = (a as { span?: { start: number; end: number } }).span
  const bs = (b as { span?: { start: number; end: number } }).span
  if (as || bs) {
    if (!as || !bs || as.start !== bs.start || as.end !== bs.end) return false
  }
  if (at === 'leaf' || at === 'trivia') {
    return (a as { value: string }).value === (b as { value: string }).value
  }
  if ((a as { type?: string }).type !== (b as { type?: string }).type) return false
  const ac = (a as { children?: readonly unknown[] }).children
  const bc = (b as { children?: readonly unknown[] }).children
  if (ac || bc) {
    if (!ac || !bc || ac.length !== bc.length) return false
    for (let i = 0; i < ac.length; i++) if (!structurallyEqual(ac[i], bc[i])) return false
  }
  return true
}

// ── Span shifting (absolute model; shares the prefix by identity) ────────────

function shiftChild(child: CSTChild, delta: number): CSTChild {
  const span = { ...child.span, start: child.span.start + delta, end: child.span.end + delta }
  if (hasChildren(child)) {
    return { ...child, span, children: child.children.map((c) => shiftChild(c, delta)) } as CSTChild
  }
  return { ...child, span } as CSTChild
}

// ── Node navigation ──────────────────────────────────────────────────────────

type Found = { node: CSTNode; path: number[] }

/** Deepest node whose span strictly contains `pos` (for a zero-width edit at `pos`). */
function findContaining(node: CSTNode, pos: number, path: number[] = []): Found | null {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    if (!isNode(child)) continue
    if (child.span.start <= pos && pos < child.span.end) {
      const inner = findContaining(child, pos, [...path, i])
      return inner ?? { node: child, path: [...path, i] }
    }
    // Also handle a node ending exactly at pos (edit at a boundary): include it as
    // a candidate but keep looking; the ancestor chain covers boundary edits.
  }
  return null
}

/** Chain of nodes from root down to (and including) the node at `path`. */
function ancestorsAt(root: CSTNode, path: number[]): Found[] {
  const chain: Found[] = [{ node: root, path: [] }]
  let cur = root
  const acc: number[] = []
  for (const idx of path) {
    const child = cur.children[idx]
    if (!isNode(child)) break
    acc.push(idx)
    chain.push({ node: child, path: [...acc] })
    cur = child
  }
  return chain
}

/**
 * Graft `newNode` at `path`: siblings before the edited child are shared by
 * identity, the edited child is replaced, siblings after are span-shifted by
 * `delta`, and each ancestor's span.end grows by delta. Returns [tree, reused].
 */
function graftAndShift(
  root: CSTNode,
  path: number[],
  newNode: CSTNode,
  delta: number,
): CSTNode {
  if (path.length === 0) return newNode
  const [idx, ...rest] = path as [number, ...number[]]
  const newChildren = root.children.map((child, i): CSTChild => {
    if (i < idx) return child // shared by identity — unchanged prefix
    if (i === idx) {
      return rest.length === 0 ? newNode : graftAndShift(child as CSTNode, rest, newNode, delta)
    }
    return delta === 0 ? child : shiftChild(child, delta) // suffix
  })
  return {
    ...root,
    span: { ...root.span, end: root.span.end + delta },
    children: newChildren,
  }
}

/** Count nodes shared by identity between old and new trees (reuse metric). */
function countShared(oldTree: CSTChild, newTree: CSTChild): number {
  if (oldTree === newTree) return countNodes(newTree)
  if (!hasChildren(oldTree) || !hasChildren(newTree)) return 0
  let shared = 0
  const oc = oldTree.children
  const nc = newTree.children
  for (let i = 0; i < nc.length; i++) {
    // Match children positionally where identity survived.
    if (oc[i] !== undefined) shared += countShared(oc[i]!, nc[i]!)
  }
  return shared
}

// ── Rule registry: type → its node() combinator ──────────────────────────────

/**
 * Walk the combinator `_def` tree collecting each node() rule's own combinator,
 * keyed by its `type`. A node() combinator is a complete, re-runnable unit — the
 * re-entry primitive. `lazy`/`ref` thunks are resolved (guarded against cycles).
 */
export function collectRules(root: Combinator<unknown>): Map<string, Combinator<unknown>> {
  const out = new Map<string, Combinator<unknown>>()
  const seen = new Set<Combinator<unknown>>()
  const visit = (c: Combinator<unknown> | undefined): void => {
    if (!c || seen.has(c)) return
    seen.add(c)
    const def = c._def
    switch (def.tag) {
      case 'node':
        if (!out.has(def.type)) out.set(def.type, c)
        visit(def.parser)
        break
      case 'lazy': {
        let inner: Combinator<unknown> | undefined
        try { inner = def.thunk() } catch { inner = undefined }
        visit(inner)
        break
      }
      case 'sequence':
      case 'choice':
        for (const p of def.parsers) visit(p)
        break
      case 'many':
      case 'oneOrMore':
      case 'optional':
      case 'transform':
      case 'trivia':
      case 'label':
      case 'not':
      case 'expect':
      case 'grammar':
        visit((def as { parser: Combinator<unknown> }).parser)
        break
      case 'sepBy':
        visit(def.parser); visit(def.separator); break
      case 'skip':
        visit(def.main); visit(def.skipped); break
      case 'withCtx':
        visit(def.parser); break
      case 'recover':
        visit(def.parser); visit(def.sentinel); break
      case 'scanTo':
        for (const s of def.skip) visit(s); visit(def.sentinel); break
      default:
        break
    }
  }
  visit(root)
  return out
}

// ── Stage 2: lookahead / backtracking reuse-validity guard ───────────────────

/**
 * A reused suffix spliced at boundary `b` (new coords) is only sound if the
 * reparse's result did NOT depend on any input at/after `b` — otherwise a
 * lookahead or backtrack read across the splice and the fresh full parse could
 * differ. We prove independence by an edit-sentinel probe: re-run the same rule
 * at the same position on an input where the first character at `b` is replaced
 * by a sentinel (and, defensively, the whole tail). If the produced node is
 * structurally identical, no lookahead crossed `b`; the boundary is safe.
 *
 * Conservative by construction: any probe difference (or failure) ⇒ not safe ⇒
 * caller widens toward a full reparse. Correctness over reuse fraction.
 */
function boundaryIsSafe(
  rule: Combinator<unknown>,
  newInput: string,
  start: number,
  boundary: number,
  state: unknown,
  produced: ParseResult<unknown>,
): boolean {
  if (!produced.ok) return false
  if (boundary >= newInput.length) return true // nothing after the node to peek at
  // Two sentinels that cannot both equal the real tail char — if either changes
  // the parse, some read crossed the boundary.
  for (const sentinel of [' ', '￿']) {
    if (newInput[boundary] === sentinel) continue
    const probed = newInput.slice(0, boundary) + sentinel.repeat(newInput.length - boundary)
    const ctx: ParseContext = { trackLines: false, state }
    let r: ParseResult<unknown>
    try {
      r = rule.parse(probed, start, ctx)
    } catch {
      return false
    }
    if (!r.ok) return false
    if (r.span.end !== produced.span.end) return false
    if (!structurallyEqual(r.value, produced.value)) return false
  }
  return true
}

// ── Public API ────────────────────────────────────────────────────────────────

export type IncrementalOptions = {
  /** Skip the Stage-2 lookahead guard (unsafe — tests / benchmarking only). */
  unsafeSkipGuard?: boolean
}

/**
 * Incrementally reparse `newSource` (= applying `edit` to `oldSource`) reusing
 * untouched subtrees from `oldParse`. Falls back to a full, correct reparse
 * whenever incremental reuse cannot be proven sound.
 *
 * `oldParse` must be the CST from `parse(combinator, oldSource)` for the SAME
 * `combinator`. The result tree is deep-equal to `parse(combinator, newSource)`.
 */
export function incrementalReparse(
  combinator: Combinator<unknown>,
  oldParse: CSTChild,
  oldSource: string,
  edit: Edit,
  opts: IncrementalOptions = {},
): IncrementalResult {
  const delta = edit.inserted.length - edit.deleted
  const newSource = oldSource.slice(0, edit.start) + edit.inserted + oldSource.slice(edit.start + edit.deleted)

  const full = (strategy: IncrementalResult['strategy'] = 'full'): IncrementalResult => {
    const r = parse(combinator, newSource)
    const tree = (r.ok ? (r.value as CSTChild) : errorTree(newSource))
    return {
      tree,
      reusedNodes: 0,
      totalNodes: countNodes(tree),
      reparsedRange: { start: 0, end: newSource.length },
      strategy,
    }
  }

  // Only nodes carry re-entry state; a bare leaf/error root can't be re-entered.
  if (!isNode(oldParse)) return full()

  // The edited character range in OLD coords. For a pure insertion (deleted=0)
  // this is the zero-width point `edit.start`.
  const editFrom = edit.start
  const editTo = edit.start + edit.deleted

  const rules = collectRules(combinator)

  // Locate the deepest node containing the edit start, then build the widening
  // chain of ancestors (deepest → root). A boundary edit (at a node's edge) is
  // covered because an ancestor always spans across the boundary.
  const found = findContaining(oldParse, editFrom)
  const chain: Found[] = found
    ? ancestorsAt(oldParse, found.path).reverse()
    : [{ node: oldParse, path: [] }]

  for (const { node, path } of chain) {
    // The reused subtree must fully contain the edited range; otherwise the edit
    // touches a sibling and this candidate can't be the resync unit.
    if (!(node.span.start <= editFrom && editTo <= node.span.end)) continue
    const rule = rules.get(node.type)
    if (!rule) continue

    const ctx: ParseContext = { trackLines: false, state: node.state }
    let r: ParseResult<unknown>
    try {
      r = rule.parse(newSource, node.span.start, ctx)
    } catch {
      continue
    }
    if (!r.ok) continue
    if (!isNode(r.value)) continue

    // Convergence: the reparsed rule must end exactly at the old node's shifted
    // boundary. Only then does the untouched suffix line up for splicing.
    const expectedEnd = node.span.end + delta
    if (r.span.end !== expectedEnd) continue

    // Stage 2: prove no lookahead/backtrack read past the reparsed node's end.
    if (!opts.unsafeSkipGuard &&
        !boundaryIsSafe(rule, newSource, node.span.start, expectedEnd, node.state, r)) {
      continue // widen — inspected input crossed the boundary
    }

    const newNode = r.value as CSTNode
    const newTree = graftAndShift(oldParse, path, newNode, delta)
    const reused = countShared(oldParse, newTree)
    return {
      tree: newTree,
      reusedNodes: reused,
      totalNodes: countNodes(newTree),
      reparsedRange: { start: node.span.start, end: expectedEnd },
      strategy: 'reentry',
    }
  }

  return full()
}

function errorTree(source: string): CSTChild {
  return { _tag: 'error', type: '<parse-error>', span: { start: 0, end: source.length }, expected: [], children: [], state: undefined } as CSTError
}
