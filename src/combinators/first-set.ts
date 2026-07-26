import type { CharRange, FirstSet, Combinator, ParserDef } from '../types.ts'

/**
 * Resolve a NAMED cross-artifact rule reference (`g.Foo`) whose own thunk does not
 * resolve — the shared-shape hole, bound by name at fuse time.
 *
 * A shape module compiles `Ratio: sequence(g.Value, …)` without defining `Value`, so
 * that `lazy`'s thunk throws and every first-set through it degrades to `any`. Once
 * the shape is FUSED with a dialect that defines `Value`, the hole is bound — pass a
 * resolver over the fused winner map and the first-set is the real one.
 *
 * Only NAMED refs are resolvable: an unnamed `ref()` that was never `.define()`d
 * carries no name for anyone to bind, so it stays `any`.
 */
export type RefResolver = (name: string) => Combinator<unknown> | undefined

/** The `resolve`-supplied target for an unresolvable NAMED lazy, if any. */
function resolveNamedRef(p: Combinator<unknown>, resolve: RefResolver | undefined): Combinator<unknown> | undefined {
  if (resolve === undefined) return undefined
  const name = (p as unknown as { _ruleName?: string })._ruleName
  return name === undefined ? undefined : resolve(name)
}

export function union(a: FirstSet, b: FirstSet): FirstSet {
  if (a.kind === 'any' || b.kind === 'any') return { kind: 'any' }
  if (a.kind === 'empty') return b
  if (b.kind === 'empty') return a
  return { kind: 'ranges', ranges: mergeRanges([...a.ranges, ...b.ranges]) }
}

export function intersects(a: FirstSet, b: FirstSet): boolean {
  if (a.kind === 'any' || b.kind === 'any') return true
  if (a.kind === 'empty' || b.kind === 'empty') return false
  for (const ra of a.ranges) {
    for (const rb of b.ranges) {
      if (ra.lo <= rb.hi && rb.lo <= ra.hi) return true
    }
  }
  return false
}

export function fromChar(code: number): FirstSet {
  return { kind: 'ranges', ranges: [{ lo: code, hi: code }] }
}

/**
 * True when `combinator`'s first set admits the code point at `input[pos]` (or its
 * first set is `any`). The runtime counterpart of codegen's `firstSetCond` guard —
 * used by the interpreter's first-set fail-fast in `optional`/`many`/`attempt`/
 * `node` to reject a doomed sub-parse before doing any setup. Returns `false` at EOF.
 */
export function startsFirstSet(combinator: Combinator<unknown>, input: string, pos: number): boolean {
  const fs = combinator._meta.firstSet
  if (fs.kind === 'any') return true
  if (fs.kind === 'empty') return false
  const code = input.codePointAt(pos)
  if (code === undefined) return false
  for (const r of fs.ranges) if (code >= r.lo && code <= r.hi) return true
  return false
}

export function fromRange(lo: number, hi: number): FirstSet {
  return { kind: 'ranges', ranges: [{ lo, hi }] }
}

export function any(): FirstSet {
  return { kind: 'any' }
}

export function empty(): FirstSet {
  return { kind: 'empty' }
}

/**
 * Can this parser SUCCEED consuming zero characters (nullable / matches-empty)?
 * Used to compute a sound sequence first-set: a nullable leading term lets the
 * NEXT term's first chars start the whole sequence. MUST err toward `true` when
 * unsure — over-estimating nullability only widens the (over-approximated) first
 * set, which stays sound; under-estimating would drop valid start chars and make
 * first-char dispatch skip a matching arm.
 */
export function matchesEmpty(
  p: Combinator<unknown>,
  seen: Set<Combinator<unknown>> = new Set(),
  resolve?: RefResolver,
): boolean {
  // Cycle guard: a mutually-nullable ref cycle (e.g. `A = oneOrMore(B); B = oneOrMore(A)`)
  // would recurse forever. Treat a re-entered node as nullable — the safe (`true`)
  // default, consistent with the err-toward-true contract below.
  if (seen.has(p)) return true
  seen.add(p)
  const me = (c: Combinator<unknown>): boolean => matchesEmpty(c, seen, resolve)
  const d = p._def as ParserDef
  switch (d.tag) {
    case 'literal':   return d.value.length === 0
    case 'keywords':  return false
    case 'routed':    return false
    case 'regex':
      // Precise: does the pattern admit a zero-length match? (`a*`, `a?`, `a|`, …)
      try { const m = new RegExp(d.source).exec(''); return m != null && m[0] === '' }
      catch { return true }
    case 'many':
    case 'optional':
    case 'not':
    case 'peek':     return true          // zero repetitions / absent / lookahead
    // Default `sepBy` is `(item (sep item)*)?` — it MATCHES THE EMPTY STRING.
    // Any `min >= 1` requires that many ITEMS, so it is nullable only when the
    // item is. (Keying this off `min === 1` reported every `{ min: 2 }` list as
    // nullable — safe, but wrong, and it put a bogus `nullable-prefix` note on
    // the gating diagnostic for a list that can never match empty.)
    case 'sepBy':     return d.min >= 1 ? me(d.parser) : true
    case 'oneOrMore': return me(d.parser)
    case 'sequence':  return d.parsers.every(me)
    case 'choice':
      return d.parsers.some(me)
    case 'dispatch':
      return me(d.selector)
    case 'transform':
    case 'label':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'expect':
    case 'withCtx':
    case 'node':
    case 'grammar':
    case 'recover':   return me(d.parser)
    case 'skip':      return me(d.main)
    case 'lazy':
      try { return me(d.thunk()) }
      catch { const t = resolveNamedRef(p, resolve); return t ? me(t) : true }
    default:          return true          // scanTo / guard / unknown → assume nullable (safe)
  }
}

/**
 * A ZERO-WIDTH ASSERTION never consumes input, so it contributes NOTHING to a
 * sequence's first-set — the first consumed char comes from the following
 * non-nullable term. `not(X)` reports `firstSet: any()` (it cannot know what it
 * forbids), which would otherwise poison a sequence's first-set to `any` and kill
 * first-char dispatch of the whole arm. Skipping its contribution is SOUND: a
 * first-set used for dispatch gating must stay a correct SUPERSET of the rule's
 * true first chars, and `not(X) Y` can only start with a char in firstSet(Y) — the
 * assertion only NARROWS the language (it forbids a full match ahead), it never
 * widens the set of possible first chars beyond Y. So firstSet(Y) is a sound (and
 * tighter) superset.
 *
 * The POSITIVE lookahead `peek(X)` is zero-width too, but it is NOT in this
 * predicate: unlike `not`, it knows what it requires, so its first-set is a real
 * constraint that must be INTERSECTED into the sequence's set rather than dropped
 * (see `isPositiveLookahead` and `sequenceFirstSet`).
 */
export function isZeroWidthAssertion(p: Combinator<unknown>): boolean {
  return (p._def as ParserDef).tag === 'not'
}

/**
 * A POSITIVE zero-width assertion (`peek(X)`). It consumes nothing, so like
 * `not(X)` it does not contribute a first char of its own — but it does REQUIRE
 * that X match here, so `peek(X) Y` can only start with a char in
 * firstSet(X) ∩ firstSet(Y). That intersection is what makes a leading `peek()`
 * gate its choice arm; `not(not(X))`, the only previous spelling, reports `any()`
 * and poisons the dispatch instead.
 *
 * Soundness: first-sets are SUPERSETS of the true first chars, and
 * (A ⊇ a) ∧ (B ⊇ b) ⇒ A ∩ B ⊇ a ∩ b — so intersecting stays a superset and can
 * never skip a real match. A NULLABLE body succeeds on the empty string and
 * therefore constrains nothing; `peek()` reports `any()` in that case, which the
 * intersection treats as "no constraint".
 */
export function isPositiveLookahead(p: Combinator<unknown>): boolean {
  return (p._def as ParserDef).tag === 'peek'
}

/** Intersect a lookahead constraint into an accumulator; `any` = no constraint. */
function narrowBy(acc: FirstSet | null, constraint: FirstSet): FirstSet | null {
  if (constraint.kind === 'any') return acc
  if (acc === null) return constraint
  if (acc.kind === 'any') return constraint
  if (acc.kind === 'empty' || constraint.kind === 'empty') return { kind: 'empty' }
  const ranges: CharRange[] = []
  for (const a of acc.ranges) for (const b of constraint.ranges) {
    const lo = Math.max(a.lo, b.lo)
    const hi = Math.min(a.hi, b.hi)
    if (lo <= hi) ranges.push({ lo, hi })
  }
  return ranges.length === 0 ? { kind: 'empty' } : { kind: 'ranges', ranges }
}

/**
 * Apply the accumulated `peek()` constraints to a sequence's first-set. When the
 * consuming terms contributed NOTHING (the sequence is all zero-width/nullable,
 * e.g. a bare `peek(X)` arm), the assertion IS the first-set: the sequence can
 * only succeed — even zero-width — where X matches.
 */
function applyAssertion(fs: FirstSet, assertion: FirstSet | null): FirstSet {
  if (assertion === null) return fs
  if (fs.kind === 'empty') return assertion
  return narrowBy(fs, assertion) ?? fs
}

/**
 * First-set of a sequence: union each term's first-set through the NULLABLE
 * PREFIX — a leading `optional(…)` / `many(…)` / nullable term can be skipped, so
 * the sequence can begin with a LATER term's first char. Stop at (and include)
 * the first non-nullable term. (`parsers[0].firstSet` alone under-approximates
 * and silently breaks first-char dispatch — see the InterpolatedSelector bug.)
 * A leading zero-width assertion (`not(…)`) is nullable but contributes NOTHING to
 * the first-set (see `isZeroWidthAssertion`) — its `any` must not poison the union.
 */
export function sequenceFirstSet(parsers: readonly Combinator<unknown>[]): FirstSet {
  let fs: FirstSet = empty()
  let assertion: FirstSet | null = null
  for (const p of parsers) {
    if (isPositiveLookahead(p)) {
      // Zero-width but CONSTRAINING: intersect, keep scanning (it consumes nothing).
      assertion = narrowBy(assertion, p._meta.firstSet)
      continue
    }
    if (!isZeroWidthAssertion(p)) fs = union(fs, p._meta.firstSet)
    if (!matchesEmpty(p)) return applyAssertion(fs, assertion)
  }
  return applyAssertion(fs, assertion)
}

/**
 * Deep first-set that RESOLVES `lazy`/`ref` combinators to their targets. The
 * combinators bake `_meta.firstSet` at CONSTRUCTION, when a `ref()` still reads
 * `any()` (define() never updates it) — so a `choice`/`sequence` built over refs
 * caches a spuriously-`any` first-set and loses first-char dispatch. Recomputing
 * here, following refs, recovers the real set. Over-approximates on cycles /
 * unknown constructs (returns `any`) — always sound: a wider set only means "try
 * this arm for more first chars", never skips a real match.
 *
 * SOUND ONLY where refs are FINAL (monolithic compile). Under compose OVERRIDE a
 * referenced rule can be replaced with a WIDER first-set, so a baked deep set
 * would wrongly skip valid input — the compose path defers dispatch to fuse time.
 *
 * `resolve` binds NAMED cross-artifact holes (`g.Foo`) against a fused winner map —
 * see `RefResolver`. Diagnostic-only today: it is what lets the gating analysis ask
 * the question at the site where the hole actually HAS an answer.
 */
export function firstSetOf(
  p: Combinator<unknown>,
  seen: Set<Combinator<unknown>> = new Set(),
  resolve?: RefResolver,
): FirstSet {
  if (seen.has(p)) return any()               // cycle → any (safe over-approximation)
  seen.add(p)
  const fs = (c: Combinator<unknown>): FirstSet => firstSetOf(c, seen, resolve)
  const empties = (c: Combinator<unknown>): boolean => matchesEmpty(c, new Set(), resolve)
  const d = p._def as ParserDef
  switch (d.tag) {
    case 'literal':
    case 'regex':
    case 'keywords':  return p._meta.firstSet  // terminals: no refs, cached set is exact
    case 'dispatch':  return fs(d.selector)
    case 'lazy':
      try { return fs(d.thunk()) }
      catch { const t = resolveNamedRef(p, resolve); return t ? fs(t) : any() }
    case 'choice': {
      let out: FirstSet = empty()
      for (const arm of d.parsers) out = union(out, fs(arm))
      return out
    }
    case 'sequence': {
      // Union through the nullable prefix (a leading nullable term lets a later
      // term's first chars start the sequence) — ref-resolving `sequenceFirstSet`.
      // A leading zero-width assertion (`not`) contributes nothing (its `any` would
      // poison the union) but is still nullable, so keep scanning past it. A
      // positive `peek()` is zero-width AND constraining → intersect.
      let out: FirstSet = empty()
      let assertion: FirstSet | null = null
      for (const term of d.parsers) {
        if (isPositiveLookahead(term)) { assertion = narrowBy(assertion, fs(term)); continue }
        if (!isZeroWidthAssertion(term)) out = union(out, fs(term))
        if (!empties(term)) return applyAssertion(out, assertion)
      }
      return applyAssertion(out, assertion)
    }
    case 'peek': {
      // Deep-resolve the body: a `ref()` reads `any()` at CONSTRUCTION, so the
      // shallow `_meta.firstSet` baked into the assertion would lose the gate.
      const inner = d.parser
      return empties(inner) ? any() : fs(inner)
    }
    case 'oneOrMore':
    case 'many':
    case 'optional':
    case 'transform':
    case 'label':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'node':
    case 'grammar':
    case 'expect':    return fs(d.parser)
    case 'sepBy':     return fs(d.parser)   // both min 0 and min 1 start with the item
    case 'skip':      return fs(d.main)
    default:          return p._meta.firstSet  // not / scanTo / guard / withCtx / recover / unknown
  }
}

function mergeRanges(ranges: CharRange[]): CharRange[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.lo - b.lo)
  // Always copy — never alias input objects
  const out: CharRange[] = [{ lo: sorted[0]!.lo, hi: sorted[0]!.hi }]
  for (let i = 1; i < sorted.length; i++) {
    const top = out[out.length - 1]!
    const cur = sorted[i]!
    if (cur.lo <= top.hi + 1) {
      if (cur.hi > top.hi) top.hi = cur.hi
    } else {
      out.push({ lo: cur.lo, hi: cur.hi })
    }
  }
  return out
}
