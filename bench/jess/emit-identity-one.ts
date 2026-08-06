/**
 * THE EMITTED ENGINE AGAINST THE CLOSURE ENGINE, ON ONE SHIPPING GRAMMAR.
 *
 * `assembledRules` is the SHIPPED table engine, and it picks between two
 * lowerings of the same table: `emit-assembly.ts`'s generated source, or
 * `assemble.ts`'s closure walk when the emitter refuses. `PM_TABLE_EMIT=0`
 * forces the second. So the differential is this file run TWICE, once with each
 * value, and the two TSVs compared byte for byte.
 *
 * The digest is `digest.ts`'s — the whole `RunResult` plus a column per facet,
 * so a divergence names itself. `unconsumedFrom` is inside the `whole` and the
 * `value` digests, which is what makes a parse that returns `ok: true` having
 * consumed two thirds of its input a MISMATCH here rather than a pass.
 *
 * The refusal is printed to stderr on the first line, so a run that fell back is
 * never mistaken for a run that emitted.
 *
 * One dialect per process — `composeLeaf()`'s fuse mutates the shared
 * recognition pieces in place (`grammars.ts` header).
 *
 *   PM_TABLE_EMIT=1 node --import ./bench/jess/register.mjs \
 *     bench/jess/emit-identity-one.ts <dialect> [variant]
 */
import { cstBuildHost } from '../../src/compiler/linker.ts'
import { run } from '../../src/functional/run.ts'
import { assemble, assembledRules } from '../../src/table/assemble.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { resolveTable } from '../../src/table/program.ts'
import { COLUMNS, digestRow } from './digest.ts'
import {
  corpus, corpusTotal, DIALECTS, ENTRY, VARIANTS, VARIANT_SETTINGS, loadGrammar,
  type Dialect, type Variant,
} from './grammars.ts'

type RunnableLike = Parameters<typeof run>[0]

const dialect = process.argv[2] as Dialect
if (!DIALECTS.includes(dialect)) throw new Error(`unknown dialect '${String(process.argv[2])}'`)
const variant = (process.argv[3] ?? 'ast') as Variant
if (!VARIANTS.includes(variant)) throw new Error(`unknown variant '${String(process.argv[3])}'`)

const { rules } = await loadGrammar(dialect, variant)
const settings = VARIANT_SETTINGS[variant]
const prog = encodeTable(rules, settings)

// WHICH ENGINE THIS PROCESS IS ACTUALLY RUNNING, stated before any digest. The
// option set is the one `AssemblyCache.forCtx` selects for a plain `run()`:
// hostCst from the table's host mode, and no tolerance, coverage or probe.
{
  const t = resolveTable(prog)
  const a = assemble(t, prog, {
    hostCst: settings.hostMode === 'cst',
    trackLines: settings.trackLines === true,
    tolerant: false,
    coverage: false,
    probe: false,
  })
  const verdict = a.emitRefusal === undefined ? 'EMITTED' : `CLOSURES — refused: ${a.emitRefusal}`
  const files = corpus(dialect).length
  console.error(`# ${dialect}/${variant}  PM_TABLE_EMIT=${process.env.PM_TABLE_EMIT ?? '(unset ⇒ 1)'}  ${verdict}  ${files}/${corpusTotal(dialect)} files`)
}

const entry = assembledRules(prog)[ENTRY] as RunnableLike | undefined
if (entry === undefined) throw new Error(`no rule '${ENTRY}'`)

// A `cst` TABLE REFUSES TO RUN WITHOUT A HOST. `host-mode.ts:65` throws on the
// first node, so a sweep that omitted this produced 314 identical `threw:` rows
// per leg and reported them as agreement — a vacuous leg that a planted emitter
// defect could not move. The `ast` variants take no host by construction.
const opts = VARIANT_SETTINGS[variant].hostMode === 'cst' ? { build: cstBuildHost() } : {}

const lines: string[] = [`# ${dialect}\t${variant}\t${COLUMNS.join('\t')}`]
for (const f of corpus(dialect)) {
  let cells: string[]
  try { cells = digestRow(run(entry, f.input, opts)) }
  catch (e) { cells = [`threw: ${(e as Error).message.split('\n')[0] ?? ''}`] }
  lines.push(`${f.name}\t${cells.join('\t')}`)
}
process.stdout.write(lines.join('\n') + '\n')
