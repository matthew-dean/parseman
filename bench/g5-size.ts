/**
 * G5 size measurement.
 *
 * Ruler for the SHIPPED lowering is the one `bench/size/probe.ts` uses:
 * `transformMacro` over a macro-tagged module, weighing the emitted module.
 * Ruler for the TABLE lowering is `emitTableModule` over the same grammar with
 * the same reducer sources, so the only difference between the two numbers is
 * how the recognizer is represented.
 *
 * Both sides are reported with the resolved artifact path they were written to.
 */
import { gzipSync } from 'node:zlib'
import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { transformMacro } from '../src/plugin/index.ts'
import { encodeTable } from '../src/table/encode.ts'
import { emitTableModule } from '../src/table/emit.ts'
import { nodeLadder, jsonRules, JSON_FN_SOURCES } from './g5-grammars.ts'
import type { Combinator } from '../src/types.ts'
import { PARSEMAN_VERSION } from '../src/version.ts'

const MACRO = `import { rules, literal, regex, sequence, choice, many, oneOrMore, optional, sepBy, node, transform, trivia, compose, composeLeaf, parser } from 'parseman' with { type: 'macro' }`
const OUT = '/tmp/pm-g5-size'

function ladderSource(n: number): string {
  const defs: string[] = []
  for (let i = 0; i < n; i++) {
    defs.push(`  N${i}: node('N${i}', sequence(regex(/[a-z]+/), literal('${String.fromCharCode(97 + (i % 26))}'), optional(literal(';'))), (c) => ({ t: 'N${i}', c })),`)
  }
  defs.push(`  Root: node('Root', many(choice(${Array.from({ length: n }, (_, i) => `g.N${i}`).join(', ')})), (c) => ({ t: 'Root', c })),`)
  return `${MACRO}\nexport const g = rules((g) => ({\n${defs.join('\n')}\n}))\n`
}

function ladderFnSources(n: number): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(`(c) => ({ t: 'N${i}', c })`)
  out.push(`(c) => ({ t: 'Root', c })`)
  return out
}

function macroBytes(src: string, id: string): { bytes: number; gz: number; file: string } {
  const dir = path.join(OUT, id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), '{}')
  const file = path.join(dir, 'g.ts')
  writeFileSync(file, src)
  const out = transformMacro(src, file, new Set(['parseman']))
  const code = typeof out === 'string' ? out : out?.code
  if (!code) throw new Error(`macro lowering produced nothing for ${id}`)
  const outFile = path.join(dir, 'g.codegen.js')
  writeFileSync(outFile, code)
  return { bytes: Buffer.byteLength(code), gz: gzipSync(code).length, file: outFile }
}

function tableBytes(
  ruleMap: Record<string, Combinator<unknown>>,
  fnSources: readonly string[],
  id: string,
): { bytes: number; gz: number; file: string; words: number } {
  const prog = encodeTable(ruleMap)
  const code = emitTableModule(prog, { name: 'g', fnSources })
  const dir = path.join(OUT, id)
  mkdirSync(dir, { recursive: true })
  const outFile = path.join(dir, 'g.table.js')
  writeFileSync(outFile, code)
  return { bytes: Buffer.byteLength(code), gz: gzipSync(code).length, file: outFile, words: prog.code.length }
}

function driverBytes(): { bytes: number; files: string[] } {
  // The shared driver's own source — paid ONCE for the whole bundle, by every
  // grammar and every variant together.
  const files = ['src/table/exec.ts', 'src/table/program.ts', 'src/table/ops.ts']
  let bytes = 0
  for (const f of files) bytes += statSync(f).size
  return { bytes, files }
}

function main(): void {
  console.log(`parseman ${PARSEMAN_VERSION}   cwd ${process.cwd()}`)
  console.log('')
  console.log('=== node() ladder — SHIPPED codegen vs TABLE, same grammar, same reducers')
  console.log('    n  codegen B   gzip     table B   gzip   words   ratio')
  const ns = [1, 2, 4, 8, 16, 32]
  const cg: number[] = []
  const tb: number[] = []
  let lastPaths: [string, string] = ['', '']
  for (const n of ns) {
    const c = macroBytes(ladderSource(n), `ladder-${n}`)
    const t = tableBytes(nodeLadder(n), ladderFnSources(n), `ladder-${n}`)
    cg.push(c.bytes); tb.push(t.bytes)
    lastPaths = [c.file, t.file]
    console.log(`  ${String(n).padStart(3)}  ${String(c.bytes).padStart(9)}  ${String(c.gz).padStart(6)}  ${String(t.bytes).padStart(9)}  ${String(t.gz).padStart(6)}  ${String(t.words).padStart(6)}  ${(c.bytes / t.bytes).toFixed(2)}x`)
  }
  console.log(`  artifacts: ${lastPaths[0]}`)
  console.log(`             ${lastPaths[1]}`)
  console.log('')
  const mc = (cg.at(-1)! - cg[0]!) / (ns.at(-1)! - ns[0]!)
  const mt = (tb.at(-1)! - tb[0]!) / (ns.at(-1)! - ns[0]!)
  console.log(`  MARGINAL BYTES PER ADDITIONAL RULE (fit over n=${ns[0]}..${ns.at(-1)}):`)
  console.log(`    codegen (shipped)  ${mc.toFixed(0)} B/rule`)
  console.log(`    table   (G5)       ${mt.toFixed(0)} B/rule    ${(mc / mt).toFixed(1)}x smaller`)
  console.log('')

  console.log('=== json (9 rules) — SHIPPED codegen vs TABLE')
  const jt = tableBytes(jsonRules as unknown as Record<string, Combinator<unknown>>, JSON_FN_SOURCES, 'json')
  console.log(`  table   ${jt.bytes} B (gzip ${jt.gz}), ${jt.words} code words`)
  console.log(`          ${jt.file}`)
  const shipped = JSON.parse(readFileSync('bench/size-baseline.json', 'utf8')) as { fixtures: Record<string, { genBytes: number; gzipBytes: number }> }
  const ex = shipped.fixtures['example/json']!
  console.log(`  codegen ${ex.genBytes} B (gzip ${ex.gzipBytes})  [bench/size-baseline.json, example/json — the SHIPPED json example, 9 productions]`)
  console.log(`  ratio   ${(ex.genBytes / jt.bytes).toFixed(1)}x`)
  console.log('')

  const d = driverBytes()
  console.log('=== the shared driver (paid ONCE for the whole bundle)')
  console.log(`  ${d.bytes} B of TS source across ${d.files.join(', ')}`)
  console.log(`  Break-even vs codegen at ${(d.bytes / mc).toFixed(1)} rules; every rule after that is pure saving.`)
}

main()
