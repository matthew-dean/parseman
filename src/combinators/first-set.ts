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
 * First-set of a sequence: union each term's first-set through the NULLABLE
 * PREFIX — a leading `optional(…)` / `many(…)` / nullable term can be skipped, so
 * the sequence can begin with a LATER term's first char. Stop at (and include)
 * the first non-nullable term. (`parsers[0].firstSet` alone under-approximates
 * and silently breaks first-char dispatch — see the InterpolatedSelector bug.)
 */
export function sequenceFirstSet(parsers: readonly Combinator<unknown>[]): FirstSet {
  let fs: FirstSet = empty()
  for (const p of parsers) {
    fs = union(fs, p._meta.firstSet)
    if (!matchesEmpty(p)) return fs
  }
  return fs
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
