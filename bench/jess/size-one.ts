/**
 * The size of ONE (dialect, variant) pair, both lowerings, as one JSON line.
 *
 * Its own process because `composeLeaf()`'s interpreted fuse binds the shared
 * recognition pieces IN PLACE, so a process may realise only one variant of one
 * dialect (see `grammars.ts`). `size.ts` forks one of these per pair and joins.
 *
 * WHAT EACH FIGURE INCLUDES — these are different claims and each is only
 * readable when labelled:
 *
 *   machinery   the recognizer alone. For the table that is `emitTableOnly`:
 *               the code stream, const pool and rule index with an EMPTY reducer
 *               pool. For codegen it is the lowered module minus the reducers,
 *               which is not separable by construction, so codegen's machinery
 *               figure is `whole - reducers` and is derived, not measured.
 *   reducers    the author's own callbacks. They ship under BOTH lowerings and
 *               are the same bytes either way, so they belong in neither
 *               lowering's credit. Taken from `prog.fns` via `Function.toString`,
 *               which returns the transpiled source that actually ships.
 *   whole       machinery + reducers: the artifact a bundle would carry, minus
 *               the shared driver, which is paid ONCE for the whole bundle.
 *
 * The table's `whole` module is a SIZE artifact, not a loadable one: reducer
 * sources recovered from closures have lost their captured scope. The bytes are
 * exactly the bytes; the module would not run. `emitTableModule` with real
 * `fnSources` is what a build emits, and a build has the scope.
 */
import { gzipSync } from 'node:zlib'
import { encodeTable } from '../../src/table/encode.ts'
import { emitTableModule, emitTableOnly } from '../../src/table/emit.ts'
import {
  DIALECTS, VARIANTS, VARIANT_SETTINGS,
  assertParseman, loadGrammar, type Dialect, type Variant,
} from './grammars.ts'

export type SizeRow = {
  dialect: Dialect
  variant: Variant
  rules: number
  fns: number
  words: number
  /** Table: machinery, reducers, whole — raw and gzip. */
  tableMachinery: [number, number]
  tableReducers: [number, number]
  tableWhole: [number, number]
  /** A content hash of the emitted machinery, so the variant fold is PROVEN
   * byte-identical rather than inferred from two equal byte counts. */
  machineryHash: string
}

function pair(s: string): [number, number] {
  return [Buffer.byteLength(s), gzipSync(s).length]
}

export async function sizeOf(dialect: Dialect, variant: Variant): Promise<SizeRow> {
  const { rules } = await loadGrammar(dialect, variant)
  // The export and the TableSettings are two halves of one variant; pairing
  // them wrongly throws in the encoder rather than shrinking anything.
  const prog = encodeTable(rules, VARIANT_SETTINGS[variant])
  const fnSources = prog.fns.map(f => String(f))
  const machinery = emitTableOnly(prog)
  const whole = emitTableModule(prog, { name: 'g', fnSources })
  const reducersOnly = fnSources.join(',')
  const { createHash } = await import('node:crypto')
  return {
    dialect,
    variant,
    rules: Object.keys(rules).length,
    fns: prog.fns.length,
    words: prog.code.length,
    tableMachinery: pair(machinery),
    tableReducers: pair(reducersOnly),
    tableWhole: pair(whole),
    machineryHash: createHash('sha256').update(machinery).digest('hex').slice(0, 16),
  }
}

async function main(): Promise<void> {
  const dialect = process.argv[2] as Dialect
  const variant = process.argv[3] as Variant
  if (!DIALECTS.includes(dialect)) throw new Error(`unknown dialect '${String(process.argv[2])}'`)
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant '${String(process.argv[3])}'`)
  const pm = await assertParseman()
  const row = await sizeOf(dialect, variant)
  process.stdout.write(JSON.stringify({ ...row, parseman: pm }) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
