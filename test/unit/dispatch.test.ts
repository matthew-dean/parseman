import { describe, expect, it } from 'vitest'
import {
  choice,
  compile,
  dispatch,
  expect as expectParser,
  literal,
  node,
  otherwise,
  parser,
  regex,
  sequence,
  trivia,
  when,
  type Combinator,
  type ParseContext,
} from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { assertEnginesAgree } from '../parity/helpers/engine-parity.ts'

type ParseFn = (input: string, pos: number, ctx: ParseContext) => unknown

function run<T>(parser: Combinator<T>, input: string) {
  return parser.parse(input, 0, { trackLines: false })
}

describe('dispatch()', () => {
  it('routes a parsed selector value to a matching when() tail', () => {
    const parser = dispatch(
      regex(/@[a-z]+/),
      when('@media', sequence(literal('{'), literal('}'))),
      otherwise(literal(';')),
    )

    expect(run(parser, '@media{}')).toEqual({
      ok: true,
      value: ['@media', ['{', '}']],
      span: { start: 0, end: 8 },
    })
  })

  it('takes otherwise() only for an unmatched selector value', () => {
    const parser = dispatch(
      regex(/@[a-z]+/),
      when('@media', sequence(literal('{'), literal('}'))),
      otherwise(literal(';')),
    )

    expect(run(parser, '@unknown;')).toEqual({
      ok: true,
      value: ['@unknown', ';'],
      span: { start: 0, end: 9 },
    })
  })

  it('fails at the selector end when there is no matching key and no otherwise()', () => {
    const parser = dispatch(
      regex(/@[a-z]+/),
      when('@media', literal('{')),
    )

    expect(run(parser, '@unknown;')).toEqual({
      ok: false,
      expected: ['"@media"'],
      span: { start: 8, end: 8 },
    })
  })

  it('does not commit when the selector itself fails', () => {
    const parser = choice(
      dispatch(literal('@media'), when('@media', literal('{'))),
      literal('@other'),
    )

    expect(assertEnginesAgree(parser, '@other')).toEqual({
      ok: true,
      value: '@other',
      span: { start: 0, end: 6 },
    })
  })

  it('commits a matched tail failure so an outer choice cannot fall through', () => {
    const parser = choice(
      dispatch(literal('@media'), when('@media', literal('{')), otherwise(literal(';'))),
      sequence(literal('@media'), literal('x')),
    )

    expect(assertEnginesAgree(parser, '@mediax')).toEqual({
      ok: false,
      expected: ['"{"'],
      span: { start: 6, end: 6 },
      committed: true,
    })
  })

  it('commits an otherwise() tail failure after the selector succeeds', () => {
    const parser = choice(
      dispatch(regex(/@[a-z]+/), when('@media', literal('{')), otherwise(literal(';'))),
      sequence(literal('@unknown'), literal('x')),
    )

    expect(assertEnginesAgree(parser, '@unknownx')).toEqual({
      ok: false,
      expected: ['";"'],
      span: { start: 9, end: 9 },
      committed: true,
    })
  })

  it('rolls back selected-tail captures before returning a committed failure', () => {
    const parser = sequence(
      node('Head', literal('@')),
      dispatch(
        literal('k'),
        when('k', sequence(
          node('Tail', literal('x')),
          literal('y'),
        )),
      ),
    )

    expect(assertEnginesAgree(parser, '@kxZ')).toEqual({
      ok: false,
      expected: ['"y"'],
      span: { start: 3, end: 3 },
      committed: true,
    })
  })

  it('rolls back selected-tail recovery errors before returning a committed failure', () => {
    const parser = dispatch(
      literal('k'),
      when('k', sequence(
        expectParser(literal('x'), '"x"'),
        literal('y'),
      )),
    )

    const interpretedErrors: unknown[] = []
    const interpreted = parser.parse('kz', 0, {
      trackLines: false,
      _errors: interpretedErrors,
    } as ParseContext)
    const compiled = compile(parser).parseWithErrors('kz')

    const expected = {
      ok: false,
      expected: ['"y"'],
      span: { start: 1, end: 1 },
      committed: true,
    }
    expect(interpreted).toEqual(expected)
    expect(interpretedErrors).toEqual([])
    expect(compiled).toEqual({ ...expected, errors: [] })
  })

  it('rolls back selected-tail trivia log entries before returning a committed failure', () => {
    const root = parser(
      { trivia: trivia(regex(/[ ]+/)) },
      dispatch(
        literal('k'),
        when('k', sequence(
          literal('x'),
          literal('y'),
        )),
      ),
    )

    const interpretedLog: number[] = []
    const compiledLog: number[] = []
    const interpreted = root.parse('kx z', 0, {
      trackLines: false,
      _triviaLog: interpretedLog,
    } as ParseContext)
    const compiled = compile(root).parseWithContext('kx z', {
      trackLines: false,
      _triviaLog: compiledLog,
    }, 0)

    const expected = {
      ok: false,
      expected: ['"y"'],
      span: { start: 3, end: 3 },
      committed: true,
    }
    expect(interpreted).toEqual(expected)
    expect(compiled).toEqual(expected)
    expect(interpretedLog).toEqual([])
    expect(compiledLog).toEqual([])
  })

  it('supports grouped and object-unfriendly string keys', () => {
    const parser = dispatch(
      regex(/(?:__proto__|constructor|default|a\.b\/c)/),
      when(['__proto__', 'constructor', 'default', 'a.b/c'], literal(':')),
    )

    for (const key of ['__proto__', 'constructor', 'default', 'a.b/c']) {
      expect(assertEnginesAgree(parser, `${key}:`)).toEqual({
        ok: true,
        value: [key, ':'],
        span: { start: 0, end: key.length + 1 },
      })
    }
  })

  it('supports an empty string key when the selector can produce it', () => {
    const parser = dispatch(literal(''), when('', literal(':')))

    expect(assertEnginesAgree(parser, ':')).toEqual({
      ok: true,
      value: ['', ':'],
      span: { start: 0, end: 1 },
    })
  })

  it('rejects duplicate keys, including duplicates across grouped cases', () => {
    expect(() => dispatch(literal('a'), when('a', literal('x')), when('a', literal('y'))))
      .toThrow('duplicate dispatch key')
    expect(() => dispatch(literal('a'), when(['a', 'b'], literal('x')), when('b', literal('y'))))
      .toThrow('duplicate dispatch key')
  })

  it('compile() lowers dispatch without runtime parser fallback', () => {
    const parser = dispatch(regex(/@[a-z]+/), when('@media', literal('{')), otherwise(literal(';')))
    const compiled = compile(parser)

    expect(compiled.source).not.toContain('_rp[')
    expect(compiled.parse('@media{')).toEqual({
      ok: true,
      value: ['@media', '{'],
      span: { start: 0, end: 7 },
    })
  })

  it('macro-lowers dispatch(), when(), and otherwise()', () => {
    const source = `
import { dispatch, literal, otherwise, when } from 'parseman' with { type: 'macro' }
const parser = dispatch(literal('@media'), when('@media', literal('{')), otherwise(literal(';')))
`.trim()
    const transformed = transformMacro(source, 'dispatch-macro.ts', new Set(['parseman']))!

    expect(transformed.code).not.toContain("from 'parseman'")
    expect(transformed.code).not.toMatch(/\bdispatch\s*\(/)
    expect(transformed.code).not.toMatch(/\bwhen\s*\(/)
    expect(transformed.code).not.toMatch(/\botherwise\s*\(/)

    const parser = new Function(`${transformed.code}\nreturn parser`)() as ParseFn
    expect(parser('@media{', 0, { trackLines: false })).toEqual({
      ok: true,
      value: ['@media', '{'],
      span: { start: 0, end: 7 },
    })
    expect(parser('@mediax', 0, { trackLines: false })).toEqual({
      ok: false,
      expected: ['"{"'],
      span: { start: 6, end: 6 },
      committed: true,
    })
  })

  it('macro-lowers factory-local when() and otherwise() aliases', () => {
    const source = `
import { dispatch, literal, otherwise, rules, transform, when } from 'parseman' with { type: 'macro' }
const grammar = rules(g => {
  const block = when('@media', transform(literal('{'), () => 'block'))
  const statement = otherwise(literal(';'))
  return { AtRule: dispatch(literal('@media'), block, statement) }
})
`.trim()
    const transformed = transformMacro(source, 'dispatch-arm-aliases.ts', new Set(['parseman']))!

    expect(transformed.code).not.toContain("from 'parseman'")
    expect(transformed.code).not.toMatch(/\bdispatch\s*\(/)
    expect(transformed.code).not.toMatch(/\bwhen\s*\(/)
    expect(transformed.code).not.toMatch(/\botherwise\s*\(/)

    const grammar = new Function(`${transformed.code}\nreturn grammar`)() as { AtRule: ParseFn }
    expect(grammar.AtRule('@media{', 0, { trackLines: false })).toEqual({
      ok: true,
      value: ['@media', 'block'],
      span: { start: 0, end: 7 },
    })
  })
})
