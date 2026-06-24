/**
 * Compiler parity for choice fast paths inside node() captures.
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, choice, transform, node, parser, trivia, compile, parse,
  makeWord, keywords,
} from '../../src/index.ts'

function par<T>(
  label: string,
  parserFn: import('../../src/index.ts').Combinator<T>,
  inputs: string[],
  ctxFactory?: () => import('../../src/types.ts').ParseContext,
) {
  const compiled = compile(parserFn)
  for (const input of inputs) {
    it(`${label} — ${JSON.stringify(input)}`, () => {
      const ctx = ctxFactory?.() ?? { trackLines: false }
      const interpreted = parse(parserFn, input, ctx)
      const compiledResult = ctxFactory
        ? compiled.parseWithContext(input, ctx, 0)
        : compiled.parse(input, 0)
      expect(compiledResult.ok).toBe(interpreted.ok)
      if (interpreted.ok && compiledResult.ok) {
        expect(compiledResult.value).toEqual(interpreted.value)
        expect(compiledResult.span.start).toBe(interpreted.span.start)
        expect(compiledResult.span.end).toBe(interpreted.span.end)
      }
    })
  }
}

describe('choice fast paths — capturing compile parity', () => {
  const ws = trivia(regex(/[ \t]+/))
  const cstCtx = () => {
    const triviaLog: number[] = []
    return { trackLines: false, _triviaLog: triviaLog }
  }

  // literalsLongestFirst: combinator choice inside node()
  const combinatorRule = node(
    'Comb',
    parser({ trivia: ws }, choice(literal('||'), literal('>'), literal('+'), literal('~'), literal('|'))),
    (c, _r, s) => ({ _tag: 'node', type: 'Comb', span: s, leaves: c.map(x => (x as { value?: string }).value ?? x) }),
  )
  par('literalsLongestFirst in node', combinatorRule, ['>', '||', '+', '|', '~', 'x'], cstCtx)

  // greedyClassify: ident regex + literal keywords
  const kw = makeWord('_0-9A-Za-z')
  const boolRule = node(
    'Bool',
    parser({ trivia: ws }, choice(kw('true'), kw('false'), regex(/[a-z]+/))),
    (c, _r, s) => ({ _tag: 'node', type: 'Bool', span: s, leaves: [...c] }),
  )
  par('greedyClassify-ish keywords in node', boolRule, ['true', 'false', 'truthy', 'foobar'], cstCtx)

  // keywords() combinator (longest-first regex alternation)
  const colorKw = node(
    'ColorKw',
    parser({ trivia: ws }, keywords(['red', 'rebeccapurple', 'blue'], { caseInsensitive: true })),
    (c, _r, s) => ({ _tag: 'node', type: 'ColorKw', span: s, leaves: [...c] }),
  )
  par('keywords in node', colorKw, ['red', 'rebeccapurple', 'RED', 'blue'], cstCtx)

  // transform + overlapping literals under node
  const opRule = node(
    'Op',
    parser({ trivia: ws }, transform(
      choice(literal('instanceof'), literal('in'), literal('if')),
      s => s,
    )),
    (c, _r, s) => ({ _tag: 'node', type: 'Op', span: s, leaves: [...c] }),
  )
  par('literalsLongestFirst + transform in node', opRule, ['instanceof', 'in', 'if', 'inside'], cstCtx)
})

describe('parseWithContext — compiled CST capture', () => {
  it('passes _triviaLog through to generated parser', () => {
    const ws = trivia(regex(/[ \t]+/))
    const p = node(
      'Pair',
      parser({ trivia: ws }, sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/))),
      (c, _r, s, tl) => ({ _tag: 'node', type: 'Pair', span: s, n: c.length, tl: tl.length }),
    )
    const compiled = compile(p)
    const triviaLog: number[] = []
    const r = compiled.parseWithContext('a : 1', { trackLines: false, _triviaLog: triviaLog })
    expect(r.ok).toBe(true)
    expect(triviaLog.length).toBeGreaterThan(0)
    if (r.ok) expect((r.value as { tl: number }).tl).toBeGreaterThan(0)
  })
})

describe('choice fast paths — codegen uses optimized emitters when capturing', () => {
  it('literalsLongestFirst emits startsWith chain, not firstMatch rollback', () => {
    const ws = trivia(regex(/[ \t]+/))
    const p = node(
      'T',
      parser({ trivia: ws }, choice(literal('instanceof'), literal('in'))),
      (c, _r, s) => ({ _tag: 'node', type: 'T', span: s, c }),
    )
    const src = compile(p).source
    expect(src).toContain('startsWith("instanceof"')
    expect(src).not.toContain('_crok')
  })

  it('greedyClassify emits single regex exec for keyword + ident choice', () => {
    const ws = trivia(regex(/[ \t]+/))
    const p = node(
      'T',
      parser({ trivia: ws }, choice(literal('true'), literal('false'), regex(/[a-z]+/))),
      (c, _r, s) => ({ _tag: 'node', type: 'T', span: s, c }),
    )
    const src = compile(p).source
    expect(src).toContain('.exec(input)')
    expect(src).not.toContain('_crok')
    expect(src).toContain('_cstLeaves.push')
  })
})
