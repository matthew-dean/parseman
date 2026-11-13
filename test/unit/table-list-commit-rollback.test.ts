/**
 * A separated list with a minimum can fail even when its item cannot: short of a
 * minimum above one, or on a separator that commits a failure. Inside a contained
 * attempt that failure is ordinary, and the next arm reads the same input again,
 * so the engines must take back what the list's sequence captured before it.
 * `mayFail` read only the item for a `sepBy` with `min >= 1`, so the emitted
 * engine kept the leading `a` and the next arm captured it a second time.
 *
 * A plain repeat (`many`/`oneOrMore`) with a minimum above one has no such hole:
 * its mandatory items are attempted at every position, so an item that cannot
 * fail makes the repeat unable to fail. Those cases are pinned here too.
 */
import { describe, expect, it } from 'vitest'
import { attempt, choice, dispatch, literal, many, node, oneOrMore, optional, regex, routed, rules, sepBy, sequence, when } from '../../src/index.ts'
import { run } from '../../src/functional/run.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { readers } from '../helpers/table-readers.ts'
import type { Combinator } from '../../src/types.ts'

type Comb = Combinator<unknown>
// A separator that commits once it has read `foo`, and then fails without `!`.
const committingSep = (): Comb => sequence(literal(','), dispatch(regex(/[a-z]+/), when('foo', sequence(routed(), literal('!')))))
const grammar = (list: () => Comb): Record<string, Comb> => rules(() => ({
  R: node('N', choice(attempt(sequence(literal('a'), node('L', list())), { contain: true }), sequence(literal('a'), regex(/.*/)))),
})) as Record<string, Comb>

const observe = (r: ReturnType<typeof run>): unknown => ({ ok: r.ok, value: r.value, span: r.span, expected: [...r.expected].sort() })

function expectEveryEngine(list: () => Comb, inputs: readonly string[]): void {
  for (const input of inputs) {
    const want = observe(run(grammar(list).R!, input))
    for (const [engine, entry] of readers(encodeTable(grammar(list)))) {
      expect(observe(run(entry.R!, input)), `${engine} ${JSON.stringify(input)}`).toEqual(want)
    }
  }
}

const children = (list: () => Comb, input: string): unknown =>
  (run(grammar(list).R!, input).value as { children: Array<{ value?: unknown }> }).children.map(c => c.value)

describe('a separated list with a minimum takes back its captures in every engine', () => {
  const cases: Record<string, { list: () => Comb; inputs: string[] }> = {
    'a min-1 list whose separator commits': {
      list: () => sepBy(optional(literal('x')), committingSep(), { min: 1 }),
      inputs: ['ax,foo', 'ax,foo!', 'ax'],
    },
    'a min-2 list short of its minimum': {
      list: () => sepBy(optional(literal('x')), literal(','), { min: 2 }),
      inputs: ['ax', 'ab', 'ax,', 'ax,x'],
    },
    'a min-2 list whose separator commits': {
      list: () => sepBy(optional(literal('x')), committingSep(), { min: 2 }),
      inputs: ['ax,foo', 'ax', 'ax,foo!'],
    },
  }
  for (const [name, { list, inputs }] of Object.entries(cases)) {
    it(`restores ${name}`, () => expectEveryEngine(list, inputs))
  }

  it('reads the input once in the arm that matched', () => {
    // Asserted directly: the next arm sees `a` once, as the interpreter does.
    expect(children(cases['a min-1 list whose separator commits']!.list, 'ax,foo')).toEqual(['a', 'x,foo'])
    expect(children(cases['a min-2 list short of its minimum']!.list, 'ax')).toEqual(['a', 'x'])
  })

  it('agrees on a plain repeat with a minimum above one, which cannot fail on a total item', () => {
    expectEveryEngine(() => many(optional(literal('x')), { min: 2 }), ['ax', 'ab', 'axx'])
    expectEveryEngine(() => oneOrMore(optional(literal('x')), { min: 3 }), ['ax', 'ab'])
  })
})
