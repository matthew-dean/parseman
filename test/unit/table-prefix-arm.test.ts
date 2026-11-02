/**
 * `choice(sequence(X, a), X)` inside a node: the first arm becomes
 * `sequence(X, optional(a))`, so an `X` with no `a` after it is parsed once
 * instead of twice (`factor-choice.ts` `factorPrefixArms`). The SCSS mixin
 * argument (`$name: v`, `v...`, `v`) is this shape.
 *
 * Every reader — reference `execRules`, closure and precompiled emitted
 * `tableRules` — must give the interpreter's whole RunResult over generated
 * argument lists, accepting and failing alike.
 *
 * Only a strict parse reads the factored arm (`OP_STRICT`). Tolerant recovery
 * and a completions probe run the choice as written: inside `sequence(X,
 * optional(a))`, `X`'s own recovery would take `a`'s first set for all that may
 * follow it, and `(a )` below recovered past its `)`.
 */
import { describe, expect, it } from 'vitest'
import { choice, literal, many, node, regex, rules, sepBy, sequence } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { countSiteVisits } from '../../src/table/assemble.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { OP_NODE, OP_STRICT } from '../../src/table/ops.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { readers, seeded } from '../helpers/table-readers.ts'

type Comb = Combinator<unknown>


const call = rules({ trivia: regex(/[ \t]+/) }, (g: Record<string, Comb>) => ({
  Call: sequence(regex(/[a-z]+/), literal('('), sepBy(g.Arg!, literal(',')), literal(')')),
  Arg: node('Arg', choice(
    sequence(literal('$'), regex(/[a-z]+/), literal(':'), g.Term!),
    sequence(g.Term!, literal('...')),
    g.Term!,
  ), children => ({ arg: children })),
  // A second argument shape whose next arm is NOT its prefix.
  Flag: node('Flag', choice(sequence(g.Word!, literal('!')), g.Num!), children => ({ flag: children })),
  Term: node('Term', many(choice(g.Word!, g.Num!, g.Flag!), { min: 1 }), children => ({ term: children })),
  Word: regex(/[a-z]+/),
  Num: regex(/[0-9]+/),
})) as Record<string, Comb>

/** Distinct generated inputs (468 of 513 with the seeded generator). */
const DISTINCT = 450
function inputs(): string[] {
  const rnd = seeded(11)
  const atom = (): string => [() => 'a', () => 'bc', () => String(rnd(99)), () => 'x!'][rnd(4)]!()
  const term = (): string => Array.from({ length: 1 + rnd(3) }, atom).join(' ')
  const arg = (): string => [() => term(), () => `${term()}...`, () => `$k: ${term()}`, () => `${term()} ...`][rnd(4)]!()
  const out = ['f()', 'f(a)', 'f(a...)', 'f($a: b)', 'f(a, b...)', 'f(a..)', 'f(a ...)', 'f($a b)', 'f(x!)', 'f(x)', 'f(1!)', 'f(', 'f(a,)']
  for (let i = 0; i < 250; i++) {
    const ok = `f(${Array.from({ length: 1 + rnd(3) }, arg).join(', ')})`
    out.push(ok)
    const at = rnd(ok.length)
    out.push([ok.slice(0, at), `${ok.slice(0, at)}.${ok.slice(at)}`, ok.slice(0, at) + ok.slice(at + 1)][rnd(3)]!)
  }
  return out
}

describe('an arm whose next sibling is its own prefix', () => {
  it('parses the shared term once when the rest is absent', () => {
    const prog = encodeTable(call)
    const term = Object.entries(prog.rules).find(([name]) => name === 'Term')![1]
    // The Term rule's node row, through its entry wrappers.
    let ip = term
    for (let n = 0; n < 6 && prog.code[ip] !== OP_NODE; n++) ip = prog.code[ip + 2]!
    expect(prog.code[ip]).toBe(OP_NODE)
    const counts = countSiteVisits(prog, rs => { run(rs.Call!, 'f(a, b, c)') })
    expect(counts[ip]).toBe(3)
  })

  it('keeps the choice as written for tolerant recovery', () => {
    const prog = encodeTable(call)
    expect([...reachableIps(prog)].filter(ip => prog.code[ip] === OP_STRICT).length).toBeGreaterThanOrEqual(1)
  })

  for (const tolerant of [false, true]) {
    it(`parses and fails as the interpreter does in every reader${tolerant ? ' (tolerant)' : ''}`, () => {
      const cases = [...new Set(inputs())]
      expect(cases.length).toBeGreaterThan(DISTINCT)
      const opts = tolerant ? { tolerant: true } : {}
      const want = cases.map(input => digestValue(run(call.Call!, input, opts)))
      for (const [name, entries] of readers(encodeTable(call))) {
        cases.forEach((input, i) => {
          expect(digestValue(run(entries.Call!, input, opts)), `${name} ${JSON.stringify(input)}`).toBe(want[i])
        })
      }
    }, 60_000)
  }

  it('recovers inside the prefix as the interpreter does', () => {
    // A repeat as the shared term: in the factored arm its recovery would see
    // only `...` after it, and swallow the `)` of `(a )`.
    const g = rules({ trivia: regex(/[ ]+/) }, (g: Record<string, Comb>) => ({
      Call: sequence(literal('('), sepBy(g.Arg!, literal(',')), literal(')')),
      Arg: node('Arg', choice(sequence(g.Term!, literal('...')), g.Term!), children => ({ arg: children })),
      Term: node('Term', many(regex(/[a-z]+/), { min: 1 }), children => ({ term: children })),
    })) as Record<string, Comb>
    for (const [name, entries] of readers(encodeTable(g))) {
      for (const input of ['(a )', '(a b )', '(a ...)', '(a, b )', '(a ..)', '(a !)', '(a , )', '( a)']) {
        for (const opts of [{ tolerant: true }, {}]) {
          expect(digestValue(run(entries.Call!, input, opts)), `${name} ${JSON.stringify(input)} ${JSON.stringify(opts)}`)
            .toBe(digestValue(run(g.Call!, input, opts)))
        }
      }
    }
  })
})
