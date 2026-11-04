/**
 * A lookahead contains its child's commitment. The interpreter's `not()` and
 * `peek()` return a fresh result, so a committed failure inside the probe never
 * reaches the enclosing grammar (`not.ts`, `peek.ts`). The table engines carry
 * commitment on `ctx._fc` instead, and left it set after the probe: the next
 * ordinary failure in the same sequence read as committed. An ordered choice then
 * returned that failure without trying its next arm, and without restoring the
 * trivia logs the arm had written.
 */
import { describe, expect, it } from 'vitest'
import { attempt, choice, classifiedTrivia, dispatch, literal, not, peek, regex, rules, sequence, when } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'

type Comb = Combinator<unknown>
const t = classifiedTrivia({ ws: regex(/[ ]+/), comment: regex(/\/\*[^*]*\*\//) })
// `x`, then a lookahead whose child commits on `a` and fails at `Q`.
const committingProbe = (look: (p: Comb) => Comb): Comb =>
  sequence(literal('x'), look(dispatch(regex(/[a-z]/), when('a', sequence(literal('Q'))))), literal('a'), literal('z'))

const cases: Record<string, { doc: () => Comb; inputs: string[] }> = {
  'the next arm of a choice after not()': {
    doc: () => choice(committingProbe(not), sequence(literal('x'), literal('a'), literal('b'))),
    inputs: ['xab', 'xaz', 'xa'],
  },
  'the trivia logs of a contained attempt() after not()': {
    doc: () => choice(
      attempt(choice(committingProbe(not), sequence(literal('x'), literal('a'), literal('q'))), { contain: true }),
      sequence(literal('x'), literal('a'), literal('b')),
    ),
    inputs: ['x/*c*/ab', 'xab', 'x/*c*/aq'],
  },
  'the next arm of a choice after peek()': {
    doc: () => choice(
      sequence(literal('x'), peek(dispatch(regex(/[a-z]/), when('a', sequence(literal('Q'))))), literal('a')),
      sequence(literal('x'), literal('a'), literal('b')),
    ),
    inputs: ['xab', 'xaQ'],
  },
}

describe('a lookahead contains its child\'s commitment', () => {
  for (const [name, { doc, inputs }] of Object.entries(cases)) {
    it(`restores ${name} in every engine`, () => {
      const g = rules({ trivia: t }, () => ({ Doc: doc() })) as Record<string, Comb>
      const prog = encodeTable(g, { hostMode: 'ast' })
      const engines = {
        reference: execRules(prog).Doc!,
        closure: tableRules({ ...prog, asm: [] }).Doc!,
        emitted: tableRules(prog).Doc!,
      }
      const opts = { rootTrivia: { select: ['comment'] } }
      for (const input of inputs) {
        const want = run(g.Doc!, input, opts)
        for (const [engine, entry] of Object.entries(engines)) {
          const got = run(entry, input, opts)
          const at = `${engine} ${JSON.stringify(input)}`
          expect(got.ok, at).toBe(want.ok)
          expect(got.value, at).toEqual(want.value)
          expect(got.rootTrivia?.rows, at).toEqual(want.rootTrivia?.rows)
        }
      }
    })
  }
})
