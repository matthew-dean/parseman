/**
 * THE DOCUMENT ROOT OWNS ITS TRAILING TRIVIA, and `run()` is what decides which
 * rule the document root is.
 *
 * The defect this pins is not "a byte was left over". It is a parse that
 * consumes NOTHING and reports `ok: true` — which is what a root whose body is a
 * repetition does on a comment-only file when nothing consumes the document's
 * trailing trivia: `many` matches zero items, the root matches zero-width, and
 * the driver reports success with `unconsumedFrom: 0`. Two of jess's four
 * shipping grammars set `node({ trailingTrivia })` on `Stylesheet` and two did
 * not; the two that did not lost 1626 of 2409 sass-spec inputs by exactly one
 * byte and one whole 124-byte `.jess` document by all of it, silently.
 *
 * Every assertion here is stated for BOTH engines, because the failure is
 * invisible in each of them alone.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, label, literal, many, node, oneOrMore, regex, rules, sequence, trivia,
} from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { run, type RunResult } from '../../src/functional/run.ts'
import type { Combinator } from '../../src/types.ts'

const rw = trivia(oneOrMore(choice(
  label('space', regex(/\s+/)),
  label('comment', regex(/\/\*[^]*?\*\//)),
)))

const grammar = rules({ trivia: rw }, (g: any) => ({
  Doc: node('Doc', many(g.Block)),
  Block: node('Block', sequence(literal('{'), many(literal('a')), literal('}'))),
}))

const table = execRules(encodeTable(grammar, {}))

/** The same question asked of the interpreter and of the table. */
function bothEngines(rule: 'Doc' | 'Block', input: string, options = {}): {
  interpreted: RunResult
  tabled: RunResult
} {
  return {
    interpreted: run(grammar[rule] as Combinator<unknown>, input, options),
    tabled: run(table[rule]!, input, options),
  }
}

function expectAgree(a: RunResult, b: RunResult): void {
  expect({ ok: b.ok, end: b.span.end, unconsumedFrom: b.unconsumedFrom })
    .toEqual({ ok: a.ok, end: a.span.end, unconsumedFrom: a.unconsumedFrom })
}

describe('run() — the entry rule owns the document\'s trailing trivia', () => {
  it('consumes a whole comment-only document instead of matching zero-width', () => {
    // THE REGRESSION. `benchmark.jess` is 124 bytes of comment; the root's body is
    // a repetition, so without this the run returns ok:true having consumed 0.
    const input = '/* a header comment, and nothing else */\n'
    const { interpreted, tabled } = bothEngines('Doc', input)
    expect(interpreted.ok).toBe(true)
    expect(interpreted.span.end).toBe(input.length)
    expect(interpreted.unconsumedFrom).toBe(null)
    expectAgree(interpreted, tabled)
  })

  it('consumes the trailing newline a text file ends with', () => {
    // 1626 of 2409 sass-spec inputs were short by exactly this one byte.
    const input = '{a}\n'
    const { interpreted, tabled } = bothEngines('Doc', input)
    expect(interpreted.span.end).toBe(4)
    expect(interpreted.unconsumedFrom).toBe(null)
    expectAgree(interpreted, tabled)
  })

  it('needs no `options.trivia`, and is unchanged when one is passed', () => {
    const input = '{a} /* EOF */'
    const auto = bothEngines('Doc', input)
    const explicit = bothEngines('Doc', input, { trivia: rw })
    expect(auto.interpreted.span.end).toBe(input.length)
    expect(auto.interpreted.unconsumedFrom).toBe(null)
    expectAgree(auto.interpreted, auto.tabled)
    expectAgree(auto.interpreted, explicit.interpreted)
    expectAgree(auto.interpreted, explicit.tabled)
  })

  it('still reports real leftover, and reports it AFTER the trivia', () => {
    const input = '{a} /* gap */ !junk'
    const { interpreted, tabled } = bothEngines('Doc', input)
    expect(interpreted.ok).toBe(true)
    expect(interpreted.unconsumedFrom).toBe(input.indexOf('!'))
    expectAgree(interpreted, tabled)
  })

  it('leaves an UNTERMINATED comment where it starts', () => {
    // The trivia rule does not match it, so it is leftover — not silently eaten.
    const input = '{a} /* never closed'
    const { interpreted, tabled } = bothEngines('Doc', input)
    // The space at 3 IS trivia; the comment is where the trivia rule stops.
    expect(interpreted.unconsumedFrom).toBe(input.indexOf('/*'))
    expectAgree(interpreted, tabled)
  })

  it('consumes nothing extra on a failed parse', () => {
    const { interpreted, tabled } = bothEngines('Block', '   ')
    expect(interpreted.ok).toBe(false)
    expect(interpreted.unconsumedFrom).toBe(null)
    expectAgree(interpreted, tabled)
  })

  it('is a property of the RUN, so the same rule is a root in one call and not in another', () => {
    // `Block` is referenced by `Doc` and is also a valid entry. Handed to `run()`
    // it is the document and owns the tail; reached THROUGH `Doc` it is an
    // interior rule and `Doc` — the document — owns it instead. Nothing is
    // stamped on the rule, so both are true of the same combinator object.
    const input = '{a}\n\n'
    const asRoot = bothEngines('Block', input)
    expect(asRoot.interpreted.span.end).toBe(input.length)
    expect(asRoot.interpreted.unconsumedFrom).toBe(null)
    expectAgree(asRoot.interpreted, asRoot.tabled)

    // Reached through `Doc`, `Block` contributes only `{a}` — the trailing gap is
    // never attributed to it. The node spans below are the proof; `run()` moved
    // the DOCUMENT's span, not any node's.
    const spans: Array<{ type: string; start: number; end: number }> = []
    const build = (
      type: string,
      _children: readonly unknown[] | undefined,
      _fields: unknown,
      span: { start: number; end: number },
    ) => {
      spans.push({ type, start: span.start, end: span.end })
      return { type }
    }
    const viaDoc = run(grammar.Doc as Combinator<unknown>, input, { build })
    expect(viaDoc.span.end).toBe(input.length)
    expect(spans).toEqual([
      { type: 'Block', start: 0, end: 3 },
      { type: 'Doc', start: 0, end: 3 },
    ])
  })

  it('does not touch a grammar with no ambient trivia', () => {
    const bare = rules((g: any) => ({
      Doc: node('Doc', many(g.Block)),
      Block: node('Block', sequence(literal('{'), literal('a'), literal('}'))),
    }))
    const bareTable = execRules(encodeTable(bare, {}))
    const input = '{a}\n'
    const a = run(bare.Doc as Combinator<unknown>, input)
    const b = run(bareTable.Doc!, input)
    expect(a.span.end).toBe(3)
    expect(a.unconsumedFrom).toBe(3)
    expectAgree(a, b)
  })
})
