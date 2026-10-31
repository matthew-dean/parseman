/**
 * A call from the closure engine into a selective assembly's emitted body hands
 * the installed trivia scanner across only where that body reads the slot: a
 * body whose sites' labels name their trivia runs on that trivia's own scanner
 * (`site-labels.ts` `scanHandoffNeeded`). Where the labels cannot name it, the
 * handoff stays, and the parse is the closure engine's either way.
 */
import { describe, expect, it } from 'vitest'
import { choice, literal, many, noTrivia, parser, regex, rules, sequence, trivia } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'

const space = trivia(regex(/[ ]*/))
const under = trivia(regex(/[ _]*/))

/** One trivia for the whole map: every site's label names it. */
const oneTrivia = rules<Record<string, Combinator<unknown>>>({ trivia: space }, g => ({
  Doc: many(g.Item!),
  Item: choice(g.List!, g.Word!),
  List: sequence(literal('['), many(g.Item!), literal(']')),
  Word: sequence(regex(/[a-z]+/), many(sequence(literal(','), regex(/[a-z]+/)))),
}))
/** `Words` is reached under two trivias and none: its labels cannot name one. */
const sharedScopes = rules<Record<string, Combinator<unknown>>>({ trivia: space }, g => ({
  Doc: many(g.Item!),
  Item: choice(g.Loose!, g.Under!, g.Tight!, g.Words!),
  Loose: sequence(literal('('), many(g.Item!), literal(')')),
  Under: parser({ trivia: under }, sequence(literal('<'), many(g.Item!), literal('>'))),
  Tight: noTrivia(sequence(literal('['), many(g.Item!), literal(']'))),
  Words: sequence(g.W!, many(sequence(literal(','), g.W!))),
  W: regex(/[a-z]+/),
}))

/** Every other emitted site, as a build-time selective assembly; `calls.n` counts handoffs into it. */
function selective(prog: TableProgram, calls: { n: number }): TableProgram {
  const cfg = defaultAssemblyCfgs(prog)[0]!
  const all = [...emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true).siteBytes.keys()]
  const select = new Set(all.filter((_, i) => i % 2 === 0))
  const em = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true, select)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const inner = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
  const factory = ((...args: readonly unknown[]) => {
    const asm = inner(...args)
    const scan = asm.scan!
    return { ...asm, scan: (s: unknown) => { calls.n++; return scan(s as never) } }
  }) as EmittedFactory
  return { ...prog, asm: [{ key: cfgKey(cfg), factory, plan: em.plan, reached: [...em.reached] }] }
}

describe('scanner handoff into an emitted body', () => {
  const cases = [
    { name: 'one trivia', g: oneTrivia, inputs: ['a [b, c [d]] e', '[ [ ] ]', 'a,b', '[a'], handoffs: false },
    { name: 'shared scopes', g: sharedScopes, inputs: ['a, b (c <d _e> [f,g]) h', '(a', '<a _ b>'], handoffs: true },
  ]
  for (const c of cases) {
    it(`${c.name}: ${c.handoffs ? 'keeps' : 'drops'} the handoff, and parses as the closure engine`, () => {
      const prog = encodeTable(c.g as Record<string, Combinator<unknown>>, {})
      const closure = tableRules({ ...prog, asm: [] }).Doc!
      const calls = { n: 0 }
      const hybrid = tableRules(selective(prog, calls)).Doc!
      for (const input of c.inputs) {
        expect(run(hybrid as never, input), input).toEqual(run(closure as never, input))
      }
      if (c.handoffs) expect(calls.n).toBeGreaterThan(0)
      else expect(calls.n).toBe(0)
    })
  }
})
