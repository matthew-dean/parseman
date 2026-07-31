/**
 * Does the SHIPPED path lose first-char dispatch on a recursive grammar because
 * `def.disjoint` was decided when `choice()` was constructed, with `g.X` arms
 * still unresolved?
 *
 * Two questions, kept apart:
 *   A) does the flag read false for a genuinely disjoint recursive choice?
 *   B) does the EMITTED artifact still dispatch anyway?
 */
import { firstSetOf } from '../src/combinators/first-set.ts'
import { compose } from '../src/compiler/linker.ts'
import { jsonRules } from '../bench/g5-grammars.ts'
import type { Combinator, ParserDef } from '../src/types.ts'

const map = jsonRules as unknown as Record<string, Combinator<unknown>>
let value = map.Value!
// `rules()` hands back a lazy proxy; unwrap to the real combinator.
while (value._def.tag === 'lazy') value = (value._def as { thunk: () => Combinator<unknown> }).thunk()
const d = value._def as ParserDef

if (d.tag !== 'choice') throw new Error(`Value is ${d.tag}`)

console.log('A) def.disjoint as recorded at construction :', d.disjoint)
console.log('   def.strategy                             :', d.strategy.tag)
console.log('')
console.log('   arm first sets, RESOLVED (firstSetOf follows lazy refs):')
for (let i = 0; i < d.parsers.length; i++) {
  const fs = firstSetOf(d.parsers[i]!)
  const desc = fs.kind === 'ranges'
    ? fs.ranges.map(r => (r.lo === r.hi ? JSON.stringify(String.fromCharCode(r.lo)) : `${JSON.stringify(String.fromCharCode(r.lo))}-${JSON.stringify(String.fromCharCode(r.hi))}`)).join(' ')
    : fs.kind
  console.log(`     arm ${i}  ${desc}`)
}

// Pairwise disjointness over the RESOLVED sets.
const sets = d.parsers.map(p => firstSetOf(p))
let overlap = false
const seen: Array<{ lo: number; hi: number }> = []
for (const fs of sets) {
  if (fs.kind !== 'ranges') { overlap = true; break }
  for (const r of fs.ranges) {
    for (const p of seen) if (r.lo <= p.hi && p.lo <= r.hi) overlap = true
    seen.push(r)
  }
}
console.log('')
console.log('   genuinely disjoint once refs resolve     :', !overlap)

console.log('')
const fused = compose([map as never]) as unknown as Record<string, unknown>
const src = String((fused.Value as { toString(): string }).toString())
console.log('B) emitted _r_Value body, first 900 chars:')
console.log(src.slice(0, 900))
