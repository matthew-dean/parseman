/**
 * Micro instruction harness: one engine, one rule, one input, N parses.
 * Usage: node --import ../../bench/jess/register.mjs micro.ts <dialect> <engine> <rule> <N> <input-json>
 *   engine: assembled | exec | interp
 * Prints digest of the result once (to stderr) so A/B identity can be checked.
 */
import { resolve as resolvePath } from 'node:path'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { JESS_ROOT, exportName, loadGrammar, type Dialect } from '../../bench/jess/grammars.ts'

const MODULE: Record<Dialect, string> = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts',
  less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts',
  jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
}
const [dialect, engine, rule, nStr, inputJson, variantArg] = process.argv.slice(2) as [Dialect, string, string, string, string, string | undefined]
const variant = (variantArg ?? 'ast') as 'ast' | 'cst'
const input = inputJson.startsWith('@') ? (await import('node:fs')).readFileSync(inputJson.slice(1), 'utf8') : JSON.parse(inputJson) as string
const N = Number(nStr)
type Entry = Parameters<typeof run>[0]
let entry: Entry
if (engine === 'assembled') {
  const mod = await import(`pm-macro:${resolvePath(JESS_ROOT, MODULE[dialect])}`) as Record<string, Record<string, Entry>>
  entry = mod[exportName(dialect, variant)]![rule]!
} else {
  const { rules } = await loadGrammar(dialect, variant)
  entry = (engine === 'exec' ? execRules(encodeTable(rules, variant === 'cst' ? { hostMode: 'cst' } : {}))[rule] : rules[rule]) as Entry
}
if (entry === undefined) throw new Error('no rule ' + rule)
const first = run(entry, input)
if (process.env.DIGEST) process.stderr.write(digestValue(first) + "\n")
if (process.env.OKC) process.stderr.write(`ok=${String(first.ok)} unconsumedFrom=${String(first.unconsumedFrom)} len=${input.length}\n`)
if (process.env.SHOW) process.stderr.write(JSON.stringify(first, (_k, v) => typeof v === 'bigint' ? String(v) : v).slice(0, 4000) + '\n')
let sink = 0
for (let i = 1; i < N; i++) sink += run(entry, input).ok ? 1 : 0
if (sink < 0) console.log(sink)
const stats = (globalThis as { __lcStats?: Map<number, { shape: string; hits: number; deep: number; depths: number[] }> }).__lcStats
if (stats) for (const [ip, s] of stats) if (s.hits > 0) process.stderr.write(`${ip}: hits=${s.hits / N} deep=${s.deep / N} depths=${JSON.stringify(s.depths.map(x => x / N))}  ${s.shape}\n`)
const shapes = (globalThis as { __lcShapes?: Map<string, number> }).__lcShapes
if (shapes) for (const [k, v] of shapes) process.stderr.write(`${v / N}x ${k}\n`)
const cnts = (globalThis as { __lcCounts?: Record<string, number> }).__lcCounts
if (cnts) process.stderr.write('counts ' + JSON.stringify(Object.fromEntries(Object.entries(cnts).map(([k, v]) => [k, v / N]))) + '\n')
