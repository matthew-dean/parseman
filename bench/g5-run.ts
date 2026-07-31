/**
 * G5 lane driver: correctness gate, then the numbers.
 */
import { checkIdentity } from './g5-identity.ts'
import { encodeTable } from '../src/table/encode.ts'
import { LARGE_JSON, MEDIUM_JSON, SMALL_JSON, SMALL_GQL, MEDIUM_GQL, LARGE_GQL, SMALL_EXPR, MEDIUM_EXPR } from './fixtures.ts'
import { baseNodes, jsonRules, jsonWs, nodeLadder } from './g5-grammars.ts'
import type { Combinator } from '../src/types.ts'
import { readFileSync } from 'node:fs'
import { lessRules } from './workloads/less.ts'

const JSON_CASES = [
  { name: 'small', input: SMALL_JSON },
  { name: 'medium', input: MEDIUM_JSON },
  { name: 'large', input: LARGE_JSON },
  { name: 'scalars', input: '[1, -2.5, 1e10, true, false, null, "a\\nb", "\\u0041"]' },
  { name: 'nested', input: '{"a":{"b":[{"c":[[[]]]}]},"d":[]}' },
  { name: 'empty-obj', input: '{}' },
  { name: 'empty-arr', input: '[]' },
  { name: 'ws', input: '  {  "a" :  [ 1 , 2 ]  ,  "b" : null  }  ' },
  { name: 'unicode-key', input: '{"\\u00e9": "caf\\u00e9"}' },
  { name: 'bad-trailing-comma', input: '[1,2,]' },
  { name: 'bad-unclosed', input: '{"a":' },
  { name: 'bad-garbage', input: '@@@' },
]

function ladderCases(n: number): Array<{ name: string; input: string }> {
  const words = Array.from({ length: n }, (_, i) => `xyz${String.fromCharCode(97 + (i % 26))};`)
  return [
    { name: 'one', input: words[0]! },
    { name: 'all', input: words.join('') },
    { name: 'no-semis', input: words.map(w => w.slice(0, -1)).join('') },
    { name: 'empty', input: '' },
    { name: 'garbage', input: '###' },
  ]
}

async function main(): Promise<void> {
  console.log('=== G5 table lowering — correctness gate (oracle: parseman/oracle digestValue)')
  const jr = checkIdentity(jsonRules as unknown as Record<string, Combinator<unknown>>, 'Value', JSON_CASES, { trivia: jsonWs })
  console.log(`  json    ${jr.matched}/${jr.total} cases identical across interpreted | compiled | table`)
  for (const m of jr.mismatches.slice(0, 6)) console.log(`    MISMATCH ${m.case} [${m.path}] ${m.a.slice(0, 16)} != ${m.b.slice(0, 16)}`)

  for (const n of [4, 8, 16, 32]) {
    const map = nodeLadder(n)
    const r = checkIdentity(map, 'Root', ladderCases(n))
    console.log(`  ladder${String(n).padStart(3)}  ${r.matched}/${r.total} cases identical`)
    for (const m of r.mismatches.slice(0, 4)) console.log(`    MISMATCH ${m.case} [${m.path}] ${m.a.slice(0, 16)} != ${m.b.slice(0, 16)}`)
  }

  const baseCases = [
    { name: 'atom', input: 'abc' },
    { name: 'num', input: '42' },
    { name: 'list', input: '(a,b,12)' },
    { name: 'nested-doc', input: '(a,1)zz(b)7' },
    { name: 'empty', input: '' },
    { name: 'unclosed', input: '(a,b' },
    { name: 'stray', input: ')' },
    { name: 'trailing-sep', input: '(a,)' },
  ]
  const br = checkIdentity(baseNodes, 'Doc', baseCases)
  console.log(`  base    ${br.matched}/${br.total} cases identical (node()-building grammar)`)
  for (const m of br.mismatches.slice(0, 6)) console.log(`    MISMATCH ${m.case} [${m.path}] ${m.a.slice(0, 16)} != ${m.b.slice(0, 16)}`)

  // The BIGGEST real grammar in the repo (29 rules, node()-bearing, `parser()`
  // trivia scopes, `not()` boundaries) against its own committed fixtures. This
  // is the projection's evidence, not an extrapolation.
  try {
    const less = lessRules as unknown as Record<string, Combinator<unknown>>
    const lessCases = [
      { name: 'app.less', input: readFileSync('bench/workloads/fixtures/app.less', 'utf8') },
      { name: 'site.css', input: readFileSync('bench/workloads/fixtures/site.css', 'utf8') },
      { name: 'decls', input: readFileSync('fixtures/css/decls.css', 'utf8') },
      { name: 'selector', input: readFileSync('fixtures/css/selector.css', 'utf8') },
    ]
    const lr = checkIdentity(less, 'Stylesheet', lessCases)
    console.log(`  less    ${lr.matched}/${lr.total} cases identical (29-rule Less grammar, committed fixtures)`)
    for (const m of lr.mismatches.slice(0, 6)) console.log(`    MISMATCH ${m.case} [${m.path}] ${m.a.slice(0, 16)} != ${m.b.slice(0, 16)}`)
  } catch (e) {
    console.log(`  less    could not run: ${(e as Error).message.split('\n')[0]}`)
  }

  // The grammars the newly added opcodes unlocked. Encoding them proves nothing;
  // these prove the trees match.
  const single = (name: string, comb: unknown): Record<string, Combinator<unknown>> => ({ [name]: comb as Combinator<unknown> })
  try {
    const { expr } = await import('../examples/lang/parser.ts')
    const lr = checkIdentity(single('Expr', expr), 'Expr', [
      { name: 'small', input: SMALL_EXPR },
      { name: 'medium', input: MEDIUM_EXPR },
      { name: 'nested', input: 'if a then if b then c else d else e' },
      { name: 'garbage', input: '@@@' },
    ])
    console.log(`  lang    ${lr.matched}/${lr.total} cases identical (choice(literalsLongestFirst) reordering)`)
    for (const m of lr.mismatches.slice(0, 4)) console.log(`    MISMATCH ${m.case} [${m.path}]`)
  } catch (e) { console.log(`  lang    could not run: ${(e as Error).message.split('\n')[0]}`) }

  try {
    const gq = await import('../examples/graphql/parser.ts')
    const gr = checkIdentity(single('Doc', gq.graphqlDoc), 'Doc', [
      { name: 'small', input: SMALL_GQL },
      { name: 'medium', input: MEDIUM_GQL },
      { name: 'large', input: LARGE_GQL },
      { name: 'garbage', input: '!!!' },
    ], { trivia: gq.ws as Combinator<unknown>, interpreterOnly: true })
    console.log(`  graphql ${gr.matched}/${gr.total} cases identical vs the INTERPRETER only (keywords() as a sticky-regex row; the example exports an entry combinator, not a rule map, so compose() cannot build the compiled leg)`)
    for (const m of gr.mismatches.slice(0, 4)) console.log(`    MISMATCH ${m.case} [${m.path}]`)
  } catch (e) { console.log(`  graphql could not run: ${(e as Error).message.split('\n')[0]}`) }

  console.log('')
  console.log('=== table shape')
  const p = encodeTable(jsonRules as unknown as Record<string, Combinator<unknown>>)
  console.log(`  json: ${p.code.length} words, ${p.k.length} consts, ${p.fns.length} reducers, ${p.cc.length} classes, ${p.disp.length} dispatch tables, ${Object.keys(p.rules).length} rules`)
}

void main()
