// MEASUREMENT SCAFFOLDING — NOT FOR MERGE. See .measure/README.md.
//
// Partitions the `any`-first-set arms of the four jess grammars into
//   (a) grammar-side, fixable by rewriting the arm,
//   (b) parseman-side, a first set that IS derivable but analysis reports `any`,
//   (c) genuinely un-computable,
// and weights the partition by REAL ARM ENTRIES rather than static site count.
// Requires a `PARSEMAN_MEASURE_DISPATCH=arms` build (.measure/build-jess.sh arms).
import fs from 'node:fs'
const DEST = '/Users/matthew/git/worktrees/jess-dispatch-measure/packages'
const CASES = [
  ['css ', 'css-parser',  '/Users/matthew/git/worktrees/less.js/master/packages/test-data/tests-config/3rd-party/bootstrap4.css'],
  ['less', 'less-parser', '/Users/matthew/git/worktrees/jess-dispatch-measure/packages/jess/benchmark/benchmark.less'],
]

// A cause is fixable in the grammar when the first char is hidden by HOW the arm
// is written; it is a library gap when a real first set exists behind a ref.
const BUCKET = {
  'nullable-prefix':    'a-grammar',
  'leading-not':        'a-grammar',
  'broad-recognizer':   'a-grammar',
  'opaque-wrapper':     'c-uncomputable',
  'cross-artifact-ref': 'b-parseman',
  'ref-cycle':          'b-parseman',
}

const rows = []
for (const [name, pkg, file] of CASES) {
  const reg = JSON.parse(fs.readFileSync(`${DEST}/${pkg}/arms.json`, 'utf8'))
  const { parse } = await import(`${DEST}/${pkg}/lib/index.js`)
  const src = fs.readFileSync(file, 'utf8')
  globalThis.__ah = []
  parse(src)
  const hits = globalThis.__ah
  // Only the ESM emission is loaded, so only its ids are ever hit.
  for (const a of reg) rows.push({ ...a, dialect: name.trim(), hits: (hits[a.id] | 0) })

  // Did the fuse actually substitute the deferred `@FS:` placeholders?
  const code = fs.readFileSync(`${DEST}/${pkg}/lib/index.js`, 'utf8')
  const left = (code.match(/\/\*@FS:[^*]*\*\/true/g) ?? []).length
  console.log(`${name} ${file.split('/').pop()}: ${reg.length} registry rows, ${left} unsubstituted @FS placeholders left in the artifact`)
}

const entered = rows.filter(r => r.hits > 0)
const totalHits = rows.reduce((a, r) => a + r.hits, 0)
const pct = n => `${(100 * n / totalHits).toFixed(1)}%`

console.log(`\n=== ARM ENTRIES (both fixtures) : ${totalHits.toLocaleString()} ===`)
const byGuard = {}
for (const r of rows) byGuard[r.guardKind] = (byGuard[r.guardKind] ?? 0) + r.hits
for (const [k, v] of Object.entries(byGuard).sort((x, y) => y[1] - x[1]))
  console.log(`  guardKind=${k.padEnd(15)} ${String(v).padStart(9)} entries  ${pct(v)}`)

const unguarded = rows.filter(r => r.guardKind === 'none')
const uh = unguarded.reduce((a, r) => a + r.hits, 0)
console.log(`\n=== THE 'any' COST: arms compiled with NO guard ===`)
console.log(`  static arms (deduped) : ${new Set(unguarded.map(r => `${r.dialect}|${r.rule}|${r.armIndex}`)).size}`)
console.log(`  arm entries           : ${uh.toLocaleString()}  (${pct(uh)} of all entries)`)

console.log(`\n=== TRIAGE, weighted by arm entries ===`)
const buckets = {}
for (const r of unguarded) {
  const b = BUCKET[r.cause] ?? 'c-uncomputable'
  buckets[b] ??= { hits: 0, causes: {}, sites: new Set() }
  buckets[b].hits += r.hits
  buckets[b].causes[r.cause] = (buckets[b].causes[r.cause] ?? 0) + r.hits
  buckets[b].sites.add(`${r.dialect}|${r.rule}|${r.armIndex}`)
}
for (const [b, v] of Object.entries(buckets).sort((x, y) => y[1].hits - x[1].hits)) {
  console.log(`  ${b.padEnd(16)} ${String(v.hits).padStart(9)} entries (${(100 * v.hits / uh).toFixed(1)}% of unguarded)  ${v.sites.size} static arms`)
  for (const [c, h] of Object.entries(v.causes).sort((x, y) => y[1] - x[1]))
    console.log(`      ${c.padEnd(20)} ${String(h).padStart(9)}`)
}

console.log(`\n=== (b) EVIDENCE: shallow-any arms whose DEEP set is finite ===`)
const recovered = rows.filter(r => r.guardKind === 'deep-recovered')
const deferred = rows.filter(r => r.guardKind === 'deferred')
console.log(`  deep-recovered (codegen already fixes) : ${recovered.length} rows, ${recovered.reduce((a, r) => a + r.hits, 0).toLocaleString()} entries`)
console.log(`  deferred to fuse time                  : ${deferred.length} rows, ${deferred.reduce((a, r) => a + r.hits, 0).toLocaleString()} entries`)
console.log(`  unguarded but deep set is FINITE       : ${unguarded.filter(r => !r.deepAny).length} rows  <- pure analysis gap`)

console.log(`\n=== HOTTEST UNGUARDED ARMS (where the work goes) ===`)
const agg = new Map()
for (const r of unguarded) {
  const k = `${r.dialect}|${r.rule}|${r.armIndex}`
  const p = agg.get(k) ?? { ...r, hits: 0 }
  p.hits += r.hits
  agg.set(k, p)
}
for (const r of [...agg.values()].sort((a, b) => b.hits - a.hits).slice(0, 20))
  console.log(`  ${String(r.hits).padStart(8)}  ${r.dialect.padEnd(5)} ${(r.rule + '[' + r.armIndex + ']' + (r.arm ? ' →' + r.arm : '')).padEnd(58)} ${BUCKET[r.cause] ?? 'c'}  ${r.cause}: ${r.detail.slice(0, 60)}`)
