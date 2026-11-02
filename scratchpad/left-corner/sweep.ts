// Identity sweep: one process per (dialect, variant, PM_LC). Prints TSV: name, digestRow cells.
// node --import ./register.mjs sweep.ts <dialect> <variant: ast|ast-lines|cst|cst-lines>
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { run } from '../../src/functional/run.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
import { digestRow } from '../../bench/jess/digest.ts'
import { JESS_ROOT, exportName, VARIANT_SETTINGS, type Dialect, type Variant } from '../../bench/jess/grammars.ts'
const MODULE: Record<Dialect, string> = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts', less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts', jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
}
const MAIN = '/Users/matthew/git/oss/jess'
const FIX = '/private/tmp/claude-501/-Users-matthew-git-oss-jess/8341857d-0f0c-4f2b-9bb9-258cd289a43b/scratchpad/fixtures'
const ROOTS: Record<Dialect, { roots: string[]; ext: string; extra: string[] }> = {
  css: { roots: [JESS_ROOT + '/packages/syntax/css/css-parser/test/css'], ext: '.css', extra: [JESS_ROOT + '/packages/jess/benchmark/benchmark.css'] },
  less: { roots: [MAIN + '/node_modules/@less/test-data'], ext: '.less', extra: [JESS_ROOT + '/packages/jess/benchmark/benchmark.less', FIX + '/gen-workload.less', FIX + '/bootstrap4-all.less'] },
  scss: { roots: [MAIN + '/packages/syntax/scss/scss-parser/.cache/sass-spec/inputs'], ext: '.scss', extra: [FIX + '/gen-workload.scss'] },
  jess: { roots: ['packages/syntax/jess/jess-parser/test', 'packages/jess/test/files', 'packages/jess/benchmark', 'packages/fns/test/files', 'packages/rollup-plugin-jess/test'].map(r => JESS_ROOT + '/' + r), ext: '.jess', extra: [FIX + '/jess-x8.jess'] },
}
function walk(dir: string, ext: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir).sort()) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p, ext, out); else if (p.endsWith(ext)) out.push(p) }
}
// Failure right at a value's end, where a skipped continuation's expected set is the answer.
const EDGE = ['a{b:c )}', 'a{b:c)}', 'a{b:1 )}', 'a{b:1)}', 'a{b:c d)}', 'a{b:c,)}', 'a{b:c !}', 'a{b:c/)}', 'a{b:c / )}', 'a{b:1px+)}', 'a{b:1px + )}', 'a{b:1px * )}', 'a{b:c ]}', 'a{b:c]}', 'a{b:(c)}', 'a{b:f(c d)}', 'a{b:f(c,)}', 'a{b:c 1/2 d}', 'a{b: c , d ; }', 'a{b:c/*x*/ d}', 'a{b:c /*x*/,d}']
const MICRO: Record<Dialect, string[]> = {
  less: ['a { color: red; }', 'a { margin: 0 auto; }', 'a { font: 12px/1.5 a, b; }', 'a { width: 1px + 2px * 3; }', 'a { color: -@x; }', 'a { color: - @x; }', 'a { b: foo(a, b); }', 'a { b: if((1 = 1), a, b); }', 'a { color: red ; }', 'a { color: red /* c */; }', 'a { color: red !important; }', '@x: red;', '@x: red, blue;', 'a { color: red', 'a { color: red )', 'a { color: , }', 'a { color: red,; }', 'a{color:red)}', 'a{color:red]}', '@x:red)', 'a{color:red,)}', 'a{b:foo(red)}', 'a{b:foo(red,)}'],
  scss: ['a { color: red; }', 'a { margin: 0 auto; }', 'a { font: 12px/1.5 a, b; }', 'a { width: 1px + 2px * 3; }', 'a { color: -$x; }', 'a { color: - $x; }', '$x: red;', 'a { color: red', 'a { color: red )'],
  jess: ['a { color: red; }', 'a { margin: 0 auto; }', 'a { font: 12px/1.5 a, b; }', 'a { width: $(1px + 2px * 3); }', '$x: red;', 'a { color: red', 'a { color: red )'],
  css: ['a { color: red; }', 'a { margin: 0 auto; }', 'a { font: 12px/1.5 a, b; }', 'a { width: calc(1px + 2px * 3); }', 'a { color: red', 'a { color: red )'],
}
const [dialect, variant] = process.argv.slice(2) as [Dialect, Variant]
const files: string[] = []
for (const r of ROOTS[dialect].roots) walk(r, ROOTS[dialect].ext, files)
const inputs: { name: string; input: string }[] = []
for (const p of [...files, ...ROOTS[dialect].extra]) {
  if (!existsSync(p)) continue
  const s = readFileSync(p, 'utf8')
  inputs.push({ name: p, input: s })
  // Failure paths: the same file cut at three places.
  for (const f of [0.31, 0.5, 0.77]) inputs.push({ name: `${p}@${f}`, input: s.slice(0, Math.floor(s.length * f)) })
}
MICRO[dialect].forEach((m, i) => inputs.push({ name: `micro${i}`, input: m }))
EDGE.forEach((m, i) => inputs.push({ name: `edge${i}`, input: m }))
const mod = await import(`pm-macro:${resolvePath(JESS_ROOT, MODULE[dialect])}`) as Record<string, Record<string, Parameters<typeof run>[0]>>
const entry = mod[exportName(dialect, variant)]!['Stylesheet']!
if (typeof entry !== 'function') throw new Error('not assembled')
const opts: { build?: ReturnType<typeof cstBuildHost>; state?: unknown } = VARIANT_SETTINGS[variant].hostMode === 'cst' ? { build: cstBuildHost() } : {}
const mathMode = process.env.PM_SWEEP_MATH
const out: string[] = [`# ${dialect} ${variant} PM_LC=${process.env.PM_LC ?? ''} files=${files.length} inputs=${inputs.length}`]
for (const f of inputs) {
  let cells: string[]
  if (mathMode !== undefined) opts.state = { mathMode, source: f.input }
  try { cells = digestRow(run(entry, f.input, opts)) } catch (e) { cells = ['threw: ' + ((e as Error).message.split('\n')[0] ?? '')] }
  out.push(`${f.name}\t${cells.join('\t')}`)
}
process.stdout.write(out.join('\n') + '\n')
const counts = (globalThis as { __lcCounts?: Record<string, number> }).__lcCounts
if (counts) process.stderr.write('counts ' + JSON.stringify(counts) + '\n')
