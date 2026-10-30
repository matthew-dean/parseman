/**
 * `optional`, `not` and `peek` decide on the first character when their child
 * cannot match empty: at a character outside the child's first set the outcome
 * is already known (`null`, success, failure), so the child is not entered and
 * no rollback mark is taken. The interpreter's `optional` makes the same test
 * (`repeat.ts` `startsFirstSet`).
 *
 * Pinned two ways: the child's rows are not visited on a miss, and every engine
 * — interpreter, closure table, emitted assembly — returns the same result.
 */
import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, countSiteVisits, tableRules } from '../../src/table/assemble.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'
import type { Combinator } from '../../src/types.ts'
import { choice, literal, many, not, optional, peek, regex, rules, sequence, trivia } from '../../src/index.ts'

type RuleMap = Record<string, Combinator<unknown>>

function emitted(prog: TableProgram): TableProgram {
  return { ...prog, asm: defaultAssemblyCfgs(prog).map(cfg => {
    const em = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
    return { key: cfgKey(cfg), factory, plan: em.plan, reached: [...em.reached] }
  }) }
}

const g = rules<RuleMap>({ trivia: trivia(regex(/[ ]*/)) }, g => ({
  Doc: many(choice(g.Opt!, g.Neg!, g.Pos!)),
  // `Pair` is a rule: a sequence, so no scalar shortcut applies to it.
  Opt: sequence(literal('o'), optional(g.Pair!), literal(';')),
  Neg: sequence(literal('n'), not(g.Pair!), regex(/[a-z]+/), literal(';')),
  Pos: sequence(literal('p'), peek(g.Pair!), g.Pair!, literal(';')),
  Pair: sequence(literal('['), regex(/[a-z]*/), literal(']')),
}))
const INPUTS = ['o ;', 'o [x] ;', 'n x ;', 'n [x] ;', 'p [x] ;', 'p x ;', 'o [x ;', 'o ; n y ; p [z] ;']

describe('optional / not / peek gate on a non-nullable child\'s first set', () => {
  const prog = encodeTable(g, {})
  // The sites a parse of `Pair` alone runs: the child the wrappers guard.
  const pairSites = (() => {
    const c = countSiteVisits(prog, r => { run(r['Pair'] as never, '[x]') })
    return [...c.keys()].filter(ip => c[ip]! > 0)
  })()
  const visitsOfPair = (inputs: readonly string[]): number => {
    const c = countSiteVisits(prog, r => { for (const input of inputs) run(r['Doc'] as never, input) })
    return pairSites.reduce((n, ip) => n + c[ip]!, 0)
  }

  it('does not enter the child at a character outside its first set', () => {
    expect(pairSites.length).toBeGreaterThan(0)
    expect(visitsOfPair(['o ;', 'n x ;', 'p x ;'])).toBe(0)
  })

  it('still enters it where the first character admits it', () => {
    expect(visitsOfPair(['o [x] ;'])).toBeGreaterThan(0)
  })

  it('parses as the interpreter does, on the closure engine and the emitted assembly', () => {
    const closure = tableRules({ ...prog, asm: [] })['Doc']!
    const fast = tableRules(emitted(prog))['Doc']!
    for (const input of INPUTS) {
      const want = run(g['Doc'] as never, input)
      expect(run(closure as never, input), input).toEqual(want)
      expect(run(fast as never, input), input).toEqual(want)
    }
  })
})
