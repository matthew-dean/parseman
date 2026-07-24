import type { CharRange, FirstSet, Combinator, ParserDef } from '../types.ts'

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
export function matchesEmpty(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  // Cycle guard: a mutually-nullable ref cycle (e.g. `A = oneOrMore(B); B = oneOrMore(A)`)
  // would recurse forever. Treat a re-entered node as nullable — the safe (`true`)
  // default, consistent with the err-toward-true contract below.
  if (seen.has(p)) return true
  seen.add(p)
  const me = (c: Combinator<unknown>): boolean => matchesEmpty(c, seen)
  const d = p._def as ParserDef
  switch (d.tag) {
    case 'literal':   return d.value.length === 0
    case 'keywords':  return false
    case 'regex':
      // Precise: does the pattern admit a zero-length match? (`a*`, `a?`, `a|`, …)
      try { const m = new RegExp(d.source).exec(''); return m != null && m[0] === '' }
      catch { return true }
    case 'many':
    case 'optional':
    case 'not':       return true          // zero repetitions / absent / lookahead
    case 'oneOrMore': return me(d.parser)
    case 'sequence':  return d.parsers.every(me)
    case 'choice':
      return d.parsers.some(me)
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
      try { return me(d.thunk()) } catch { return true }
    default:          return true          // sepBy / scanTo / guard / unknown → assume nullable (safe)
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
 * Parseman has NO positive-lookahead combinator (`(?=X)` exists only INSIDE a
 * `regex()` pattern, where the regex first-set analyzer handles it). If one is ever
 * added, its tight first-set is firstSet(body) ∩ firstSet(Y) when `body` is
 * NON-nullable (both must be satisfiable at the same position), else firstSet(Y)
 * (a nullable `(?=body)` succeeds on empty, so it imposes no first-char constraint
 * and intersecting would UNSOUNDLY exclude valid chars). It must NOT be added to
 * this predicate without that intersection logic — a future assertion combinator
 * left out of this set merely contributes its shallow `any` first-set, which stays
 * sound (over-approximation), only losing tightness.
 */
export function isZeroWidthAssertion(p: Combinator<unknown>): boolean {
  return (p._def as ParserDef).tag === 'not'
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
  for (const p of parsers) {
    if (!isZeroWidthAssertion(p)) fs = union(fs, p._meta.firstSet)
    if (!matchesEmpty(p)) return fs
  }
  return fs
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
 */
export function firstSetOf(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): FirstSet {
  if (seen.has(p)) return any()               // cycle → any (safe over-approximation)
  seen.add(p)
  const fs = (c: Combinator<unknown>): FirstSet => firstSetOf(c, seen)
  const d = p._def as ParserDef
  switch (d.tag) {
    case 'literal':
    case 'regex':
    case 'keywords':  return p._meta.firstSet  // terminals: no refs, cached set is exact
    case 'lazy':
      try { return fs(d.thunk()) } catch { return any() }
    case 'choice': {
      let out: FirstSet = empty()
      for (const arm of d.parsers) out = union(out, fs(arm))
      return out
    }
    case 'sequence': {
      // Union through the nullable prefix (a leading nullable term lets a later
      // term's first chars start the sequence) — ref-resolving `sequenceFirstSet`.
      // A leading zero-width assertion (`not`) contributes nothing (its `any` would
      // poison the union) but is still nullable, so keep scanning past it.
      let out: FirstSet = empty()
      for (const term of d.parsers) {
        if (!isZeroWidthAssertion(term)) out = union(out, fs(term))
        if (!matchesEmpty(term)) return out
      }
      return out
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
    case 'sepBy':     return fs(d.parser)
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
