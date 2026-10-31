/**
 * A choice whose arms differ in one term scans what they share ONCE, then
 * dispatches on what follows it (`src/table/factor-choice.ts`) — in both table
 * engines — and parses exactly what the arms as written parse.
 *
 * The shape is a math run's operator: `leaf(noTrivia(sequence(gap, op, gap)))`
 * for each operator, where `gap` may be empty. On a run with no operator
 * (`a b`) every arm scanned the gap and then failed on its operator. A gate in
 * the shared prefix counts how often that prefix runs.
 */
import { describe, expect, it } from 'vitest'
import { choice, gate, keywords, leaf, literal, many, node, noTrivia, optional, regex, rules, sequence } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import type { TableProgram } from '../../src/table/program.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { buildGrammarPlan } from '../../src/compiler/grammar-coverage-ids.ts'

type Arm = { op: Combinator<unknown>; fn: (v: unknown) => unknown; src: string | undefined; tail?: Combinator<unknown> }

/**
 * A run of atoms joined by `arms`. Each arm is built separately, as a grammar
 * spells each operator: its own `gap`s, its own reducer, the reducer's printed
 * source when the arm has one (the macro evaluator sets it).
 */
function grammar(arms: Arm[], counter: { n: number }): Record<string, Combinator<unknown>> {
  const counted = gate(() => { counter.n++; return true })
  const operator = (a: Arm): Combinator<unknown> => {
    const l = leaf(noTrivia(sequence(optional(regex(/ +/)), counted, a.op, a.tail ?? optional(regex(/ +/)))), a.fn)
    if (a.src !== undefined) (l._def as { fnSrc?: string }).fnSrc = a.src
    return l
  }
  const ops = arms.map(operator) as [Combinator<unknown>, ...Combinator<unknown>[]]
  return rules((g: Record<string, Combinator<unknown>>) => ({
    // Space-separated runs, as a value's pieces are.
    Root: node('List', noTrivia(sequence(g.Run!, many(sequence(regex(/ +/), g.Run!)), optional(regex(/ +/)))),
      children => ({ list: children })),
    Run: node('Run', noTrivia(sequence(g.Atom!, many(sequence(choice(...ops), g.Atom!)))), children => ({ run: children })),
    Atom: node('Atom', regex(/[a-z0-9]+/), children => ({ atom: children[0] })),
  })) as Record<string, Combinator<unknown>>
}

const second = (v: unknown): unknown => (v as unknown[])[2]
const SRC = '(v) => v[2]'
const MATH: Arm[] = [
  { op: keywords(['*', '/', '%']), fn: second, src: SRC },
  { op: noTrivia(regex(/[-+]/)), fn: v => (v as unknown[])[2], src: SRC },
]

/** No precompiled assembly: `assemble` emits one. An empty inventory: it runs closures. */
function engines(prog: TableProgram): Record<string, Runnable> {
  const { asm: _none, ...emitted } = prog
  return {
    emitted: tableRules(emitted).Root!,
    closure: tableRules({ ...prog, asm: [] }).Root!,
    reference: execRules(prog).Root!,
  }
}

/** The same rule map encoded as written: a coverage plan keeps every arm as authored. */
function asWritten(g: Record<string, Combinator<unknown>>): TableProgram {
  const entries = Object.entries(g)
  return encodeTable(g, {
    coverage: buildGrammarPlan(entries.map(([, r]) => r), Object.fromEntries(entries.filter(([, r]) => r._def.tag !== 'lazy'))),
  })
}

describe('a choice whose arms differ in one term', () => {
  it('scans the shared gap once per operator position, in every table engine', () => {
    const counter = { n: 0 }
    const prog = encodeTable(grammar(MATH, counter))
    for (const [engine, rule] of Object.entries(engines(prog))) {
      counter.n = 0
      const r = run(rule, 'a b c')
      expect(r.ok, engine).toBe(true)
      // Two operator positions with a gap after the atom (after `a` and `b`); the
      // shared prefix runs once at each, not once per arm.
      expect(counter.n, engine).toBe(2)
    }
  })

  it('keeps arms whose reducers may differ as written', () => {
    const counter = { n: 0 }
    const unsourced: Arm[] = MATH.map(a => ({ ...a, src: undefined }))
    const prog = encodeTable(grammar(unsourced, counter))
    for (const [engine, rule] of Object.entries(engines(prog))) {
      counter.n = 0
      run(rule, 'a b c')
      expect(counter.n, engine).toBe(4)
    }
  })

  const variants: Record<string, Arm[]> = {
    math: MATH,
    // One reducer object for both arms: the same function needs no source.
    shared: MATH.map(a => ({ ...a, fn: second, src: undefined })),
    // Reducers that print differently stay apart.
    reducers: [MATH[0]!, { op: noTrivia(regex(/[-+]/)), fn: v => String((v as unknown[])[2]).repeat(2), src: '(v) => String(v[2]).repeat(2)' }],
    // Literal arms where one is a prefix of the next: declared order picks `+`.
    literals: [{ op: literal('+'), fn: second, src: SRC }, { op: literal('+='), fn: second, src: SRC }],
    // An arm whose differing term matches, then fails after it, must leave the
    // next arm its turn: `+` then `!` fails where `+=` then `!` matches.
    failing: [
      { op: regex(/\+/), fn: second, src: SRC, tail: literal('!') },
      { op: regex(/\+=/), fn: second, src: SRC, tail: literal('!') },
    ],
  }
  const inputs = ['a', 'a*b', 'a * b', 'a - b', 'a b', 'a  +  b * c', 'a *', 'a * ', '*', '', 'a-b', 'a+', 'a /b', 'a %c ',
    'a+!b', 'a+=!b', 'a +=! b', 'a+= b', 'a ++b']
  for (const [name, arms] of Object.entries(variants)) {
    it(`${name}: both engines parse what the arms as written parse`, () => {
      const g = grammar(arms, { n: 0 })
      const factored = engines(encodeTable(g))
      const written = engines(asWritten(g))
      for (const input of inputs) {
        const want = digestValue(run(written.reference!, input))
        for (const engine of ['emitted', 'closure', 'reference']) {
          expect(digestValue(run(written[engine]!, input)), `${input} ${engine} as written`).toBe(want)
          expect(digestValue(run(factored[engine]!, input)), `${input} ${engine} factored`).toBe(want)
        }
      }
    })
  }
})
