/**
 * ROWS EXECUTED PER BYTE PARSED, for ONE dialect. See `table-rows.ts`.
 *
 * One dialect per process because `composeLeaf()`'s fuse mutates the shared
 * recognition pieces in place (`grammars.ts` header) — a second dialect in the
 * same process is measuring the first one's leftovers.
 *
 * Requires `PM_TABLE_COUNT=1`, which arms the counter in `src/table/exec.ts`.
 * This process therefore MEASURES NO TIME and prints none: the counter is a
 * branch and a store on the hottest path in the driver.
 */
import { encodeTable } from '../../src/table/encode.ts'
import { resetTableCounters, tableCounters, execRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import * as OPS from '../../src/table/ops.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { assertParseman, corpus, ENTRY, loadGrammar, type Dialect } from './grammars.ts'

const OP_NAME = new Map<number, string>()
for (const [name, v] of Object.entries(OPS)) {
  if (typeof v === 'number' && name.startsWith('OP_')) OP_NAME.set(v, name.slice(3))
}

const dialect = process.argv[2] as Dialect

const prov = await assertParseman()
const g = await loadGrammar(dialect, 'ast')
const prog = encodeTable(g.rules, {})
const rules = execRules(prog)
const entry = rules[ENTRY]
if (entry === undefined) throw new Error(`${dialect}: table has no '${ENTRY}'`)

const files = corpus(dialect)

// STATIC reducer-site width: how many DISTINCT author functions the encoder put
// behind each shared call site in the driver. Four is V8's inline-cache limit,
// so anything above it is a megamorphic site by construction, before a single
// parse runs.
const staticSites = new Map<string, Set<number>>()
{
  const code = prog.code
  const add = (s: string, i: number): void => {
    let set = staticSites.get(s)
    if (set === undefined) { set = new Set(); staticSites.set(s, set) }
    set.add(i)
  }
  // Reachability from the rule entries, decoding each row's declared width — a
  // linear scan of `code` would read operands as opcodes and report nonsense.
  for (const ip of reachableIps(prog)) {
    const op = code[ip]!
    switch (op) {
      case OPS.OP_SEQX: {
        const reducer = code[ip + 1]!
        if (reducer >= 0) add('SEQX fn()', reducer)
        break
      }
      case OPS.OP_XFORM: add('XFORM fn()', code[ip + 1]!); break
      case OPS.OP_LEAF: add('LEAF fn()', code[ip + 1]!); break
      case OPS.OP_NODE: case OPS.OP_NODE_TRACK:
        if (code[ip + 1]! >= 0) add('NODE build()', code[ip + 1]!)
        break
      default: break
    }
  }
}

resetTableCounters()
let bytes = 0
let parsed = 0
let ok = 0
for (const f of files) {
  try {
    const r = run(entry, f.input)
    if (r.ok) ok++
  } catch { /* a throw is still rows executed; keep the byte in the denominator */ }
  bytes += f.input.length
  parsed++
}

const byOp: Record<string, number> = {}
for (let i = 0; i < tableCounters.byOp.length; i++) {
  const n = tableCounters.byOp[i]!
  if (n > 0) byOp[OP_NAME.get(i) ?? `op${i}`] = n
}

const dynSites: Record<string, number> = {}
for (const [k, v] of tableCounters.sites) dynSites[k] = v.size
const statSites: Record<string, number> = {}
for (const [k, v] of staticSites) statSites[k] = v.size

console.log(JSON.stringify({
  dialect,
  parsemanRoot: prov.root,
  parsemanVersion: prov.version,
  rules: Object.keys(prog.rules).length,
  words: prog.code.length,
  fns: prog.fns.length,
  files: parsed,
  ok,
  bytes,
  meanFileBytes: bytes / parsed,
  rows: tableCounters.rows,
  rowsPerByte: tableCounters.rows / bytes,
  byOp,
  staticSites: statSites,
  dynamicSites: dynSites,
}))
