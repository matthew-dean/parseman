/**
 * A selective build whose same-reading functions have been merged parses exactly as
 * the closure engine alone, entered through every rule. A grammar's root usually
 * never fails, so entering only there misses a wrong failure set: each rule gets
 * inputs of its own and the whole result is compared, `expected` included.
 *
 * `twins` holds rules whose functions differ in one thing a merge could lose, and
 * literals that read like the names the merge compares and renames.
 */
import { describe, expect, it } from 'vitest'
import { isDeepStrictEqual } from 'node:util'
import { cfgKey, countSiteVisits, tableRules } from '../../src/table/assemble.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { selectHotSites } from '../../src/table/select-hot.ts'
import { mergeSameBodies, supercompileEmittedAssembly } from '../../src/plugin/entry-supercompiler.ts'
import { run } from '../../src/functional/run.ts'
import { cssRules } from '../../examples/css/parser.ts'
import type { Combinator } from '../../src/types.ts'
import { choice, field, label, literal, many, node, optional, regex, rules, sequence } from '../../src/index.ts'

type RuleMap = Record<string, Combinator<unknown>>

const SITE_LIKE = Array.from({ length: 60 }, (_, n) => [`S${n}`, literal(`_pf${n}`)] as const)
const pair = sequence(regex(/a/), regex(/b/))
const letter = regex(/f/)
const twins = rules(g => ({
  Doc: many(choice(sequence(g.Failure1!, literal('c')), sequence(g.Failure2!, literal('c')), g.Number1!, g.Number2!, g.Fields!, sequence(g.Optional1!, literal('x')), sequence(g.Optional1!, literal('y')), sequence(g.Optional2!, literal('z')), sequence(g.Optional2!, literal('w')), g.Temp1!, g.Temp2!, ...SITE_LIKE.map(([name]) => g[name]!))),
  Failure1: label('one thing', letter),
  Failure2: label('another thing', letter),
  Number1: label('a letter', regex(/d/)),
  Number2: label('a letter', regex(/e/)),
  Fields: node(choice(sequence(literal('1'), g.Field1!), sequence(literal('2'), g.Field2!)), (_children, fields) => Object.keys(fields ?? {})),
  Field1: field('_t1_', pair),
  Field2: field('_t2_', pair),
  Optional1: optional(letter),
  Optional2: optional(letter),
  Temp1: literal('_t1_'),
  Temp2: literal('_t1_v0'),
  ...Object.fromEntries(SITE_LIKE),
}))

const CSS_INPUTS = ['a { color: red }', '@media x { b { y: z } }', '.a > .b, #x:hover { margin: 0 1px; background: url(a.png) }', '@import "a"; /* c */ @font-face { src: local("x") }', 'a { color', 'a { color: red', '@media', '.a >', '[a=', 'a { @@@ }']
const CSS_PIECES = ['a', 'a {', 'a { color: red }', '@media x {', '.a > .b', '#x:hover', '[a=b]', '[a=', '1px', 'rgb(1,2,', 'color: red;', 'color:', 'url(x', '"str', '/* c', '!important', '@', '{', '}', '(', ')', ':', '::before', 'a, b', 'a,', '']
const TWIN_PIECES = ['c', 'd', 'e', 'f', 'q', '1ab', '2ab', '1a', 'x', 'xd', 'xe', '_t1_', '_t2_', '_t1_v0', '', ...SITE_LIKE.flatMap(([, ], n) => (n % 7 === 0 ? [`_pf${n}`] : []))]

const assembled = (prog: TableProgram, source: string, joined: ReturnType<typeof supercompileEmittedAssembly>) => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function(...EMITTED_PARAMS, source) as EmittedFactory
  return tableRules({ ...prog, asm: [{ key: cfgKey(defaultAssemblyCfgs(prog)[0]!), arity: EMITTED_PARAMS.length, factory, plan: joined.plan, reached: [...joined.reached] }] })
}

const outcome = (rule: unknown, input: string): unknown => {
  try { return JSON.parse(JSON.stringify(run(rule as never, input))) as unknown } catch (error) { return `threw ${String(error)}` }
}

describe('a merged build against the closure engine', () => {
  describe.each([
    ['the css example', cssRules as unknown as RuleMap, 'Stylesheet', CSS_INPUTS, CSS_PIECES],
    ['rules that differ in one thing a merge could lose', twins as unknown as RuleMap, 'Doc', ['fcdefx', 'fz', 'x', '1ab2ab', '_t1__pf0_pf7', 'q'], TWIN_PIECES],
  ] as const)('%s', (_name, ruleMap, root, inputs, pieces) => {
    const prog = encodeTable(ruleMap, {})
    const cfg = defaultAssemblyCfgs(prog)[0]!
    const extra = assemblyExtraIps(prog)
    const table = resolveTable(prog)
    const { siteBytes } = emitAssemblySource(table, prog, cfg, extra, true)
    const total = [...siteBytes.values()].reduce((sum, bytes) => sum + bytes, 0)
    const profile = countSiteVisits(prog, built => { for (const input of inputs) { try { run(built[root] as never, input) } catch { /* the calls it made still count */ } } })
    const names = Object.keys(prog.rules)
    const cases = [...inputs.map(input => [root, input] as const), ...names.flatMap(name => pieces.map(piece => [name, piece] as const))]
    const closure = tableRules({ ...prog, asm: [] })
    const expected = cases.map(([name, input]) => outcome(closure[name]!, input))

    it('has failures to compare', () => {
      expect(expected.filter(result => (result as { expected?: unknown[] }).expected?.length).length).toBeGreaterThan(100)
    })

    it.each([
      ...[0.05, 0.15, 0.3, 0.6, 1].map(share => ['measured calls', share] as const),
      ...[0.05, 0.15, 0.3, 0.6, 1].map(share => ['the static estimate', share] as const),
    ])('ranked by %s, with %d of the sites\' bytes', (ranking, share) => {
      const picked = selectHotSites(prog.code, Object.values(prog.rules), siteBytes, total * share, ranking === 'measured calls' ? profile : undefined)
      const joined = supercompileEmittedAssembly(prog, cfg, extra, emitAssemblySource(table, prog, cfg, extra, true, picked))
      const built = assembled(prog, mergeSameBodies(joined.source), joined)
      const differs = cases.flatMap(([name, input], i) => (isDeepStrictEqual(outcome(built[name]!, input), expected[i]) ? [] : [`${name} on ${JSON.stringify(input)}`]))
      expect(differs.slice(0, 5)).toEqual([])
    })

    it('merges something, or this compares nothing', () => {
      const picked = selectHotSites(prog.code, Object.values(prog.rules), siteBytes, total, profile)
      const { source } = supercompileEmittedAssembly(prog, cfg, extra, emitAssemblySource(table, prog, cfg, extra, true, picked))
      expect(mergeSameBodies(source).length).toBeLessThan(source.length)
    })
  })
})
