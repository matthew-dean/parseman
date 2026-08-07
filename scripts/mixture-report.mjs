/** Render the deterministic sweep. Reads a file; no parsing, no timing. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rows = readFileSync(path.join(root, 'notes/results/mixture-sweep.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l))

const bad = rows.filter(r => r.error || r.ok !== true || r.consumed !== r.bytes)
console.log(`rows ${rows.length} | errors ${rows.filter(r => r.error).length} | not-ok-or-short ${bad.length}`)
if (bad.length) for (const b of bad.slice(0, 8)) console.log('  BAD', b.dialect, b.mix, b.ok, b.consumed, b.bytes)

const pad = (s, n) => String(s).padEnd(n)
const lp = (s, n) => String(s).padStart(n)

for (const d of ['css', 'less', 'scss', 'jess']) {
  const of = m => rows.find(r => r.dialect === d && r.mix === m)
  const spec = rows.find(r => r.dialect === d && r.direction === 'endpoint-specialised')
  const shared = rows.find(r => r.dialect === d && r.direction === 'endpoint-shared')
  if (!spec || !shared) continue

  // THE MECHANISM CONTROL: a construct with zero sites in this dialect. Its
  // byte delta is the whole cost of the mix machinery, and every mixed row is
  // read net of it.
  const zero = rows.filter(r => r.dialect === d && r.direction === 'forward'
    && r.driverRows === 0 && r.mix !== '')
  const mech = zero.length ? zero[0].emittedBytes - spec.emittedBytes : 0

  console.log(`\n=== ${d}  specialised ${(spec.emittedBytes / 1024).toFixed(0)} KB`
    + `  shared ${(shared.emittedBytes / 1024).toFixed(0)} KB`
    + `  ratio ${(spec.emittedBytes / shared.emittedBytes).toFixed(1)}x`
    + `  mechanism +${mech} B (${zero.map(z => z.mix).join(',') || 'none'})`)

  const fwd = rows.filter(r => r.dialect === d && r.direction === 'forward' && !r.error)
    .map(r => ({
      kind: r.mix,
      rows: r.driverRows,
      saved: spec.emittedBytes - (r.emittedBytes - mech),
    }))
    .filter(r => r.rows > 0)
    .sort((a, b) => b.saved - a.saved)

  console.log(pad('  construct', 14) + lp('KB saved', 10) + lp('driver rows', 13) + lp('B/row', 9))
  for (const r of fwd) {
    console.log(pad('  ' + r.kind, 14) + lp((r.saved / 1024).toFixed(1), 10)
      + lp(r.rows.toLocaleString(), 13) + lp((r.saved / r.rows).toFixed(2), 9))
  }

  // Reverse: what SPECIALISING one construct costs, starting from all-shared.
  const rev = rows.filter(r => r.dialect === d && r.direction === 'reverse' && !r.error)
    .map(r => ({ kind: r.mix.replace('*,-', ''), cost: r.emittedBytes - shared.emittedBytes }))
    .filter(r => r.cost !== 0)
    .sort((a, b) => b.cost - a.cost)
  if (rev.length) {
    console.log('  reverse — KB ADDED by specialising just this one, from all-shared:')
    console.log('   ' + rev.slice(0, 12).map(r => `${r.kind} ${(r.cost / 1024).toFixed(0)}`).join('  '))
  }
}
