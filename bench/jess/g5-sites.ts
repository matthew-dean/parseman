/**
 * DISTINCT REACHABLE SITES vs ROW EXECUTIONS — the ratio that sizes assembly.
 *
 * A piece is created per SITE (grammar-sized); a row is executed per INPUT
 * position (input-sized). Assembly cost is the first number; the dispatch it
 * removes is paid on the second.
 */
import { encodeTable } from '../../src/table/encode.ts'
import { opHistogram, reachableIps } from '../../src/table/inspect.ts'
import { loadGrammar, type Dialect } from './grammars.ts'

const dialect = (process.argv[2] ?? 'less') as Dialect
const g = await loadGrammar(dialect, 'ast')
const prog = encodeTable(g.rules, {})
const ips = reachableIps(prog)
console.log(JSON.stringify({
  dialect,
  rules: Object.keys(prog.rules).length,
  words: prog.code.length,
  distinctSites: ips.size,
  byOp: opHistogram(prog),
}, null, 2))
