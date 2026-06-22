/**
 * Compiler parity: for every input, compile(parser).parse(input) must equal
 * parser.parse(input, 0, ctx) — same ok/fail, same value, same span offsets.
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, choice, many, oneOrMore, optional, sepBy, transform, grammar,
  parse as runtimeParse, compile,
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
