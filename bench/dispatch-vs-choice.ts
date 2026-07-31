/**
 * Dispatch vs. shared-opener choice A/B.
 *
 * Each A/B pair accepts the same language and returns the same values. The
 * `choice` forms are technically correct, but sibling arms share a broad opener
 * and then diverge by the parsed value. The `dispatch` forms parse that opener
 * once and route by the returned string.
 *
 * Run:
 *   pnpm bench:dispatch
 */
import {
  analyzeGating, choice, compile, dispatch, endsWith, formatGatingWarnings, literal, matches,
  makeWhen, node, oneOrMoreSep, otherwise, regex, routed, sequence, transform, when,
  type Combinator, type ParseResult,
} from '../src/index.ts'

type AtRuleSpec = readonly [name: string, tail: string, kind: string]
type CompiledFn = (input: string) => ParseResult<unknown>

const AT_RULES: readonly AtRuleSpec[] = [
  ['@media', '{', 'media'],
  ['@supports', '{', 'supports'],
  ['@container', '{', 'container'],
  ['@layer', '{', 'layer'],
  ['@scope', '(', 'scope'],
  ['@keyframes', '{', 'keyframes'],
  ['@font-face', '{', 'font-face'],
  ['@property', '{', 'property'],
  ['@namespace', ';', 'namespace'],
]

const WORKLOAD_TOKENS = [
  '@unknown;',
  '@custom;',
  '@vendor-rule;',
  '@property{',
  '@namespace;',
  '@font-face{',
  '@keyframes{',
  '@scope(',
  '@container{',
  '@supports{',
  '@media{',
] as const

function value(kind: string, name: unknown): string {
  return `${kind}:${String(name)}`
}

function valueCall(kind: string, head: unknown, arg: unknown): string {
  return `${kind}:${String(head)}:${String(arg)}`
}

function nonEmpty(items: readonly Combinator<unknown>[]): [Combinator<unknown>, ...Combinator<unknown>[]] {
  if (items.length === 0) throw new Error('expected at least one combinator')
  return items as [Combinator<unknown>, ...Combinator<unknown>[]]
}

function pick<T>(items: readonly T[], index: number): T {
  return items[index % items.length]!
}

function atRuleChoiceRule(): Combinator<unknown> {
  const exact = AT_RULES.map(([name, tail, kind]) =>
    transform(sequence(literal(name), literal(tail)), ([head]) => value(kind, head)),
  )
  const generic = transform(sequence(regex(/@[A-Za-z-]+/), literal(';')), ([head]) => value('generic', head))
  return choice(...nonEmpty([...(exact as Combinator<unknown>[]), generic]))
}

function atRuleDispatchRule(): Combinator<unknown> {
  const exact = AT_RULES.map(([name, tail, kind]) =>
    when(name, transform(sequence(routed(), literal(tail)), ([head]) => value(kind, head))),
  )
  return transform(
    dispatch(
      regex(/@[A-Za-z-]+/),
      ...exact,
      otherwise(transform(sequence(routed(), literal(';')), ([head]) => value('generic', head))),
    ),
    ([, tail]) => tail,
  )
}

const ident = regex(/--?[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_-]*/)
const identOrFunctionHead = regex(/(?:--?[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_-]*)(?:\()?/)
const broadHead = regex(/(?:--?[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_-]*)(?:[(:!])?/)
const functionArg = regex(/[A-Za-z0-9_./%+-]+/)

function childValue(children: readonly unknown[], index: number): string {
  const child = children[index]
  return typeof child === 'object' && child !== null && 'value' in child
    ? String((child as { value: unknown }).value)
    : String(child)
}

function identFunctionChoiceRule(): Combinator<unknown> {
  const fn = node(
    'FunctionValue',
    sequence(ident, literal('('), functionArg, literal(')')),
    children => valueCall('function', `${childValue(children, 0)}(`, childValue(children, 2)),
  )
  const keyword = node(
    'KeywordValue',
    ident,
    children => value('keyword', childValue(children, 0)),
  )
  return choice(fn, keyword)
}

function identFunctionDispatchRule(): Combinator<unknown> {
  const fn = node(
    'FunctionValue',
    sequence(routed(), functionArg, literal(')')),
    children => valueCall('function', childValue(children, 0), childValue(children, 1)),
  )
  const keyword = node(
    'KeywordValue',
    routed(),
    children => value('keyword', childValue(children, 0)),
  )
  return transform(
    dispatch(
      identOrFunctionHead,
      when(endsWith('('), fn),
      otherwise(keyword),
    ),
    ([, tail]) => tail,
  )
}

function exactFunctionOpener(name: string): Combinator<string> {
  return regex(new RegExp(`${name}\\(`, 'i'))
}

function identFunctionSpecificChoiceRule(): Combinator<unknown> {
  const url = node(
    'UrlFunction',
    sequence(exactFunctionOpener('url'), functionArg, literal(')')),
    children => valueCall('url', childValue(children, 0), childValue(children, 1)),
  )
  const calc = node(
    'CalcFunction',
    sequence(exactFunctionOpener('calc'), functionArg, literal(')')),
    children => valueCall('calc', childValue(children, 0), childValue(children, 1)),
  )
  const variable = node(
    'VarFunction',
    sequence(exactFunctionOpener('var'), functionArg, literal(')')),
    children => valueCall('var', childValue(children, 0), childValue(children, 1)),
  )
  const generic = node(
    'GenericFunction',
    sequence(ident, literal('('), functionArg, literal(')')),
    children => valueCall('generic-function', `${childValue(children, 0)}(`, childValue(children, 2)),
  )
  const keyword = node(
    'Identifier',
    ident,
    children => value('identifier', childValue(children, 0)),
  )
  return choice(url, calc, variable, generic, keyword)
}

function identFunctionSpecificDispatchRule(): Combinator<unknown> {
  const fnCase = makeWhen({ caseInsensitive: true })
  const url = node(
    'UrlFunction',
    sequence(routed(), functionArg, literal(')')),
    children => valueCall('url', childValue(children, 0), childValue(children, 1)),
  )
  const calc = node(
    'CalcFunction',
    sequence(routed(), functionArg, literal(')')),
    children => valueCall('calc', childValue(children, 0), childValue(children, 1)),
  )
  const variable = node(
    'VarFunction',
    sequence(routed(), functionArg, literal(')')),
    children => valueCall('var', childValue(children, 0), childValue(children, 1)),
  )
  const generic = node(
    'GenericFunction',
    sequence(routed(), functionArg, literal(')')),
    children => valueCall('generic-function', childValue(children, 0), childValue(children, 1)),
  )
  const keyword = node(
    'Identifier',
    routed(),
    children => value('identifier', childValue(children, 0)),
  )
  return transform(
    dispatch(
      identOrFunctionHead,
      fnCase('url(', url),
      fnCase('calc(', calc),
      fnCase('var(', variable),
      when(endsWith('('), generic),
      otherwise(keyword),
    ),
    ([, tail]) => tail,
  )
}

function identBroadMultiChoiceRule(): Combinator<unknown> {
  const fn = node(
    'FunctionValue',
    sequence(ident, literal('('), functionArg, literal(')')),
    children => valueCall('function', `${childValue(children, 0)}(`, childValue(children, 2)),
  )
  const property = node(
    'PropertyValue',
    sequence(ident, literal(':'), functionArg),
    children => valueCall('property', `${childValue(children, 0)}:`, childValue(children, 2)),
  )
  const modifier = node(
    'ModifierValue',
    sequence(ident, literal('!'), ident),
    children => valueCall('modifier', `${childValue(children, 0)}!`, childValue(children, 2)),
  )
  const keyword = node(
    'KeywordValue',
    ident,
    children => value('keyword', childValue(children, 0)),
  )
  return choice(fn, property, modifier, keyword)
}

function identBroadMultiDispatchRule(): Combinator<unknown> {
  const fn = node(
    'FunctionValue',
    sequence(routed(), functionArg, literal(')')),
    children => valueCall('function', childValue(children, 0), childValue(children, 1)),
  )
  const property = node(
    'PropertyValue',
    sequence(routed(), functionArg),
    children => valueCall('property', childValue(children, 0), childValue(children, 1)),
  )
  const modifier = node(
    'ModifierValue',
    sequence(routed(), ident),
    children => valueCall('modifier', childValue(children, 0), childValue(children, 1)),
  )
  const keyword = node(
    'KeywordValue',
    routed(),
    children => value('keyword', childValue(children, 0)),
  )
  return transform(
    dispatch(
      broadHead,
      when(endsWith('('), fn),
      when(endsWith(':'), property),
      when(endsWith('!'), modifier),
      otherwise(keyword),
    ),
    ([, tail]) => tail,
  )
}

const aliasIdent = regex(/(?:--[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_-]*-alias)/)

function identMatchesChoiceRule(): Combinator<unknown> {
  const alias = node(
    'AliasIdentifier',
    aliasIdent,
    children => value('alias', childValue(children, 0)),
  )
  const keyword = node(
    'Identifier',
    ident,
    children => value('identifier', childValue(children, 0)),
  )
  return choice(alias, keyword)
}

function identMatchesDispatchRule(): Combinator<unknown> {
  const alias = node(
    'AliasIdentifier',
    routed(),
    children => value('alias', childValue(children, 0)),
  )
  const keyword = node(
    'Identifier',
    routed(),
    children => value('identifier', childValue(children, 0)),
  )
  return transform(
    dispatch(
      ident,
      when(matches(/^(?:--[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_-]*-alias)$/), alias),
      otherwise(keyword),
    ),
    ([, tail]) => tail,
  )
}

function list(rule: Combinator<unknown>): Combinator<unknown> {
  return oneOrMoreSep(rule, literal(' '))
}

function andList(rule: Combinator<unknown>): Combinator<unknown> {
  return oneOrMoreSep(rule, literal(' and '))
}

function compileRule(rule: Combinator<unknown>): CompiledFn {
  const compiled = compile(rule, undefined)
  return input => compiled.parse(input, 0)
}

export type DispatchChoiceCase = {
  name: string
  input: string
  choiceParser: CompiledFn
  dispatchParser: CompiledFn
  choiceWarnings: readonly string[]
  dispatchWarnings: readonly string[]
  valid: boolean
  minSpeedup: number
  examples: readonly string[]
}

function buildAtRuleCase(repetitions: number): DispatchChoiceCase {
  const choiceGrammar = list(atRuleChoiceRule())
  const dispatchGrammar = list(atRuleDispatchRule())
  const input = Array.from({ length: repetitions }, (_, i) => WORKLOAD_TOKENS[i % WORKLOAD_TOKENS.length]).join(' ')
  const choiceWarnings = formatGatingWarnings(analyzeGating(choiceGrammar))
  const dispatchWarnings = formatGatingWarnings(analyzeGating(dispatchGrammar))
  return {
    name: 'at-rule shared opener',
    input,
    choiceParser: compileRule(choiceGrammar),
    dispatchParser: compileRule(dispatchGrammar),
    choiceWarnings,
    dispatchWarnings,
    valid: choiceWarnings.some(line => line.includes('UNGATED') && line.includes('@')) && dispatchWarnings.length === 0,
    minSpeedup: 1.25,
    examples: ['@media{', '@property{', '@namespace;', '@custom;', '@media{ @custom; @property{ @unknown;'],
  }
}

const KEYWORD_TOKENS = [
  'red',
  '--accent',
  'blue',
  'compact',
  'border-box',
  'inherit',
  'currentColor',
  'grid',
  'inline-size',
  'visible',
] as const

const FUNCTION_TOKENS = [
  'url(images/a.svg)',
  'calc(100%+-20px)',
  'attr(data-size)',
  'min(10px)',
  'rgb(15)',
  'color-mix(red)',
  'linear-gradient(red)',
  'paint(border)',
  'var(--accent)',
  'env(safe-area)',
] as const

const SPECIFIC_FUNCTION_TOKENS = [
  'URL(images/a.svg)',
  'calc(100%+-20px)',
  'VAR(--accent)',
] as const

const GENERIC_FUNCTION_TOKENS = [
  'rgb(15)',
  'color-mix(red)',
  'linear-gradient(red)',
  'paint(border)',
  'env(safe-area)',
] as const

const PROPERTY_TOKENS = [
  'width:10px',
  '--gap:2rem',
  'mode:compact',
  'ratio:16/9',
  'font-size:12px',
] as const

const MODIFIER_TOKENS = [
  'color!important',
  'theme!dark',
  'display!block',
  'layout!grid',
  'origin!local',
] as const

const MATCHES_TOKENS = [
  'red',
  'border-box',
  '--accent',
  'currentColor',
  'layout-alias',
  'inline-size',
  'theme-alias',
  'visible',
  'grid',
  '--gap',
] as const

function identFunctionTokens(repetitions: number, functionsPerTen: number): string[] {
  return Array.from({ length: repetitions }, (_, i) => {
    if (i % 10 < functionsPerTen) {
      return pick(FUNCTION_TOKENS, i)
    }
    return pick(KEYWORD_TOKENS, i)
  })
}

function identSpecificFunctionTokens(repetitions: number): string[] {
  return Array.from({ length: repetitions }, (_, i) => {
    switch (i % 10) {
      case 0:
      case 1:
      case 2:
        return pick(SPECIFIC_FUNCTION_TOKENS, i)
      case 3:
      case 4:
      case 5:
        return pick(GENERIC_FUNCTION_TOKENS, i)
      default:
        return pick(KEYWORD_TOKENS, i)
    }
  })
}

function identBroadMultiTokens(repetitions: number): string[] {
  return Array.from({ length: repetitions }, (_, i) => {
    switch (i % 10) {
      case 0:
      case 1:
        return pick(FUNCTION_TOKENS, i)
      case 2:
      case 3:
        return pick(PROPERTY_TOKENS, i)
      case 4:
      case 5:
        return pick(MODIFIER_TOKENS, i)
      default:
        return pick(KEYWORD_TOKENS, i)
    }
  })
}

function identMatchesTokens(repetitions: number): string[] {
  return Array.from({ length: repetitions }, (_, i) => pick(MATCHES_TOKENS, i))
}

function buildIdentSpecificFunctionCase(repetitions: number): DispatchChoiceCase {
  const choiceGrammar = andList(identFunctionSpecificChoiceRule())
  const dispatchGrammar = andList(identFunctionSpecificDispatchRule())
  const input = identSpecificFunctionTokens(repetitions).join(' and ')
  const choiceWarnings = formatGatingWarnings(analyzeGating(choiceGrammar))
  const dispatchWarnings = formatGatingWarnings(analyzeGating(dispatchGrammar))
  return {
    name: 'identifier/function specific+generic broad opener',
    input,
    choiceParser: compileRule(choiceGrammar),
    dispatchParser: compileRule(dispatchGrammar),
    choiceWarnings,
    dispatchWarnings,
    valid: choiceWarnings.some(line => line.includes('UNGATED')) && dispatchWarnings.length === 0,
    minSpeedup: 1.10,
    examples: ['URL(images/a.svg)', 'calc(100%+-20px)', 'rgb(15)', 'red', 'URL(images/a.svg) and rgb(15) and red'],
  }
}

function buildIdentMatchesCase(repetitions: number): DispatchChoiceCase {
  const choiceGrammar = andList(identMatchesChoiceRule())
  const dispatchGrammar = andList(identMatchesDispatchRule())
  const input = identMatchesTokens(repetitions).join(' and ')
  const choiceWarnings = formatGatingWarnings(analyzeGating(choiceGrammar))
  const dispatchWarnings = formatGatingWarnings(analyzeGating(dispatchGrammar))
  return {
    name: 'identifier broad opener matches() arm',
    input,
    choiceParser: compileRule(choiceGrammar),
    dispatchParser: compileRule(dispatchGrammar),
    choiceWarnings,
    dispatchWarnings,
    valid: choiceWarnings.some(line => line.includes('UNGATED')) && dispatchWarnings.length === 0,
    minSpeedup: 0,
    examples: ['red', '--accent', 'layout-alias', 'red and layout-alias and --gap'],
  }
}

function buildIdentFunctionCase(
  repetitions: number,
  mix: { name: string; functionsPerTen: number; minSpeedup: number },
): DispatchChoiceCase {
  const choiceGrammar = andList(identFunctionChoiceRule())
  const dispatchGrammar = andList(identFunctionDispatchRule())
  const input = identFunctionTokens(repetitions, mix.functionsPerTen).join(' and ')
  const choiceWarnings = formatGatingWarnings(analyzeGating(choiceGrammar))
  const dispatchWarnings = formatGatingWarnings(analyzeGating(dispatchGrammar))
  return {
    name: mix.name,
    input,
    choiceParser: compileRule(choiceGrammar),
    dispatchParser: compileRule(dispatchGrammar),
    choiceWarnings,
    dispatchWarnings,
    valid: choiceWarnings.some(line => line.includes('UNGATED')) && dispatchWarnings.length === 0,
    minSpeedup: mix.minSpeedup,
    examples: ['url(images/a.svg)', 'red', 'url(images/a.svg) and red and rgb(15)'],
  }
}

function buildIdentBroadMultiCase(repetitions: number): DispatchChoiceCase {
  const choiceGrammar = andList(identBroadMultiChoiceRule())
  const dispatchGrammar = andList(identBroadMultiDispatchRule())
  const input = identBroadMultiTokens(repetitions).join(' and ')
  const choiceWarnings = formatGatingWarnings(analyzeGating(choiceGrammar))
  const dispatchWarnings = formatGatingWarnings(analyzeGating(dispatchGrammar))
  return {
    name: 'identifier broad opener multi-branch',
    input,
    choiceParser: compileRule(choiceGrammar),
    dispatchParser: compileRule(dispatchGrammar),
    choiceWarnings,
    dispatchWarnings,
    valid: choiceWarnings.some(line => line.includes('UNGATED')) && dispatchWarnings.length === 0,
    minSpeedup: 1.20,
    examples: ['url(images/a.svg)', 'width:10px', 'color!important', 'red', 'width:10px and red and color!important'],
  }
}

export function buildDispatchChoiceCases(repetitions = 600): DispatchChoiceCase[] {
  return [
    buildIdentFunctionCase(repetitions, { name: 'identifier/function two-arm broad opener — all keywords', functionsPerTen: 0, minSpeedup: 1.25 }),
    buildIdentFunctionCase(repetitions, { name: 'identifier/function two-arm broad opener — 10% functions', functionsPerTen: 1, minSpeedup: 1.20 }),
    buildIdentFunctionCase(repetitions, { name: 'identifier/function two-arm broad opener — 50% functions', functionsPerTen: 5, minSpeedup: 1.05 }),
    buildIdentFunctionCase(repetitions, { name: 'identifier/function two-arm broad opener — 90% functions', functionsPerTen: 9, minSpeedup: 0 }),
    buildIdentSpecificFunctionCase(repetitions),
    buildIdentMatchesCase(repetitions),
    buildIdentBroadMultiCase(repetitions),
    buildAtRuleCase(repetitions),
  ]
}

export function buildDispatchChoiceCase(repetitions = 600): DispatchChoiceCase {
  return buildDispatchChoiceCases(repetitions)[0]!
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function measurePair(
  choiceParser: CompiledFn,
  dispatchParser: CompiledFn,
  input: string,
  iterations: number,
): { choiceUs: number; dispatchUs: number } {
  for (let i = 0; i < 500; i++) {
    choiceParser(input)
    dispatchParser(input)
  }
  const choiceSamples: number[] = []
  const dispatchSamples: number[] = []
  const window = (fn: CompiledFn): number => {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) fn(input)
    return ((performance.now() - start) / iterations) * 1000
  }
  for (let pass = 0; pass < 11; pass++) {
    if (pass % 2 === 0) {
      choiceSamples.push(window(choiceParser))
      dispatchSamples.push(window(dispatchParser))
    } else {
      dispatchSamples.push(window(dispatchParser))
      choiceSamples.push(window(choiceParser))
    }
  }
  return { choiceUs: median(choiceSamples), dispatchUs: median(dispatchSamples) }
}

export type DispatchChoiceResult = {
  name: string
  bytes: number
  choiceUs: number
  dispatchUs: number
  speedup: number
  valid: boolean
  ok: boolean
  minSpeedup: number
}

function runCase(c: DispatchChoiceCase, iterations: number): DispatchChoiceResult {
  const choiceResult = c.choiceParser(c.input)
  const dispatchResult = c.dispatchParser(c.input)
  const ok = choiceResult.ok
    && dispatchResult.ok
    && choiceResult.span.end === c.input.length
    && dispatchResult.span.end === c.input.length
    && JSON.stringify(choiceResult) === JSON.stringify(dispatchResult)
  const { choiceUs, dispatchUs } = measurePair(c.choiceParser, c.dispatchParser, c.input, iterations)
  return {
    name: c.name,
    bytes: c.input.length,
    choiceUs,
    dispatchUs,
    speedup: choiceUs / dispatchUs,
    valid: c.valid,
    ok,
    minSpeedup: c.minSpeedup,
  }
}

export function runDispatchChoiceAb(iterations = 800): DispatchChoiceResult[] {
  return buildDispatchChoiceCases(600).map(c => runCase(c, iterations))
}

export function printDispatchChoiceAb(): void {
  const results = runDispatchChoiceAb()
  console.log('\n=== Dispatch vs choice A/B — shared opener, then route by value ===')
  console.log('    choice = overlapping sibling arms; dispatch = parse shared head once + route\n')
  for (const r of results) {
    console.log(`  ${r.name} (${r.bytes} bytes)`)
    console.log(`    choice   ${r.choiceUs.toFixed(2).padStart(8)} µs/op`)
    console.log(`    dispatch ${r.dispatchUs.toFixed(2).padStart(8)} µs/op`)
    const threshold = r.minSpeedup > 0 ? `  [target > ${r.minSpeedup.toFixed(2)}x]` : '  [tracked, not a win gate]'
    console.log(`    speedup  ${r.speedup.toFixed(2)}x${threshold}${r.valid ? '' : '  [A/B path invalid]'}${r.ok ? '' : '  [outputs differ]'}`)
  }
  console.log()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  printDispatchChoiceAb()
}
