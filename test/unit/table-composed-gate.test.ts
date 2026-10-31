/**
 * A node's fail-fast gate under `compose()`.
 *
 * A body that reaches a rule of ANOTHER piece is built before that rule
 * exists, so its construction-time `_meta.firstSet` is `any`, and the encoder,
 * which read that cached set, gave the node no gate: the node's body ran at
 * every position the node was tried. On jess's Less grammar that put
 * `CompoundSelector` behind `{` and `Call` behind `}`. The gate now comes from
 * the first set resolved over the merged map, the one a choice arm's gate uses.
 */
import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, countSiteVisits, tableRules } from '../../src/table/assemble.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'
import { OP_GATE } from '../../src/table/ops.ts'
import type { Combinator } from '../../src/types.ts'
import { choice, composeLeaf, literal, many, node, regex, rules, sequence, trivia } from '../../src/index.ts'

type RuleMap = Record<string, Combinator<unknown>>

function emitted(prog: TableProgram): TableProgram {
  return { ...prog, asm: defaultAssemblyCfgs(prog).map(cfg => {
    const em = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
    return { key: cfgKey(cfg), factory, plan: em.plan, reached: [...em.reached] }
  }) }
}

const ws = trivia(regex(/[ ]*/))
const composed = composeLeaf([
  rules<RuleMap>({ trivia: ws }, () => ({ Atom: regex(/[a-z]+/) })),
  rules<RuleMap>({ trivia: ws }, g => ({
    Doc: many(choice(sequence(literal('-'), g.Box!), g.Semi!)),
    // The node's body starts with a rule of the OTHER piece.
    Box: node('Box', sequence(g.Atom!, literal('!'), g.Atom!), children => ({ n: children.length })),
    Semi: literal(';'),
  })),
]) as unknown as RuleMap
const map: RuleMap = {}
for (const k of Object.keys(composed)) map[k] = composed[k]!

describe('a node over a composed rule is gated on its resolved first set', () => {
  const prog = encodeTable(map, {})
  const boxSites = (() => {
    const c = countSiteVisits(prog, r => { run(r['Box'] as never, 'a ! b') })
    // The rule's entry and its gate are the guard, not the body.
    return [...c.keys()].filter(ip => c[ip]! > 0 && ip !== prog.rules['Box'] && prog.code[ip] !== OP_GATE)
  })()
  const visitsOfBox = (input: string): number => {
    const c = countSiteVisits(prog, r => { run(r['Doc'] as never, input) })
    return boxSites.reduce((n, ip) => n + c[ip]!, 0)
  }

  it('does not run the body at a character outside it', () => {
    expect(boxSites.length).toBeGreaterThan(0)
    // After `-` the sequence calls `Box` with nothing gating the call but the
    // node's own gate; at `;` it fails before any of the body runs.
    expect(visitsOfBox('- ;')).toBe(0)
  })

  it('runs it where the character admits it', () => {
    expect(visitsOfBox('- a ! b ;')).toBeGreaterThan(0)
  })

  it('parses as the interpreter does', () => {
    const closure = tableRules({ ...prog, asm: [] })['Doc']!
    const fast = tableRules(emitted(prog))['Doc']!
    for (const input of [';;', '- a ! b ;', '- a ! ;', '- ;', '- a b', '; - a ! b ; - x ! y']) {
      const want = run(map['Doc'] as never, input)
      expect(run(closure as never, input), input).toEqual(want)
      expect(run(fast as never, input), input).toEqual(want)
    }
  })
})
