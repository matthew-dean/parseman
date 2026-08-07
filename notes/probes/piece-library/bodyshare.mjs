// BYTE MEASUREMENT (no timing). Per-BODY sharing across option sets.
// Whole-artifact hashes differ across cfgs; that says nothing about how many
// individual `_pf<ip>` bodies are byte-identical. This measures that directly,
// because it is the number the "generate once, share the invariant majority"
// claim rests on.
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

/** Split emitted source into named top-level `function _NAME(...){...}` bodies. */
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
  const per = []
  for (const [label, cfg] of CFGS) {
    try { per.push([label, bodies(emitAssemblySource(t, prog, cfg, []).source)]) }
    catch (e) { per.push([label, null, String(e.construct ?? e).slice(0, 50)]) }
  }
  const base = per[0][1]
  console.log(`\n=== ${id} ===  bodies in k0: ${base.size}`)
  for (const [label, bs, err] of per) {
    if (!bs) { console.log(`  ${label.padEnd(13)} EMIT REFUSED: ${err}`); continue }
    let same = 0, diff = 0, only = 0, diffBytes = 0
    for (const [name, text] of bs) {
      const b = base.get(name)
      if (b === undefined) { only++; diffBytes += text.length; continue }
      if (h(b) === h(text)) same++; else { diff++; diffBytes += text.length }
    }
    const total = bs.size
    console.log(`  ${label.padEnd(13)} bodies=${String(total).padStart(5)}  identical-to-k0=${String(same).padStart(5)} (${(100 * same / total).toFixed(1)}%)  differing=${diff}  k0-absent=${only}  variant-bytes=${diffBytes}`)
  }
}
