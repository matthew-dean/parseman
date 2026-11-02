/**
 * A `balanced()` that is a whole token is lowered as one lexical program over its
 * interpreted scan (`OP_LEX_PROGRAM`, `lexPrograms[id].scan`). The scan records a
 * `parseError` for an unclosed group, like `OP_SCAN` does, but the emitted
 * assembly's side-sink census counted only `OP_SCAN` as an `_errors` writer. So a
 * choice arm or `optional()` that failed after such a group kept the arm's rollback
 * mark but not its `_errors` half: the error of an arm that lost stayed on
 * `RunResult.errors`. The closure engine and the reference driver restore
 * `_errors` with every mark.
 */
import { describe, expect, it } from 'vitest'
import { balanced, choice, literal, optional, regex, rules, sequence } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_LEX_PROGRAM } from '../../src/table/ops.ts'
import { run } from '../../src/functional/run.ts'

type Comb = Combinator<unknown>

function emitted(prog: TableProgram): TableProgram {
  return { ...prog, asm: defaultAssemblyCfgs(prog).map(cfg => {
    const em = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
    return { key: cfgKey(cfg), factory, plan: em.plan, reached: [...em.reached] }
  }) }
}

const shapes: Record<string, (g: Record<string, Comb>) => Comb> = {
  choice: g => sequence(choice(sequence(g.Group!, literal('!')), literal('(')), regex(/.*/)),
  optional: g => sequence(optional(sequence(g.Group!, literal('!'))), regex(/.*/)),
}

describe('an unclosed balanced() group in a failed arm leaves no error behind', () => {
  for (const [name, shape] of Object.entries(shapes)) {
    it(`through ${name}() on every engine`, () => {
      const g = rules({}, (g: Record<string, Comb>) => ({ Doc: shape(g), Group: balanced('(', ')') })) as Record<string, Comb>
      const prog = encodeTable(g, { hostMode: 'ast' })
      expect([...reachableIps(prog)].some(ip => prog.code[ip] === OP_LEX_PROGRAM)).toBe(true)
      const engines = {
        reference: execRules(prog).Doc!,
        closure: tableRules({ ...prog, asm: [] }).Doc!,
        emitted: tableRules(emitted(prog)).Doc!,
      }
      for (const input of ['(x', '(x;', '(x)!', '(x)?']) {
        const want = run(g.Doc!, input)
        expect(want.ok, input).toBe(true)
        for (const [engine, entry] of Object.entries(engines)) {
          expect(run(entry, input), `${engine} ${JSON.stringify(input)}`).toEqual(want)
        }
      }
    })
  }
})
