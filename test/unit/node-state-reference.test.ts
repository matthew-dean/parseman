/**
 * A builder that reads `state` receives the `ctx.state` active at that node: the
 * object itself, in every engine.
 *
 * Parseman never changes a state object (`withCtx` installs a new one for its
 * scope and restores the old one), so the object IS the state the node was parsed
 * under. Each engine used to hand the builder a shallow `Object.assign` copy:
 * one allocation per node that reads state, 11,285 per parse of jess's
 * `benchmark.less`, for a value equal to the original.
 */
import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'
import type { Combinator } from '../../src/types.ts'
import { literal, many, node, rules, sequence, withCtx } from '../../src/index.ts'

type RuleMap = Record<string, Combinator<unknown>>

function emitted(prog: TableProgram): TableProgram {
  return { ...prog, asm: defaultAssemblyCfgs(prog).map(cfg => {
    const em = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
    return { key: cfgKey(cfg), factory, plan: em.plan, reached: [...em.reached] }
  }) }
}

const inner = { depth: 1 }
const g = rules<RuleMap>(() => ({
  Doc: many(sequence(
    node('Outer', literal('a'), (_c, _f, _s, _r, _t, state) => ({ state })),
    withCtx(inner, node('Inner', literal('b'), (_c, _f, _s, _r, _t, state) => ({ state }))),
  )),
}))
const prog = encodeTable(g, { hostMode: 'ast' })
const engines: Record<string, unknown> = {
  interpreter: g.Doc,
  closure: tableRules({ ...prog, asm: [] }).Doc,
  emitted: tableRules(emitted(prog)).Doc,
  reference: execRules(prog).Doc,
}

describe('a builder reading state', () => {
  for (const [name, entry] of Object.entries(engines)) {
    it(`receives the active ctx.state itself (${name})`, () => {
      const state = { depth: 0 }
      const r = run(entry as never, 'abab', { state })
      expect(r.ok).toBe(true)
      const nodes = (r as { value: Array<Array<{ state: unknown }>> }).value.flat()
      expect(nodes).toHaveLength(4)
      expect(nodes[0]!.state).toBe(state)
      expect(nodes[1]!.state).toBe(inner)
      expect(nodes[2]!.state).toBe(state)
      expect(nodes[3]!.state).toBe(inner)
    })
  }
})
