/**
 * Part B: does the SHIPPED artifact dispatch on that choice, or does the stale
 * `disjoint` flag reach the emitted code?
 *
 * Uses the same ruler as bench/size/probe.ts — `transformMacro` over a
 * macro-tagged module — so this is the artifact that ships, not a runtime proxy.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { transformMacro } from '../src/plugin/index.ts'
import { diagnoseGrammar } from '../src/index.ts'
import { jsonRules } from '../bench/g5-grammars.ts'
import type { Combinator } from '../src/types.ts'

const MACRO = `import { rules, literal, regex, sequence, choice, many, optional, sepBy, transform } from 'parseman' with { type: 'macro' }`

const SRC = `${MACRO}
export const g = rules((g) => ({
  Str: transform(sequence(literal('"'), regex(/[^"]*/), literal('"')), (v) => v[1]),
  Num: transform(regex(/-?[0-9]+/), (s) => Number(s)),
  True: transform(literal('true'), () => true),
  False: transform(literal('false'), () => false),
  Null: transform(literal('null'), () => null),
  Arr: transform(sequence(literal('['), optional(sepBy(g.Value, literal(','))), literal(']')), (v) => v[1] ?? []),
  Pair: transform(sequence(g.Str, literal(':'), g.Value), (v) => [v[0], v[2]]),
  Obj: transform(sequence(literal('{'), optional(sepBy(g.Pair, literal(','))), literal('}')), (v) => v[1] ?? []),
  Value: choice(g.Obj, g.Arr, g.Str, g.Num, g.True, g.False, g.Null),
}))
`

const dir = '/tmp/pm-disjoint'
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'package.json'), '{}')
const file = path.join(dir, 'g.ts')
writeFileSync(file, SRC)
const out = transformMacro(SRC, file, new Set(['parseman']))
const code = typeof out === 'string' ? out : out?.code
if (!code) throw new Error('no code')
writeFileSync(path.join(dir, 'g.out.js'), code)

const m = /function _r_Value\(input, _pos, _ctx\) \{[\s\S]*?\n  \}/.exec(code)
console.log('=== emitted _r_Value (artifact: /tmp/pm-disjoint/g.out.js)')
console.log(m ? m[0].slice(0, 1400) : '(not found)')

console.log('')
console.log('=== diagnoseGrammar on the same rule map')
const rep = diagnoseGrammar(jsonRules as unknown as Record<string, Combinator<unknown>>)
console.log(JSON.stringify(rep, null, 1).slice(0, 1600))
