/**
 * Is `def.disjoint` decided before `g.X` arms resolve?
 *
 * choice.ts:35 computes `disjoint` from `p._meta.firstSet` INSIDE choice(). A `g.X`
 * arm inside a rules() factory is an unresolved ref at that moment, so if a ref reports
 * `any` the choice is recorded non-disjoint permanently — losing the O(1) first-char
 * dispatch at choice.ts:90 even after `.define()` makes the arms provably disjoint.
 */
import { rules, choice, literal, regex, sequence } from '../../src/index.ts'
import { ref } from '../../src/combinators/ref.ts'

const show = (label: string, c: unknown) => {
  const d = (c as { _def: { disjoint?: boolean; tag: string } })._def
  const fs = (c as { _meta: { firstSet: { kind: string } } })._meta.firstSet
  console.log(`  ${label.padEnd(46)} disjoint=${String(d.disjoint).padEnd(5)} firstSet=${fs.kind}`)
}

console.log('a bare ref BEFORE define():')
const r = ref<string>()
console.log(`  ref firstSet = ${JSON.stringify(r._meta.firstSet)}`)

console.log('\nchoice built from LITERAL arms (arms already resolved):')
const direct = choice(literal('a'), literal('b'), literal('c'))
show('choice(literal a, literal b, literal c)', direct)

console.log('\nchoice built from g.X arms inside a rules() factory:')
const g = rules((g: Record<string, never>) => ({
  Entry: choice(g.A!, g.B!, g.C!),
  A: literal('a'),
  B: literal('b'),
  C: literal('c'),
}))
// The rule value is a named lazy; unwrap to the real choice.
const unwrap = (c: unknown): unknown => {
  const d = (c as { _def: { tag: string; thunk?: () => unknown } })._def
  return d.tag === 'lazy' && d.thunk ? unwrap(d.thunk()) : c
}
const entry = unwrap(g.Entry)
show('choice(g.A, g.B, g.C)  [same 3 disjoint literals]', entry)

console.log('\nchoice built from g.X arms, RESOLVED first-sets after define:')
const arms = ((entry as { _def: { parsers: Array<{ _meta: { firstSet: { kind: string } } }> } })._def.parsers)
arms.forEach((a, i) => console.log(`  arm ${i} firstSet now = ${a._meta.firstSet.kind}`))

console.log('\nrecursive grammar (the real shape) — a perfectly gated choice:')
const rg = rules((g: Record<string, never>) => ({
  Expr: choice(g.Paren!, g.Brack!, g.Word!),
  Paren: sequence(literal('('), g.Expr!, literal(')')),
  Brack: sequence(literal('['), g.Expr!, literal(']')),
  Word: regex(/[a-z]+/),
}))
show('choice(g.Paren, g.Brack, g.Word)', unwrap(rg.Expr))

console.log('\nSame three arms, spelled non-recursively (arms resolved at construction):')
const P = sequence(literal('('), literal('x'), literal(')'))
const B = sequence(literal('['), literal('x'), literal(']'))
const W = regex(/[a-z]+/)
show('choice(P, B, W)', choice(P, B, W))
