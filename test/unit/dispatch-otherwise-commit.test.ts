/**
 * `otherwise(p, { commit: false })`: the fallback of a `dispatch()` fails
 * uncommitted while its `when()` cases keep the dispatch cut.
 *
 * The shape is a statement whose name is read once: a call (`name(`) is a case
 * and commits, so a broken call stops the parse; anything else is the fallback,
 * and a statement no fallback arm reads ends the statement list, as it does when
 * each arm reads the name itself. Every reader — interpreter, reference
 * `execRules`, closure and precompiled emitted `tableRules` — and the macro's
 * evaluation of the same source must agree.
 */
import { describe, expect, it } from 'vitest'
import { parseSync } from 'oxc-parser'
import {
  choice, dispatch, endsWith, literal, many, node, otherwise, regex, routed, rules, sequence, when,
} from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource, EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import { evaluateExpr } from '../../src/plugin/evaluator.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'

type Comb = Combinator<unknown>

function readers(prog: TableProgram): ReadonlyArray<readonly [string, Record<string, Runnable>]> {
  const resolved = resolveTable(prog)
  const precompiled: PrecompiledAssembly[] = defaultAssemblyCfgs(prog).map(cfg => {
    const out = emitAssemblySource(resolved, prog, cfg, [])
    return {
      key: cfgKey(cfg),
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      factory: new Function(...EMITTED_PARAMS, out.source) as PrecompiledAssembly['factory'],
      plan: out.plan, reached: [...out.reached],
    }
  })
  return [
    ['reference', execRules(prog)],
    ['closure', tableRules({ ...prog, asm: [] })],
    ['emitted', tableRules({ ...prog, asm: precompiled })],
  ]
}

const name = regex(/[a-z]+/)
const value = regex(/[a-z0-9]+/)
const statement = (commit: boolean): Comb => dispatch(regex(/[a-z]+\(?/),
  when(endsWith('('), node('Call', sequence(routed(), value, literal(')'), literal(';')), c => ({ call: c[0] }))),
  otherwise(choice(
    node('Decl', sequence(routed(), literal(':'), value, literal(';')), c => ({ decl: c[0] })),
    node('Rule', sequence(routed(), literal('{'), literal('}')), c => ({ rule: c[0] })),
  ), commit ? undefined : { commit: false }))
const sheet = (commit: boolean): Record<string, Comb> => rules({ trivia: regex(/\s+/) }, (g: Record<string, Comb>) => ({
  Sheet: many(g.Statement!),
  Statement: statement(commit),
})) as Record<string, Comb>
// The name read by each arm: the uncommitted reference behaviour.
const perArm = rules({ trivia: regex(/\s+/) }, (g: Record<string, Comb>) => ({
  Sheet: many(g.Statement!),
  Statement: choice(
    node('Call', sequence(regex(/[a-z]+\(/), value, literal(')'), literal(';')), c => ({ call: c[0] })),
    node('Rule', sequence(name, literal('{'), literal('}')), c => ({ rule: c[0] })),
    node('Decl', sequence(name, literal(':'), value, literal(';')), c => ({ decl: c[0] })),
  ),
})) as Record<string, Comb>

const outcome = (r: ReturnType<typeof run>): string => r.ok
  ? `ok unconsumedFrom=${String(r.unconsumedFrom ?? null)}`
  : `FAIL at ${r.span.start} ${JSON.stringify(r.expected)}`

describe('otherwise(p, { commit: false })', () => {
  it('a fallback no arm reads ends the list; a broken call still stops the parse', () => {
    const loose = sheet(false)
    expect(outcome(run(loose.Sheet!, 'a{} b c{}'))).toBe(outcome(run(perArm.Sheet!, 'a{} b c{}')))
    expect(outcome(run(loose.Sheet!, 'a{} b c{}'))).toBe('ok unconsumedFrom=4')
    expect(outcome(run(loose.Sheet!, 'a{} f(x) c{}'))).toBe(outcome(run(sheet(true).Sheet!, 'a{} f(x) c{}')))
    expect(outcome(run(loose.Sheet!, 'a{} f(x) c{}'))).toBe('FAIL at 9 ["\\";\\""]')
    // The default keeps the cut on the fallback too.
    expect(outcome(run(sheet(true).Sheet!, 'a{} b c{}'))).toBe('FAIL at 4 ["\\":\\"","\\"{\\""]')
  })

  it('every table reader matches the interpreter, committed and not', () => {
    const inputs = ['a{} b c{}', 'a{} f(x) c{}', 'a{}', 'a:b;', 'f(x);', 'f(x)', 'a', 'a:', 'a{', '', 'a{} b:c; f(1); d{}', 'f(', '1']
    for (const commit of [true, false]) {
      const g = sheet(commit)
      for (const [label, entries] of readers(encodeTable(g))) {
        for (const input of inputs) {
          expect(digestValue(run(entries.Sheet!, input)), `${label} commit=${String(commit)} ${JSON.stringify(input)}`)
            .toBe(digestValue(run(g.Sheet!, input)))
        }
      }
    }
  })

  it('the macro evaluates the option, as the interpreter builds it', () => {
    const code = "const x = dispatch(regex(/[a-z]+/), when('a', literal('x')), otherwise(literal('y'), { commit: false }))"
    const ast = parseSync('t.ts', code)
    const init = (ast.program.body[0] as unknown as { declarations: { init: unknown }[] }).declarations[0]!.init
    const out = evaluateExpr(init as never, new Map() as never, code) as { _def?: { otherwiseCommit?: unknown } } | null
    expect(out?._def?.otherwiseCommit).toBe(false)
  })
})
