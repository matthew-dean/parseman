/**
 * The reproduction, both engines: a `choice` whose EARLIER arm flattens the node
 * a LATER arm would have structured.
 *
 * Transcribed from a real Less grammar, where a "deferred scalar declaration"
 * fast path sat first in `Declaration` and matched the commonest shape of all —
 * a property with exactly one numeric value. The result was a CST in which
 * `margin: 0px` had no number node and `margin: 0px 0px` had two, so the editor
 * lint that reads those nodes fired on the two-value form and silently did not on
 * the one-value form. Nothing else reported it: both inputs PARSE, both spans are
 * right, both round-trip to the same text, and the compiled CSS is identical. The
 * shape is the only thing that moved.
 *
 * Two facts are asserted here, and the second is why the file lives in `parity/`:
 *
 *   1. ABSOLUTE — arm order alone decides whether the child nodes exist. Same
 *      grammar, same inputs; only the order of the two arms differs.
 *   2. PARITY — the interpreter and the compiled engine agree on it, wrongly and
 *      then rightly. A repro asserted on one engine would let the other drift,
 *      and this repo has shipped interpreter-only fixes twice.
 *
 * The whitespace assertion is the SECOND defect in the same production and is
 * deliberately not folded into the first: `noTrivia` + hand-written `optional(ws)`
 * does not merely re-implement trivia skipping, it changes what the whitespace IS.
 * Trivia is skipped and logged; a matched `regex(/\s+/)` is CONTENT, so the space
 * after the colon lands in the node's children as a value leaf.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, compile, cstBuildHost, literal, many, node, noTrivia, not, oneOrMore,
  optional, parser, regex, rules, run, sequence, trivia,
} from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'

const ws = trivia(regex(/[ \t\n]+/))
const rawWs = regex(/[ \t\n]+/)
const propName = regex(/[a-z-]+/)
const numeric = regex(/\d+(?:[a-z]+|%)?/)

type Arm = 'flat' | 'structured'

/** The grammar, parameterized ONLY by the order of the two `Declaration` arms. */
const build = (order: readonly [Arm, Arm]) => rules({ trivia: ws }, g => {
  const Dimension = node('Dimension', numeric)
  // The flattening fast path, spelled as the Less grammar spells it: `noTrivia`
  // around hand-written `optional(ws)`, a trailing `not()` boundary, and its own
  // `;`. Its body contains no `node()`, so the `Declaration` it builds has only
  // leaves under it.
  const FlatDecl = node('Declaration', noTrivia(sequence(
    propName, optional(rawWs), literal(':'), optional(rawWs),
    numeric, optional(rawWs), not(regex(/[^\s;}]/)), optional(literal(';')),
  )))
  const StructuredDecl = node('Declaration', sequence(
    propName, literal(':'), oneOrMore(g.Dimension), optional(literal(';')),
  ))
  const pick = (a: Arm): Combinator<unknown> => (a === 'flat' ? g.FlatDecl : g.StructuredDecl)
  const Declaration = choice(pick(order[0]), pick(order[1]))
  const Rule = node('Rule', sequence(regex(/[a-z]+/), literal('{'), many(g.Declaration), literal('}')))
  return { Dimension, FlatDecl, StructuredDecl, Declaration, Rule }
})

type CstChild = { _tag: 'node'; type: string; children: CstChild[] } | { _tag: 'leaf'; value: string }

const nodeTypes = (t: unknown): string[] => {
  const c = t as CstChild | null | undefined
  return c == null || c._tag !== 'node' ? [] : [c.type, ...c.children.flatMap(nodeTypes)]
}
const leafValues = (t: unknown): string[] => {
  const c = t as CstChild | null | undefined
  if (c == null) return []
  return c._tag === 'node' ? c.children.flatMap(leafValues) : [c.value]
}

/**
 * Run one input through BOTH engines with the CST host and assert they produced
 * the same tree, then return it for the absolute assertion. `compile()` bakes the
 * `rules({ trivia })` ambient, so both sides see the same grammar.
 */
function bothEngines(entry: Combinator<unknown>, input: string): unknown {
  const interpreted = run(entry, input, { build: cstBuildHost, trivia: ws })
  const compiled = compile(entry, undefined)
  const ctx = { trackLines: false, build: cstBuildHost }
  const emitted = compiled.parseWithContext(input, ctx, 0)

  expect(emitted.ok, `compiled must accept ${JSON.stringify(input)} like the interpreter`)
    .toBe(interpreted.ok)
  expect(emitted.ok && emitted.value, `compiled tree must equal interpreted for ${JSON.stringify(input)}`)
    .toEqual(interpreted.value)
  expect(interpreted.ok).toBe(true)
  return interpreted.value
}

const ONE_VALUE = 'a { margin: 0px; }'
const TWO_VALUES = 'a { margin: 0px 0px; }'

describe('an earlier choice arm that flattens what a later arm structures', () => {
  it('flat arm FIRST: the single-value input loses its child node, the multi-value one keeps its', () => {
    const g = build(['flat', 'structured'])

    // The bug, stated as an equality rather than a "does not contain": the two
    // inputs differ by one repeated value, and the trees differ by ALL structure.
    expect(nodeTypes(bothEngines(g.Rule, ONE_VALUE))).toEqual(['Rule', 'Declaration'])
    expect(nodeTypes(bothEngines(g.Rule, TWO_VALUES)))
      .toEqual(['Rule', 'Declaration', 'Dimension', 'Dimension'])
  })

  it('structured arm FIRST: both inputs keep their child nodes', () => {
    const g = build(['structured', 'flat'])

    expect(nodeTypes(bothEngines(g.Rule, ONE_VALUE)))
      .toEqual(['Rule', 'Declaration', 'Dimension'])
    expect(nodeTypes(bothEngines(g.Rule, TWO_VALUES)))
      .toEqual(['Rule', 'Declaration', 'Dimension', 'Dimension'])
  })

  it('the flattening arm also turns the space after the colon into a value leaf', () => {
    // `noTrivia` clears the ambient trivia; the hand-written `optional(ws)` that
    // puts the whitespace back MATCHES it, and a match is content. So the space
    // is a child of `Declaration`, indistinguishable from `0px` to any consumer
    // that reads the children — whereas the structured arm lets it stay trivia.
    const flatFirst = leafValues(bothEngines(build(['flat', 'structured']).Rule, ONE_VALUE))
    const structuredFirst = leafValues(bothEngines(build(['structured', 'flat']).Rule, ONE_VALUE))

    expect(flatFirst).toEqual(['a', '{', 'margin', ':', ' ', '0px', ';', '}'])
    expect(structuredFirst).toEqual(['a', '{', 'margin', ':', '0px', ';', '}'])
  })

  it('scoped trivia is the supported spelling of "whitespace here, but no comments"', () => {
    // The reason the grammar reached for `noTrivia` was to make COMMENTS
    // ineligible inside the declaration; the hand-written `optional(ws)` runs
    // were how it got whitespace back. `parser({ trivia })` expresses exactly
    // that in one place — an inner trivia scope, innermost wins — and because
    // the whitespace is trivia again it is skipped, not captured.
    const wsOnly = trivia(regex(/[ \t\n]+/))
    const wsOrComment = trivia(oneOrMore(choice(regex(/[ \t\n]+/), regex(/\/\*(?:[^*]|\*(?!\/))*\*\//))))
    const g = rules({ trivia: wsOrComment }, r => {
      const Dimension = node('Dimension', numeric)
      const Declaration = node('Declaration', parser({ trivia: wsOnly }, sequence(
        propName, literal(':'), oneOrMore(r.Dimension), optional(literal(';')),
      )))
      const Rule = node('Rule', sequence(regex(/[a-z]+/), literal('{'), many(r.Declaration), literal('}')))
      return { Dimension, Declaration, Rule }
    })

    // Structure kept on BOTH inputs, and the whitespace stays trivia — neither
    // an extra arm nor a hand-written `ws` run anywhere.
    expect(nodeTypes(bothEngines(g.Rule, ONE_VALUE)))
      .toEqual(['Rule', 'Declaration', 'Dimension'])
    expect(leafValues(bothEngines(g.Rule, ONE_VALUE)))
      .toEqual(['a', '{', 'margin', ':', '0px', ';', '}'])

    // The property the `noTrivia` wrapper was actually reaching for: a comment is
    // trivia OUTSIDE the declaration and not inside it. Innermost scope wins.
    expect(run(g.Rule, 'a { /*c*/ margin: 0px; }', { build: cstBuildHost }).ok).toBe(true)
    expect(run(g.Rule, 'a { margin: /*c*/ 0px; }', { build: cstBuildHost }).ok).toBe(false)
  })
})
