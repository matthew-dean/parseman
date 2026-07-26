/**
 * Dispatch vs. shared-opener choice A/B.
 *
 * Both grammars accept the same at-rule-shaped language and return the same
 * values. The `choice` form is technically correct, but every arm starts with
 * `@`, so a late or generic arm rechecks several exact literals before the
 * fallback. The `dispatch` form parses the broad at-keyword once and routes by
 * the returned string.
 *
 * Run:
 *   pnpm bench:dispatch
 */
import {
  analyzeGating, choice, compile, dispatch, formatGatingWarnings, literal,
  matches, otherwise, regex, routed, sepBy, sequence, token, transform, when,
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

function nonEmpty(items: readonly Combinator<unknown>[]): [Combinator<unknown>, ...Combinator<unknown>[]] {
  if (items.length === 0) throw new Error('expected at least one combinator')
  return items as [Combinator<unknown>, ...Combinator<unknown>[]]
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
    result => {
      if (Array.isArray(result) && typeof result[1] === 'string') return result[1]
      throw new Error('unexpected dispatch result shape')
    },
  )
}

const mediaWs = regex(/[ \t]*/)
const mediaIdent = regex(/[A-Za-z-]+/)
const mediaValue = regex(/[0-9]+(?:\.[0-9]+)?[A-Za-z%]*/)
const mediaRangeOp = regex(/>=|<=|[><=]/)
const mediaMarker = regex(/>=|<=|[><=:]/)

function mediaHeadParts(head: unknown): { name: string; marker: string } {
  const text = String(head)
  const marker = text.match(/(?:>=|<=|>|<|=|:)$/)?.[0]
  if (marker === undefined) throw new Error(`bad media feature head ${JSON.stringify(text)}`)
  return { name: text.slice(1, -marker.length).trim(), marker }
}

function mediaRange(head: unknown, rhs: unknown): string {
  const parts = mediaHeadParts(head)
  return `range:${parts.name}:${parts.marker}:${String(rhs)}`
}

function mediaDeclaration(head: unknown, rhs: unknown): string {
  const parts = mediaHeadParts(head)
  return `feature:${parts.name}:${String(rhs)}`
}

function mediaFeatureChoiceRule(): Combinator<unknown> {
  const range = transform(
    sequence(literal('('), mediaIdent, mediaWs, mediaRangeOp, mediaWs, mediaValue, literal(')')),
    ([, name, , op, , rhs]) => `range:${String(name)}:${String(op)}:${String(rhs)}`,
  )
  const declaration = transform(
    sequence(literal('('), mediaIdent, mediaWs, literal(':'), mediaWs, mediaValue, literal(')')),
    ([, name, , , , rhs]) => `feature:${String(name)}:${String(rhs)}`,
  )
  return choice(range, declaration)
}

function mediaFeatureDispatchRule(): Combinator<unknown> {
  const featureHead = token(sequence(literal('('), mediaIdent, mediaWs, mediaMarker))
  return transform(
    dispatch(
      featureHead,
      when(matches(/(?:>=|<=|>|<|=)$/), transform(sequence(routed(), mediaWs, mediaValue, literal(')')), ([head, , rhs]) => mediaRange(head, rhs))),
      when(matches(/:$/), transform(sequence(routed(), mediaWs, mediaValue, literal(')')), ([head, , rhs]) => mediaDeclaration(head, rhs))),
    ),
    result => {
      if (Array.isArray(result) && typeof result[1] === 'string') return result[1]
      throw new Error('unexpected media dispatch result shape')
    },
  )
}

function list(rule: Combinator<unknown>): Combinator<unknown> {
  return sepBy(rule, literal(' '), { min: 1 })
}

function andList(rule: Combinator<unknown>): Combinator<unknown> {
  return sepBy(rule, literal(' and '), { min: 1 })
}

function compileRule(rule: Combinator<unknown>): CompiledFn {
  const compiled = compile(rule, undefined, { gating: 'off' })
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
    examples: ['@media{', '@property{', '@namespace;', '@custom;', '@media{ @custom; @property{ @unknown;'],
  }
}

const MEDIA_TOKENS = [
  '(width >= 50em)',
  '(height <= 40em)',
  '(min-width: 50em)',
  '(color: 8)',
  '(aspect-ratio > 1)',
  '(resolution: 2dppx)',
  '(width = 60em)',
] as const

function buildMediaFeatureCase(repetitions: number): DispatchChoiceCase {
  const choiceGrammar = andList(mediaFeatureChoiceRule())
  const dispatchGrammar = andList(mediaFeatureDispatchRule())
  const input = Array.from({ length: repetitions }, (_, i) => MEDIA_TOKENS[i % MEDIA_TOKENS.length]).join(' and ')
  const choiceWarnings = formatGatingWarnings(analyzeGating(choiceGrammar))
  const dispatchWarnings = formatGatingWarnings(analyzeGating(dispatchGrammar))
  return {
    name: 'media feature head',
    input,
    choiceParser: compileRule(choiceGrammar),
    dispatchParser: compileRule(dispatchGrammar),
    choiceWarnings,
    dispatchWarnings,
    valid: choiceWarnings.some(line => line.includes('UNGATED')) && choiceWarnings.some(line => line.includes("overlap on '('")) && dispatchWarnings.length === 0,
    examples: ['(width >= 50em)', '(min-width: 50em)', '(width >= 50em) and (min-width: 50em)'],
  }
}

export function buildDispatchChoiceCases(repetitions = 600): DispatchChoiceCase[] {
  return [buildAtRuleCase(repetitions), buildMediaFeatureCase(repetitions)]
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
}

function runCase(c: DispatchChoiceCase, iterations: number): DispatchChoiceResult {
  const choiceResult = c.choiceParser(c.input)
  const dispatchResult = c.dispatchParser(c.input)
  const ok = JSON.stringify(choiceResult) === JSON.stringify(dispatchResult)
  const { choiceUs, dispatchUs } = measurePair(c.choiceParser, c.dispatchParser, c.input, iterations)
  return {
    name: c.name,
    bytes: c.input.length,
    choiceUs,
    dispatchUs,
    speedup: choiceUs / dispatchUs,
    valid: c.valid,
    ok,
  }
}

export function runDispatchChoiceAb(iterations = 800): DispatchChoiceResult[] {
  return [runCase(buildAtRuleCase(600), iterations)]
}

export function printDispatchChoiceAb(): void {
  const results = runDispatchChoiceAb()
  console.log('\n=== Dispatch vs choice A/B — shared opener, then route by value ===')
  console.log('    choice = overlapping sibling arms; dispatch = parse shared head once + route\n')
  for (const r of results) {
    console.log(`  ${r.name} (${r.bytes} bytes)`)
    console.log(`    choice   ${r.choiceUs.toFixed(2).padStart(8)} µs/op`)
    console.log(`    dispatch ${r.dispatchUs.toFixed(2).padStart(8)} µs/op`)
    console.log(`    speedup  ${r.speedup.toFixed(2)}x${r.valid ? '' : '  [A/B path invalid]'}${r.ok ? '' : '  [outputs differ]'}`)
  }
  console.log()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  printDispatchChoiceAb()
}
