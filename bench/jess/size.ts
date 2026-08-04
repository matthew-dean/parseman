/**
 * TABLE vs CODEGEN artifact size, over jess's four SHIPPING grammars.
 *
 * Apples to apples: same grammar module, same variant, same reducers, both
 * lowerings driven from THIS worktree's `src/`. The codegen side is
 * `transformMacro` — the lowering a build actually splices, not a reconstruction
 * of it. The table side is `encodeTable` + `emitTableModule`. Neither side is
 * quoted from a note.
 *
 * Raw AND gzip for every figure, because they can move in opposite directions:
 * a table is a dense numeric stream that gzip likes less than it likes repeated
 * emitted code, so a raw win can be a smaller gzip win — or not a win at all.
 * Reporting one without the other is how that gets hidden.
 *
 * THE HEADLINE IS PER-VARIANT. Four `trackLines`x`hostMode` variants folding
 * onto fewer tables is a build/DX win and is reported in its own section; it is
 * never folded into a per-dialect artifact figure.
 *
 * NOT MEASURED HERE: the shared driver (`src/table/exec.ts` and friends), which
 * the table lowering adds to a bundle ONCE, for all grammars and all variants
 * together. It is printed at the end as its own line so the break-even is
 * visible, and it is not netted off any dialect's figure.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/size.ts`
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { statSync } from 'node:fs'
import {
  DIALECTS, JESS_ROOT, VARIANTS, assertParseman, exportName,
  type Dialect, type Variant,
} from './grammars.ts'
import type { SizeRow } from './size-one.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REGISTER = resolvePath(HERE, 'register.mjs')
const SIZE_ONE = resolvePath(HERE, 'size-one.ts')

const MODULE: Record<Dialect, string> = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts',
  less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts',
  jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
}

/** The shared driver: what the TABLE lowering adds to a bundle, once, ever. */
const DRIVER = ['src/table/exec.ts', 'src/table/program.ts', 'src/table/ops.ts']

function tableRow(dialect: Dialect, variant: Variant): SizeRow {
  const out = execFileSync(process.execPath, ['--import', REGISTER, SIZE_ONE, dialect, variant], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    env: { ...process.env, PM_MACRO: '' },
  })
  return JSON.parse(out.trim().split('\n').at(-1)!) as SizeRow
}

/**
 * Cut a grammar module down to ONE variant export.
 *
 * All four dialects end with their four `export const <dialect><suffix>Grammar`
 * declarations and nothing after them, so keeping the header plus one export's
 * line range is a whole module. This is what makes a per-variant codegen figure
 * possible at all: the shipped module lowers all four at once, and the shipped
 * total divided by four would silently credit codegen with sharing it does not
 * do (imports and type declarations are shared; recognizers are not).
 */
function sliceToVariant(src: string, dialect: Dialect, variant: Variant): string {
  const lines = src.split('\n')
  const at = VARIANTS.map(v => {
    const needle = `export const ${exportName(dialect, v)}`
    const i = lines.findIndex(l => l.startsWith(needle))
    if (i < 0) throw new Error(`${dialect}: no line starting '${needle}'`)
    return i
  })
  const n = VARIANTS.indexOf(variant)
  const end = n + 1 < at.length ? at[n + 1]! : lines.length
  return [...lines.slice(0, at[0]!), ...lines.slice(at[n]!, end)].join('\n')
}

type Cg = { raw: number; gz: number }

async function codegen(src: string, file: string): Promise<Cg> {
  const { transformMacro } = await import('../../src/plugin/index.ts')
  const out = transformMacro(src, file, new Set(['parseman']))
  const code = typeof out === 'string' ? out : out?.code
  if (!code) throw new Error(`macro lowering produced nothing for ${file}`)
  return { raw: Buffer.byteLength(code), gz: gzipSync(code).length }
}

const kb = (n: number): string => (n / 1024).toFixed(1)
const ratio = (a: number, b: number): string => `${(a / b).toFixed(1)}x`

async function main(): Promise<void> {
  const pm = await assertParseman()
  console.log(`parseman ${pm.version}   ${pm.root}   (measured)`)
  console.log(`jess     ${JESS_ROOT}   installs parseman ${pm.installed} — NOT what is measured here`)
  console.log('')

  const rows = new Map<string, SizeRow>()
  const cgVar = new Map<string, Cg>()
  const cgAll = new Map<Dialect, Cg>()

  for (const d of DIALECTS) {
    const file = resolvePath(JESS_ROOT, MODULE[d])
    const src = readFileSync(file, 'utf8')
    cgAll.set(d, await codegen(src, file))
    for (const v of VARIANTS) {
      rows.set(`${d}|${v}`, tableRow(d, v))
      cgVar.set(`${d}|${v}`, await codegen(sliceToVariant(src, d, v), file))
    }
  }

  /* ── headline ───────────────────────────────────────────────────────────── */
  console.log('=== PER-VARIANT ARTIFACT SIZE — AST variant (hostMode=ast, trackLines=false)')
  console.log('    the canonical path. One dialect, one variant, both lowerings, same reducers.')
  console.log('')
  console.log('           rules  |------- codegen -------|  |-------- table --------|   raw    gzip')
  console.log('                        raw KB    gzip KB        raw KB    gzip KB      ratio   ratio')
  for (const d of DIALECTS) {
    const t = rows.get(`${d}|ast`)!
    const c = cgVar.get(`${d}|ast`)!
    console.log(
      `  ${d.padEnd(6)} ${String(t.rules).padStart(5)}  ${kb(c.raw).padStart(12)} ${kb(c.gz).padStart(10)}  ${kb(t.tableWhole[0]).padStart(14)} ${kb(t.tableWhole[1]).padStart(10)}  ${ratio(c.raw, t.tableWhole[0]).padStart(8)} ${ratio(c.gz, t.tableWhole[1]).padStart(7)}`,
    )
  }
  console.log('    WHOLE ARTIFACT: recognizer + the author\'s reducers, excluding the shared driver.')
  console.log('')

  console.log('=== THE SAME, SPLIT — machinery vs reducers (AST variant)')
  console.log('    reducers ship under BOTH lowerings, so they are neither lowering\'s credit.')
  console.log('    codegen machinery is DERIVED (whole - reducers); it is not separable in that lowering.')
  console.log('')
  console.log('           reducers KB  |-- machinery raw KB --|  |-- machinery gzip KB --|   raw    gzip')
  console.log('           raw   gzip     codegen      table        codegen      table       ratio   ratio')
  for (const d of DIALECTS) {
    const t = rows.get(`${d}|ast`)!
    const c = cgVar.get(`${d}|ast`)!
    const cmRaw = c.raw - t.tableReducers[0]
    const cmGz = c.gz - t.tableReducers[1]
    console.log(
      `  ${d.padEnd(6)} ${kb(t.tableReducers[0]).padStart(6)} ${kb(t.tableReducers[1]).padStart(6)}  ${kb(cmRaw).padStart(11)} ${kb(t.tableMachinery[0]).padStart(11)}  ${kb(cmGz).padStart(13)} ${kb(t.tableMachinery[1]).padStart(11)}  ${ratio(cmRaw, t.tableMachinery[0]).padStart(8)} ${ratio(cmGz, t.tableMachinery[1]).padStart(7)}`,
    )
  }
  console.log('')

  console.log('=== PER-RULE COST (AST variant, machinery only)')
  console.log('           rules   code words   codegen B/rule   table B/rule')
  for (const d of DIALECTS) {
    const t = rows.get(`${d}|ast`)!
    const c = cgVar.get(`${d}|ast`)!
    const cm = c.raw - t.tableReducers[0]
    console.log(
      `  ${d.padEnd(6)} ${String(t.rules).padStart(5)} ${String(t.words).padStart(12)} ${(cm / t.rules).toFixed(0).padStart(16)} ${(t.tableMachinery[0] / t.rules).toFixed(0).padStart(14)}`,
    )
  }
  console.log('')

  /* ── every variant ──────────────────────────────────────────────────────── */
  console.log('=== EVERY VARIANT — whole artifact, raw B (gzip B)')
  console.log('           variant       codegen                 table                 ratio')
  for (const d of DIALECTS) {
    for (const v of VARIANTS) {
      const t = rows.get(`${d}|${v}`)!
      const c = cgVar.get(`${d}|${v}`)!
      console.log(
        `  ${d.padEnd(6)} ${v.padEnd(11)} ${String(c.raw).padStart(9)} (${String(c.gz).padStart(7)})   ${String(t.tableWhole[0]).padStart(9)} (${String(t.tableWhole[1]).padStart(7)})   ${ratio(c.raw, t.tableWhole[0]).padStart(7)}`,
      )
    }
  }
  console.log('')

  /* ── the fold, kept apart ───────────────────────────────────────────────── */
  console.log('=== THE VARIANT FOLD  [BUILD/DX RESULT — NOT a per-dialect artifact figure]')
  console.log('    Standing rule: this must never be quoted as a dialect\'s size. It is here')
  console.log('    because it is true, and in its own section because it is a different claim.')
  console.log('    Identity is proven by a sha256 of the emitted MACHINERY, not by equal byte counts.')
  console.log('')
  for (const d of DIALECTS) {
    const hashes = new Map<string, Variant[]>()
    for (const v of VARIANTS) {
      const h = rows.get(`${d}|${v}`)!.machineryHash
      hashes.set(h, [...(hashes.get(h) ?? []), v])
    }
    const groups = [...hashes.values()].map(g => g.join('+')).join('  |  ')
    const tableTotal = [...hashes.keys()].reduce((a, h) => {
      const v = VARIANTS.find(x => rows.get(`${d}|${x}`)!.machineryHash === h)!
      return a + rows.get(`${d}|${v}`)!.tableWhole[0]
    }, 0)
    const cgTotal = cgAll.get(d)!
    console.log(`  ${d.padEnd(6)} ${hashes.size} distinct table(s) from 4 variants:  ${groups}`)
    console.log(`         four-variant SHIPPED codegen module  ${cgTotal.raw} B (gzip ${cgTotal.gz})`)
    console.log(`         distinct tables + reducers together  ${tableTotal} B`)
  }
  console.log('')
  const cgSum = DIALECTS.reduce((a, d) => a + cgAll.get(d)!.raw, 0)
  console.log(`  all four dialects, four-variant codegen as SHIPPED: ${cgSum} B (${(cgSum / 1024 / 1024).toFixed(2)} MB)`)
  console.log('')

  /* ── the driver, never netted off ───────────────────────────────────────── */
  const driverBytes = DRIVER.reduce((a, f) => a + statSync(resolvePath(HERE, '../..', f)).size, 0)
  console.log('=== THE SHARED DRIVER — added to a bundle ONCE, by all grammars and all variants')
  console.log(`  ${driverBytes} B of TS source across ${DRIVER.join(', ')}`)
  console.log('  It is NOT netted off any figure above. Against the smallest per-variant')
  console.log('  codegen saving in this table it pays for itself inside a single dialect.')
}

await main()
