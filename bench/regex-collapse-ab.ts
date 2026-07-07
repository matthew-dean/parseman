/**
 * A/B shape matrix for grammar-level "collapse combinators to one terminal".
 *
 * This is intentionally not an optimizer. It tests combinator-combination
 * classes against an equivalent single regex/literal-shaped terminal, so we can
 * see which classes are even worth considering for automatic lowering.
 *
 * Run: node --import tsx/esm bench/regex-collapse-ab.ts
 */
import {
  choice,
  compile,
  literal,
  many,
  oneOrMore,
  optional,
  parse,
  regex,
  sepBy,
  sequence,
  token,
  type Combinator,
  type ParseResult,
} from '../src/index.ts'
import { measureMedianUs } from './parseman-perf.ts'

type ParserFn = (input: string) => ParseResult<unknown>

type RawCase = {
  name: string
  input: string
  parity: string[]
  diagnostic: string[]
  iterations: number
  combinator: Combinator<unknown>
  collapsed: Combinator<unknown>
}

export type RegexCollapseAbResult = {
  name: string
  interpretedCombinatorUs: number
  interpretedRegexUs: number
  compiledCombinatorUs: number
  compiledRegexUs: number
  interpretedSpeedup: number
  compiledSpeedup: number
  combinatorSourceBytes: number
  regexSourceBytes: number
  matchParity: boolean
  diagnosticDrifts: number
}

function repeated(count: number, fn: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => fn(i)).join('')
}

function outcome(r: ParseResult<unknown>): string {
  return `${r.ok ? 'ok' : 'fail'}:${r.span.start}:${r.span.end}`
}

function comparable(a: ParserFn, b: ParserFn, inputs: string[]): boolean {
  return inputs.every(input => outcome(a(input)) === outcome(b(input)))
}

function measure(fn: () => void, iterations: number): number {
  return measureMedianUs(fn, iterations, { samples: 7 })
}

function rawCases(): RawCase[] {
  const ident = regex(/[a-z][a-z0-9]*/)
  const digits = regex(/[0-9]+/)
  const hex = regex(/#[0-9a-fA-F]{3,8}/)
  const ws = regex(/[ \t]+/)
  const sp = literal(' ')

  return [
    {
      name: 'sequence(terminals)',
      input: 'name123:456px',
      parity: ['name123:456px!', 'name:', '1name:456px'],
      diagnostic: ['name123:px'],
      iterations: 250_000,
      combinator: sequence(ident, literal(':'), digits, literal('px')),
      collapsed: regex(/[a-z][a-z0-9]*:[0-9]+px/),
    },
    {
      name: 'oneOrMore(sequence(terminals))',
      input: repeated(2000, i => `name${i % 100} ${i % 1000}px #${(i % 4096).toString(16).padStart(3, 'a')} `),
      parity: ['name1 1px #abc ', 'name1 1px #abc !', '1name 1px #abc '],
      diagnostic: ['name1 1 #abc '],
      iterations: 7_000,
      combinator: oneOrMore(sequence(ident, sp, digits, literal('px'), sp, hex, sp)),
      collapsed: regex(/(?:[a-z][a-z0-9]* [0-9]+px #[0-9a-fA-F]{3,8} )+/),
    },
    {
      name: 'many(sequence(terminals))',
      input: repeated(2000, i => `k${i % 100}=${i % 1000};`),
      parity: ['k1=2;', 'k1=2;!', '!'],
      diagnostic: ['k1=;'],
      iterations: 7_000,
      combinator: many(sequence(ident, literal('='), digits, literal(';'))),
      collapsed: regex(/(?:[a-z][a-z0-9]*=[0-9]+;)*/),
    },
    {
      name: 'optional(sequence(terminals))',
      input: '!important',
      parity: ['!important;', ';'],
      diagnostic: ['!important'],
      iterations: 250_000,
      combinator: optional(sequence(literal('!'), regex(/important/i))),
      collapsed: regex(/(?:!important)?/i),
    },
    {
      name: 'token(sequence(terminals))',
      input: '!important',
      parity: ['!important;', '!IMPORTANT', '! important', 'important'],
      diagnostic: ['! important'],
      iterations: 300_000,
      combinator: token(sequence(literal('!'), regex(/important/i))),
      collapsed: token(regex(/!important/i)),
    },
    {
      name: 'token(escaped literals + regex)',
      input: '$.*[12345]^',
      parity: ['$.*[1]^!', '$.*[]^', '$xx[123]^'],
      diagnostic: ['$.*[]^'],
      iterations: 300_000,
      combinator: token(sequence(literal('$.*['), regex(/[0-9]+/), literal(']^'))),
      collapsed: token(regex(/\$\.\*\[[0-9]+\]\^/)),
    },
    {
      name: 'many(token(sequence(terminals)))',
      input: repeated(2000, i => `!important${i % 10}`),
      parity: ['!important1!important2', '!importantx', ' !important1'],
      diagnostic: ['! important1'],
      iterations: 7_000,
      combinator: many(token(sequence(literal('!'), regex(/important/i), regex(/[0-9]/)))),
      collapsed: regex(/(?:!important[0-9])*/i),
    },
    {
      name: 'many(token(escaped literals))',
      input: repeated(1500, i => `$.*[${i % 100}]^`),
      parity: ['$.*[1]^$.*[2]^', '$.*[]^', '$xx[1]^'],
      diagnostic: ['$.*[]^'],
      iterations: 7_000,
      combinator: many(token(sequence(literal('$.*['), regex(/[0-9]+/), literal(']^')))),
      collapsed: regex(/(?:\$\.\*\[[0-9]+\]\^)*/),
    },
    {
      name: 'token(many(sequence(terminals)))',
      input: repeated(2000, i => `!important${i % 10}`),
      parity: ['!important1!important2', '!importantx', ' !important1'],
      diagnostic: ['! important1'],
      iterations: 7_000,
      combinator: token(many(sequence(literal('!'), regex(/important/i), regex(/[0-9]/)))),
      collapsed: token(regex(/(?:!important[0-9])*/i)),
    },
    {
      name: 'token(many(escaped literals))',
      input: repeated(1500, i => `$.*[${i % 100}]^`),
      parity: ['$.*[1]^$.*[2]^', '$.*[]^', '$xx[1]^'],
      diagnostic: ['$.*[]^'],
      iterations: 7_000,
      combinator: token(many(sequence(literal('$.*['), regex(/[0-9]+/), literal(']^')))),
      collapsed: token(regex(/(?:\$\.\*\[[0-9]+\]\^)*/)),
    },
    {
      name: 'token(optional(escaped literals))',
      input: '$.*[12345]^',
      parity: ['$.*[1]^!', '$.*[]^', '$xx[123]^'],
      diagnostic: ['$.*[]^'],
      iterations: 300_000,
      combinator: token(optional(sequence(literal('$.*['), regex(/[0-9]+/), literal(']^')))),
      collapsed: token(regex(/(?:\$\.\*\[[0-9]+\]\^)?/)),
    },
    {
      name: 'token(sepBy(terminals))',
      input: repeated(500, i => `${i === 0 ? '' : '|.$|'}item${i % 100}`),
      parity: ['item1|.$|item2', 'item1|.$|', '|.$|item1'],
      diagnostic: ['|.$|item1'],
      iterations: 12_000,
      combinator: token(sepBy(ident, literal('|.$|'))),
      collapsed: token(regex(/(?:[a-z][a-z0-9]*(?:\|\.\$\|[a-z][a-z0-9]*)*)?/)),
    },
    {
      name: 'separated list',
      input: repeated(500, i => `${i === 0 ? '' : ','}item${i % 100}`),
      parity: ['item1,item2', 'item1,item2!', 'item1,'],
      diagnostic: [',item1'],
      iterations: 12_000,
      combinator: sequence(ident, many(sequence(literal(','), ident))),
      collapsed: regex(/[a-z][a-z0-9]*(?:,[a-z][a-z0-9]*)*/),
    },
    {
      name: 'delimited optional payload',
      input: 'url("assets/bg.png")',
      parity: ['url(foo)', 'url()', 'url(foo)!', 'url("unterminated)'],
      diagnostic: ['url("unterminated)'],
      iterations: 150_000,
      combinator: sequence(regex(/url\(/i), optional(choice(regex(/"(?:[^"\\]|\\[\s\S])*"/), regex(/'(?:[^'\\]|\\[\s\S])*'/), regex(/[^)"'\s]+/))), literal(')')),
      collapsed: regex(/url\((?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|[^)"'\s]+)?\)/i),
    },
    {
      name: 'optional suffix',
      input: '10.5em',
      parity: ['10.5', '10.5em!', '.5rem'],
      diagnostic: ['.em'],
      iterations: 200_000,
      combinator: sequence(regex(/[0-9]+(?:\.[0-9]+)?/), optional(regex(/[a-z]+/))),
      collapsed: regex(/[0-9]+(?:\.[0-9]+)?[a-z]*/),
    },
    {
      name: 'literal prefix + choice + suffix',
      input: '[name123]',
      parity: ['["x"]', '[name123]!', '[1]'],
      diagnostic: ['['],
      iterations: 200_000,
      combinator: sequence(literal('['), choice(ident, regex(/"(?:[^"\\]|\\.)*"/)), literal(']')),
      collapsed: regex(/\[(?:[a-z][a-z0-9]*|"(?:[^"\\]|\\.)*")\]/),
    },
    {
      name: 'choice(literals)',
      input: 'instanceof',
      parity: ['in', 'if', 'instanceof!', 'while'],
      diagnostic: ['zzz'],
      iterations: 300_000,
      combinator: choice(literal('instanceof'), literal('in'), literal('if')),
      collapsed: regex(/instanceof|in|if/),
    },
    {
      name: 'regex ws between tokens',
      input: repeated(1000, i => `name${i % 100} \t ${i % 1000};`),
      parity: ['name1  2;', 'name1  2;!', 'name1;'],
      diagnostic: ['name1 ;'],
      iterations: 7_000,
      combinator: oneOrMore(sequence(ident, ws, digits, literal(';'))),
      collapsed: regex(/(?:[a-z][a-z0-9]*[ \t]+[0-9]+;)+/),
    },
  ]
}

export function runRegexCollapseAb(): RegexCollapseAbResult[] {
  return rawCases().map(c => {
    const compiledCombinator = compile(c.combinator)
    const compiledRegex = compile(c.collapsed)
    const interpretedCombinator = (input: string) => parse(c.combinator, input)
    const interpretedRegex = (input: string) => parse(c.collapsed, input)
    const compiledCombinatorFn = (input: string) => compiledCombinator.parse(input, 0)
    const compiledRegexFn = (input: string) => compiledRegex.parse(input, 0)
    const matchParity = comparable(interpretedCombinator, interpretedRegex, [c.input, ...c.parity])
      && comparable(compiledCombinatorFn, compiledRegexFn, [c.input, ...c.parity])
    const diagnosticDrifts = c.diagnostic.filter(input =>
      outcome(interpretedCombinator(input)) !== outcome(interpretedRegex(input))
      || outcome(compiledCombinatorFn(input)) !== outcome(compiledRegexFn(input)),
    ).length
    const interpretedCombinatorUs = measure(() => { interpretedCombinator(c.input) }, c.iterations)
    const interpretedRegexUs = measure(() => { interpretedRegex(c.input) }, c.iterations)
    const compiledCombinatorUs = measure(() => { compiledCombinatorFn(c.input) }, c.iterations)
    const compiledRegexUs = measure(() => { compiledRegexFn(c.input) }, c.iterations)
    return {
      name: c.name,
      interpretedCombinatorUs,
      interpretedRegexUs,
      compiledCombinatorUs,
      compiledRegexUs,
      interpretedSpeedup: interpretedCombinatorUs / interpretedRegexUs,
      compiledSpeedup: compiledCombinatorUs / compiledRegexUs,
      combinatorSourceBytes: Buffer.byteLength(compiledCombinator.source, 'utf8'),
      regexSourceBytes: Buffer.byteLength(compiledRegex.source, 'utf8'),
      matchParity,
      diagnosticDrifts,
    }
  })
}

export function printRegexCollapseAb(): void {
  console.log('\n=== combinator-shape collapse A/B ===')
  for (const r of runRegexCollapseAb()) {
    const parity = r.matchParity ? '' : ' parity!'
    const diag = r.diagnosticDrifts === 0 ? '' : ` diagΔ=${r.diagnosticDrifts}`
    console.log(
      `  ${r.name.padEnd(34)} ` +
      `interp ${r.interpretedSpeedup.toFixed(2).padStart(5)}x ` +
      `compiled ${r.compiledSpeedup.toFixed(2).padStart(5)}x ` +
      `src ${r.combinatorSourceBytes}->${r.regexSourceBytes}${diag}${parity}`,
    )
  }
  console.log()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  printRegexCollapseAb()
}
