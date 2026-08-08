// BYTE MEASUREMENT (no timing). What does emitAssemblySource actually produce,
// per grammar, per cfgKey? This is the artifact a macro-time move would ship.
import { encodeTable } from '../../../src/table/encode.ts'
import { resolveTable } from '../../../src/table/program.ts'
import { emitAssemblySource } from '../../../src/table/emit-assembly.ts'
import { reachableIps } from '../../../src/table/inspect.ts'

const specs = []
{
  const m = await import('../../../examples/css/parser.ts')
  specs.push(['example/css', m])
}
{
  const m = await import('../../../examples/json/parser.ts')
  specs.push(['example/json', m])
}

function rootOf(m) {
  for (const k of ['Stylesheet', 'Document', 'Root', 'Entry', 'Value', 'Json']) if (m[k]) return [k, m[k]]
  const keys = Object.keys(m)
  return [keys[0], m[keys[0]]]
}

for (const [id, m] of specs) {
  const [name, root] = rootOf(m)
  let prog
  try { prog = encodeTable({ [name]: root }) } catch (e) { console.log(id, 'encode failed:', String(e).slice(0, 120)); continue }
  const t = resolveTable(prog)
  const sites = reachableIps(prog).length
  const rows = []
  for (const cfg of [
    { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false },
    { hostCst: true, trackLines: false, tolerant: false, coverage: false, probe: false },
    { hostCst: false, trackLines: true, tolerant: false, coverage: false, probe: false },
    { hostCst: true, trackLines: true, tolerant: false, coverage: false, probe: false },
  ]) {
    let em
    try { em = emitAssemblySource(t, prog, cfg, []) } catch (e) { rows.push(['REFUSED', String(e.construct ?? e).slice(0, 60)]); continue }
    const key = (cfg.hostCst ? 1 : 0) | (cfg.trackLines ? 2 : 0)
    rows.push([key, Buffer.byteLength(em.source, 'utf8')])
  }
  console.log(`${id}: root=${name} reachableSites=${sites} emitBytes by cfgKey: ${JSON.stringify(rows)}`)
}
