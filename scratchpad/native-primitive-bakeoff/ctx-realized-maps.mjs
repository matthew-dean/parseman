/**
 * REALIZED maps under a real workload — the measurement the prior reverted
 * lane's lesson demands ("count REALIZED maps, not construction sites").
 *
 * Structural fact established on the real artifact: exactly ONE context object
 * exists per parse (0 `{..._ctx}` constructions, 0 derived `_ctxN` vars). So
 * the realized-map question is not "how many contexts" but "how many maps does
 * THAT ONE object pass through, and how early does it settle" — because a read
 * site executed after the object settles pays nothing.
 *
 * Method: parse growing prefixes of the real corpus and, after each, test the
 * live context's map against a witness that has been through the full
 * transition chain. The prefix length at which they first agree is the point
 * after which every remaining read site sees ONE stable map.
 *
 * node --allow-natives-syntax --import tsx/esm ctx-realized-maps.mjs
 */
import { compile } from '../../src/index.ts'
import { Stylesheet as CssStylesheet } from '../../examples/css/parser.ts'
import { Stylesheet as LessStylesheet } from '../../bench/workloads/less.ts'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const F = p => readFileSync(path.join(here, '../../bench/workloads/fixtures', p), 'utf8')

for (const [label, comb, corpus] of [
  ['css', CssStylesheet, F('site.css')],
  ['less', LessStylesheet, F('app.less')],
]) {
  const compiled = compile(comb)
  const mk = () => ({ trackLines: false, _triviaLog: [] })

  // Witness: a context that has completed a FULL parse, i.e. every transition.
  const witness = mk()
  compiled.parseWithContext(corpus, witness, 0)

  // How many distinct maps does the object pass through, and when does it settle?
  let settleAt = null
  const marks = []
  for (const frac of [0, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1]) {
    const n = Math.max(1, Math.floor(corpus.length * frac))
    const c = mk()
    try { compiled.parseWithContext(corpus.slice(0, n), c, 0) } catch { /* partial input may fail; the ctx still transitioned */ }
    const same = %HaveSameMap(c, witness)
    marks.push(`${(frac * 100).toFixed(1)}%(${n}B)=${same ? 'SETTLED' : 'differs'}`)
    if (same && settleAt === null) settleAt = n
  }

  // Distinct maps across many independent parses of the SAME input.
  const pool = Array.from({ length: 8 }, () => { const c = mk(); compiled.parseWithContext(corpus, c, 0); return c })
  let distinct = 0
  const groups = []
  for (const o of pool) {
    if (!groups.some(g => %HaveSameMap(g, o))) { groups.push(o); distinct++ }
  }

  console.log(`\n=== ${label} (corpus ${corpus.length} B) ===`)
  console.log(`  distinct REALIZED maps across 8 independent full parses: ${distinct}`)
  console.log(`  map settles after: ${settleAt === null ? 'never' : settleAt + ' B (' + (100 * settleAt / corpus.length).toFixed(2) + '% of corpus)'}`)
  console.log(`  ${marks.join('  ')}`)
  console.log(`  dictionary mode after full parse: ${%HasDictionaryElements(witness)}`)
}
