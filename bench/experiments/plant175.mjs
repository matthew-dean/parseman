// parseman#175 scratch: plant a known cost in the working tree's src/ (the head side).
//   uniform <frac>  — a checksum over <frac> of the input in every parse
//   token <k>       — <k> iterations of work in every lead() call (per token / decision)
//   mixture <mult>  — in one PROCESS in five, a checksum over <mult> x the input per parse
import { readFileSync, writeFileSync } from 'node:fs'
const [kind, arg] = process.argv.slice(2)
const edit = (f, from, add, before = false) => {
  const s = readFileSync(f, 'utf8')
  if (!s.includes(from)) throw new Error(`anchor not found in ${f}`)
  writeFileSync(f, s.replace(from, before ? add + from : from + add))
}
const compile = 'src/table/compile.ts'
const pwc = 'parseWithContext(input: string, parseCtx: ParseContext, pos = 0): ParseResult<T> {\n'
if (kind === 'uniform') {
  edit(compile, pwc, `      { let h = 0; const n = Math.floor(input.length * ${Number(arg)}); for (let i = 0; i < n; i++) h = (h * 31 + input.charCodeAt(i)) | 0; (globalThis as { __plant?: number }).__plant = h }\n`)
} else if (kind === 'token') {
  edit('src/table/run-support.ts', 'export function lead(input: string, pos: number): number {\n',
    `  { let h = pos; for (let i = 0; i < ${Number(arg)}; i++) h = (h * 31 + i) | 0; (globalThis as { __plant?: number }).__plant = h }\n`)
} else if (kind === 'mixture') {
  edit(compile, 'export function compile<T>(combinator: Combinator<T>', 'const PLANT_SLOW_PROCESS = Math.random() < 0.2\n', true)
  edit(compile, pwc, `      if (PLANT_SLOW_PROCESS) { let h = 0; const n = Math.floor(input.length * ${Number(arg)}); for (let i = 0; i < n; i++) h = (h * 31 + input.charCodeAt(i % input.length)) | 0; (globalThis as { __plant?: number }).__plant = h }\n`)
} else throw new Error(`unknown plant ${kind}`)
console.log('planted', kind, arg)
