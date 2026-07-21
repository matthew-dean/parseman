/**
 * Incremental parse document — incremental re-parse over a rules() registry.
 */
import type { Combinator, ParseContext, ParseError, ParseResult, ParserDef, Span } from '../types.ts'
import type { NodeLike, CSTLeaf, CSTError } from '../cst/types.ts'
import { relativizeCST, absoluteSpanCST } from '../cst/relative-spans.ts'
import { REC } from '../recovery/scan.ts'

/**
 * Build the parse ctx for a (re)parse. In `tolerant` mode the same recovery bundle
 * the interpreter/`run` use is installed (`_tolerant` + `_rec`), so a broken edit
 * keeps producing a tree (with recovered `ParseError`s embedded) instead of
 * collapsing to `null`. Strict mode is byte-identical to before. Every reparse site
 * — root, localized rule reparse, list-splice middle, and the soundness probes —
 * threads the SAME flag, so a probe's tolerance matches the parse it is checking
 * (a mismatch would spuriously diverge and forgo reuse, never miscompare).
 */
function mkCtx(state: unknown, build: ParseContext['build'], tolerant: boolean): ParseContext {
  return tolerant
    ? { trackLines: false, state, build, _tolerant: true, _rec: REC, _errors: [] }
    : { trackLines: false, state, build }
}

/** A single compiled (or interpreted) rule: parse from `pos`, producing node `N`. */
export type RuleFn<N> = (input: string, pos: number, ctx: ParseContext) => ParseResult<N>

/**
 * Rule name → parser. Each entry is either a bare parse function or a
 * `Combinator` (what `rules()` returns). Passing the `rules()` combinators
 * directly lets `.edit()` inspect the grammar — required for **sound** structural
 * list-reuse (see `structuralReuse`): only a rule the grammar proves is a genuine
 * repetition is ever spliced. A bare-function registry still parses correctly; it
 * just can't be structurally reused (the splice is skipped, never guessed).
 */
export type Registry<N> = Record<string, RuleFn<N> | Combinator<N>>

/** Normalize a registry entry to a callable parse function. */
function asRuleFn<N>(entry: RuleFn<N> | Combinator<N>): RuleFn<N> {
  return typeof entry === 'function' ? entry : (input, pos, ctx) => entry.parse(input, pos, ctx)
}

/** The combinator def behind a registry entry, if it carries one (bare functions don't). */
function defOf(entry: unknown): ParserDef | undefined {
  return typeof entry === 'object' && entry !== null && '_def' in entry
    ? (entry as { _def: ParserDef })._def
    : undefined
}

/**
 * Does this rule's grammar produce its element children via a genuine, unbounded
 * **repetition** (`sepBy` / `many` / `oneOrMore`) — as opposed to a fixed-arity
 * sequence of same-typed tokens (e.g. `Triple = Num ',' Num ',' Num`)? Only the
 * former is sound to structurally reuse: a full reparse accepts any element count,
 * so splicing one in or out matches it; a fixed-arity rule would not. We walk the
 * def, transparently unwrapping semantic wrappers (`node`, `transform`, …) and
 * looking through a top-level `sequence` / `optional` (the `[ (sepBy)? ]` shape),
 * and return true iff a repetition combinator is reachable that way. Structurally
 * indistinguishable-from-the-CST cases (fixed sequences) return false and fall
 * back to a full, correct reparse. This is what makes `structuralReuse` sound
 * rather than a promise the caller has to keep.
 */
function producesRepetition(def: ParserDef | undefined, depth = 0): boolean {
  if (!def || depth > 24) return false
  const d = def as ParserDef & Record<string, unknown>
  switch (d.tag) {
    case 'sepBy':
    case 'many':
    case 'oneOrMore':
      return true
    // Rule entries and `ref`s wrap their body in a `lazy` thunk — resolve it. The
    // `depth` cap bounds any self-referential cycle (a repetition, if present, is
    // found shallowly before recursion goes deep).
    case 'lazy': {
      const thunk = d.thunk as (() => { _def?: ParserDef }) | undefined
      let inner: { _def?: ParserDef } | undefined
      try { inner = typeof thunk === 'function' ? thunk() : undefined } catch { return false }
      return producesRepetition(inner?._def, depth + 1)
    }
    // Transparent wrappers — look through to the inner parser.
    case 'node':
    case 'transform':
    case 'attempt':
    case 'token':
    case 'leaf':
    case 'label':
    case 'field':
    case 'expect':
    case 'withCtx':
    case 'grammar':
    case 'optional':
      return producesRepetition(defOf(d.parser), depth + 1)
    case 'skip':
      return producesRepetition(defOf(d.main), depth + 1)
    // A bracketed/anchored list is a sequence whose element run is a repetition.
    case 'sequence':
      return (d.parsers as unknown[]).some(p => producesRepetition(defOf(p), depth + 1))
    default:
      return false
  }
}

export type ParseDocOptions<N extends NodeLike> = {
  /** Initial grammar state threaded into ctx.state for the root parse. */
  state?: unknown
  /**
   * Reconstruct a parent node with one child replaced (used when grafting a
   * re-parsed subtree into its ancestors). Defaults to a shallow spread, which
   * works for plain-object nodes; class-instance ASTs should supply their own.
   */
  rebuild?: (node: N, children: ReadonlyArray<N | CSTLeaf | CSTError>) => N
  /**
   * Mode host for a linkable/fused grammar (RULE_ABI_PLAN §7): threaded into
   * `ctx.build` on every (re)parse so `node()` rules build a positioned CST /
   * language-service tree instead of their own eval-AST. Unset → the grammar's
   * own builders (eval mode).
   */
  build?: ParseContext['build']
  /**
   * Enable structural list-reuse: on a length-changing *structural* edit (adding
   * or removing a whole element in a collection) that would otherwise force a full
   * reparse, reparse only the disturbed span and reuse the collection's untouched
   * tail elements by identity — turning an insert near the top of a large list from
   * O(list) into O(edit + trailing siblings).
   *
   * OFF by default because it is sound only when a rule whose CST children form a
   * homogeneous, separator-delimited element list is a genuine REPETITION
   * (`many` / `sepBy` / `oneOrMore`), not a fixed-arity sequence of same-typed
   * tokens (e.g. `Triple = Num ',' Num ',' Num`) — the two are structurally
   * indistinguishable without the grammar, and splicing the latter would accept an
   * element count it shouldn't. Turn it on when your list rules are true
   * repetitions (the common case: JSON arrays/objects, CSS value lists, argument
   * lists). Every splice is still guarded (exact tiling + lookahead probe +
   * stateless-tail check) and falls back to a full, correct reparse when unproven;
   * the flag only authorises *attempting* the reuse.
   */
  structuralReuse?: boolean
  /**
   * Parse tolerantly: `many`/`sepBy`/`oneOrMore` recover from a failed element
   * (skip to an inferred sync point, embed a `ParseError` over the skipped span),
   * so a broken edit keeps producing a tree instead of collapsing to `null` — the
   * editor-backend path. Off by default (strict, byte-identical). Recovery is a cold
   * path: well-formed input never triggers it. Every reparse the doc does — root,
   * localized rule, and list-splice — inherits this flag, and the reuse-soundness
   * probes run at the same tolerance so incremental reuse stays valid under recovery
   * (a scan that would cross a splice boundary just falls back to a full reparse).
   */
  tolerant?: boolean
  /**
   * The grammar's trivia rule, used ONLY to compute `unconsumedFrom`: a root rule
   * consumes trivia BETWEEN terms but not after the last, so trailing
   * whitespace/comments would otherwise read as leftover input. Given the trivia
   * rule, the tail is skipped before reporting the first unconsumed offset —
   * matching `run()`'s semantics. Defaults to the root rule's own
   * `_meta.grammarTrivia` (from `rules({ trivia })`); set it only to override.
   */
  trivia?: Combinator<unknown>
}

export interface ParseDoc<N extends NodeLike> {
  /**
   * The parse tree with PARENT-RELATIVE spans — each node's `span` is relative to
   * its parent's start (root base 0). This is the shareable representation: a
   * length-changing `.edit()` keeps every untouched subtree shared by identity,
   * and reading the tree is O(1) (no offset rewrite). For absolute positions use
   * the O(depth) cursor `spanAt(path)`, or `absolutizeCST(doc.tree)` to
   * materialize the whole absolute tree. A fresh non-incremental `node().parse()`
   * result is unchanged — still absolute.
   */
  readonly tree: N | null
  /**
   * Recovery diagnostics collected during the (re)parse — the missing-token
   * `expect()` errors and tolerant-list recovery errors that ride the tree as
   * `parseError` nodes, surfaced here as a flat list too (spans ABSOLUTE). Empty
   * in strict mode. On a hard (non-recovered) parse failure this holds the single
   * top-level failure. This is what makes an editor document able to see syntax
   * errors — a blank `errors: []` (the prior behaviour) hid every recovery.
   */
  readonly errors: ParseError[]
  /**
   * Offset where unparsed input begins — the first non-trivia character the parse
   * left unconsumed (trailing trivia skipped when a trivia rule is available), or
   * `null` if the whole input was consumed. This is how a document detects "the
   * grammar stopped short, there's junk here"; computed exactly as `run()` does.
   */
  readonly unconsumedFrom: number | null
  readonly input: string
  /**
   * Absolute span of the node at `path` (child indices from the root) — O(depth),
   * without materializing the absolute tree. The projection cursor for the
   * relative representation; use it for spot queries on a large incremental doc.
   */
  spanAt(path: readonly number[]): { start: number; end: number }
  /**
   * Incrementally re-parse after a text change. `from`/`to` are byte offsets in
   * the OLD input; `replacement` fills that range (editor change-event shape).
   * Sound: the result tree is always structurally identical to a fresh
   * `parseDoc` of the edited text (the Stage-2 guard falls back to a full
   * reparse whenever reuse can't be proven safe). Reuse/strategy is intentionally
   * NOT reported here — an observer derives it by diffing this tree against the
   * previous one (see the incremental tests); the runtime's job is to be fast,
   * not to measure itself.
   */
  edit(from: number, to: number, replacement: string): ParseDoc<N>
}

// ---------------------------------------------------------------------------
// Tree navigation (generic over NodeLike — no class, no CST assumptions)
// ---------------------------------------------------------------------------

/**
 * A reentry candidate is only worth reparsing if it's meaningfully smaller than
 * the whole document — reparsing a rule that spans (say) >half the input costs
 * about as much as a full reparse with none of the reuse. Above this fraction of
 * the input length, `.edit()` skips straight to a full reparse. Keeps the worst
 * case (a structural edit near the front) at ~1× full reparse, never several.
 */
const REENTRY_MAX_SPAN_FRACTION = 0.5

type FoundNode<N extends NodeLike> = { node: N; path: number[] }

function isNode(x: unknown): x is NodeLike {
  return typeof x === 'object' && x !== null && (x as { _tag?: string })._tag === 'node'
}

/**
 * Locate the deepest node containing absolute offset `pos`. The tree stores
 * PARENT-RELATIVE spans (see relative-spans), so we thread each node's absolute
 * start down the descent: a child's absolute start is `nodeAbsStart +
 * child.span.start`.
 */
function findContaining<N extends NodeLike>(
  node: N,
  nodeAbsStart: number,
  pos: number,
  path: number[] = [],
): FoundNode<N> | null {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    if (!isNode(child)) continue
    const childAbsStart = nodeAbsStart + child.span.start
    const childAbsEnd = nodeAbsStart + child.span.end
    if (childAbsStart <= pos && pos < childAbsEnd) {
      const inner = findContaining(child as N, childAbsStart, pos, [...path, i])
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
 * Shift a node's PARENT-RELATIVE span by `delta`. Used for siblings that sit
 * *after* a length-changing edit inside the same parent: the node moved as a
 * unit, so both endpoints slide by `delta`, but its own children are relative to
 * *its* start and are unchanged — so `children` is shared by identity. That's the
 * relative-span win: O(1) per trailing sibling, not O(subtree). (Contrast the old
 * absolute model, which had to deep-rewrite every descendant.)
 */
function shiftRelStart<T>(child: T, delta: number): T {
  const c = child as unknown as SpanChild
  return { ...(c as object), span: { start: c.span.start + delta, end: c.span.end + delta } } as unknown as T
}

/**
 * Graft `newNode` at `path` into a parent-relative tree for a length-changing
 * edit (`delta !== 0`): children before the edit are shared by reference, the
 * edited child is replaced, children *after* it have their relative start slid by
 * `delta` (one shallow alloc each — their subtrees are shared by identity), and
 * each ancestor's relative `span.end` grows by `delta` while its start is
 * untouched. Cost is O(depth + trailing siblings along the spine), independent of
 * how many nodes sit inside those trailing siblings.
 */
function graftRelative<N extends NodeLike>(root: N, path: number[], newNode: N, delta: number): N {
  if (path.length === 0) return newNode
  const [idx, ...rest] = path as [number, ...number[]]
  const oldChildren = root.children as ReadonlyArray<N | CSTLeaf | CSTError>
  const newChildren = oldChildren.map((child, i) => {
    if (i < idx) return child
    if (i === idx) {
      return rest.length === 0 ? newNode : graftRelative(child as N, rest, newNode, delta)
    }
    return shiftRelStart(child, delta)
  })
  return {
    ...root,
    span: { start: root.span.start, end: root.span.end + delta },
    children: newChildren,
  } as N
}

// ---------------------------------------------------------------------------
// List-splice reuse (structural edits in a collection)
//
// A structural edit — inserting or deleting a whole element in a list — makes the
// innermost-rule reparse fail to converge, and the containing collection is often
// too big to reparse (that's the "insert at the top of a large array" case where
// a whole-rule reparse costs ~a full reparse). Instead of reparsing the whole
// collection, reparse ONLY the disturbed span between the last untouched element
// before the edit and the first untouched element after it, then splice: the head
// children are shared as-is, the freshly-parsed middle replaces the changed run,
// and the tail children are reused with their relative start slid by `delta`
// (O(1) each — their subtrees are shared by identity, the relative-span win).
//
// Soundness rests on: (1) the reparsed middle exactly fills [reStart, reEnd) and
// lands on element/separator boundaries; (2) a lookahead probe proving the middle
// read nothing at/after the splice point (else it peeked into the reused tail);
// (3) a stateless-reentry precondition on the reused tail (its saved `state` is
// null), so a forward, context-free grammar reproduces those subtrees unchanged.
// Any failure ⇒ `null` ⇒ the caller falls back to a full, correct reparse. The
// incremental oracle fuzz (edit() ≡ full reparse, 400 seeds × 3 list grammars +
// edge cases) is the end-to-end correctness net.
// ---------------------------------------------------------------------------

type AnyChild = { readonly _tag: string; readonly span: { start: number; end: number }; readonly value?: string; readonly type?: string; readonly state?: unknown; readonly children?: readonly unknown[] }

/**
 * Parse the collection's disturbed middle `[reStart, reEnd)` as an
 * `element (separator element)*` run (optionally with a trailing separator that
 * connects to the reused tail), C-relative. Alternation is STRICT: after an
 * element, if we're not yet at `reEnd`, the separator MUST match — element/element
 * juxtaposition is rejected (that's a `sepBy` violation). When the grammar has no
 * separator (`separator === null`, i.e. a bare repetition), consecutive elements
 * are allowed. Returns the C-relative children, or `null` if the run doesn't tile
 * `[reStart, reEnd)` exactly on token boundaries.
 */
function parseMiddle(
  input: string,
  reStart: number,
  reEnd: number,
  cStart: number,
  ruleFn: RuleFn<NodeLike>,
  separator: string | null,
  build: ParseContext['build'],
  tolerant: boolean,
): AnyChild[] | null {
  const ctx: ParseContext = mkCtx(null, build, tolerant)
  const out: AnyChild[] = []
  let pos = reStart
  let guard = 0
  while (pos < reEnd) {
    if (++guard > reEnd - reStart + 2) return null // no-progress backstop
    // After an element, a separator is mandatory before the next element (unless
    // the grammar is separator-free). This is what keeps `elem elem` — invalid in
    // a `sepBy` — from being accepted as two elements.
    if (separator && out.length > 0 && out[out.length - 1]!._tag === 'node') {
      if (pos + separator.length > reEnd || !input.startsWith(separator, pos)) return null
      out.push({ _tag: 'leaf', value: separator, span: { start: pos - cStart, end: pos + separator.length - cStart } })
      pos += separator.length
      continue
    }
    let r: ParseResult<NodeLike>
    try {
      r = ruleFn(input, pos, ctx)
    } catch {
      return null
    }
    if (!r.ok || r.span.end <= pos || r.span.end > reEnd) return null
    out.push(relativizeCST(r.value as unknown as AnyChild, cStart))
    pos = r.span.end
  }
  return pos === reEnd ? out : null
}

/**
 * Try to reuse the untouched tail of collection `C` (at `path`, absolute start
 * `cStart`) around a length-changing edit, reparsing only the disturbed middle.
 * Returns the new relative root, or `null` to fall back to a full reparse.
 */
function tryListSplice<N extends NodeLike>(
  root: N,
  path: number[],
  C: N,
  cStart: number,
  newInput: string,
  from: number,
  to: number,
  delta: number,
  registry: Record<string, RuleFn<N>>,
  build: ParseContext['build'],
  tolerant: boolean,
): N | null {
  const kids = C.children as ReadonlyArray<AnyChild>
  if (kids.length === 0) return null

  // head = maximal prefix ending before the edit, backed off so it ends at a
  // leaf (open delimiter or separator) — i.e. where an ELEMENT is next expected.
  let h = 0
  while (h < kids.length && cStart + kids[h]!.span.end <= from) h++
  while (h > 0 && kids[h - 1]!._tag === 'node') h--
  // tail = maximal suffix starting after the edit, advanced so it BEGINS at an
  // element (node) boundary — a self-contained element run to reuse.
  let t = kids.length
  while (t > h && cStart + kids[t - 1]!.span.start >= to) t--
  while (t < kids.length && kids[t]!._tag !== 'node') t++
  if (t >= kids.length) return null // nothing reusable after the edit

  // Stateless-reentry precondition on the reused tail (see soundness note).
  for (let i = t; i < kids.length; i++) {
    if (kids[i]!._tag === 'node' && kids[i]!.state != null) return null
  }

  // C must look like a genuine homogeneous COLLECTION — a repetition of one
  // element rule joined by one separator — not a fixed heterogeneous sequence
  // (e.g. `Pair = Key ':' Val`, whose `:` is not a list separator). Require: all
  // element (node) children share a type, and there are ≥2 elements joined by a
  // consistent separator leaf. This rejects fixed sequences (their nodes differ
  // in type, or there's only one) so we never treat them as splice-able lists.
  let elemType: string | undefined
  let elemCount = 0
  for (const k of kids) {
    if (k._tag !== 'node') continue
    elemCount++
    if (elemType === undefined) elemType = k.type
    else if (k.type !== elemType) return null // heterogeneous → not a collection
  }
  if (elemType === undefined || elemCount < 2) return null
  const ruleFn = registry[elemType]
  if (!ruleFn) return null
  // The separator is the leaf that appears between two elements; require it to be
  // consistent everywhere two elements meet (a real list delimiter).
  let separator: string | null = null
  for (let i = 1; i < kids.length - 1; i++) {
    if (kids[i - 1]!._tag === 'node' && kids[i + 1]!._tag === 'node') {
      if (kids[i]!._tag !== 'leaf') return null
      const sep = kids[i]!.value ?? null
      if (separator === null) separator = sep
      else if (sep !== separator) return null // inconsistent delimiter → not a plain list
    }
  }
  if (separator === null) return null // ≥2 elements but no delimiter between any pair

  // The disturbed middle must be pure elements + separators. If the collection is
  // bracketed, its OPENING / CLOSING delimiter (a leaf whose value isn't the
  // separator, sitting before the first / after the last element) must lie OUTSIDE
  // the edit — otherwise the edit changed the collection's own framing and a
  // whole-rule reparse (not a splice) is required.
  const first = kids[0]!
  const last = kids[kids.length - 1]!
  if (first._tag === 'leaf' && first.value !== separator && from < cStart + first.span.end) return null
  if (last._tag === 'leaf' && last.value !== separator && to > cStart + last.span.start) return null

  const reStart = h > 0 ? cStart + kids[h - 1]!.span.end : cStart
  const reEnd = cStart + kids[t]!.span.start + delta
  if (reEnd < reStart) return null

  const middle = parseMiddle(newInput, reStart, reEnd, cStart, ruleFn as RuleFn<NodeLike>, separator, build, tolerant)
  if (!middle) return null

  // Junction check: `tail` always begins with an ELEMENT (we advanced `t` to a
  // node), so a non-empty middle must END with a SEPARATOR to connect validly —
  // otherwise the edit deleted the delimiter between the middle's last element and
  // the tail's first, and splicing would fuse two elements with no separator (a
  // `sepBy` violation the whole-collection reparse would never produce). When the
  // middle is empty the tail is preceded by `head`'s last token, itself already a
  // separator or the open delimiter (head was backed off to a leaf), so it's fine.
  if (middle.length > 0) {
    const last = middle[middle.length - 1]!
    if (!(last._tag === 'leaf' && last.value === separator)) return null
  }

  // Lookahead guard: the middle must have read nothing at/after `reEnd`, else it
  // peeked into the reused tail. Re-run over an input whose tail is overwritten
  // with a sentinel and require an identical middle. Two sentinels so the real
  // byte at `reEnd` can't accidentally match the probe.
  if (reEnd < newInput.length) {
    for (const sentinel of [' ', '￿']) {
      if (newInput[reEnd] === sentinel) continue
      const probed = newInput.slice(0, reEnd) + sentinel.repeat(newInput.length - reEnd)
      const probe = parseMiddle(probed, reStart, reEnd, cStart, ruleFn as RuleFn<NodeLike>, separator, build, tolerant)
      if (!probe || probe.length !== middle.length) return null
      for (let i = 0; i < middle.length; i++) if (!structurallyEqual(probe[i], middle[i])) return null
    }
  }

  const head = kids.slice(0, h)
  const tail = kids.slice(t).map((k) => shiftRelStart(k, delta))
  const newC = {
    ...C,
    span: { start: C.span.start, end: C.span.end + delta },
    children: [...head, ...middle, ...tail],
  } as N

  // Replace C at `path` and slide C's own trailing siblings / ancestor ends.
  return graftRelative(root, path, newC, delta)
}

// ---------------------------------------------------------------------------
// Stage-2 soundness guard
// ---------------------------------------------------------------------------

/**
 * Deep structural equality on parse trees: `_tag`, `span`, node `type`, leaf
 * `value`, and children pairwise. This is the oracle relation `.edit()` must
 * preserve against a full reparse; it's also what the Stage-2 guard compares
 * probe results with.
 */
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
  if (at === 'parseError') {
    // Embedded recovered error: span already compared above; also compare the
    // expected-token set so two errors at the same span but different expectations
    // are not conflated (the oracle must distinguish them).
    const ae = (a as { expected?: readonly string[] }).expected ?? []
    const be = (b as { expected?: readonly string[] }).expected ?? []
    return ae.length === be.length && ae.every((x, i) => x === be[i])
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

/**
 * A reused suffix spliced at `boundary` (new-input coords) is sound only if the
 * re-parse of the containing rule did NOT read any input at or after `boundary`
 * — otherwise a lookahead or backtrack peeked across the splice and the reused
 * tail could be wrong. We prove independence by re-running the same rule at the
 * same start on an input whose entire tail from `boundary` is overwritten with a
 * sentinel: if the produced node is byte-for-byte structurally identical,
 * nothing past `boundary` was inspected. Two distinct sentinels are tried so the
 * real char at `boundary` can't accidentally equal the probe. Conservative by
 * construction — any probe difference, failure, or throw ⇒ not safe ⇒ the caller
 * widens toward a full reparse (correctness over reuse fraction).
 */
function boundaryIsSafe<N extends NodeLike>(
  ruleFn: RuleFn<N>,
  newInput: string,
  start: number,
  boundary: number,
  state: unknown,
  build: ParseContext['build'],
  produced: ParseResult<N>,
  tolerant: boolean,
): boolean {
  if (!produced.ok) return false
  if (boundary >= newInput.length) return true // nothing after the node to peek at
  for (const sentinel of [' ', '￿']) {
    if (newInput[boundary] === sentinel) continue
    const probed = newInput.slice(0, boundary) + sentinel.repeat(newInput.length - boundary)
    const ctx: ParseContext = mkCtx(state, build, tolerant)
    let r: ParseResult<N>
    try {
      r = ruleFn(probed, start, ctx)
    } catch {
      return false
    }
    if (!r.ok || r.span.end !== produced.span.end) return false
    if (!structurallyEqual(r.value, produced.value)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

class ParseDocImpl<N extends NodeLike> implements ParseDoc<N> {
  private readonly _registry: Registry<N>
  /** Registry entries normalized to callable parse functions (memoized once). */
  private readonly _fns: Record<string, RuleFn<N>>
  /** Rule names the grammar proves are genuine repetitions — the ONLY splice-safe types. */
  private readonly _reps: Set<string>
  private readonly _rootRule: string
  private readonly _opts: ParseDocOptions<N>
  /**
   * The tree, held in whichever coordinate system it arrived in. A fresh parse
   * arrives ABSOLUTE (`_abs` set); an incremental graft arrives PARENT-RELATIVE
   * (`_rel` set). The public `tree` is always the RELATIVE form (so untouched
   * subtrees stay shared by identity across edits and reads are O(1)); it's
   * materialized from `_abs` once, on demand, and memoized. `undefined` = not yet
   * computed; `null` = failed parse. A fresh parse that's never edited nor
   * tree-read pays no conversion — important for the full-reparse fallback path.
   */
  private _abs: N | null | undefined
  private _rel: N | null | undefined
  readonly errors: ParseError[]
  readonly unconsumedFrom: number | null
  readonly input: string

  constructor(
    registry: Registry<N>,
    rootRule: string,
    opts: ParseDocOptions<N>,
    trees: { abs?: N | null; rel?: N | null },
    errors: ParseError[],
    unconsumedFrom: number | null,
    input: string,
  ) {
    this._registry = registry
    this._fns = {}
    this._reps = new Set()
    for (const [name, entry] of Object.entries(registry)) {
      this._fns[name] = asRuleFn(entry)
      if (producesRepetition(defOf(entry))) this._reps.add(name)
    }
    this._rootRule = rootRule
    this._opts = opts
    this._abs = trees.abs
    this._rel = trees.rel
    this.errors = errors
    this.unconsumedFrom = unconsumedFrom
    this.input = input
  }

  /**
   * The parse tree with PARENT-RELATIVE spans — a node's `span` is relative to
   * its parent's start (root base 0). This is the shareable representation:
   * untouched subtrees keep the same identity across `.edit()`s, and reading the
   * tree after a length-changing edit is O(1) (no offset rewrite). For absolute
   * positions use the O(depth) cursor `spanAt(path)`, or `absolutizeCST(tree)` to
   * materialize the whole absolute tree. (A fresh non-incremental `node().parse()`
   * result is unchanged — still absolute.)
   */
  get tree(): N | null {
    if (this._rel === undefined) {
      this._rel = this._abs ? (relativizeCST(this._abs as unknown as N & { span: Span }, 0) as unknown as N) : null
    }
    return this._rel
  }

  spanAt(path: readonly number[]): { start: number; end: number } {
    const rel = this.tree
    if (!rel) throw new Error('spanAt on a failed parse (tree is null)')
    return absoluteSpanCST(rel as unknown as { span: Span; children?: readonly unknown[] }, path)
  }

  /**
   * Wrap a reused (grafted/spliced) RELATIVE tree, recomputing `errors` and
   * `unconsumedFrom` from it so both stay consistent with the tree across the
   * edit (the flat errors are recovered errors embedded in the reused subtrees;
   * unconsumedFrom re-derives trailing junk over the new input).
   */
  private wrapReuse(newTree: N, newInput: string): ParseDoc<N> {
    const trivia = triviaOf(this._registry[this._rootRule], this._opts)
    const end = (newTree as unknown as { span: { end: number } }).span.end
    const errors = collectEmbeddedErrors(newTree, 0, [])
    const unconsumedFrom = unconsumedAfter(end, newInput, trivia)
    return new ParseDocImpl(this._registry, this._rootRule, this._opts, { rel: newTree }, errors, unconsumedFrom, newInput)
  }

  edit(from: number, to: number, replacement: string): ParseDoc<N> {
    const newInput = this.input.slice(0, from) + replacement + this.input.slice(to)
    const reparse = () => parseDoc(this._registry, this._rootRule, newInput, this._opts)

    const root = this.tree
    if (!root) return reparse()

    const delta = replacement.length - (to - from)
    // When `from` sits on the root's own boundary (e.g. right after a top-level
    // element, before its separator), no child node contains it and
    // `findContaining` returns null — but the root still does. Fall back to the
    // root as the container so the structural splice below still gets a shot
    // (this is exactly the "insert/delete a top-level list element" position).
    const found = findContaining(root, 0, from) ?? { node: root, path: [] as number[] }

    // Try the innermost containing rule first, then widen outward.
    const ancestors = ancestorsAt(root, found.path)
    const candidates: FoundNode<N>[] = [found]
    const pathCopy = [...found.path]
    for (let i = ancestors.length - 2; i >= 0; i--) {
      pathCopy.pop()
      candidates.push({ node: ancestors[i + 1]!, path: [...pathCopy] })
    }

    const rebuild = this._opts.rebuild ?? defaultRebuild
    for (const { node, path } of candidates) {
      // Absolute span of this candidate, projected from the relative root (O(depth)).
      const { start: absStart, end: absEnd } = absoluteSpanCST(root as unknown as { span: Span; children?: readonly unknown[] }, path)
      // Reentry only pays off when the re-parsed rule is substantially smaller
      // than the whole document. Candidates widen deepest→root (monotonically
      // growing span), so once one covers most of the input, reparsing it — and
      // every larger ancestor after it — can't beat a full reparse and would just
      // be wasted work before the fallback. Bail to the full reparse NOW. This
      // caps `.edit()` at ~one full reparse in the worst case (e.g. a structural
      // insert near the front) instead of stacking several near-full reparses.
      if (absEnd - absStart > this.input.length * REENTRY_MAX_SPAN_FRACTION) break
      const ruleFn = this._fns[node.type]
      if (!ruleFn) continue
      // The reused subtree must FULLY CONTAIN the edited range (old coords).
      // `findContaining` only locates `from`; if the edit's end `to` spills past
      // this node's end, the edit also changed a sibling/separator after it, and
      // reusing the untouched suffix would be unsound — widen to an ancestor
      // that does span the whole edit (ultimately a full reparse).
      if (!(absStart <= from && to <= absEnd)) continue
      const ctx: ParseContext = mkCtx(node.state, this._opts.build, !!this._opts.tolerant)
      const r = ruleFn(newInput, absStart, ctx)
      if (!r.ok) continue
      if (r.span.end !== absEnd + delta) continue

      // Stage-2 soundness guard: only reuse the untouched suffix if the re-parse
      // provably read no input past its own end (else a lookahead/backtrack
      // crossed the splice). Widen to the next candidate — ultimately a full
      // reparse — when it can't be proven.
      if (!boundaryIsSafe(ruleFn, newInput, absStart, absEnd + delta, node.state, this._opts.build, r, !!this._opts.tolerant)) {
        continue
      }

      // The re-parse produced an ABSOLUTE subtree; rebase it to parent-relative
      // for splicing into the relative tree. The parent's absolute start is
      // `absStart - node.span.start` (node.span is already relative to it).
      const parentBase = absStart - node.span.start
      const newRel = relativizeCST(r.value as unknown as N & { span: Span }, parentBase) as unknown as N

      // delta === 0: relative spans are unchanged, so the spine graft (sharing
      // every untouched sibling by reference) is already correct.
      if (delta === 0) {
        const newTree = replaceAtPath(rebuild, root, path, newRel)
        return this.wrapReuse(newTree, newInput)
      }
      // Length-changing edit: trailing siblings' relative starts slide by `delta`.
      // A custom `rebuild` (possibly a class instance) can't have its span slid
      // safely, so fall back to a full, correct reparse.
      if (this._opts.rebuild) return reparse()
      const newTree = graftRelative(root, path, newRel, delta)
      return this.wrapReuse(newTree, newInput)
    }

    // No localized rule reparse converged — the edit is structural. Before paying
    // a full reparse, try reusing the untouched tail of a containing collection
    // (add/remove an element in a list). We only ever splice a rule the GRAMMAR
    // proves is a genuine repetition (`this._reps`, from its combinator def) — a
    // fixed-arity same-typed sequence is structurally indistinguishable from a list
    // by its CST alone, so splicing it could accept a wrong element count; it's
    // excluded here and falls back to a full, correct reparse. Innermost containing
    // collection first; a candidate whose disturbed middle doesn't tile cleanly
    // returns null and we widen. Correctness net is the incremental oracle fuzz.
    if (this._opts.structuralReuse && delta !== 0 && !this._opts.rebuild) {
      // Candidates run innermost→ancestor but never include the root itself; the
      // splice-able collection can BE the root (e.g. a top-level `sepBy` list), so
      // consider it last.
      const spliceCandidates: FoundNode<N>[] = [...candidates, { node: root, path: [] }]
      for (const { node, path } of spliceCandidates) {
        if (!this._reps.has(node.type)) continue // grammar didn't prove this rule a repetition
        const { start: cStart, end: cEnd } = absoluteSpanCST(root as unknown as { span: Span; children?: readonly unknown[] }, path)
        if (!(cStart <= from && to <= cEnd)) continue
        const spliced = tryListSplice(root, path, node, cStart, newInput, from, to, delta, this._fns, this._opts.build, !!this._opts.tolerant)
        if (spliced) return this.wrapReuse(spliced, newInput)
      }
    }

    return reparse()
  }
}

/**
 * The relative (parent-offset) tree backing a doc. Currently identical to the
 * public `doc.tree` (which is relative); kept as a named internal handle for the
 * reuse-metric tests, which assert on the shareable representation explicitly.
 */
export function relTreeOf<N extends NodeLike>(doc: ParseDoc<N>): N | null {
  return doc.tree
}

/**
 * The grammar trivia rule to skip when computing `unconsumedFrom`: an explicit
 * `trivia` option wins; otherwise the root entry's ambient `grammarTrivia` (the
 * same source `run()` derives it from). A bare-function registry carries no meta,
 * so trailing trivia can't be inferred and the parse must reach the exact end.
 */
function triviaOf<N extends NodeLike>(
  entry: RuleFn<N> | Combinator<N> | undefined,
  opts: ParseDocOptions<N>,
): Combinator<unknown> | undefined {
  if (opts.trivia) return opts.trivia
  // Only an interpreter Combinator carries `_meta`; a bare parse function or a
  // compiled-grammar object (which bakes its ambient trivia into codegen) does
  // not, so there's nothing to derive and trailing trivia isn't skipped.
  if (entry === undefined || typeof entry === 'function') return undefined
  const meta = (entry as { _meta?: { grammarTrivia?: Combinator<unknown> } })._meta
  return meta ? meta.grammarTrivia : undefined
}

/**
 * First unconsumed non-trivia offset after a parse that ended at `end` (trailing
 * trivia skipped when a trivia rule is available), or `null` when the whole input
 * was consumed — byte-for-byte the computation in `run()` (run.ts:117-129).
 */
function unconsumedAfter(end: number, input: string, trivia: Combinator<unknown> | undefined): number | null {
  let pos = end
  if (trivia && pos < input.length) {
    const t = trivia.parse(input, pos, { trackLines: false })
    if (t.ok && t.span.end > pos) pos = t.span.end
  }
  return pos < input.length ? pos : null
}

/**
 * Collect embedded `parseError` recovery nodes from a PARENT-RELATIVE tree,
 * projecting each to an ABSOLUTE span (root base 0) — the flat mirror of the
 * errors that ride the tree, recomputed for a reuse-path (grafted/spliced) result
 * so `doc.errors` stays consistent with the tree across incremental edits.
 */
function collectEmbeddedErrors(node: unknown, base: number, out: ParseError[]): ParseError[] {
  const c = node as { _tag?: string; span?: { start: number; end: number }; expected?: string[]; children?: readonly unknown[] }
  if (!c || typeof c !== 'object' || !c.span) return out
  const start = base + c.span.start
  if (c._tag === 'parseError') {
    out.push({ _tag: 'parseError', span: { start, end: base + c.span.end }, expected: c.expected ?? [] })
    return out
  }
  if (Array.isArray(c.children)) for (const k of c.children) collectEmbeddedErrors(k, start, out)
  return out
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
  const entry = registry[rootRule]
  if (!entry) throw new Error(`No rule '${rootRule}' in registry`)
  const ctx: ParseContext = mkCtx(opts.state, opts.build, !!opts.tolerant)
  const r: ParseResult<N> = asRuleFn(entry)(input, 0, ctx)
  if (r.ok) {
    // A fresh parse is ABSOLUTE; the relative form is materialized lazily on the
    // first edit/spanAt, so a parse that's never edited pays no conversion. The
    // recovery errors the tolerant parse collected into ctx._errors are surfaced
    // flat too (like run()), and unconsumedFrom reports any trailing junk.
    const errors = ctx._errors ? [...ctx._errors] : []
    const unconsumedFrom = unconsumedAfter(r.span.end, input, triviaOf(entry, opts))
    return new ParseDocImpl(registry, rootRule, opts, { abs: r.value }, errors, unconsumedFrom, input)
  }
  // Hard (non-recovered) failure: the single top-level failure, as a parseError.
  const fail: ParseError = { _tag: 'parseError', span: r.span, expected: r.expected }
  return new ParseDocImpl(registry, rootRule, opts, { abs: null }, [fail], null, input)
}
