/**
 * WHAT THE MACRO PRINTED vs WHAT `encodeTable` PRODUCES, field by field.
 *
 * `bench/jess/macro-vs-assembled.ts` (lane/linker-engine) measured the shipping
 * macro artifact at 1.29x the cost of `assembledRules(encodeTable(rules, {}))`
 * over the same grammar, 0/16 wins twice against a -0.1% control. Both sides run
 * the SAME engine — the macro emits `import { tableRules } from 'parseman/table'`
 * and `src/table/index.ts:28` aliases that to `assembledRules` — so the gap is in
 * the PROGRAM, not the driver.
 *
 * This file is DETERMINISTIC. It reads no clock. Everything it prints is a count,
 * a set difference or a byte, so it can be run on a busy box and quoted.
 *
 * Usage: node --import ./bench/jess/register.mjs bench/jess/macro-program-diff.ts [dialect]
 */
import { resolve as resolvePath } from 'node:path'
import { encodeTable } from '../../src/table/encode.ts'
import { expandCompact, type TableProgram } from '../../src/table/program.ts'
import { opHistogram, reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE } from '../../src/table/ops.ts'
import { resolveTable } from '../../src/table/program.ts'
import { assertParseman, exportName, headSha, JESS_ROOT, type Dialect } from './grammars.ts'
import type { Capture } from './capture.ts'

const MODULE: Record<Dialect, string> = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts',
  less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts',
  jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
}

const dialect = (process.argv[2] ?? 'less') as Dialect

const prov = await assertParseman()
console.log(`parseman ${prov.version} at ${prov.root}  HEAD ${headSha()}`)
console.log(`  jess root ${JESS_ROOT}   node ${process.version}`)
console.log(`  dialect ${dialect}   module ${MODULE[dialect]}`)

/* ── The macro side ──────────────────────────────────────────────────────── */

const modPath = resolvePath(JESS_ROOT, MODULE[dialect])
const capMod = await import('./capture.ts') as { captured: Capture[] }
const macroMod = await import(`pm-capture:${modPath}`) as Record<string, unknown>
const wanted = macroMod[exportName(dialect, 'ast')] as Record<string, unknown>
const hit = capMod.captured.find(c => c.rules === wanted)
if (hit === undefined) {
  throw new Error(
    `no capture matched ${exportName(dialect, 'ast')} — the macro emitted ${capMod.captured.length} `
    + 'program(s) and none of them returned that export. The export is produced some other way '
    + '(a fold, a wrapper); this probe has to follow it before any field comparison means anything.',
  )
}
console.log(`  macro emitted ${capMod.captured.length} program literal(s); matched the '${exportName(dialect, 'ast')}' one`)
const macro = expandCompact(hit.source)

/* ── The interpreted-fuse side ───────────────────────────────────────────── */

/**
 * The fuse MUTATES the shared recognition pieces, so the plain module import has
 * to come AFTER the macro one — the macro instance is a separate module URL and
 * must not be handed an already-realised piece.
 */
const plainMod = await import(modPath) as Record<string, unknown>
const grammar = plainMod[exportName(dialect, 'ast')] as Record<string, never>
const rules: Record<string, never> = {}
for (const k of Object.keys(grammar)) rules[k] = grammar[k]!
const encoded: TableProgram = encodeTable(rules, {})

console.log('')
console.log(`RULES   macro ${Object.keys(macro.rules).length}   encoded ${Object.keys(encoded.rules).length}`)
{
  const a = new Set(Object.keys(macro.rules))
  const b = new Set(Object.keys(encoded.rules))
  const onlyA = [...a].filter(k => !b.has(k))
  const onlyB = [...b].filter(k => !a.has(k))
  if (onlyA.length > 0) console.log(`  only in macro:   ${onlyA.join(', ')}`)
  if (onlyB.length > 0) console.log(`  only in encoded: ${onlyB.join(', ')}`)
}

/* ── Field-by-field ──────────────────────────────────────────────────────── */

const len = (v: unknown): string => (Array.isArray(v) ? String(v.length) : v === undefined ? '-' : JSON.stringify(v))

console.log('')
console.log('FIELD SIZES                macro   encoded   delta')
const FIELDS = ['code', 'k', 'cc', 'fx', 'disp', 'dsp', 'fns', 'labels', 'triviaSpecs', 'scans', 'scanSkip', 'scanSkipOf', 'cov'] as const
for (const f of FIELDS) {
  const a = macro[f] as unknown
  const b = encoded[f] as unknown
  const na = Array.isArray(a) ? a.length : null
  const nb = Array.isArray(b) ? b.length : null
  const d = na !== null && nb !== null ? String(na - nb) : ''
  const mark = len(a) === len(b) ? '' : '   <-- DIFFERS'
  console.log(`  ${f.padEnd(24)}${len(a).padStart(6)}${len(b).padStart(10)}${d.padStart(8)}${mark}`)
}
console.log('SCALARS')
for (const f of ['lines', 'classified', 'hostMode', 'rec'] as const) {
  const a = macro[f] as unknown
  const b = encoded[f] as unknown
  console.log(`  ${f.padEnd(24)}${String(a).padStart(6)}${String(b).padStart(10)}${a === b ? '' : '   <-- DIFFERS'}`)
}

/* ── Reachable opcode histograms ─────────────────────────────────────────── */

const hA = opHistogram(macro)
const hB = opHistogram(encoded)
const ops = [...new Set([...Object.keys(hA), ...Object.keys(hB)])].sort()
console.log('')
console.log(`REACHABLE OPS   macro ${reachableIps(macro).size} rows   encoded ${reachableIps(encoded).size} rows`)
console.log('  op                       macro   encoded   delta')
let opDiffs = 0
for (const op of ops) {
  const a = hA[op] ?? 0
  const b = hB[op] ?? 0
  if (a !== b) opDiffs++
  console.log(`  ${op.padEnd(24)}${String(a).padStart(6)}${String(b).padStart(10)}${String(a - b).padStart(8)}${a === b ? '' : '   <--'}`)
}
console.log(`  ${opDiffs} opcode(s) differ in reachable count`)

/* ── The code stream itself ──────────────────────────────────────────────── */

console.log('')
{
  const a = macro.code, b = encoded.code
  console.log(`CODE STREAM   macro ${a.length} words   encoded ${b.length} words`)
  let first = -1
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) { first = i; break }
  if (first === -1 && a.length === b.length) {
    console.log('  IDENTICAL word for word')
  } else {
    let same = 0
    for (let i = 0; i < n; i++) if (a[i] === b[i]) same++
    console.log(`  first divergence at word ${first === -1 ? n : first};  ${same}/${n} words equal (${((same / n) * 100).toFixed(1)}%)`)
    const at = first === -1 ? n : first
    const lo = Math.max(0, at - 6), hi = Math.min(n, at + 10)
    console.log(`  macro   [${lo}..${hi}) ${a.slice(lo, hi).join(',')}`)
    console.log(`  encoded [${lo}..${hi}) ${b.slice(lo, hi).join(',')}`)
  }
}

/* ── Pools ───────────────────────────────────────────────────────────────── */

console.log('')
{
  const norm = (v: unknown): string => (v instanceof RegExp ? `/${v.source}/${v.flags}` : typeof v === 'function' ? 'fn' : JSON.stringify(v) ?? String(v))
  const a = macro.k.map(norm), b = encoded.k.map(norm)
  let diff = 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff++
  console.log(`CONST POOL k   macro ${a.length}   encoded ${b.length}   positions differing ${diff}`)
  if (diff > 0) {
    let shown = 0
    for (let i = 0; i < Math.max(a.length, b.length) && shown < 8; i++) {
      if (a[i] === b[i]) continue
      console.log(`  k[${i}]  macro ${a[i]}   encoded ${b[i]}`)
      shown++
    }
  }
}
{
  const a = macro.cc, b = encoded.cc
  let diff = 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff++
  console.log(`CHAR CLASSES cc   macro ${a.length}   encoded ${b.length}   positions differing ${diff}`)
}
{
  const key = (d: readonly number[]): string => d.join(',')
  const a = macro.disp.map(key), b = encoded.disp.map(key)
  let diff = 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff++
  console.log(`FIRST-SET DISPATCH disp   macro ${a.length}   encoded ${b.length}   positions differing ${diff}`)
  console.log(`  arms total   macro ${macro.disp.reduce((s, d) => s + d.length, 0)}   encoded ${encoded.disp.reduce((s, d) => s + d.length, 0)}`)
  const openArms = (ds: readonly (readonly number[])[]): number => ds.reduce((s, d) => s + d.filter(x => x < 0).length, 0)
  console.log(`  OPEN arms (-1, no first set)   macro ${openArms(macro.disp)}   encoded ${openArms(encoded.disp)}`)
}
{
  const a = macro.scans ?? [], b = encoded.scans ?? []
  console.log(`SCAN POOL sc   macro ${a.length}   encoded ${b.length}`)
}
{
  const a = macro.triviaSpecs ?? [], b = encoded.triviaSpecs ?? []
  const shape = (t: { plain?: unknown; alts?: unknown; arms?: readonly unknown[]; live?: unknown }): string =>
    t.live !== undefined ? 'LIVE' : t.plain !== undefined ? 'plain' : t.alts !== undefined ? 'alts' : `arms(${t.arms?.length ?? 0})`
  console.log(`TRIVIA SPECS tv   macro [${a.map(shape).join(' ')}]   encoded [${b.map(shape).join(' ')}]`)
}

/* ── OP_CHOICE gating, the thing dispatch actually buys ──────────────────── */

console.log('')
{
  /**
   * THE THREE CHOICE PIECES `assemble.ts:1741` selects between, counted over the
   * REACHABLE rows. `exclusive` is the O(1) ascii-slot piece; `maskable` is the
   * `Uint32Array` candidate-mask loop; `general` is the per-arm `classHas` loop.
   * Which one a row gets is a function of its dispatch table, so this is where a
   * first-set difference between the two programs would show up as SPEED.
   */
  const count = (p: TableProgram): Record<string, number> => {
    const t = resolveTable(p)
    let choices = 0, exclusive = 0, maskable = 0, general = 0
    let armsTotal = 0, armsGated = 0, openArms = 0
    for (const ip of reachableIps(p)) {
      if (p.code[ip] !== OP_CHOICE) continue
      choices++
      const di = p.code[ip + 1]!
      const n = p.code[ip + 2]!
      armsTotal += n
      const arms = p.disp[di] ?? []
      armsGated += arms.filter(x => x >= 0).length
      openArms += arms.filter(x => x < 0).length
      const table = t.disp[di]
      if (table?.exclusive === true) exclusive++
      else if (n <= 32) maskable++
      else general++
    }
    return { choices, exclusive, maskable, general, armsTotal, armsGated, openArms }
  }
  const a = count(macro), b = count(encoded)
  console.log('CHOICE GATING (the first-set lever)   macro   encoded   delta')
  for (const k of Object.keys(a)) {
    const x = a[k]!, y = b[k]!
    console.log(`  ${k.padEnd(34)}${String(x).padStart(6)}${String(y).padStart(10)}${String(x - y).padStart(8)}${x === y ? '' : '   <--'}`)
  }
}
