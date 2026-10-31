/**
 * A lookahead between two gaps does not make its sequence scan the gap twice:
 * the gap before a `not()`/`peek()` is kept for the next term when that term
 * cannot match empty (`hold-gap.ts`). Both table engines; the parse is the one
 * the sequence made before.
 *
 * The trivia counts the gaps it consumes: its gate runs only after a match.
 */
import { describe, expect, it } from 'vitest'
import { gate, literal, node, not, optional, peek, regex, rules, sequence, trivia } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import type { TableProgram } from '../../src/table/program.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'

function grammar(counter: { n: number }): Record<string, Combinator<unknown>> {
  const ws = trivia(sequence(regex(/ +/), gate(() => { counter.n++; return true })))
  return rules({ trivia: ws }, (g: Record<string, Combinator<unknown>>) => ({
    // A word, a gap, a lookahead, the next word: the shape of a value run's boundary.
    Root: node('Pair', sequence(g.Word!, not(literal('!')), g.Word!, peek(regex(/[;]/)), literal(';'), optional(literal('?'))),
      children => ({ pair: children })),
    // A lookahead before a term that CAN match empty keeps the gap unconsumed.
    Tail: node('Tail', sequence(g.Word!, not(literal('!')), optional(literal('x'))), (children, _fields, span) => ({ tail: children, span })),
    Word: node('Word', regex(/[a-z]+/), children => ({ word: children[0] })),
  })) as Record<string, Combinator<unknown>>
}

function emittedOf(prog: TableProgram): TableProgram {
  const { asm: _none, ...rest } = prog
  return rest
}

describe('a gap held over a lookahead', () => {
  it('is consumed once per gap in both table engines', () => {
    const counter = { n: 0 }
    const prog = encodeTable(grammar(counter))
    for (const [engine, entry] of [['emitted', tableRules(emittedOf(prog)).Root!], ['closure', tableRules({ ...prog, asm: [] }).Root!]] as const) {
      counter.n = 0
      expect(run(entry as Runnable, 'a b ;').ok, engine).toBe(true)
      // The gap after `a` and the gap after `b`, once each.
      expect(counter.n, engine).toBe(2)
    }
  })

  it('parses what the reference and the interpreter parse', () => {
    const counter = { n: 0 }
    const g = grammar(counter)
    const prog = encodeTable(g)
    const reference = execRules(prog).Root!
    const engines = { emitted: tableRules(emittedOf(prog)).Root!, closure: tableRules({ ...prog, asm: [] }).Root! }
    for (const input of ['a b;', 'a b ;', 'a  b  ; ?', 'a !b;', 'a ! b;', 'a', 'a ', 'a b', 'a b x', ' a b;', 'a b;?', 'a b ;  ?']) {
      const ref = run(reference as Runnable, input)
      const i = run(g.Root!, input)
      expect(digestValue([i.ok, i.ok ? i.value : null, i.span]), `${input} interpreter`).toBe(digestValue([ref.ok, ref.ok ? ref.value : null, ref.span]))
      for (const [name, e] of Object.entries(engines)) expect(digestValue(run(e as Runnable, input)), `${input} ${name}`).toBe(digestValue(ref))
    }
    const tail = { reference: execRules(prog).Tail!, emitted: tableRules(emittedOf(prog)).Tail!, closure: tableRules({ ...prog, asm: [] }).Tail! }
    for (const input of ['a', 'a ', 'a x', 'a  x', 'a !', 'a !x']) {
      const ref = run(tail.reference as Runnable, input)
      for (const name of ['emitted', 'closure'] as const) expect(digestValue(run(tail[name] as Runnable, input)), `Tail ${input} ${name}`).toBe(digestValue(ref))
    }
  })
})
