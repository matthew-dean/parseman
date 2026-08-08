/**
 * A SITE SHARED BY TWO TRIVIA SCOPES.
 *
 * `site-labels.ts` computes each site's label as the MEET of what every parent
 * hands it, and the meet is load-bearing rather than merely conservative: the
 * emitted assembly lowers each site to ONE body, so a shared site labelled from
 * whichever parent happened to be walked first would carry a scan specialised for
 * a scope it does not always run in.
 *
 * Nothing pinned that. Replacing the meet with "first writer wins" passed all
 * 3318 tests, even though the meet demonstrably fires on fifteen assemblies
 * across the suite — the natural firings simply never put the over-specific
 * label somewhere its difference is observable.
 *
 * `inner` here is ONE combinator instance referenced twice, with no scope of its
 * own, so the encoder memoises it to a single site with two parents: the
 * grammar's ambient `ws` and an explicit `parser({ trivia: wsc })`. The two
 * differ on exactly one thing — whether a block comment is trivia — so a body
 * specialised for either scope gets the other one wrong.
 */
import { describe, it, expect } from 'vitest'
import {
  rules, parser, trivia, sequence, literal, oneOrMore, choice, regex, parse,
} from '../../src/index.ts'
// `index.ts:36` exports `compile` AS `compile`, so the public compiler IS
// the table — named here for what it is, since this test is about the emitter.
import { compile } from '../../src/table/compile.ts'
import type { Combinator, ParseResult } from '../../src/types.ts'

const ws = trivia(oneOrMore(regex(/[ \t\n]+/)))
const wsc = trivia(oneOrMore(choice(regex(/[ \t\n]+/), regex(/\/\*[^]*?\*\//))))

const end = (r: ParseResult<unknown>): number | 'FAIL' => (r.ok ? r.span.end : 'FAIL')

describe('a site reached from two different trivia scopes is labelled by the MEET', () => {
  const inner = sequence(literal('p'), literal('q'))
  const g = rules({ trivia: ws }, () => ({
    Doc: sequence(
      literal('x'),
      inner,
      literal('|'),
      parser({ trivia: wsc }, inner),
    ),
  })) as unknown as Record<string, Combinator<unknown>>

  /** The interpreter is the semantic reference; the table is what emits per site. */
  const all = (input: string): Record<string, number | 'FAIL'> => ({
    interpreted: end(parse(g.Doc!, input)),
    table: end(compile(g.Doc!).parse(input)),
  })

  const same = (v: number | 'FAIL'): Record<string, number | 'FAIL'> =>
    ({ interpreted: v, table: v })

  it('the wsc occurrence skips a comment the ws occurrence must reject', () => {
    // Second occurrence only: its scope admits the comment.
    expect(all('x pq | p/*c*/q')).toEqual(same(14))
    // First occurrence: the SAME site under `ws`, which does not.
    expect(all('x p/*c*/q | pq')).toEqual(same('FAIL'))
    // Neither occurrence carries a comment — the shape parses either way, so a
    // failure above is about the scope and not about the grammar.
    expect(all('x pq | pq')).toEqual(same(9))
  })
})
