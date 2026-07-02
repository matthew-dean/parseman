/**
 * Measure macro/compile code-expansion: how many lines/bytes of generated JS a
 * compact combinator grammar expands into. One-off inspection helper.
 */
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { compile } from '../src/index.ts'
import { jsonDoc } from '../examples/json/parser.ts'
import { csvParser } from '../examples/csv/parser.ts'
import { graphqlDoc } from '../examples/graphql/parser.ts'

const here = dirname(fileURLToPath(import.meta.url))
const examples = join(here, '..', 'examples')

function lines(s: string): number {
  return s.split('\n').length
}

function srcLines(file: string): number {
  const text = readFileSync(file, 'utf8')
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    }).length
}

type Row = {
  grammar: string
  grammarLines: number
  genLines: number
  genKB: number
  gzipKB: number
  lineMult: string
}

const cases: { name: string; parser: ReturnType<typeof compile>; file: string }[] = [
  { name: 'JSON',    parser: compile(jsonDoc),     file: join(examples, 'json', 'parser.ts') },
  { name: 'CSV',     parser: compile(csvParser),   file: join(examples, 'csv', 'parser.ts') },
  { name: 'GraphQL', parser: compile(graphqlDoc),  file: join(examples, 'graphql', 'parser.ts') },
]

const rows: Row[] = cases.map(({ name, parser, file }) => {
  const gen = parser.source
  const g = srcLines(file)
  const gl = lines(gen)
  return {
    grammar: name,
    grammarLines: g,
    genLines: gl,
    genKB: +(Buffer.byteLength(gen, 'utf8') / 1024).toFixed(1),
    gzipKB: +(gzipSync(gen).length / 1024).toFixed(1),
    lineMult: (gl / g).toFixed(1) + '×',
  }
})

console.log('\nMacro / compile() code expansion (generated JS vs grammar source):\n')
console.log('  grammar   grammar LOC   generated LOC   raw size   gzipped   line multiplier')
for (const r of rows) {
  console.log(
    '  ' +
      r.grammar.padEnd(10) +
      String(r.grammarLines).padStart(9) +
      String(r.genLines).padStart(16) +
      (r.genKB + ' kB').padStart(11) +
      (r.gzipKB + ' kB').padStart(10) +
      r.lineMult.padStart(17),
  )
}
console.log()
