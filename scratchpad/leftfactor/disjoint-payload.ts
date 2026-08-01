/**
 * Does the disjoint dispatch path return a DIFFERENT failure payload than firstMatch?
 *
 * This decides how the `def.disjoint` fix must be shaped. If the two paths differ in
 * `expected`, then simply resolving disjointness later changes observable behaviour,
 * and the interpreter and codegen must be moved TOGETHER or the parity suite will
 * (correctly) go red.
 */
import { rules, choice, literal, parse } from '../../src/index.ts'

const unwrap = (c: unknown): unknown => {
  const d = (c as { _def: { tag: string; thunk?: () => unknown } })._def
  return d.tag === 'lazy' && d.thunk ? unwrap(d.thunk()) : c
}
const dis = (c: unknown) => (unwrap(c) as { _def: { disjoint?: boolean } })._def.disjoint

// A: three disjoint literals, spelled directly -> disjoint=true  -> dispatch path
const direct = choice(literal('a'), literal('b'), literal('c'))

// B: the SAME three literals reached through g.X -> disjoint=false -> firstMatch path
const g = rules((g: Record<string, never>) => ({
  Entry: choice(g.A!, g.B!, g.C!),
  A: literal('a'), B: literal('b'), C: literal('c'),
}))

console.log(`direct disjoint = ${dis(direct)}`)
console.log(`g.X    disjoint = ${dis(g.Entry)}\n`)

let differ = 0
for (const input of ['z', '', 'ab', 'a']) {
  const a = parse(direct as never, input)
  const b = parse(g.Entry as never, input)
  const sa = JSON.stringify(a), sb = JSON.stringify(b)
  const same = sa === sb
  if (!same) differ++
  console.log(`${same ? 'SAME    ' : 'DIFFER  '} ${JSON.stringify(input)}`)
  if (!same) {
    console.log(`    direct (dispatch)  ${sa}`)
    console.log(`    g.X    (firstMatch) ${sb}`)
  }
}
console.log(`\n${differ} of 4 inputs already differ between the two SPELLINGS of the same grammar.`)
