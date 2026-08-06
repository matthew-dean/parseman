/**
 * SHAPE-LOWERING ORACLE — the emitted scan against `RegExp.exec`, per regex, per
 * position, over real corpus text.
 *
 * The end-to-end identity sweep only reaches a regex at the positions its
 * grammar happens to drive it to. This drives EVERY regex constant of every
 * grammar at EVERY position of its own workload's input, and compares the
 * emitted straight-line scan against the sticky `RegExp.exec` it replaces —
 * matched / not matched, and the exact end. A shape that agrees end-to-end
 * because the grammar never asks it the hard question fails here.
 *
 * Run: node --import tsx/esm bench/scan-shape-oracle.ts
 */
import { encodeTable } from '../src/table/encode.ts'
import { emitShapeMatch, scanShapeFromRegex } from '../src/table/scan-shapes.ts'
import { buildWorkloads } from './workloads/index.ts'
import { lessRules } from './workloads/less.ts'
import { cssRules } from '../examples/css/parser.ts'
import { jsonRules } from './table-grammars.ts'
import { graphqlDoc } from '../examples/graphql/parser.ts'
import type { Combinator } from '../src/types.ts'

type Probe = (input: string, pos: number) => number

/** Compile one shape's emitted match to a function returning `end`, or −1 on no match. */
function compileShape(source: string, flags: string): Probe | null {
  const shape = scanShapeFromRegex(source, flags)
  if (shape === null) return null
  let n = 0
  const mint = (prefix = '_v'): string => `${prefix}${n++}`
  const m = emitShapeMatch(shape, 'pos', mint, '  ')
  const body = [...m.setup, `  return (${m.ok}) ? (${m.end}) : -1`].join('\n')
  return new Function('input', 'pos', body) as Probe
}

function regexConstants(rules: Record<string, Combinator<unknown>>): Array<[string, string]> {
  const prog = encodeTable(rules, {})
  const out = new Map<string, [string, string]>()
  for (const c of prog.k) {
    if (c instanceof RegExp) out.set(`${c.source}/${c.flags}`, [c.source, c.flags])
  }
  return [...out.values()]
}

const CORPORA = new Map<string, string>()
for (const w of buildWorkloads()) CORPORA.set(w.id.split('/')[0]!, w.input)

const GRAMMARS: Array<[string, Record<string, Combinator<unknown>>, string]> = [
  ['less', lessRules as unknown as Record<string, Combinator<unknown>>, CORPORA.get('less')!],
  ['css', cssRules as unknown as Record<string, Combinator<unknown>>, CORPORA.get('css')!],
  ['json', jsonRules as unknown as Record<string, Combinator<unknown>>, CORPORA.get('json')!],
  ['graphql', { Document: graphqlDoc } as unknown as Record<string, Combinator<unknown>>, CORPORA.get('graphql')!],
]

let totalRx = 0
let lowered = 0
let checks = 0
let mismatches = 0

for (const [name, rules, corpus] of GRAMMARS) {
  const rxs = regexConstants(rules)
  let gLowered = 0
  for (const [source, flags] of rxs) {
    totalRx++
    let probe: Probe | null
    try {
      probe = compileShape(source, flags)
    } catch (e) {
      console.log(`  ${name}: /${source}/${flags} EMIT THREW ${String(e)}`)
      continue
    }
    if (probe === null) continue
    lowered++
    gLowered++
    const re = new RegExp(source, flags.includes('y') ? flags : `${flags}y`)
    let bad = 0
    for (let pos = 0; pos <= corpus.length; pos++) {
      re.lastIndex = pos
      const m = re.exec(corpus)
      const want = m === null ? -1 : pos + m[0].length
      const got = probe(corpus, pos)
      checks++
      if (got !== want) {
        bad++
        mismatches++
        if (bad <= 3) {
          console.log(
            `  MISMATCH ${name} /${source}/${flags} @${pos} want ${want} got ${got} ` +
            `ctx=${JSON.stringify(corpus.slice(pos, pos + 24))}`,
          )
        }
      }
    }
  }
  console.log(`${name}: ${gLowered}/${rxs.length} regexes lowered`)
}

console.log(`\nlowered ${lowered}/${totalRx} regex constants · ${checks} position checks · ${mismatches} mismatches`)
process.exitCode = mismatches === 0 ? 0 : 1
