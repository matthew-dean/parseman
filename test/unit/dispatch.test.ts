import { describe, expect, it } from 'vitest'
import { tableRules } from '../../src/table/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'
import {
  attempt,
  choice,
  dispatch,
  endsWith,
  expect as expectParser,
  field,
  literal,
  makeWhen,
  matches,
  many,
  node,
  oneOrMore,
  optional,
  otherwise,
  parser,
  regex,
  routed,
  rules,
  sepBy,
  sequence,
  startsWith,
  token,
  transform,
  trivia,
  when,
  withCtx,
  type Combinator,
  type ParseContext,
  type ParseError,
} from '../../src/index.ts'
import { compileTable as compile } from '../../src/table/compile.ts'
import { compileRuleMapTable as compileRuleMap } from '../../src/table/compile-rule-map.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { assertEnginesAgree } from '../parity/helpers/engine-parity.ts'

type ParseFn = (input: string, pos: number, ctx: ParseContext) => unknown

function run<T>(parser: Combinator<T>, input: string) {
  return parser.parse(input, 0, { trackLines: false })
}

function expectEnginesResult<T>(parser: Combinator<T>, input: string, expected: unknown): void {
  expect(run(parser, input)).toEqual(expected)
  expect(compile(parser).parse(input)).toEqual(expected)
}

describe('dispatch()', () => {
  it('routes a parsed value to a matching when() tail', () => {
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

  it('takes otherwise() only for an unmatched value', () => {
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

  it('fails at the routed value end when there is no matching key and no otherwise()', () => {
    const parser = dispatch(
      regex(/@[a-z]+/),
      when('@media', literal('{')),
    )

    expect(assertEnginesAgree(parser, '@unknown;')).toEqual({
      ok: false,
      expected: ['"@media"'],
      span: { start: 8, end: 8 },
    })
  })

  it('does not commit when the first combinator itself fails', () => {
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

  it('commits an otherwise() tail failure after the first combinator succeeds', () => {
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

  it('propagates matched tail commitment through swallowing combinators', () => {
    const matchedTail = () => dispatch(literal('k'), when('k', literal('x')))
    const expected = {
      ok: false,
      expected: ['"x"'],
      span: { start: 1, end: 1 },
      committed: true,
    }

    const entries: Combinator<unknown>[] = [
      many(matchedTail()),
      oneOrMore(matchedTail()),
      optional(matchedTail()),
      attempt(matchedTail()),
      sepBy(matchedTail(), literal(',')),
    ]

    for (const entry of entries) {
      expect(assertEnginesAgree(entry, 'kq')).toEqual(expected)
    }
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

  it('does not leak recovered tail commitment into an enclosing choice fallback', () => {
    const parser = choice(
      sequence(
        expectParser(
          dispatch(
            literal('k'),
            when('k', literal('x')),
          ),
          'dispatch tail',
        ),
        literal('z'),
      ),
      literal('kq'),
    )

    expect(assertEnginesAgree(parser, 'kq', { recovery: true })).toEqual({
      ok: true,
      value: 'kq',
      span: { start: 0, end: 2 },
    })
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

  it('routes case-insensitive when() keys while preserving the authored routed value', () => {
    const parser = dispatch(
      regex(/@[A-Za-z-]+/),
      when('@media', literal('{'), { caseInsensitive: true }),
      otherwise(literal(';')),
    )

    expect(assertEnginesAgree(parser, '@MEDIA{')).toEqual({
      ok: true,
      value: ['@MEDIA', '{'],
      span: { start: 0, end: 7 },
    })
  })

  it('supports grouped case-insensitive keys', () => {
    const parser = dispatch(
      regex(/@[A-Za-z-]+/),
      when(['@media', '@supports'], literal('{'), { caseInsensitive: true }),
      otherwise(literal(';')),
    )

    expect(assertEnginesAgree(parser, '@SUPPORTS{')).toEqual({
      ok: true,
      value: ['@SUPPORTS', '{'],
      span: { start: 0, end: 10 },
    })
  })

  it('supports makeWhen() for repeated dispatch arm options', () => {
    const atCase = makeWhen({ caseInsensitive: true })
    const parser = dispatch(
      regex(/@[A-Za-z-]+/),
      atCase('@media', literal('{')),
      atCase('@scope', literal('(')),
      otherwise(literal(';')),
    )

    expect(assertEnginesAgree(parser, '@SCOPE(')).toEqual({
      ok: true,
      value: ['@SCOPE', '('],
      span: { start: 0, end: 7 },
    })
  })

  it('routes glued CSS function openers by exact full returned value', () => {
    const fnCase = makeWhen({ caseInsensitive: true })
    const cssIdent = regex(/[A-Za-z-]+/)
    const functionOpen = token(sequence(cssIdent, literal('(')))
    const parser = dispatch(
      functionOpen,
      fnCase('url(', literal('raw')),
      fnCase('calc(', literal('math')),
      when(endsWith('('), literal('generic')),
    )

    expectEnginesResult(parser, 'URL(raw', {
      ok: true,
      value: ['URL(', 'raw'],
      span: { start: 0, end: 7 },
    })
    expectEnginesResult(parser, 'url (raw', {
      ok: false,
      expected: ['"("'],
      span: { start: 3, end: 3 },
    })
    expectEnginesResult(parser, 'urlx(generic', {
      ok: true,
      value: ['urlx(', 'generic'],
      span: { start: 0, end: 12 },
    })
  })

  it('splits glued functions before keyword parsing', () => {
    const fnCase = makeWhen({ caseInsensitive: true })
    const cssIdent = regex(/[A-Za-z-]+/)
    const identOrFunctionOpen = token(sequence(cssIdent, optional(literal('('))))
    const identOrFunctionValue = dispatch(
      identOrFunctionOpen,
      fnCase('url(', literal('raw')),
      fnCase('calc(', literal('math')),
      fnCase('var(', literal('var')),
      when(endsWith('('), literal('generic')),
      otherwise(transform(literal(''), () => 'keyword')),
    )

    expectEnginesResult(identOrFunctionValue, 'url', {
      ok: true,
      value: ['url', 'keyword'],
      span: { start: 0, end: 3 },
    })
    expectEnginesResult(identOrFunctionValue, 'URL(raw', {
      ok: true,
      value: ['URL(', 'raw'],
      span: { start: 0, end: 7 },
    })
    expectEnginesResult(identOrFunctionValue, 'foo(generic', {
      ok: true,
      value: ['foo(', 'generic'],
      span: { start: 0, end: 11 },
    })
    expectEnginesResult(identOrFunctionValue, 'foo (', {
      ok: true,
      value: ['foo', 'keyword'],
      span: { start: 0, end: 3 },
    })
    expectEnginesResult(identOrFunctionValue, 'URL(nope', {
      ok: false,
      expected: ['"raw"'],
      span: { start: 4, end: 4 },
      committed: true,
    })
  })

  it('splits pseudo names and pseudo-function openers in one lexical dispatch', () => {
    const pseudoCase = makeWhen({ caseInsensitive: true })
    const pseudoName = regex(/[A-Za-z-]+/)
    const pseudoHead = token(sequence(choice(literal('::'), literal(':')), pseudoName, optional(literal('('))))
    const pseudo = dispatch(
      pseudoHead,
      pseudoCase(':is(', literal('selector')),
      pseudoCase(':nth-child(', literal('An+B')),
      pseudoCase('::part(', literal('ident')),
      when(endsWith('('), literal('generic-function')),
      otherwise(transform(literal(''), () => 'bare')),
    )

    expectEnginesResult(pseudo, ':Hover', {
      ok: true,
      value: [':Hover', 'bare'],
      span: { start: 0, end: 6 },
    })
    expectEnginesResult(pseudo, ':IS(selector', {
      ok: true,
      value: [':IS(', 'selector'],
      span: { start: 0, end: 12 },
    })
    expectEnginesResult(pseudo, '::PART(ident', {
      ok: true,
      value: ['::PART(', 'ident'],
      span: { start: 0, end: 12 },
    })
    expectEnginesResult(pseudo, ':unknown(generic-function', {
      ok: true,
      value: [':unknown(', 'generic-function'],
      span: { start: 0, end: 25 },
    })
    expectEnginesResult(pseudo, ':nth-child(generic-function', {
      ok: false,
      expected: ['"An+B"'],
      span: { start: 11, end: 11 },
      committed: true,
    })
  })

  it('lets branch nodes own the routed value without reparsing it', () => {
    const fnCase = makeWhen({ caseInsensitive: true })
    const cssIdent = regex(/[A-Za-z-]+/)
    const identOrFunction = token(sequence(cssIdent, optional(literal('('))))
    const urlTail = literal('raw')
    const genericTail = literal('generic')
    const UrlFunction = node('UrlFunction',
      sequence(routed(), urlTail, literal(')')),
      children => ({
        type: 'UrlFunction',
        name: (children[0] as { value: string }).value.slice(0, -1),
        value: (children[1] as { value: string }).value,
      }))
    const GenericFunction = node('Function',
      sequence(routed(), genericTail, literal(')')),
      children => ({
        type: 'Function',
        name: (children[0] as { value: string }).value.slice(0, -1),
        value: (children[1] as { value: string }).value,
      }))
    const Identifier = node('Identifier',
      routed(),
      children => ({
        type: 'Identifier',
        name: (children[0] as { value: string }).value,
      }))
    const Value = dispatch(
      identOrFunction,
      fnCase('url(', UrlFunction),
      when(endsWith('('), GenericFunction),
      otherwise(Identifier),
    )

    expect(assertEnginesAgree(Value, 'URL(raw)')).toEqual({
      ok: true,
      value: ['URL(', { type: 'UrlFunction', name: 'URL', value: 'raw' }],
      span: { start: 0, end: 8 },
    })
    expect(assertEnginesAgree(Value, 'foo(generic)')).toEqual({
      ok: true,
      value: ['foo(', { type: 'Function', name: 'foo', value: 'generic' }],
      span: { start: 0, end: 12 },
    })
    expect(assertEnginesAgree(Value, 'url')).toEqual({
      ok: true,
      value: ['url', { type: 'Identifier', name: 'url' }],
      span: { start: 0, end: 3 },
    })
  })

  it('detects routed() through rules() refs before selecting the branch start', () => {
    const grammar = rules((g: { Branch: Combinator<unknown> }) => ({
      Value: dispatch(
        literal('a'),
        when('a', g.Branch),
      ),
      Branch: sequence(routed(), literal('!')),
    }))

    expectEnginesResult(grammar.Value, 'a!', {
      ok: true,
      value: ['a', ['a', '!']],
      span: { start: 0, end: 2 },
    })
  })

  it('keeps private single-use rules() branch refs on routed locals', () => {
    const identOrFunction = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
    type ValueGrammar = {
      Value: Combinator<unknown>
      UrlFunction: Combinator<unknown>
      Identifier: Combinator<unknown>
    }
    const grammar = rules((g: ValueGrammar) => ({
      Value: dispatch(
        identOrFunction,
        when('url(', g.UrlFunction, { caseInsensitive: true }),
        otherwise(g.Identifier),
      ),
      UrlFunction: node('UrlFunction',
        sequence(routed(), literal('raw'), literal(')')),
        children => ({
          type: 'UrlFunction',
          opener: (children[0] as { value: string }).value,
          name: (children[0] as { value: string }).value.slice(0, -1),
          value: (children[1] as { value: string }).value,
        })),
      Identifier: node('Identifier',
        routed(),
        children => ({
          type: 'Identifier',
          name: (children[0] as { value: string }).value,
        })),
    }))

    expectEnginesResult(grammar.Value, 'URL(raw)', {
      ok: true,
      value: ['URL(', { type: 'UrlFunction', opener: 'URL(', name: 'URL', value: 'raw' }],
      span: { start: 0, end: 8 },
    })
    expectEnginesResult(grammar.Value, 'url', {
      ok: true,
      value: ['url', { type: 'Identifier', name: 'url' }],
      span: { start: 0, end: 3 },
    })
  })

  it('bridges routed() through named rule-map refs', () => {
    type ValueGrammar = {
      Value: Combinator<unknown>
      Branch: Combinator<unknown>
    }
    const grammar = rules((g: ValueGrammar) => ({
      Value: dispatch(
        literal('a'),
        when('a', g.Branch),
      ),
      Branch: sequence(routed(), literal('!')),
    }))

    const compiled = compileRuleMap(Object.entries(grammar))
    expect(compiled).not.toBeNull()
    if (compiled === null) return
    expect(compiled.replacement).toContain('_ctx._routed')
    const compiledRules = new Function('tableRules', `return ${compiled!.replacement}`)(tableRules) as Record<string, ParseFn>
    expect(compiledRules.Value?.('a!', 0, { trackLines: false })).toEqual({
      ok: true,
      value: ['a', ['a', '!']],
      span: { start: 0, end: 2 },
    })
  })

  it('rolls back selector side effects when routed branches own the selected span', () => {
    const root = parser(
      { trivia: trivia(regex(/[ ]+/)) },
      dispatch(
        field('head', transform(sequence(literal('a'), literal('b')), () => 'ab')),
        when('ab', sequence(routed(), literal('!'))),
      ),
    )

    const interpretedLog: number[] = []
    const interpretedFields: NonNullable<ParseContext['_fields']> = []
    const interpreted = root.parse('a b!', 0, {
      trackLines: false,
      _triviaLog: interpretedLog,
      _fields: interpretedFields,
    } as ParseContext)
    const compiledLog: number[] = []
    const compiledFields: NonNullable<ParseContext['_fields']> = []
    const compiled = compile(root).parseWithContext('a b!', {
      trackLines: false,
      _triviaLog: compiledLog,
      _fields: compiledFields,
    }, 0)

    const expected = {
      ok: true,
      value: ['ab', ['ab', '!']],
      span: { start: 0, end: 4 },
    }
    expect(interpreted).toEqual(expected)
    expect(compiled).toEqual(expected)
    expect(interpretedLog).toEqual([])
    expect(compiledLog).toEqual([])
    expect(interpretedFields).toEqual([])
    expect(compiledFields).toEqual([])
  })

  it('rolls back selector CST, trivia, field, and error sinks before compiled routed branches', () => {
    const selector: Combinator<string> = {
      _tag: 'leakingSelector',
      _meta: { firstSet: { kind: 'any' }, canMatchNewline: false, isTrivia: false },
      _def: { tag: 'unknown' },
      parse(_input: string, pos: number, ctx: ParseContext) {
        const span = { start: pos, end: pos + 2 }
        ctx._cstLeaves?.push({ _tag: 'leaf', value: 'selector-leaf-leak', span })
        ctx._cstRawChildren?.push({ _tag: 'leaf', value: 'selector-raw-leak', span })
        ctx._cstTriviaLog?.push(pos, pos + 1, 0)
        ctx._triviaLog?.push(pos, pos + 1)
        ctx._fields?.push({ name: 'selector', value: 'field-leak', span })
        ctx._errors?.push({ _tag: 'parseError', span, expected: ['selector-leak'] } satisfies ParseError)
        return { ok: true, value: 'ab', span }
      },
    }
    const parser = dispatch(selector, when('ab', sequence(routed(), literal('!'))))
    const expected = {
      ok: true,
      value: ['ab', ['ab', '!']],
      span: { start: 0, end: 3 },
    }

    for (const parse of [
      (input: string, ctx: ParseContext) => parser.parse(input, 0, ctx),
      (input: string, ctx: ParseContext) => compile(parser).parseWithContext(input, ctx, 0),
    ]) {
      const leaves: unknown[] = []
      const raw: unknown[] = []
      const cstTrivia: number[] = []
      const triviaLog: number[] = []
      const fields: NonNullable<ParseContext['_fields']> = []
      const errors: ParseError[] = []
      const result = parse('ab!', {
        trackLines: false,
        _cstLeaves: leaves,
        _cstRawChildren: raw,
        _cstTriviaLog: cstTrivia,
        _triviaLog: triviaLog,
        _fields: fields,
        _errors: errors,
      })

      expect(result).toEqual(expected)
      expect(leaves.map(leaf => (leaf as { value?: unknown }).value)).not.toContain('selector-leaf-leak')
      expect(raw.map(entry => (entry as { value?: unknown }).value)).not.toContain('selector-raw-leak')
      expect(cstTrivia).toEqual([])
      expect(triviaLog).toEqual([])
      expect(fields).toEqual([])
      expect(errors).toEqual([])
    }
  })

  it('supports ordered returned-value matchers inside when()', () => {
    const first = token(sequence(regex(/[@A-Za-z-]+/), optional(literal('('))))
    const parser = dispatch(
      first,
      when(startsWith('@-'), literal('!')),
      when(endsWith('('), literal('!')),
      when(matches(/^--[a-z]+$/), literal('!')),
      otherwise(literal('!')),
    )

    expectEnginesResult(parser, '@-moz!', {
      ok: true,
      value: ['@-moz', '!'],
      span: { start: 0, end: 6 },
    })
    expectEnginesResult(parser, 'foo(!', {
      ok: true,
      value: ['foo(', '!'],
      span: { start: 0, end: 5 },
    })
    expectEnginesResult(parser, '--name!', {
      ok: true,
      value: ['--name', '!'],
      span: { start: 0, end: 7 },
    })
  })

  it('applies case-insensitive comparison to returned-value matcher helpers', () => {
    const head = token(regex(/(?:PRE[A-Za-z]+|fnOPEN\(|--CUSTOM|plain)/))
    const parser = dispatch(
      head,
      when(startsWith('pre'), literal('!'), { caseInsensitive: true }),
      when(endsWith('open('), literal('?'), { caseInsensitive: true }),
      when(matches(/^--custom$/), literal(';'), { caseInsensitive: true }),
      otherwise(literal('.')),
    )

    expectEnginesResult(parser, 'PRElude!', {
      ok: true,
      value: ['PRElude', '!'],
      span: { start: 0, end: 8 },
    })
    expectEnginesResult(parser, 'fnOPEN(?', {
      ok: true,
      value: ['fnOPEN(', '?'],
      span: { start: 0, end: 8 },
    })
    expectEnginesResult(parser, '--CUSTOM;', {
      ok: true,
      value: ['--CUSTOM', ';'],
      span: { start: 0, end: 9 },
    })
  })

  it('prioritizes exact keys over matcher buckets', () => {
    const parser = dispatch(
      regex(/[a-z]+/),
      when(startsWith('a'), literal('?')),
      when('abc', literal('!')),
      otherwise(literal(';')),
    )

    expectEnginesResult(parser, 'abc!', {
      ok: true,
      value: ['abc', '!'],
      span: { start: 0, end: 4 },
    })
  })

  it('reports routed() misuse instead of silently matching outside dispatch branches', () => {
    expect(run(routed(), 'url')).toEqual({
      ok: false,
      expected: ['routed()'],
      span: { start: 0, end: 0 },
    })
    expect(() => dispatch(routed(), otherwise(literal('x'))))
      .toThrow(/routed\(\) can only appear inside a dispatch\(\) branch/)
  })

  it('rejects otherwise() before the end of a dispatch table', () => {
    expect(() => dispatch(literal('a'), otherwise(literal('x')), when('a', literal('y'))))
      .toThrow(/otherwise\(\) must be the last dispatch\(\) arm/)
    expect(() => dispatch(literal('a'), otherwise(literal('x')), otherwise(literal('y'))))
      .toThrow(/otherwise\(\) must be the last dispatch\(\) arm/)
  })

  it('does not let routed() appear after another branch term', () => {
    const parser = dispatch(
      literal('a'),
      when('a', sequence(routed(), literal('!'), routed())),
    )

    expect(assertEnginesAgree(parser, 'a!')).toEqual({
      ok: false,
      expected: ['routed()'],
      span: { start: 2, end: 2 },
      committed: true,
    })
  })

  it('supports an empty string key when the first combinator can produce it', () => {
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
    expect(() => dispatch(literal('a'), when('a', literal('x'), { caseInsensitive: true }), when('A', literal('y'), { caseInsensitive: true })))
      .toThrow('duplicate dispatch key')
    expect(() => dispatch(literal('a'), when('a', literal('x')), when('A', literal('y'), { caseInsensitive: true })))
      .toThrow('duplicate dispatch key')
    expect(() => dispatch(literal('a'), when(['a', 'A'], literal('x'), { caseInsensitive: true })))
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

  it('compile() keeps exact, matcher, case-insensitive, and routed dispatch on generated paths', () => {
    const fnCase = makeWhen({ caseInsensitive: true })
    const head = token(regex(/(?:url\(|foo\(|--custom|plain)/i))
    const parser = dispatch(
      head,
      fnCase('url(', sequence(routed(), literal('raw'))),
      when(startsWith('--'), literal('custom'), { caseInsensitive: true }),
      when(endsWith('('), literal('generic')),
      when(matches(/^plain$/), literal('plain')),
      otherwise(literal('fallback')),
    )
    const compiled = compile(parser)

    expect(compiled.source).not.toContain('_rp[')
    expect(compiled.source).not.toMatch(/\bstartsWith\s*\(/)
    expect(compiled.source).not.toMatch(/\bendsWith\s*\(/)
    expect(compiled.source).not.toMatch(/\bmatches\s*\(/)
    expect(compiled.source).not.toContain('/^plain$/.test')
    expect(compiled.source).toMatch(/const _re\d+ = \/\^plain\$\/$/m)
    expect(compiled.parse('URL(raw')).toEqual({
      ok: true,
      value: ['URL(', ['URL(', 'raw']],
      span: { start: 0, end: 7 },
    })
    expect(compiled.parse('--CUSTOMcustom')).toMatchObject({
      ok: true,
      value: ['--CUSTOM', 'custom'],
    })
    expect(compiled.parse('foo(generic')).toMatchObject({
      ok: true,
      value: ['foo(', 'generic'],
    })
    expect(compiled.parse('plainplain')).toMatchObject({
      ok: true,
      value: ['plain', 'plain'],
    })
  })

  it('compile() elides the public dispatch pair for immediate tail-only transforms', () => {
    const parser = transform(
      dispatch(
        regex(/[a-z]+(?:\()?/),
        when(endsWith('('), sequence(routed(), literal('raw'), literal(')'))),
        otherwise(routed()),
      ),
      ([, tail]) => tail,
    )
    const compiled = compile(parser)

    expect(compiled.source).not.toMatch(/_dval\d+\s*=\s*\[/)
    expect(assertEnginesAgree(parser, 'url(raw)')).toEqual({
      ok: true,
      value: ['url(', 'raw', ')'],
      span: { start: 0, end: 8 },
    })
    expect(assertEnginesAgree(parser, 'red')).toEqual({
      ok: true,
      value: 'red',
      span: { start: 0, end: 3 },
    })
  })

  it('compile() preserves the public dispatch pair when the value is observed directly', () => {
    const parser = dispatch(
      regex(/[a-z]+(?:\()?/),
      when(endsWith('('), sequence(routed(), literal('raw'), literal(')'))),
      otherwise(routed()),
    )
    const compiled = compile(parser)

    expect(compiled.source).toMatch(/_dval\d+\s*=\s*\[/)
    expect(assertEnginesAgree(parser, 'url(raw)')).toEqual({
      ok: true,
      value: ['url(', ['url(', 'raw', ')']],
      span: { start: 0, end: 8 },
    })
    expect(assertEnginesAgree(parser, 'red')).toEqual({
      ok: true,
      value: ['red', 'red'],
      span: { start: 0, end: 3 },
    })
  })

  it('compile() keeps same-function routed branch transforms local and tuple-free', () => {
    const inner = transform(
      dispatch(
        regex(/[a-z]+/),
        when('raw', transform(
          sequence(routed(), literal(')')),
          ([body, close]) => `${body}${close}`,
        )),
        otherwise(transform(routed(), body => `${body}:ident`)),
      ),
      ([, tail]) => tail,
    )
    const parser = transform(
      dispatch(
        regex(/[a-z]+(?:\()?/),
        when(endsWith('('), transform(
          sequence(routed(), inner),
          ([head, body]) => `${head}:${body}`,
        )),
        otherwise(transform(routed(), head => `${head}:ident`)),
      ),
      ([, tail]) => tail,
    )
    const compiled = compile(parser)

    expect(compiled.source).not.toMatch(/_dval\d+\s*=\s*\[/)
    expect(compiled.source).not.toMatch(/const _arr\d+\s*=\s*\[/)
    expect(assertEnginesAgree(parser, 'url(raw)')).toEqual({
      ok: true,
      value: 'url(:raw)',
      span: { start: 0, end: 8 },
    })
    expect(assertEnginesAgree(parser, 'red')).toEqual({
      ok: true,
      value: 'red:ident',
      span: { start: 0, end: 3 },
    })
  })

  it('compile() bridges nested dispatch routed branches through withCtx boundaries', () => {
    const inner = transform(
      dispatch(
        regex(/[a-z]+/),
        when('raw', withCtx({ mode: 'inner' }, transform(
          sequence(routed(), literal(')')),
          ([head, close]) => `${head}:${close}`,
        ))),
        otherwise(routed()),
      ),
      ([, tail]) => tail,
    )
    const parser = transform(
      dispatch(
        regex(/[a-z]+(?:\()?/),
        when(endsWith('('), transform(
          sequence(routed(), inner),
          ([head, body]) => `${head}:${body}`,
        )),
        otherwise(transform(routed(), head => `${head}:ident`)),
      ),
      ([, tail]) => tail,
    )
    const compiled = compile(parser)

    expect(compiled.source).not.toMatch(/_dval\d+\s*=\s*\[/)
    expect(assertEnginesAgree(parser, 'url(raw)')).toEqual({
      ok: true,
      value: 'url(:raw:)',
      span: { start: 0, end: 8 },
    })
    expect(assertEnginesAgree(parser, 'red')).toEqual({
      ok: true,
      value: 'red:ident',
      span: { start: 0, end: 3 },
    })
  })

  it('compile() does not allocate token(sequence(...)) selector tuples', () => {
    const selector = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const parser = node('Value',
      transform(
        dispatch(
          selector,
          when(endsWith('('), transform(
            sequence(routed(), literal('raw'), literal(')')),
            ([head, body, close]) => `${head}${body}${close}`,
          )),
          otherwise(routed()),
        ),
        ([, tail]) => tail,
      ),
      children => children.map(child => (child as { value: unknown }).value),
    )
    const compiled = compile(parser)

    expect(compiled.source).not.toMatch(/const _arr\d+\s*=\s*\[/)
    expect(assertEnginesAgree(parser, 'url(raw)')).toEqual({
      ok: true,
      value: ['url(', 'raw', ')'],
      span: { start: 0, end: 8 },
    })
    expect(assertEnginesAgree(parser, 'red')).toEqual({
      ok: true,
      value: ['red'],
      span: { start: 0, end: 3 },
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

    const parser = evalMacroModule<ParseFn>(transformed.code, 'parser')
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

  it('macro-lowers case-insensitive when() without changing the routed value', () => {
    const source = `
import { dispatch, literal, otherwise, regex, when } from 'parseman' with { type: 'macro' }
const parser = dispatch(regex(/@[A-Za-z-]+/), when('@media', literal('{'), { caseInsensitive: true }), otherwise(literal(';')))
`.trim()
    const transformed = transformMacro(source, 'dispatch-case-insensitive-macro.ts', new Set(['parseman']))!

    expect(transformed.code).not.toContain("from 'parseman'")
    expect(transformed.code).not.toMatch(/\bdispatch\s*\(/)
    expect(transformed.code).not.toMatch(/\bwhen\s*\(/)
    expect(transformed.code).not.toMatch(/\botherwise\s*\(/)

    const parser = evalMacroModule<ParseFn>(transformed.code, 'parser')
    expect(parser('@MEDIA{', 0, { trackLines: false })).toEqual({
      ok: true,
      value: ['@MEDIA', '{'],
      span: { start: 0, end: 7 },
    })
  })

  it('macro-lowers makeWhen() dispatch arm factories', () => {
    const source = `
import { dispatch, literal, makeWhen, otherwise, regex } from 'parseman' with { type: 'macro' }
const atCase = makeWhen({ caseInsensitive: true })
const parser = dispatch(regex(/@[A-Za-z-]+/), atCase('@media', literal('{')), atCase('@scope', literal('(')), otherwise(literal(';')))
`.trim()
    const transformed = transformMacro(source, 'dispatch-make-when-macro.ts', new Set(['parseman']))!

    expect(transformed.code).not.toContain("from 'parseman'")
    expect(transformed.code).not.toMatch(/\bdispatch\s*\(/)
    expect(transformed.code).not.toMatch(/\bmakeWhen\s*\(/)

    const parser = evalMacroModule<ParseFn>(transformed.code, 'parser')
    expect(parser('@SCOPE(', 0, { trackLines: false })).toEqual({
      ok: true,
      value: ['@SCOPE', '('],
      span: { start: 0, end: 7 },
    })
  })

  it('macro-lowers dispatch matcher keys', () => {
    const source = `
import { dispatch, endsWith, literal, matches, otherwise, regex, startsWith, token, when } from 'parseman' with { type: 'macro' }
const head = token(regex(/(?:@-[A-Z]+|foo\\(|--[A-Z]+|plain)/))
const parser = dispatch(
  head,
  when(startsWith('@-'), literal('v'), { caseInsensitive: true }),
  when(endsWith('('), literal('f')),
  when(matches(/^--[a-z]+$/), literal('c'), { caseInsensitive: true }),
  otherwise(literal('w')),
)
`.trim()
    const transformed = transformMacro(source, 'dispatch-matchers-macro.ts', new Set(['parseman']))!

    expect(transformed.code).not.toContain("from 'parseman'")
    expect(transformed.code).not.toMatch(/\bdispatch\s*\(/)
    expect(transformed.code).not.toMatch(/\bstartsWith\s*\(/)
    expect(transformed.code).not.toMatch(/\bendsWith\s*\(/)
    expect(transformed.code).not.toMatch(/\bmatches\s*\(/)

    const parser = evalMacroModule<ParseFn>(transformed.code, 'parser')
    expect(parser('@-MOZv', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['@-MOZ', 'v'] })
    expect(parser('foo(f', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['foo(', 'f'] })
    expect(parser('--NAMEc', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['--NAME', 'c'] })
    expect(parser('plainw', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['plain', 'w'] })
  })

  it('macro-lowers routed() inside dispatch branch nodes', () => {
    const source = `
import { dispatch, literal, makeWhen, node, optional, otherwise, regex, routed, sequence, token } from 'parseman' with { type: 'macro' }
const fnCase = makeWhen({ caseInsensitive: true })
const opener = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
const Fn = node('Fn', sequence(routed(), literal('raw'), literal(')')),
  children => ({ type: 'Fn', name: children[0].value.slice(0, -1), value: children[1].value }))
const Ident = node('Ident', routed(),
  children => ({ type: 'Ident', name: children[0].value }))
const parser = dispatch(opener, fnCase('url(', Fn), otherwise(Ident))
`.trim()
    const transformed = transformMacro(source, 'dispatch-routed-macro.ts', new Set(['parseman']))!

    expect(transformed.code).not.toContain("from 'parseman'")
    expect(transformed.code).not.toMatch(/\bdispatch\s*\(/)
    expect(transformed.code).not.toMatch(/\bmakeWhen\s*\(/)

    const parser = evalMacroModule<ParseFn>(transformed.code, 'parser')
    expect(parser('URL(raw)', 0, { trackLines: false })).toEqual({
      ok: true,
      value: ['URL(', { type: 'Fn', name: 'URL', value: 'raw' }],
      span: { start: 0, end: 8 },
    })
    expect(parser('url', 0, { trackLines: false })).toEqual({
      ok: true,
      value: ['url', { type: 'Ident', name: 'url' }],
      span: { start: 0, end: 3 },
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

    const grammar = evalMacroModule<{ AtRule: ParseFn }>(transformed.code, 'grammar')
    expect(grammar.AtRule('@media{', 0, { trackLines: false })).toEqual({
      ok: true,
      value: ['@media', 'block'],
      span: { start: 0, end: 7 },
    })
  })
})
