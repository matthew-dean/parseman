/**
 * SHARED ENDS, FACTORED — a choice whose arms differ in one term.
 *
 * `choice(leaf(noTrivia(sequence(gap, '*', gap))), leaf(noTrivia(sequence(gap, '+', gap))))`
 * scans `gap` once per arm, and on a value with no operator (`red red`) both
 * arms scan it and then fail. Every arm is the same wrappers over a sequence of
 * the same terms except one, so the choice is that one term:
 *
 *   leaf(noTrivia(sequence(gap, choice('*', '+'), gap)))
 *
 * The gap is scanned once, and the inner choice dispatches on the character
 * after it.
 *
 * WHY IT IS THE SAME PARSE. Each arm is tried at the same position with the same
 * context, so its terms before the differing one match the same text with the
 * same value in every arm: running them once is what each arm's retry did. The
 * inner choice tries the differing terms in arm order, as the outer one tried
 * the arms. The terms after it may differ only as `optional`/`many`, which
 * cannot fail, so the arm that matched its differing term is the arm the outer
 * choice took. The sequence's values, the wrappers' spans and the leaf or node a
 * wrapper publishes are what that arm produced.
 *
 * A choice that fails rolls its last arm back and reports the position it started
 * at, so the factored form is an `attempt`, which does both. An arm that may
 * commit is left as written: a committed choice reports without rolling back.
 *
 * WHAT "THE SAME" MEANS. Two terms are the same when they are one combinator, or
 * their definitions are, field for field, down to shared combinators. A reducer
 * is the same function, or the same printed source: a table artifact carries a
 * reducer AS its source, so two reducers printed alike are one function there.
 */
import type { Combinator, ParserDef } from '../types.ts'
import { choice } from '../combinators/choice.ts'
import { sequence } from '../combinators/sequence.ts'
import { leaf, sourceLeaf } from '../combinators/token.ts'
import { noTrivia, parser } from '../combinators/grammar.ts'
import { attempt } from '../combinators/attempt.ts'
import { mayCommitFailure } from '../analysis/commitment.ts'

type ChoiceDef = Extract<ParserDef, { tag: 'choice' }>

/** Own keys every combinator may carry beside its definition; all derived from it. */
const DERIVED = new Set(['_tag', '_meta', '_def', '_parseScalar', '_stickyRegex', 'parse'])

function isCombinator(v: unknown): v is Combinator<unknown> {
  return typeof v === 'object' && v !== null && '_def' in v && '_meta' in v
}

function sameComb(a: Combinator<unknown>, b: Combinator<unknown>, depth: number): boolean {
  if (a === b) return true
  if (depth > 32 || a._tag !== b._tag) return false
  for (const k of Object.keys(a)) if (!DERIVED.has(k)) return false
  for (const k of Object.keys(b)) if (!DERIVED.has(k)) return false
  return sameFields(a._def as Record<string, unknown>, b._def as Record<string, unknown>, depth, undefined)
}

function sameValue(u: unknown, v: unknown, depth: number): boolean {
  if (u === v) return true
  if (isCombinator(u) && isCombinator(v)) return sameComb(u, v, depth + 1)
  if (Array.isArray(u) && Array.isArray(v)) return u.length === v.length && u.every((x, i) => sameValue(x, v[i], depth))
  if (typeof u === 'object' && u !== null && typeof v === 'object' && v !== null
    && Object.getPrototypeOf(u) === Object.prototype && Object.getPrototypeOf(v) === Object.prototype) {
    return sameFields(u as Record<string, unknown>, v as Record<string, unknown>, depth, undefined)
  }
  return false
}

/** Every field of `x` and `y` the same, `skip` aside. A reducer matches its twin by printed source. */
function sameFields(x: Record<string, unknown>, y: Record<string, unknown>, depth: number, skip: string | undefined): boolean {
  const kx = Object.keys(x).filter(k => k !== skip && x[k] !== undefined)
  const ky = Object.keys(y).filter(k => k !== skip && y[k] !== undefined)
  if (kx.length !== ky.length) return false
  for (const k of kx) {
    if (!(k in y)) return false
    const u = x[k]
    const v = y[k]
    if (k === 'fn' && typeof u === 'function' && typeof v === 'function' && u !== v) {
      if (typeof x.fnSrc !== 'string' || x.fnSrc === '' || x.fnSrc !== y.fnSrc) return false
      continue
    }
    if (!sameValue(u, v, depth)) return false
  }
  return true
}

/** A wrapper the factoring can rebuild around a new body: a leaf, or a trivia scope. */
function rewrap(w: Combinator<unknown>, body: Combinator<unknown>): Combinator<unknown> | undefined {
  const d = w._def
  let out: Combinator<unknown>
  if (d.tag === 'leaf') {
    out = d.cstValue === 'source' ? sourceLeaf(body, d.fn) : leaf(body, d.fn)
    if (d.fnSrc !== undefined) (out._def as { fnSrc?: string }).fnSrc = d.fnSrc
  } else if (d.tag === 'grammar') {
    out = d.clearTrivia === true ? noTrivia(body) : parser({ trivia: d.triviaParser ?? null }, body)
  } else return undefined
  // The rebuilt wrapper must be the original in everything but its body.
  return sameFields(d as Record<string, unknown>, out._def as Record<string, unknown>, 0, 'parser') ? out : undefined
}

function unusedOf(seq: Combinator<unknown>): boolean {
  return seq._def.tag === 'sequence' && seq._def.valueUnused === true
}

function never(c: Combinator<unknown>): boolean {
  const t = c._def.tag
  return t === 'optional' || t === 'many'
}

/**
 * The factored form of `d`'s choice, or `undefined` when its arms are not one
 * shape that differs in one term.
 */
export function factorSharedEnds(d: ChoiceDef): Combinator<unknown> | undefined {
  const arms = d.parsers
  if (arms.length < 2) return undefined
  if (d.strategy.tag !== 'firstMatch' && d.strategy.tag !== 'sharedPrefix') return undefined
  if (d.gates.some(g => g !== null) || d.autoNot.some(a => a !== null)) return undefined
  // Each arm: its wrappers, outermost first, and the sequence they end in.
  const shapes: { wrappers: Combinator<unknown>[]; terms: Combinator<unknown>[]; seq: Combinator<unknown> }[] = []
  for (const arm of arms) {
    const wrappers: Combinator<unknown>[] = []
    let c = arm
    while ((c._def.tag === 'leaf' || c._def.tag === 'grammar') && wrappers.length < 4) {
      wrappers.push(c)
      c = c._def.parser
    }
    if (c._def.tag !== 'sequence' || c._def.parsers.length < 2) return undefined
    shapes.push({ wrappers, terms: c._def.parsers, seq: c })
  }
  const first = shapes[0]!
  const n = first.terms.length
  for (const s of shapes) {
    if (s.wrappers.length !== first.wrappers.length || s.terms.length !== n) return undefined
    if (unusedOf(s.seq) !== unusedOf(first.seq)) return undefined
    for (let j = 0; j < s.wrappers.length; j++) {
      const a = first.wrappers[j]!._def as Record<string, unknown>
      const b = s.wrappers[j]!._def as Record<string, unknown>
      if (a.tag !== b.tag || !sameFields(a, b, 0, 'parser')) return undefined
    }
  }
  // Exactly one term position differs, and nothing after it can fail.
  let at = -1
  for (let i = 0; i < n; i++) {
    if (shapes.every(s => sameComb(s.terms[i]!, first.terms[i]!, 0))) continue
    if (at >= 0) return undefined
    at = i
  }
  if (at < 0) return undefined
  for (let i = at + 1; i < n; i++) if (!never(first.terms[i]!)) return undefined
  // A committed failure leaves a choice without rolling its arm back. Asked last:
  // it walks everything the arms reach.
  if (arms.some(a => mayCommitFailure(a))) return undefined
  const middle = choice(...(shapes.map(s => s.terms[at]!) as [Combinator<unknown>, ...Combinator<unknown>[]]))
  // The inner choice must keep arm order: a strategy that reorders (longest
  // literal first) or classifies would pick a different arm.
  const st = middle._def.tag === 'choice' ? middle._def.strategy : undefined
  if (st === undefined || (st.tag !== 'firstMatch' && st.tag !== 'sharedPrefix'
    && !(st.tag === 'literalsLongestFirst' && st.sortedIndices.every((x, i) => x === i)))) return undefined
  let out: Combinator<unknown> | undefined = sequence(
    ...([...first.terms.slice(0, at), middle, ...first.terms.slice(at + 1)] as [Combinator<unknown>, ...Combinator<unknown>[]]),
  )
  if (unusedOf(first.seq)) {
    (out._def as { valueUnused?: boolean }).valueUnused = true
  }
  for (let j = first.wrappers.length - 1; j >= 0 && out !== undefined; j--) out = rewrap(first.wrappers[j]!, out)
  // A choice that fails is rolled back and reports where it started; so does an
  // `attempt`. The sequence alone would report where its inner choice failed.
  return out === undefined ? undefined : attempt(out)
}
