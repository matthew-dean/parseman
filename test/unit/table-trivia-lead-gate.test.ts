/**
 * THE TRIVIA LEAD GATE: a skip at a character no trivia can start answers `cur`
 * without scanning, and a sequence term there takes no trivia marks.
 *
 * Both table engines carry it: the closure engine reads a per-slot table
 * (`trivia-gap.ts` `triviaLeadTable`), the emitted assembly prints the test into
 * its skips and terms (`emit-assembly.ts` `triviaMiss`). The reference driver
 * (`execRules`) has none, so it is the leg the other two answer to.
 *
 * Generated inputs put trivia (spaces, comments, a lone `/` that starts no
 * comment, non-ASCII) before and inside every construct, and every leg runs in
 * every way a gap is recorded: nothing, a root trivia log, a CST host capturing
 * trivia, line tracking. The whole `RunResult` must agree, root trivia included.
 *
 * `pnpm check:differentials` narrows each engine's lead set by its last range and
 * requires this file to go red.
 */
import { describe, expect, it } from 'vitest'
import { commentTrivia } from '../../bench/table-grammars.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
import { choice, classifiedTrivia, literal, many, node, noTrivia, optional, parser, regex, rules, sepBy, sequence, trivia as triviaOf } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'

type Grammar = Record<string, Combinator<unknown>>

/** Unlabelled, and non-nullable so its first set is finite (a nullable one has none). */
const plainTrivia = triviaOf(regex(/(?:[ \t\n\r]|\/\*(?:[^*]|\*(?!\/))*\*\/)+/))
/** A second slot, for a scope that changes the installed trivia. */
const underscores = classifiedTrivia({ space: regex(/[ _]+/) })

const grammar = (trivia: Combinator<unknown>): Grammar => rules<Grammar>({ trivia: trivia as never }, g => ({
  Doc: node('Doc', many(g.Item!), (c, _f, _s, raw, tl) => ({ doc: c, raw: raw.length, tl: [...tl] })),
  Item: choice(g.Call!, g.Pair!, g.Tight!, g.Word!),
  Call: node('Call', sequence(g.Name!, noTrivia(literal('(')), optional(sepBy(g.Word!, literal(','))), literal(')')),
    (c, _f, _s, _r, tl) => ({ call: c, tl: [...tl] })),
  Pair: node('Pair', sequence(literal('['), g.Word!, literal('='), g.Word!, literal(']')), c => ({ pair: c })),
  Name: regex(/[A-Z][a-z]*/),
  Word: node('Word', regex(/[a-zé]+/), c => ({ word: c })),
  // A scope with another trivia, so the gate follows a slot change.
  Tight: node('Tight', parser({ trivia: underscores as never }, sequence(literal('{'), many(g.Word!), literal('}'))), c => ({ tight: c })),
}))

const PIECES = ['Foo(a,b)', '[a=b]', 'word', 'é', 'Bar()', '{a_b}', '{ a _ b }']
const GAPS = ['', ' ', '  ', '/* c */', ' /* c */ ', '\n', '/']
function inputs(): string[] {
  const out: string[] = []
  for (const gap of GAPS) {
    for (const piece of PIECES) {
      out.push(`${gap}${piece}`, `${piece}${gap}`, `${piece}${gap}${piece}`)
      // Trivia inside the construct, at each place it may stand.
      out.push(piece.replace(/([(,=\]])/g, `${gap}$1${gap}`))
    }
  }
  out.push('Foo(a , /* x */ b)/', 'a /', '/* only */', '', 'Foo(')
  return out
}

const MODES: Record<string, Parameters<typeof run>[2]> = {
  plain: {},
  'root trivia': { rootTrivia: { select: ['comment'] } } as never,
  'trace lines': { trackLines: true } as never,
}

describe('the trivia lead gate', () => {
  for (const [name, trivia] of [['labelled', commentTrivia], ['unlabelled', plainTrivia]] as const) {
    it(`${name} trivia: closure and emitted agree with the reference driver`, () => {
      const g = grammar(trivia)
      const prog = encodeTable(g)
      const reference = execRules(prog).Doc!
      const closure = tableRules({ ...prog, asm: [] }).Doc!
      const { asm: _none, ...noAsm } = prog
      const emitted = tableRules(noAsm).Doc!
      let parsed = 0
      for (const [mode, opts] of Object.entries(MODES)) {
        if (name === 'unlabelled' && mode === 'root trivia') continue
        for (const input of inputs()) {
          const want = run(reference as never, input, opts)
          if (want.ok && want.unconsumedFrom === null) parsed++
          expect(digestValue(run(closure as never, input, opts)), `${mode} ${JSON.stringify(input)}: closure`).toBe(digestValue(want))
          expect(digestValue(run(emitted as never, input, opts)), `${mode} ${JSON.stringify(input)}: emitted`).toBe(digestValue(want))
        }
      }
      expect(parsed, 'inputs parsed whole').toBeGreaterThan(20)
      // The gate is live: this trivia has a finite first set.
      expect((trivia as Combinator<unknown>)._meta.firstSet.kind).toBe('ranges')
    })
  }

  it('a CST host capturing trivia: closure and emitted agree with the reference driver', () => {
    const g = grammar(commentTrivia)
    const prog = encodeTable(g, { hostMode: 'cst' })
    const reference = execRules(prog).Doc!
    const closure = tableRules({ ...prog, asm: [] }).Doc!
    const { asm: _none, ...noAsm } = prog
    const emitted = tableRules(noAsm).Doc!
    for (const input of inputs()) {
      const opts = { build: cstBuildHost() as never }
      const want = run(reference as never, input, opts)
      expect(digestValue(run(closure as never, input, opts)), `${JSON.stringify(input)}: closure`).toBe(digestValue(want))
      expect(digestValue(run(emitted as never, input, opts)), `${JSON.stringify(input)}: emitted`).toBe(digestValue(want))
    }
  })
})
