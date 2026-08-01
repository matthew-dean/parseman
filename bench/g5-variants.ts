/**
 * G5 deliverable 4 — the variant story.
 *
 * `trackLines` × `hostMode` is the axis jess's css parser instantiates four
 * times over one set of shared recognition pieces. Under the shipped lowering
 * each of those four is a separate emitted copy of every rule. Under G5 they
 * are four TABLES over ONE driver.
 *
 * This prints, for each settings pair:
 *   - the emitted table bytes
 *   - which opcodes the setting selected (the table CONTENTS differing)
 *   - proof that the run path holds no branch on the option (the driver source
 *     is searched for any read of the settings, and the count must be zero)
 */
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { encodeTable, type TableSettings } from '../src/table/encode.ts'
import { emitTableModule } from '../src/table/emit.ts'
import { tableRules } from '../src/table/exec.ts'
import { run } from '../src/functional/run.ts'
import { opHistogram } from '../src/table/inspect.ts'
import { nodeLadder } from './g5-grammars.ts'
import { rules, node, regex, many, type Combinator } from '../src/index.ts'
import { PARSEMAN_VERSION } from '../src/version.ts'

const PAIRS: Array<[string, TableSettings]> = [
  ['hostMode=ast  trackLines=false', {}],
  ['hostMode=ast  trackLines=true', { trackLines: true }],
  ['hostMode=cst  trackLines=false', { hostMode: 'cst' }],
  ['hostMode=cst  trackLines=true', { hostMode: 'cst', trackLines: true }],
]

/**
 * A grammar whose reducer RETURNS the span it was handed, so the variant's
 * effect is observable in the parse output rather than only in the table.
 */
const spanProbe = rules<Record<string, Combinator<unknown>>>(g => ({
  W: node('W', regex(/[^\s()]+/), (_c, _f, span) => span),
  Doc: node('Doc', many(g.W!), c => ({ spans: c })),
})) as unknown as Record<string, Combinator<unknown>>

function main(): void {
  console.log(`parseman ${PARSEMAN_VERSION}   ${process.cwd()}`)
  console.log('')
  console.log('=== FOUR SETTINGS PAIRS, ONE DRIVER (grammar: 16-rule node() ladder)')
  const map = nodeLadder(16)
  const fnSources = [...Array.from({ length: 16 }, (_, i) => `(c) => ({ t: 'N${i}', c })`), `(c) => ({ t: 'Root', c })`]
  const INPUT = 'ab\ncd'

  const tables: Array<{ label: string; bytes: number }> = []
  for (const [label, settings] of PAIRS) {
    const prog = encodeTable(map, settings)
    const src = emitTableModule(prog, { name: 'g', fnSources })
    const hist = opHistogram(prog)
    const marks = ['LIT_TRACK', 'RX_TRACK', 'NODE_TRACK', 'LIT', 'RX', 'NODE']
      .map(n => `${n}:${hist[n] ?? 0}`).join(' ')
    tables.push({ label, bytes: Buffer.byteLength(src) })
    console.log(`  ${label}`)
    console.log(`    table ${Buffer.byteLength(src)} B (gzip ${gzipSync(src).length}), ${prog.code.length} words   [${marks}]`)
    // The table is LIVE: build it from the same settings and parse with it.
    // A table that only measures is not a demonstration.
    const live = tableRules(encodeTable(spanProbe, settings))
    const r = run(live.Doc! as never, INPUT)
    const spans = (r.value as { spans: Array<Record<string, number>> }).spans
    console.log(`    live parse of ${JSON.stringify(INPUT)}: ok=${r.ok}  node span = ${JSON.stringify(spans[1] ?? spans[0])}`)
  }

  const total = tables.reduce((a, t) => a + t.bytes, 0)
  console.log('')
  console.log(`  FOUR variants total ${total} B of table.`)
  console.log(`  The 16-rule ladder under the SHIPPED lowering is 82,273 B for ONE variant`)
  console.log(`  (bench/g5-size.ts, /tmp/pm-g5-size/ladder-16/g.codegen.js) — four of them is 4x that,`)
  console.log(`  which is exactly the defect notes/size-reduction.md records for jess's css parser.`)
  console.log('')

  console.log('=== NO BRANCH ON OPTION INPUT IN THE RUN PATH')
  const driver = readFileSync('src/table/exec.ts', 'utf8')
  // Comments are stripped first: a doc comment naming the option is not a read
  // of it, and counting one would make the check meaningless in both directions.
  const bare = driver.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const forbidden = ['trackLines:', 'hostMode', 'settings', 'TableSettings', 'opts.']
  let hits = 0
  for (const f of forbidden) {
    const n = bare.split(f).length - 1
    if (n > 0) console.log(`    src/table/exec.ts READS ${JSON.stringify(f)} ${n}x`)
    hits += n
  }
  console.log(`    option reads in the driver: ${hits}`)
  console.log(`    (${hits === 0 ? 'ZERO — settings are consumed by src/table/encode.ts at table-build time' : 'NON-ZERO — investigate'})`)
  const enc = readFileSync('src/table/encode.ts', 'utf8')
  console.log(`    src/table/encode.ts reads settings ${enc.split('this.settings').length - 1 + (enc.split('this.track').length - 1)}x — all at build time`)
  console.log('')
  console.log('=== CACHING')
  console.log('    resolveTable() memoizes on the program OBJECT (src/table/program.ts, WeakMap).')
  console.log('    One program per (grammar, settings) pair => one reference table per pair,')
  console.log('    built once at load and looked up thereafter. run() does a lookup, not a branch.')
}

main()
