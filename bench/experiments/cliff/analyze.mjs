/**
 * Turn notes/results/inlining-cliff.jsonl into the transition table.
 *
 *   node bench/experiments/cliff/analyze.mjs [runId]
 *
 * The dispatch slot is IDENTIFIED FROM THE DATA rather than hard-coded: within one
 * (kind, shapes) series, the feedback slots whose IC state CHANGES as N grows are by
 * construction the ones fed by the per-site leaves. Every other slot in the body is
 * fed by shapes that do not vary with N (the result records, the values array, ctx)
 * and stays put. Hard-coding a slot index would silently survive a bytecode change.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', '..', 'notes', 'results', 'inlining-cliff.jsonl')

const all = readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const runId = process.argv[2] ?? all[all.length - 1].runId
const recs = all.filter(r => r.runId === runId)
if (recs.length === 0) throw new Error(`no records for runId ${runId}`)

const RANK = { UNINITIALIZED: 0, MONOMORPHIC: 1, POLYMORPHIC: 2, MEGAMORPHIC: 3, GENERIC: 3 }
const SHORT = { UNINITIALIZED: 'uninit', MONOMORPHIC: 'mono', POLYMORPHIC: 'poly', MEGAMORPHIC: 'MEGA', GENERIC: 'MEGA' }

const byKey = new Map(recs.map(r => [r.group + '|' + r.key, r]))
const series = (group, pred) => recs.filter(r => r.group === group && pred(r)).sort((a, b) => a.n - b.n)

function dispatchSlots(rs) {
  // slots present in every member of the series, whose state is not constant
  const states = new Map()
  for (const r of rs) for (const s of r.icSlots ?? []) {
    const k = `${s.slot}:${s.kind}`
    if (!states.has(k)) states.set(k, [])
    states.get(k).push(s.state)
  }
  return [...states.entries()]
    .filter(([, v]) => v.length === rs.length && new Set(v).size > 1)
    .map(([k]) => k)
}

function transitionsFor(rs) {
  const slots = dispatchSlots(rs)
  const worstAt = rs.map(r => {
    const ss = (r.icSlots ?? []).filter(s => slots.includes(`${s.slot}:${s.kind}`))
    const w = ss.reduce((a, s) => (RANK[s.state] > RANK[a] ? s.state : a), 'UNINITIALIZED')
    return { n: r.n, state: w, ns: r.nsPerOp }
  })
  const firstAt = (st) => worstAt.find(x => x.state === st)?.n ?? null
  return { slots, worstAt, monoTo: firstAt('POLYMORPHIC'), polyTo: firstAt('MEGAMORPHIC') }
}

// ── noise floor from the A/A control ────────────────────────────────────────────
const aa = recs.filter(r => r.group === 'aa-control').map(r => r.nsPerOp).filter(x => x !== null)
const aaMean = aa.reduce((a, b) => a + b, 0) / aa.length
const aaFloorPct = ((Math.max(...aa) - Math.min(...aa)) / aaMean) * 100
const withinSpread = Math.max(...recs.filter(r => r.spreadPct !== null).map(r => r.spreadPct))

const lines = []
const p = (s = '') => lines.push(s)

p(`runId            ${runId}`)
p(`parseman sha     ${recs[0].sha}`)
p(`node / v8        ${recs[0].node} / ${recs[0].v8}`)
p(`A/A control      ${aa.map(x => x.toFixed(2)).join('  ')} ns/op  (n=${aa.length})`)
p(`NOISE FLOOR      ${aaFloorPct.toFixed(1)}%  (A/A spread); worst within-config rep spread ${withinSpread.toFixed(1)}%`)
p(`shape checks     ${[...new Set(recs.map(r => r.shapeCheck).filter(Boolean))].join(' | ')}`)
p(`shared FV        ${[...new Set(recs.filter(r => r.n > 1).map(r => String(r.sharedFeedbackVector)))].join(' | ')} (all N closures share one FeedbackVector when true)`)
p()

p('## Sweep: ns/op by N')
p()
for (const kind of ['seq', 'choice', 'many']) {
  const ns = [...new Set(recs.filter(r => r.group === 'sweep' && r.kind === kind).map(r => r.n))].sort((a, b) => a - b)
  p(`### ${kind}`)
  p('| shapes | ' + ns.map(n => `N=${n}`).join(' | ') + ' |')
  p('|---|' + ns.map(() => '---:').join('|') + '|')
  for (const shapes of ['identical', 'distinct']) {
    const rs = series('sweep', r => r.kind === kind && r.shapes === shapes)
    p(`| ${shapes} ns/op | ` + ns.map(n => (rs.find(r => r.n === n)?.nsPerOp ?? NaN).toFixed(2)).join(' | ') + ' |')
    p(`| ${shapes} IC | ` + ns.map(n => {
      const r = rs.find(x => x.n === n)
      const t = transitionsFor(rs).slots
      const ss = (r?.icSlots ?? []).filter(s => t.includes(`${s.slot}:${s.kind}`))
      const w = ss.reduce((a, s) => (RANK[s.state] > RANK[a] ? s.state : a), 'UNINITIALIZED')
      return SHORT[w] ?? w
    }).join(' | ') + ' |')
  }
  p()
}

p('## Transitions (dispatch slots identified from the data)')
p()
p('| piece | shapes | dispatch slots | mono->poly at N | poly->MEGA at N | ns/op N=1 | ns/op just below | ns/op just above | cost of crossing |')
p('|---|---|---|---|---|---:|---:|---:|---:|')
for (const kind of ['seq', 'choice', 'many']) {
  for (const shapes of ['identical', 'distinct']) {
    const rs = series('sweep', r => r.kind === kind && r.shapes === shapes)
    const t = transitionsFor(rs)
    const at = n => rs.find(r => r.n === n)?.nsPerOp ?? null
    const mega = t.polyTo
    const below = mega ? rs.filter(r => r.n < mega).pop()?.nsPerOp ?? null : null
    const above = mega ? at(mega) : null
    const cost = below !== null && above !== null ? (above - below) : null
    p(`| ${kind} | ${shapes} | ${t.slots.join(', ') || '(none vary)'} | ${t.monoTo ?? '-'} | ${mega ?? 'never'} | ${(at(1) ?? NaN).toFixed(2)} | ${below === null ? '-' : below.toFixed(2)} | ${above === null ? '-' : above.toFixed(2)} | ${cost === null ? '-' : `+${cost.toFixed(2)} ns/op (${((cost / below) * 100).toFixed(1)}%)`} |`)
  }
}
p()

p('## Memory control: 40 sites BUILT, 1 EXERCISED')
p()
p('| piece | shapes | 40 built / 1 called | 40 built / 40 called | N=1 |')
p('|---|---|---:|---:|---:|')
for (const kind of ['seq', 'choice', 'many']) {
  for (const shapes of ['identical', 'distinct']) {
    const mc = recs.find(r => r.group === 'memory-control' && r.kind === kind && r.shapes === shapes)
    const full = recs.find(r => r.group === 'sweep' && r.kind === kind && r.shapes === shapes && r.n === 40)
    const one = recs.find(r => r.group === 'sweep' && r.kind === kind && r.shapes === shapes && r.n === 1)
    p(`| ${kind} | ${shapes} | ${(mc?.nsPerOp ?? NaN).toFixed(2)} | ${(full?.nsPerOp ?? NaN).toFixed(2)} | ${(one?.nsPerOp ?? NaN).toFixed(2)} |`)
  }
}
p()

p('## Captured-variable count (seq)')
p()
p('| shapes | N | cap0 | cap1 | cap3 | cap8 |')
p('|---|---:|---:|---:|---:|---:|')
for (const shapes of ['identical', 'distinct']) {
  for (const n of [1, 8]) {
    const cell = c => (recs.find(r => r.group === 'captures' && r.shapes === shapes && r.n === n && r.captures === c)?.nsPerOp ?? NaN).toFixed(2)
    p(`| ${shapes} | ${n} | ${cell(0)} | ${cell(1)} | ${cell(3)} | ${cell(8)} |`)
  }
}
p()

p('## Call chain (seq of choices) — does the cliff compound?')
p()
{
  const ns = [...new Set(recs.filter(r => r.group === 'chain').map(r => r.n))].sort((a, b) => a - b)
  p('| shapes | ' + ns.map(n => `N=${n}`).join(' | ') + ' |')
  p('|---|' + ns.map(() => '---:').join('|') + '|')
  for (const shapes of ['identical', 'distinct']) {
    p(`| ${shapes} | ` + ns.map(n => (recs.find(r => r.group === 'chain' && r.shapes === shapes && r.n === n)?.nsPerOp ?? NaN).toFixed(2)).join(' | ') + ' |')
  }
}
p()

p('## Per-site monomorphic wrapper in front of the shared body')
p()
p('| piece | shapes | N | shared only | + per-site wrapper | delta | wrapper bytes |')
p('|---|---|---:|---:|---:|---:|---:|')
for (const kind of ['seq', 'choice', 'many']) {
  for (const shapes of ['identical', 'distinct']) {
    for (const n of [1, 4, 5, 8, 40]) {
      const w = recs.find(r => r.group === 'wrapper' && r.kind === kind && r.shapes === shapes && r.n === n)
      const b = recs.find(r => r.group === 'sweep' && r.kind === kind && r.shapes === shapes && r.n === n)
      if (!w || !b) continue
      const d = w.nsPerOp - b.nsPerOp
      p(`| ${kind} | ${shapes} | ${n} | ${b.nsPerOp.toFixed(2)} | ${w.nsPerOp.toFixed(2)} | ${d >= 0 ? '+' : ''}${d.toFixed(2)} | ${w.wrapperBytes} |`)
    }
  }
}
p()

p('## Causal lever: --no-polymorphic-inlining (seq, distinct shapes)')
p()
{
  const ns = [...new Set(recs.filter(r => r.group === 'no-poly-inlining').map(r => r.n))].sort((a, b) => a - b)
  p('| config | ' + ns.map(n => `N=${n}`).join(' | ') + ' |')
  p('|---|' + ns.map(() => '---:').join('|') + '|')
  p('| default | ' + ns.map(n => (recs.find(r => r.group === 'sweep' && r.kind === 'seq' && r.shapes === 'distinct' && r.n === n)?.nsPerOp ?? NaN).toFixed(2)).join(' | ') + ' |')
  p('| --no-polymorphic-inlining | ' + ns.map(n => (recs.find(r => r.group === 'no-poly-inlining' && r.n === n)?.nsPerOp ?? NaN).toFixed(2)).join(' | ') + ' |')
}
p()

p('## TurboFan inlining decisions (--trace-turbo-inlining)')
p()
p('| piece | shapes | N | considered | inlined | leaf-parse inlined into piece-parse | not inlined | deopts |')
p('|---|---|---:|---:|---:|---:|---:|---:|')
for (const r of recs.filter(x => x.group === 'trace').sort((a, b) => a.kind.localeCompare(b.kind) || a.shapes.localeCompare(b.shapes) || a.n - b.n)) {
  const t = r.trace ?? {}
  p(`| ${r.kind} | ${r.shapes} | ${r.n} | ${t.consideredForInlining ?? '-'} | ${t.inlinedCount ?? '-'} | ${t.inlinedParseIntoParse ?? '-'} | ${t.notInlinedCount ?? '-'} | ${t.deoptCount ?? '-'} |`)
}
p()
const reasons = [...new Set(recs.flatMap(r => r.trace?.notInlinedReasons ?? []))]
if (reasons.length) { p('Not-inlined reasons observed:'); for (const x of reasons) p(`  ${x}`) }
const dr = [...new Set(recs.flatMap(r => r.trace?.deoptReasons ?? []))]
if (dr.length) { p('Deopt reasons observed: ' + dr.join(' | ')) }

void byKey
process.stdout.write(lines.join('\n') + '\n')
