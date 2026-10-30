/**
 * A choice that enters no arm fails with its own encoded expected set — the
 * arms' flatMap, `choiceFx` — as the pooled array itself. Rebuilding it set by
 * set produced an equal copy per failure: the `.r { }`-shaped miss paid an
 * allocation and one `accSet` per arm for an answer the table already holds.
 *
 * "No arm entered" here is the mask admitting arms whose scalar pretests then
 * reject them: `a` opens every arm and each arm's leading literal (behind its
 * node, deep enough to be pretested) misses on `ax`.
 */
import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { run } from '../../src/functional/run.ts'
import type { Combinator } from '../../src/types.ts'
import { choice, literal, node, rules, sequence } from '../../src/index.ts'

type RuleMap = Record<string, Combinator<unknown>>

function emitted(prog: TableProgram): TableProgram {
  return { ...prog, asm: defaultAssemblyCfgs(prog).map(cfg => {
    const em = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
    return { key: cfgKey(cfg), factory, plan: em.plan, reached: [...em.reached] }
  }) }
}

const two = rules<RuleMap>(g => ({
  Doc: choice(g.A!, g.B!),
  A: node('A', sequence(literal('ab'), literal('1'))),
  B: node('B', sequence(literal('ac'), literal('2'))),
}))
const many = rules<RuleMap>(g => ({
  Doc: choice(g.A!, g.B!, g.C!, g.D!, g.E!),
  A: node('A', sequence(literal('ab'), literal('1'))),
  B: node('B', sequence(literal('ac'), literal('2'))),
  C: node('C', sequence(literal('ad'), literal('3'))),
  D: node('D', sequence(literal('ae'), literal('4'))),
  E: node('E', sequence(literal('af'), literal('5'))),
}))

describe('a choice that enters no arm reports its pooled expected set', () => {
  for (const [name, g] of [['two arms', two], ['five arms', many]] as const) {
    const prog = encodeTable(g, {})
    const pool = resolveTable(prog).fx
    for (const [engine, table] of [['closure', { ...prog, asm: [] }], ['emitted', emitted(prog)]] as const) {
      it(`${name}, ${engine}`, () => {
        const ctx = createParseContext()
        const r = tableRules(table)['Doc']!('ax', 0, ctx) as { ok: boolean }
        expect(r.ok).toBe(false)
        expect(pool.includes(ctx._fx as string[])).toBe(true)
        expect(run(tableRules(table)['Doc'] as never, 'ax')).toEqual(run(g['Doc'] as never, 'ax'))
      })
    }
  }
})
