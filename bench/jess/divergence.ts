/**
 * THREE-WAY identity sweep over jess's REAL corpora.
 *
 * The bar, owner verbatim: *"interpreted / old compiled / new table compiled all
 * must have identical behaviors (unless old / interpreted had an oversight /
 * bug)"*. So this runs THREE engines, not two. An earlier two-way version of
 * this file compared the table against the INTERPRETER alone and scored every
 * disagreement as a table defect — which is exactly the mistake that made a
 * clean number a wrong one: on the residual css/scss files the table already
 * agreed with the shipped compiled engine, and the interpreter was the outlier.
 *
 * IDENTITY IS THE WHOLE `RunResult`. A narrow digest is what let the previous
 * defect class hide: `{ ok, value, unconsumedFrom }` agreed on files where the
 * engines had taken different paths to the same answer. Each leg reports the
 * whole result plus a digest per FACET — value, span (which carries the FAILURE
 * POSITION), the expected SET, its order, the recovery ERRORS with messages and
 * spans, and root trivia — so a divergence names its own facet.
 *
 * `expected` is public API: documented on the parse result, read by consumers to
 * build diagnostics, and the basis of `completionsAt`. A table handing back a
 * different set changes what an editor shows.
 *
 * Each leg is a SEPARATE PROCESS (`digest.ts`) because the three cannot coexist:
 * `composeLeaf()`'s interpreted fuse binds the shared recognition pieces in
 * place, and the macro lowering replaces the grammar module outright.
 *
 * Usage: `pnpm divergence:jess <dialect> [variant] [--list]`
 *
 * The VARIANT defaults to `ast`. All four must be swept: `trackLines` and
 * `hostMode` are the axis the table is built along, and an identity claim made
 * from the `ast` cell alone says nothing about the other three.
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corpusTotal, DIALECTS, VARIANTS, type Dialect, type Variant } from './grammars.ts'
import { COLUMNS, ENGINES, FACETS, type Engine, type Facet } from './digest.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REGISTER = resolvePath(HERE, 'register.mjs')
const DIGEST = resolvePath(HERE, 'digest.ts')

export type Outcome =
  /** All three engines agree on the whole `RunResult`. */
  | 'identical'
  /** interpreted === compiled, and the TABLE is the outlier. A table defect. */
  | 'table-outlier'
  /** compiled === table, and the INTERPRETER is the outlier. Drift between the
   * two SHIPPED engines; the table sides with what actually ships. */
  | 'interp-outlier'
  /** interpreted === table, and the COMPILED engine is the outlier. */
  | 'compiled-outlier'
  /** No two agree. */
  | 'three-way'

export type FileResult = { name: string; outcome: Outcome; facets: Facet[] }

type Row = Record<(typeof COLUMNS)[number], string>

function legOf(dialect: Dialect, engine: Engine, variant: Variant): Map<string, Row> {
  const out = execFileSync(
    process.execPath,
    ['--import', REGISTER, DIGEST, dialect, engine, variant],
    {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      env: { ...process.env, ...(engine === 'compiled' ? { PM_MACRO: '1' } : { PM_MACRO: '' }) },
    },
  )
  const rows = new Map<string, Row>()
  for (const line of out.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const [name, ...cells] = line.split('\t')
    // A leg that THREW emits ONE cell. Broadcasting it across every facet keeps
    // the comparison total: a throw disagrees with a returned answer everywhere.
    const row = Object.fromEntries(COLUMNS.map((c, n) => [c, cells.length === 1 ? cells[0]! : cells[n]!])) as Row
    rows.set(name!, row)
  }
  return rows
}

export function compare(legs: Record<Engine, Map<string, Row>>): FileResult[] {
  const out: FileResult[] = []
  for (const [name, i] of legs.interpreted) {
    const c = legs.compiled.get(name), t = legs.table.get(name)
    if (c === undefined || t === undefined) throw new Error(`leg is missing ${name} — the corpora are not the same set`)
    const ic = i.whole === c.whole, it = i.whole === t.whole, ct = c.whole === t.whole
    if (ic && it) { out.push({ name, outcome: 'identical', facets: [] }); continue }
    const facets = FACETS.filter(f => i[f] !== c[f] || i[f] !== t[f])
    out.push({
      name,
      outcome: ic ? 'table-outlier' : ct ? 'interp-outlier' : it ? 'compiled-outlier' : 'three-way',
      // A whole-result difference with no differing facet means a field outside
      // the facet set moved; say so rather than reporting an empty list.
      facets: facets.length > 0 ? facets : ['value'],
    })
  }
  return out
}

const ORDER: Outcome[] = ['identical', 'table-outlier', 'interp-outlier', 'compiled-outlier', 'three-way']

async function main(): Promise<void> {
  const arg = process.argv[2]
  const dialect = (arg ?? 'less') as Dialect
  if (!DIALECTS.includes(dialect)) throw new Error(`unknown dialect '${String(arg)}'`)
  const vArg = process.argv[3]
  const variant = (vArg === undefined || vArg.startsWith('--') ? 'ast' : vArg) as Variant
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant '${String(vArg)}'`)
  const legs = Object.fromEntries(ENGINES.map(e => [e, legOf(dialect, e, variant)])) as Record<Engine, Map<string, Row>>
  const results = compare(legs)
  const counts = Object.fromEntries(ORDER.map(o => [o, results.filter(r => r.outcome === o).length]))
  // Print the DENOMINATOR, not just the count. `files=` is what was compared;
  // `of N` is what exists. When they differ the run bounded its own coverage and
  // has to say so — a count on its own reads as "covered everything".
  const total = corpusTotal(dialect)
  const bounded = results.length === total ? '' : `  (BOUNDED: ${total - results.length} of ${total} NOT compared)`
  console.log(`${dialect}/${variant}  files=${results.length} of ${total}${bounded}`)
  console.log('  ' + ORDER.map(o => `${o}=${counts[o]}`).join('  '))
  console.log('  facets: ' + FACETS.map(f => `${f}=${results.filter(r => r.facets.includes(f)).length}`).join(' '))
  if (process.argv.includes('--list')) {
    for (const r of results) {
      if (r.outcome === 'identical') continue
      console.log(`  ${r.outcome.padEnd(16)} {${r.facets.join(',')}} ${r.name}`)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
