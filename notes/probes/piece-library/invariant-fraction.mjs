// BYTE MEASUREMENT (no timing). PAIRWISE vs N-WAY option invariance.
// `bodyshare.mjs` reports, per option set, how many bodies are identical to cfgKey 0.
// That is a PAIRWISE figure. The "option-invariant fraction" is the N-WAY
// intersection: bodies identical across EVERY shipped option set at once. They are
// different quantities and the second is always smaller. This computes both so the
// two are never confused again.
import { createHash } from 'node:crypto'
import { encodeTable } from '../../../src/table/encode.ts'
import { resolveTable } from '../../../src/table/program.ts'
import { emitAssemblySource } from '../../../src/table/emit-assembly.ts'

const CFGS = [
  ['k0 ast', { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }],
  ['k1 cst', { hostCst: true, trackLines: false, tolerant: false, coverage: false, probe: false }],
  ['k2 lines', { hostCst: false, trackLines: true, tolerant: false, coverage: false, probe: false }],
  ['k3 cst+lines', { hostCst: true, trackLines: true, tolerant: false, coverage: false, probe: false }],
  ['k4 tolerant', { hostCst: false, trackLines: false, tolerant: true, coverage: false, probe: false }],
]

function bodies(src) {
  const out = new Map()
  const re = /\nfunction (_[A-Za-z0-9_]+)\(/g
  let m, prev = null, prevAt = 0
  while ((m = re.exec(src)) !== null) {
    if (prev !== null) out.set(prev, src.slice(prevAt, m.index))
    prev = m[1]; prevAt = m.index
  }
  if (prev !== null) out.set(prev, src.slice(prevAt))
  return out
}
const h = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12)

for (const [id, mod, rule] of [
  ['example/css', await import('../../../examples/css/parser.ts'), 'Stylesheet'],
  ['example/json', await import('../../../examples/json/parser.ts'), 'jsonDoc'],
]) {
  const prog = encodeTable({ [rule]: mod[rule] })
  const t = resolveTable(prog)
  const per = CFGS.map(([label, cfg]) => [label, bodies(emitAssemblySource(t, prog, cfg, []).source)])
  const base = per[0][1]

  const nway = (sets) => {
    let n = 0
    for (const [name, text] of base) {
      let all = true
      for (const s of sets) { const o = s.get(name); if (o === undefined || h(o) !== h(text)) { all = false; break } }
      if (all) n++
    }
    return n
  }
  const total = base.size
  const pct = (n) => `${n}/${total} (${(100 * n / total).toFixed(1)}%)`
  console.log(`\n=== ${id} === ${total} bodies`)
  console.log(`  PAIRWISE k0<->k1 (hostCst only)     : ${pct(nway([per[1][1]]))}`)
  console.log(`  N-WAY  k0,k1        (2 sets shipped): ${pct(nway([per[1][1]]))}`)
  console.log(`  N-WAY  k0,k1,k2,k3  (4 sets)        : ${pct(nway([per[1][1], per[2][1], per[3][1]]))}`)
  console.log(`  N-WAY  k0..k4       (5 sets)        : ${pct(nway([per[1][1], per[2][1], per[3][1], per[4][1]]))}`)
}
