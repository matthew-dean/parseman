/**
 * WHAT STANDS BETWEEN ONE SHIPPING GRAMMAR AND THE EMITTED ENGINE.
 *
 * `emit-assembly.ts` refuses a construct it does not lower, and `assemble.ts`
 * falls back to closures for the WHOLE assembly. The refusal names the FIRST
 * construct it hit, so discovering the set one lowering at a time takes as many
 * rounds as there are gaps. This counts them all at once: every opcode reachable
 * in the table, against the set the emitter has a case for.
 *
 * Static. It encodes and walks the code array; it parses nothing and measures no
 * time.
 *
 * One dialect per process — `composeLeaf()`'s fuse mutates the shared recognition
 * pieces in place (`grammars.ts` header).
 */
import { encodeTable } from '../../src/table/encode.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import * as OPS from '../../src/table/ops.ts'
import { assertParseman, loadGrammar, type Dialect } from './grammars.ts'

/**
 * The opcodes `emit-assembly.ts` has a `case` for, plus `OP_RULE`, which it
 * resolves as an alias rather than lowering. Kept as a literal list because the
 * point of this probe is to be told when it drifts from that file.
 */
const EMITTED = new Set<number>([
  OPS.OP_LIT, OPS.OP_LIT_TRACK, OPS.OP_LIT_CI, OPS.OP_LIT_CI_TRACK,
  OPS.OP_RX, OPS.OP_RX_TRACK, OPS.OP_EMPTY, OPS.OP_GATE, OPS.OP_XFORM, OPS.OP_SCAN,
  OPS.OP_SCOPE, OPS.OP_SCOPE_CAP, OPS.OP_SCOPE_PLAIN, OPS.OP_ATTEMPT, OPS.OP_NOT, OPS.OP_PEEK, OPS.OP_OPT,
  OPS.OP_SEQ, OPS.OP_SEQV, OPS.OP_SEQX, OPS.OP_CHOICE, OPS.OP_REP, OPS.OP_REPV,
  OPS.OP_NODE, OPS.OP_NODE_TRACK, OPS.OP_RULE,
  OPS.OP_LABEL, OPS.OP_FIELD, OPS.OP_EXPECT, OPS.OP_ROUTED, OPS.OP_TOKEN, OPS.OP_LEAF,
  OPS.OP_DISPATCH,
])

const OP_NAME = new Map<number, string>()
for (const [name, v] of Object.entries(OPS)) {
  if (typeof v === 'number' && name.startsWith('OP_')) OP_NAME.set(v, name)
}

const dialect = process.argv[2] as Dialect
const prov = await assertParseman()
const g = await loadGrammar(dialect, 'ast')
const prog = encodeTable(g.rules, {})
const code = prog.code

const counts = new Map<number, number>()
let total = 0
for (const ip of reachableIps(prog)) {
  const op = code[ip]!
  total++
  if (EMITTED.has(op)) continue
  counts.set(op, (counts.get(op) ?? 0) + 1)
}

const rows = [...counts].sort((a, b) => b[1] - a[1])
const blocked = rows.reduce((n, r) => n + r[1], 0)
console.log(`${dialect}  (parseman ${prov.version} from ${prov.root})`)
console.log(`  ${total} reachable sites, ${blocked} of them unlowered (${(blocked / total * 100).toFixed(2)}%)`)
if (rows.length === 0) console.log('  — every reachable op is lowered')
for (const [op, n] of rows) {
  console.log(`  ${String(n).padStart(6)}  ${OP_NAME.get(op) ?? `OP_${op}`}`)
}
