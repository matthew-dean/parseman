/**
 * ONE dialect's four variants, folded — the G4 measurement, as one JSON line.
 *
 * Its own process because `composeLeaf()`'s interpreted fuse binds the shared
 * recognition pieces IN PLACE, so a process may realise only one dialect. It
 * needs only ONE, though, and that is the finding this file exists to record:
 * the four `trackLines` x `hostMode` artifacts are four ENCODINGS of a single
 * grammar export, not four grammars. `xGrammar` accepts every settings pair;
 * `xPositionsGrammar` refuses the non-tracking ones (`encode.ts` rejects a
 * `parser(trackLines: true)` scope inside a table built without it), so the fold
 * is driven from the AST export.
 *
 * BEFORE is four separately emitted modules, which is what shipped. AFTER is one
 * folded module. Both include the reducers, because they ship either way and the
 * whole point is that the fold stops shipping them four times.
 */
import { gzipSync } from 'node:zlib'
import { encodeTable } from '../../src/table/encode.ts'
import { emitFoldedModule, emitTableModule } from '../../src/table/emit.ts'
import { foldPrograms, type TableProgram } from '../../src/table/program.ts'
import {
  DIALECTS, VARIANTS, VARIANT_SETTINGS, assertParseman, exportName, loadGrammar,
  type Dialect, type Variant,
} from './grammars.ts'

export type FoldRow = {
  dialect: Dialect
  rules: number
  fns: number
  words: number
  /** Per variant, the emitted module a build produces TODAY: raw and gzip. */
  before: Record<Variant, [number, number]>
  beforeTotal: [number, number]
  /** The ONE folded module, all four variants in it: raw and gzip. */
  after: [number, number]
  /** Per variant, how many code words its delta overwrites. */
  deltaWords: Record<Variant, number>
  /** sha256 of each variant's emitted module, so "four distinct" is PROVEN. */
  beforeHash: Record<Variant, string>
}

export async function foldSizeOf(dialect: Dialect): Promise<FoldRow> {
  // ONE export, four encodings. This is the claim, and it is asserted rather
  // than assumed: `foldPrograms` refuses if any shared field disagrees.
  const { rules } = await loadGrammar(dialect, 'ast')
  const progs: Record<string, TableProgram> = {}
  for (const v of VARIANTS) progs[v] = encodeTable(rules, VARIANT_SETTINGS[v])
  const base = progs['ast']!
  const fnSources = base.fns.map(f => String(f))

  const { createHash } = await import('node:crypto')
  const before = {} as Record<Variant, [number, number]>
  const beforeHash = {} as Record<Variant, string>
  let rawTotal = 0
  let gzTotal = 0
  for (const v of VARIANTS) {
    const src = emitTableModule(progs[v]!, { name: exportName(dialect, v), fnSources })
    before[v] = [Buffer.byteLength(src), gzipSync(src).length]
    beforeHash[v] = createHash('sha256').update(src).digest('hex').slice(0, 16)
    rawTotal += before[v][0]
    gzTotal += before[v][1]
  }

  const folded = foldPrograms(progs, 'ast')
  const names = Object.fromEntries(VARIANTS.map(v => [v, exportName(dialect, v)]))
  const src = emitFoldedModule(folded, { fnSources, names })
  const deltaWords = {} as Record<Variant, number>
  for (const v of VARIANTS) deltaWords[v] = folded.variants[v]!.at.length

  return {
    dialect,
    rules: Object.keys(rules).length,
    fns: base.fns.length,
    words: base.code.length,
    before,
    beforeTotal: [rawTotal, gzTotal],
    after: [Buffer.byteLength(src), gzipSync(src).length],
    deltaWords,
    beforeHash,
  }
}

async function main(): Promise<void> {
  const dialect = process.argv[2] as Dialect
  if (!DIALECTS.includes(dialect)) throw new Error(`unknown dialect '${String(process.argv[2])}'`)
  const pm = await assertParseman()
  process.stdout.write(JSON.stringify({ ...(await foldSizeOf(dialect)), parseman: pm }) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
