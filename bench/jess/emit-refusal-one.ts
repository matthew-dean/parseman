/**
 * DOES THE EMITTED ENGINE SERVE THIS DIALECT, OR DOES IT REFUSE?
 *
 * `assemble.ts` tries `emit-assembly.ts` first and falls back to its closure walk
 * for anything it refuses, recording the construct on `Assembly.emitRefusal`.
 * That field exists precisely because a grammar which quietly drops to the
 * closure path is a permanently slow path nobody would ever find — so it is worth
 * ASKING, per shipping grammar, rather than assuming U4's work applies.
 *
 * Static: it encodes and assembles, and parses nothing. No time is measured and
 * none is printed.
 *
 * One dialect per process — `composeLeaf()`'s fuse mutates the shared recognition
 * pieces in place (`grammars.ts` header).
 */
import { encodeTable } from '../../src/table/encode.ts'
import { resolveTable } from '../../src/table/program.ts'
import { assemble } from '../../src/table/assemble.ts'
import { assertParseman, loadGrammar, type Dialect } from './grammars.ts'

const dialect = process.argv[2] as Dialect

const prov = await assertParseman()
const g = await loadGrammar(dialect, 'ast')
const prog = encodeTable(g.rules, {})
const t = resolveTable(prog)

console.log(`${dialect}  (parseman ${prov.version} from ${prov.root})`)
for (const hostCst of [false, true]) {
  for (const tolerant of [false, true]) {
    const a = assemble(t, prog, { hostCst, trackLines: false, tolerant, coverage: false, probe: false })
    const verdict = a.emitRefusal === undefined ? 'EMITTED' : `CLOSURES — refused: ${a.emitRefusal}`
    console.log(`  hostCst=${String(hostCst).padEnd(5)} tolerant=${String(tolerant).padEnd(5)} ${verdict}`)
  }
}
