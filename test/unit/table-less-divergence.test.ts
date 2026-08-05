import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import {
  classifiedTrivia, leaf, literal, many, node, noTrivia, oneOrMore, oneOrMoreSep, parser,
  peek, regex, rules, sepBy, sequence, type Combinator,
} from '../../src/index.ts'

/**
 * TWO DRIVER DEFECTS THAT ONLY THE LESS DIALECT EXPOSED.
 *
 * Measured over jess's four shipping grammars on their real corpora
 * (`bench/jess/divergence.ts`), the table lowering was tree-identical to the
 * interpreter on css (87 files), scss (400) and jess (3) — and diverged on 55
 * of the 136 Less fixtures: 30 SILENT WRONG TREES, 18 table-only throws, 7
 * other. Both causes are below, and neither was reachable by any test in this
 * suite: the whole suite was green with both defects live.
 *
 * The interpreter is the oracle in every case here, since it is the semantics
 * the other two engines are defined against.
 */

const ws = classifiedTrivia({ whitespace: regex(/[ \t\n\r\f]+/) })
const num = node('Num', regex(/[0-9]+/), (c: readonly unknown[]) => ({ t: 'Num', c }))

function both(map: Record<string, Combinator<unknown>>, rule: string, input: string): { interp: string; table: string } {
  const t = tableRules(encodeTable(map))[rule]!
  return {
    interp: JSON.stringify(run(map[rule] as never, input)),
    table: JSON.stringify(run(t as never, input)),
  }
}

describe('table driver — leaf() is a CAPTURE BOUNDARY, not a transform', () => {
  // `leaf()` suppresses its interior's own CST captures and exposes exactly ONE
  // leaf carrying the reducer's value (src/combinators/token.ts:89-127). OP_LEAF
  // ran the interior with the parent's sinks still live, so every interior
  // terminal leaked into the PARENT's `children`. Less is the only dialect that
  // calls `leaf()` at all, and it uses it for its arithmetic operators: the
  // spaced `+` in `1 + 1` leaked its whitespace and keyword terminals, moving
  // the enclosing reducer's arity. In the real grammar that surfaced as
  // "Less arithmetic grammar lost an operator operand" on 16 fixtures.
  const map = rules<Record<string, Combinator<unknown>>>(() => ({
    // The shape of `sumOperatorSpaced`: a padded operator reduced to the sign.
    Leafed: node('Leafed', noTrivia(sequence(num, leaf(noTrivia(sequence(regex(/ +/), literal('+'), regex(/ +/))), () => '+'), num)), (c: readonly unknown[]) => ({ n: c.length, c })),
  })) as unknown as Record<string, Combinator<unknown>>

  it('contributes exactly ONE child, whatever its interior matched', () => {
    // Three children — operand, the leaf's value, operand. Before the fix the
    // table produced FIVE, because the leaf's three interior terminals were
    // captured by the enclosing node instead of being suppressed.
    const table = tableRules(encodeTable(map)).Leafed!
    const v = run(table as never, '1 + 1').value as { n: number; c: unknown[] }
    expect(v.n).toBe(3)
    expect((v.c[1] as { _tag: string; value: unknown })._tag).toBe('leaf')
    expect((v.c[1] as { value: unknown }).value).toBe('+')
  })

  it('agrees with the interpreter on the whole outcome', () => {
    const { interp, table } = both(map, 'Leafed', '1 + 1')
    expect(table).toBe(interp)
  })
})

describe('table driver — who owns the trivia in front of a repeat\'s FIRST item', () => {
  // Only `many()` — min 0, no separator — runs its first item through `repItem`
  // and therefore skips leading trivia (src/combinators/repeat.ts:130-137).
  // `oneOrMore`/`atLeast` (:203) and `sepBy` (:412) parse the first item AT
  // `pos`; leading trivia there belongs to the ENCLOSING context. OP_REP skipped
  // it for every shape, so any `oneOrMore` whose body starts by MATCHING trivia
  // had that trivia eaten out from under it and failed.
  //
  // In Less that body is `classifiedTrivia` itself, reached through
  // `peek(whitespace)` in the value-continuation boundary — so every
  // space-separated declaration value (`color: red blue`, `margin: 1px 2px`)
  // stopped after its first piece and the whole ruleset silently vanished from
  // an otherwise-successful `Stylesheet`.

  it('oneOrMore over a trivia body still matches the trivia it stands on', () => {
    const map = rules<Record<string, Combinator<unknown>>>({ trivia: ws }, () => ({
      // `peek(classifiedTrivia)` — zero-width, but its body must see the space.
      Peek: peek(ws),
    })) as unknown as Record<string, Combinator<unknown>>
    const { interp, table } = both(map, 'Peek', ' 2')
    expect(table).toBe(interp)
    expect(run(tableRules(encodeTable(map)).Peek as never, ' 2').ok).toBe(true)
  })

  it('a space-separated value list keeps every piece', () => {
    const map = rules<Record<string, Combinator<unknown>>>({ trivia: ws }, (g: Record<string, Combinator<unknown>>) => ({
      Piece: num,
      // The shape of Less's `valueTriviaBoundary`: a trivia scope whose first
      // term PEEKS at trivia, under a `noTrivia` sequence.
      Cont: parser({ trivia: ws }, sequence(peek(ws), g.Piece!)),
      Seq: node('Seq', noTrivia(sequence(g.Piece!, many(g.Cont!))), (c: readonly unknown[]) => ({ n: c.length })),
    })) as unknown as Record<string, Combinator<unknown>>
    const table = tableRules(encodeTable(map)).Seq!
    expect((run(table as never, '1 2 3').value as { n: number }).n).toBe(3)
    expect(both(map, 'Seq', '1 2 3').table).toBe(both(map, 'Seq', '1 2 3').interp)
  })

  it('many() DOES own the trivia before its first item, and still does', () => {
    // The complement, so the fix cannot be "never skip". `many()` is the shape
    // the earlier trivia-log fix was derived from; it must keep skipping.
    const map = rules<Record<string, Combinator<unknown>>>({ trivia: ws }, () => ({
      Many: node('Many', many(num), (c: readonly unknown[]) => ({ n: c.length })),
    })) as unknown as Record<string, Combinator<unknown>>
    const table = tableRules(encodeTable(map)).Many!
    expect((run(table as never, '  1 2').value as { n: number }).n).toBe(2)
    expect(both(map, 'Many', '  1 2').table).toBe(both(map, 'Many', '  1 2').interp)
  })

  it('the mandatory first item of oneOrMore/sepBy is parsed at pos, not past trivia', () => {
    // Stated positively as a CONSUMPTION fact: leading trivia is the enclosing
    // context's, so a bare `oneOrMore`/`oneOrMoreSep` entered on trivia fails
    // where a `many` returns empty. All three engines agree on that; the table
    // did not.
    const map = rules<Record<string, Combinator<unknown>>>({ trivia: ws }, () => ({
      One: oneOrMore(num),
      Sep: oneOrMoreSep(num, literal(',')),
      Zero: sepBy(num, literal(',')),
    })) as unknown as Record<string, Combinator<unknown>>
    for (const [rule, input] of [['One', ' 1 2'], ['Sep', ' 1,2'], ['Zero', ' 1,2']] as const) {
      const { interp, table } = both(map, rule, input)
      expect(table, `${rule} on ${JSON.stringify(input)}`).toBe(interp)
    }
  })
})
