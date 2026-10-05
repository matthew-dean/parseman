/**
 * A composed grammar reports the SAME expected set on every engine: the macro's
 * build-time table, runtime `compose()` (the linked interpreter) and `compile()` of
 * that composition.
 *
 * The macro used to evaluate each carried piece on its own and merge the maps by
 * name. Parsing bound a cross-piece `g.X` by name, so accept/reject agreed, but
 * everything the encoder DERIVED from the graph saw that `g.X` as an unresolved
 * thunk: a failure reported the bare rule name (`Num`) where every other engine
 * reported the token (`/[0-9]+/`), and treating the unresolved `g.Not` as possibly
 * empty added `"("`, a token the parse never required at that position.
 */
import { describe, it, expect } from 'vitest'
import * as P from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

const SRC = `import { rules, compose, sequence, literal, choice, regex, node, trivia } from 'parseman' with { type: 'macro' }
const ws = trivia(regex(/[ \\t]*/))
const base = rules({ trivia: ws }, (g) => ({
  Not: literal('not'),
  Ident: regex(/[a-z]+/),
  Num: node('Num', regex(/[0-9]+/), c => c),
}))
export const g = compose([base, rules({ trivia: ws }, (g) => ({
  Cond: sequence(literal('@'), choice(sequence(g.Not, literal('(')), g.Num)),
  Value: sequence(literal('='), choice(g.Num, g.Ident)),
}))])`

type Shape = { ok: boolean; at: number; expected: string[] }
const shape = (r: P.RunResult): Shape => ({
  ok: r.ok,
  at: r.ok ? r.span.end : r.span.start,
  expected: r.ok ? [] : [...r.expected].sort(),
})

describe('compose(): expected sets agree across engines', () => {
  const out = transformMacro(SRC, 'compose-expected-parity.ts', new Set(['parseman']))
  const macro = evalMacroModule<Record<string, P.Runnable>>(out!.code, 'g')
  const runtime = evalMacroModule<Record<string, P.Runnable>>(SRC, 'g', { ...P })
  const table = P.compile(runtime as Record<string, unknown>) as Record<string, P.Runnable>

  it.each([
    ['Cond', '@!', ['"not"', '/[0-9]+/']],
    ['Cond', '@not!', ['"("']],
    ['Value', '=!', ['/[0-9]+/', '/[a-z]+/']],
  ] as const)('%s on %j', (entry, input, expected) => {
    const r = shape(P.run(runtime[entry]!, input))
    expect(r.expected).toEqual(expected)
    expect(shape(P.run(macro[entry]!, input)), 'macro').toEqual(r)
    expect(shape(P.run(table[entry]!, input)), 'compile()').toEqual(r)
  })
})
