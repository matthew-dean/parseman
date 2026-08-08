/**
 * Compiler parity: for every input, compile(parser).parse(input) must equal
 * parser.parse(input, 0, ctx) — same ok/fail, same value, same span offsets.
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, choice, many, oneOrMore, optional, sepBy, transform, parser,
  label, withCtx, parse as runtimeParse, compile,
} from '../../src/index.ts'
import { trivia } from '../../src/combinators/map.ts'

function parity<T>(label: string, parser: ReturnType<typeof compile<T>> extends infer _ ? typeof compile<T> extends (p: infer P) => infer _ ? P : never : never, inputs: string[]) {
  const compiled = compile(parser)
  for (const input of inputs) {
    it(`${label} — ${JSON.stringify(input)}`, () => {
      const interpreted = runtimeParse(parser, input)
      const compiledResult = compiled.parse(input)
      expect(compiledResult.ok).toBe(interpreted.ok)
      if (interpreted.ok && compiledResult.ok) {
        expect(compiledResult.value).toEqual(interpreted.value)
        expect(compiledResult.span.start).toBe(interpreted.span.start)
        expect(compiledResult.span.end).toBe(interpreted.span.end)
      }
    })
  }
}

// Convenience: parity for a Combinator<T>
function par<T>(label: string, parser: import('../../src/index.ts').Combinator<T>, inputs: string[]) {
  const compiled = compile(parser)
  for (const input of inputs) {
    it(`${label} — ${JSON.stringify(input)}`, () => {
      const interpreted = runtimeParse(parser, input)
      const compiledResult = compiled.parse(input)
      expect(compiledResult.ok).toBe(interpreted.ok)
      if (interpreted.ok && compiledResult.ok) {
        expect(compiledResult.value).toEqual(interpreted.value)
        expect(compiledResult.span.start).toBe(interpreted.span.start)
        expect(compiledResult.span.end).toBe(interpreted.span.end)
      }
    })
  }
}

describe('literal — compiler parity', () => {
  par('exact match', literal('hello'), ['hello', 'world', 'hell', 'hello world'])
  par('single char', literal('x'), ['x', 'y', ''])
  par('case-insensitive', literal('GET', { caseInsensitive: true }), ['GET', 'get', 'Get', 'POST'])
  par('long string (>4 chars)', literal('Authorization'), ['Authorization', 'authorization', 'Auth'])
})

describe('regex — compiler parity', () => {
  par('digits', regex(/[0-9]+/), ['123', 'abc', '0', '99rest'])
  par('word chars', regex(/\w+/), ['hello', '123', '!@#'])
  par('optional group', regex(/foo(bar)?/), ['foo', 'foobar', 'baz'])
})

describe('sequence — compiler parity', () => {
  par('two lits', sequence(literal('hello'), literal(' world')), ['hello world', 'hello', 'goodbye'])
  par('lit + regex', sequence(literal('x='), regex(/[0-9]+/)), ['x=42', 'x=', 'y=42'])
  par('three parts', sequence(literal('('), regex(/[^)]+/), literal(')')), ['(hello)', '()', 'hello'])
})

describe('choice — compiler parity (disjoint)', () => {
  const p = choice(literal('apple'), literal('banana'), literal('cherry'))
  par('disjoint first chars', p, ['apple', 'banana', 'cherry', 'durian', 'ap'])
})

describe('choice — compiler parity (overlapping)', () => {
  const p = choice(literal('foo'), literal('far'), literal('baz'))
  par('overlapping first chars (f)', p, ['foo', 'far', 'baz', 'fob', 'bar'])
})

describe('many — compiler parity', () => {
  par('many lit', many(literal('ab')), ['ababab', 'ab', '', 'abx'])
  par('many regex', many(regex(/[0-9]/)), ['123', '', 'abc', '1a'])
})

describe('oneOrMore — compiler parity', () => {
  par('oneOrMore lit', oneOrMore(literal('a')), ['aaa', 'a', '', 'b', 'ab'])
})

describe('optional — compiler parity', () => {
  par('optional present', optional(literal('foo')), ['foo', 'bar', ''])
})

describe('sepBy — compiler parity', () => {
  par('comma-separated digits', sepBy(regex(/[0-9]+/), literal(',')), ['1,2,3', '42', '', 'a,b'])
})

describe('transform — compiler parity', () => {
  const p = transform(regex(/[0-9]+/), s => parseInt(s, 10))
  par('parse integer', p, ['42', '0', '999', 'abc'])
})

describe('sequence with transform — compiler parity', () => {
  const p = transform(
    sequence(literal('('), regex(/[^)]+/), literal(')')),
    ([, inner]) => inner.trim()
  )
  par('extract inner', p, ['(hello)', '( world )', '()invalid', 'nope'])
})

describe('HTTP request line — compiler parity', () => {
  const method = choice(
    literal('GET'), literal('POST'), literal('PUT'), literal('DELETE'),
    literal('PATCH'), literal('HEAD'), literal('OPTIONS')
  )
  const requestLine = transform(
    sequence(method, literal(' '), regex(/[^\s]+/), literal(' '), literal('HTTP/'), regex(/1\.[01]/), literal('\r\n')),
    ([m, , target, , , ver]) => ({ method: m, target, version: `HTTP/${ver}` })
  )
  par('request line', requestLine, [
    'GET / HTTP/1.1\r\n',
    'POST /api HTTP/1.0\r\n',
    'BREW / HTTP/1.1\r\n',
  ])
})

/**
 * REGRESSION: a `withCtx` whose INNER parser is MULTIPLY-REACHABLE self-aliased
 * into infinite recursion, and the symptom was a RangeError on ANY input.
 *
 * The source lowering wrapped the inner in a named function and pre-registered
 * `inner → thatFn` so other references reused it — then emitted the inner BODY
 * through the hoist wrapper, which re-found the pre-registration and emitted a
 * SELF-CALL whenever the inner was hoistable AND referenced twice or more.
 *
 * Only the BEHAVIOUR is kept here. The original file also asserted the emitted
 * function body's text, which pinned one engine's spelling of the fix rather
 * than the fix; this asks the question every lowering has to answer — does the
 * shape parse, and does it parse the same as the interpreter — through the
 * public `compile()`.
 */
describe('shared withCtx inner — compiler parity (self-alias regression)', () => {
  // A shared inner combinator (hoistable `choice`, big enough to hoist),
  // referenced from THREE positions: the withCtx wrapper plus two siblings.
  const shared = choice(literal('a'), literal('b'), literal('c'))
  const grammar = choice(
    withCtx({ inner: true }, shared),
    sequence(shared, literal('x')),
    sequence(shared, literal('y')),
  )
  par('multiply-referenced withCtx inner', grammar, ['a', 'bx', 'cy', 'z', ''])

  it('the raw shared inner behaves like the label()-wrapped workaround it replaced', () => {
    // The old workaround wrapped the shared inner in a transparent, non-hoistable
    // `label(...)` so the self-alias could not form. The RAW inner must behave
    // identically — that equivalence is what says the workaround is unneeded.
    const wrapped = choice(
      withCtx({ inner: true }, label('w', shared)),
      sequence(label('w', shared), literal('x')),
      sequence(label('w', shared), literal('y')),
    )
    const raw = compile(grammar)
    const viaLabel = compile(wrapped)
    for (const input of ['a', 'bx', 'cy', 'z']) {
      expect(raw.parse(input).ok, input).toBe(viaLabel.parse(input).ok)
    }
  })
})
