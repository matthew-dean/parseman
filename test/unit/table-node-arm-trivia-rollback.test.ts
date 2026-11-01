/**
 * A node that fails after its body scanned trivia leaves that trivia in the
 * trivia logs: the node drops its own capture frame, but `_triviaLog` and
 * `_rootTriviaLog` are not part of it. So a choice arm, an `optional()` or an
 * `attempt()` over such a node needs its rollback mark like any other child that
 * can fail after writing.
 *
 * The emitted assembly decides that mark from the encoder's census
 * (`mayLeavePartialCapture`), which counted every node as clean: the losing arm's
 * comment stayed in the root log and the winning arm recorded it again, so the
 * selected comment came back twice. The closure engine and the reference driver
 * kept the mark and were right. The emitted engine now restores the two trivia
 * logs alone for such a child (`choiceLogRollbackMask`, `failureLogRollback`):
 * its node frame already drops everything else. A program with no trivia takes
 * no such mark (`table-choice-rollback-elision.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import { attempt, choice, classifiedTrivia, literal, node, optional, regex, rules, sequence } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { mayLeavePartialCapture } from '../../src/analysis/commitment.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE } from '../../src/table/ops.ts'
import { choiceLogRollbackMask, choiceRollbackMask } from '../../src/table/program.ts'
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

const t = classifiedTrivia({ ws: regex(/[ ]+/), comment: regex(/\/\*[^*]*\*\//) })
// `Pair` reads `x`, then trivia, then fails at `y`: the comment is recorded and the node fails.
const shapes: Record<string, (g: Record<string, Comb>) => Comb> = {
  choice: g => sequence(choice(g.Pair!, literal('x')), literal('y')),
  optional: g => sequence(optional(g.Pair!), literal('x'), literal('y')),
  attempt: g => sequence(choice(attempt(g.Pair!), literal('x')), literal('y')),
}
const opts = { rootTrivia: { select: ['comment'] } }

describe('a failed node arm leaves no trivia rows behind', () => {
  it('counts a node as leaving what its body leaves where trivia can be recorded', () => {
    const pair = node('Pair', sequence(literal('x'), literal('a')))
    expect(mayLeavePartialCapture(pair, new Set(), true, true)).toBe(true)
    expect(mayLeavePartialCapture(node('Leaf', literal('x')), new Set(), true, true)).toBe(false)
    // A program with no trivia records no rows: the node's own frame is all it writes.
    expect(mayLeavePartialCapture(pair, new Set(), true, false)).toBe(false)
  })

  it('restores only the trivia logs for a node arm: its frame drops the rest', () => {
    const g = rules({ trivia: t }, (g: Record<string, Comb>) => ({
      Doc: shapes.choice!(g),
      Pair: node('Pair', sequence(literal('x'), literal('a')), children => ({ pair: children })),
    })) as Record<string, Comb>
    const prog = encodeTable(g, { hostMode: 'ast' })
    const at = [...reachableIps(prog)].find(ip => prog.code[ip] === OP_CHOICE)!
    expect(choiceRollbackMask(prog, at)).toBe(0)
    expect(choiceLogRollbackMask(prog, at)).toBe(1)
  })

  for (const [name, shape] of Object.entries(shapes)) {
    it(`records the comment once through ${name}() on every engine`, () => {
      const g = rules({ trivia: t }, (g: Record<string, Comb>) => ({
        Doc: shape(g),
        Pair: node('Pair', sequence(literal('x'), literal('a')), children => ({ pair: children })),
      })) as Record<string, Comb>
      const prog = encodeTable(g, { hostMode: 'ast' })
      const engines = {
        reference: execRules(prog).Doc!,
        closure: tableRules({ ...prog, asm: [] }).Doc!,
        emitted: tableRules(emitted(prog)).Doc!,
      }
      for (const input of ['x/*c*/y', 'x /*c*/ y']) {
        const want = run(g.Doc!, input, opts)
        expect(want.rootTrivia?.rows.length, input).toBe(5)
        for (const [engine, entry] of Object.entries(engines)) {
          const got = run(entry, input, opts)
          expect(got.rootTrivia?.rows, `${engine} ${JSON.stringify(input)}`).toEqual(want.rootTrivia?.rows)
          expect(got.value, `${engine} ${JSON.stringify(input)}`).toEqual(want.value)
        }
      }
    })
  }
})
