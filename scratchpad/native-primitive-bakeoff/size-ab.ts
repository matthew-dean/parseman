/**
 * Artifact size A/B for a toggled codegen change, raw AND gzip (they have moved
 * in opposite directions in this workstream, so both are reported).
 *
 * Run once per env setting; the two runs are compared by `size-ab.sh`.
 *   PARSEMAN_SCANTO=loop    node --import tsx/esm scratchpad/.../size-ab.ts base
 *   PARSEMAN_SCANTO=indexof node --import tsx/esm scratchpad/.../size-ab.ts cand
 */
import { gzipSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { compile } from '../../src/index.ts'
import { Stylesheet as LessStylesheet } from '../../bench/workloads/less.ts'
import { Stylesheet as CssStylesheet } from '../../examples/css/parser.ts'
import { graphqlDoc } from '../../examples/graphql/parser.ts'
import { jsonDoc } from '../../examples/json/parser.ts'

const tag = process.argv[2] ?? 'run'
const grammars: Array<[string, Parameters<typeof compile>[0]]> = [
  ['less/stylesheet', LessStylesheet],
  ['css/stylesheet', CssStylesheet],
  ['graphql/document', graphqlDoc],
  ['json/document', jsonDoc],
]

const out: Record<string, { raw: number; gzip: number; indexOfSites: number }> = {}
for (const [name, g] of grammars) {
  const src = compile(g).source
  writeFileSync(`scratchpad/native-primitive-bakeoff/artifact-${tag}-${name.replace('/', '-')}.js`, src)
  out[name] = {
    raw: Buffer.byteLength(src, 'utf8'),
    gzip: gzipSync(Buffer.from(src, 'utf8'), { level: 9 }).length,
    // how many times the new form actually fired
    indexOfSites: (src.match(/input\.indexOf\(/g) ?? []).length,
  }
}
console.log(JSON.stringify({ tag, env: process.env.PARSEMAN_SCANTO ?? '(unset)', out }, null, 2))
