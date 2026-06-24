/**
 * Micro-benchmarks for macro/codegen inlining — one section per combinator shape.
 * Run via bench/run.ts (not vitest) for stable timing output.
 */
import {
  literal, regex, sequence, choice, many, oneOrMore, optional, sepBy,
  transform, node, parser, trivia, rules, makeWord, keywords, compile, parse,
} from '../src/index.ts'

export type BenchCase = { name: string; interpreted: () => unknown; compiled: () => unknown }

function pair<T>(name: string, combi: import('../src/index.ts').Combinator<T>, input: string, ctx?: object): BenchCase {
  const compiled = compile(combi)
  return {
    name,
    interpreted: () => parse(combi, input, ctx as never),
    compiled: () => compiled.parse(input, 0),
  }
}

const ws = trivia(regex(/[ \t\n]+/))

export function buildCombinatorInliningCases(): BenchCase[] {
  const cases: BenchCase[] = []

  cases.push(pair('literal', literal('hello'), 'hello'))
  cases.push(pair('regex', regex(/[0-9]+/), '12345abc'))
  cases.push(pair('sequence', sequence(literal('GET'), literal(' '), regex(/\S+/)), 'GET /api'))
  cases.push(pair('disjoint-choice', choice(literal('{'), literal('['), literal('"')), '{'))
  cases.push(pair('overlap-choice (longest-first)', choice(literal('instanceof'), literal('in')), 'instanceof'))
  cases.push(pair('many', many(literal('ab')), 'ababab'))
  cases.push(pair('oneOrMore', oneOrMore(regex(/a/)), 'aaaa'))
  cases.push(pair('optional-hit', optional(literal('foo')), 'foo'))
  cases.push(pair('optional-miss', optional(literal('foo')), 'bar'))
  cases.push(pair('sepBy', sepBy(regex(/[0-9]+/), literal(',')), '1,2,3,4'))
  cases.push(pair('transform', transform(regex(/[0-9]+/), s => Number(s)), '42'))

  const kw = makeWord('_0-9A-Za-z')
  cases.push(pair('keywords-greedyClassify', choice(kw('true'), kw('false'), regex(/[a-z]+/)), 'true'))
  cases.push(pair('keywords-set', keywords(['red', 'rebeccapurple'], { caseInsensitive: true }), 'rebeccapurple'))

  // node() + overlapping choice (exercises capturing fast paths)
  const { Tok } = rules<{ Tok: import('../src/index.ts').Combinator<unknown> }>(g => ({
    Tok: node(
      'Tok',
      parser({ trivia: ws }, choice(literal('instanceof'), literal('in'), g.Ident)),
      (c, _r, s) => ({ _tag: 'node', type: 'Tok', span: s, n: c.length }),
    ),
    Ident: regex(/[a-z]+/),
  }))
  cases.push(pair('node+overlap-choice', Tok, 'instanceof'))
  cases.push(pair('node+ident-fallback', Tok, 'foobar'))

  const { Sheet } = rules<{ Sheet: import('../src/index.ts').Combinator<unknown> }>(g => ({
    Sheet: node(
      'Sheet',
      parser({ trivia: ws }, many(g.Rule)),
      (c, _r, s) => ({ _tag: 'node', type: 'Sheet', span: s, n: c.length }),
    ),
    Rule: node(
      'Rule',
      parser({ trivia: ws }, sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/), optional(literal(';')))),
      (c, _r, s) => ({ _tag: 'node', type: 'Rule', span: s, n: c.length }),
    ),
  }))
  const miniCss = '.a { color: 1; } .b { margin: 2; } .c { padding: 3; }'
  cases.push(pair('node+many-rules', Sheet, miniCss.repeat(50)))

  return cases
}

export function benchCase(c: BenchCase, iterations: number): { interpretedUs: number; compiledUs: number; speedup: number } {
  for (let i = 0; i < Math.min(iterations / 10, 200); i++) {
    c.interpreted()
    c.compiled()
  }
  const time = (fn: () => unknown) => {
    const t0 = performance.now()
    for (let i = 0; i < iterations; i++) fn()
    return (performance.now() - t0) / iterations * 1000
  }
  const interpretedUs = time(c.interpreted)
  const compiledUs = time(c.compiled)
  return { interpretedUs, compiledUs, speedup: interpretedUs / compiledUs }
}
