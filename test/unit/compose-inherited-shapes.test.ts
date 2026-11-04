/**
 * Three compositions a dialect grammar relies on, pinned across a package boundary:
 * the base is macro-built in one module and composed by a dialect in another, the
 * way a CSS grammar and its Less superset ship. Each shape is checked on the walker,
 * on the table encoded from runtime `compose()`, on `compile()` of that composition
 * and on the macro's build-time table. All four must return the same value, span and
 * expected set, on the inputs that parse and on the inputs that fail.
 *
 * - `routed()` seen through an inherited rule. The dialect's own value dispatch routes
 *   `media(` and `style(` to the base's `MediaTest`/`StyleTest`, which own the opener
 *   through `routed()`. The dialect defines no copy of either.
 * - An inherited parent over an overridden slot. The base's `RelativeSelector` reads
 *   the dialect's widened `SimpleSelector`, both through the base's own `:has()` and
 *   through a dialect rule that references the inherited parent.
 * - A `field()` reached through rule hops. The base's argument-list node reads its
 *   `separator` field through two non-node rules, and the dialect overrides the
 *   innermost one.
 */
import { describe, expect, it } from 'vitest'
import * as P from '../../src/index.ts'
import { run as walk } from '../../src/functional/run.ts'
import { evalMacroExports } from '../helpers/eval-macro-module.ts'
import { macroComposed } from '../helpers/macro-package.ts'

type Engines = Record<'interpreter' | 'compile' | 'macro', Record<string, P.Runnable>>

/** The dialect's `less` export on every engine. */
function engines(baseSource: string, dialectSource: string): Engines {
  const base = evalMacroExports(baseSource, { ...P })
  const interpreter = evalMacroExports(dialectSource, { ...P, ...base }).less as Record<string, P.Runnable>
  return {
    interpreter,
    compile: P.compile(interpreter as Record<string, unknown>) as Record<string, P.Runnable>,
    macro: macroComposed(baseSource, dialectSource).less as Record<string, P.Runnable>,
  }
}

type Shape = { ok: boolean; span: { start: number; end: number }; value: unknown; expected: string[]; unconsumedFrom: number | null }
const shape = (r: P.RunResult): Shape =>
  ({ ok: r.ok, span: { start: r.span.start, end: r.span.end }, value: r.value, expected: [...r.expected].sort(), unconsumedFrom: r.unconsumedFrom })

/** Every engine's result, checked equal; returns the walker's. */
function agree(all: Engines, entry: string, input: string): Shape {
  // The driver walks a combinator; the public `run()` encodes one to a table first.
  const want = shape(walk(all.interpreter[entry]!, input))
  const legs = { table: all.interpreter, compile: all.compile, macro: all.macro }
  for (const [engine, map] of Object.entries(legs)) {
    expect(shape(P.run(map[entry]!, input)), `${engine}: ${entry} on ${JSON.stringify(input)}`).toEqual(want)
  }
  return want
}

describe('routed() through an inherited rule', () => {
  const BASE = `import { rules, node, dispatch, when, otherwise, endsWith, routed, token, regex, literal, sequence, optional, trivia } from 'parseman' with { type: 'macro' }
const ws = trivia(regex(/[ \\t\\n]+/))
const identOrFunction = token(sequence(regex(/-?[a-z][a-z0-9-]*/), optional(literal('('))))
export const css = rules({ trivia: ws }, g => ({
  Value: dispatch(
    identOrFunction,
    when('media(', g.MediaTest),
    when('style(', g.StyleTest),
    when(endsWith('('), g.GenericFunction),
    otherwise(g.Keyword),
  ),
  MediaTest: node('Call', sequence(routed(), g.MediaTestBody, literal(')')), c => ({ type: 'Call', name: c[0].value.slice(0, -1), query: c[1] })),
  MediaTestBody: node('MediaFeature', regex(/[a-z-]+/), c => c[0].value),
  StyleTest: node('Call', sequence(routed(), g.StyleTestBody, literal(')')), c => ({ type: 'Call', name: c[0].value.slice(0, -1), query: c[1] })),
  StyleTestBody: node('StyleFeature', sequence(regex(/--[a-z-]+/), literal(':'), regex(/[a-z0-9]+/)), c => [c[0].value, c[2].value]),
  GenericFunction: node('Call', sequence(routed(), regex(/[a-z0-9]*/), literal(')')), c => ({ type: 'Call', name: c[0].value.slice(0, -1), args: c[1].value })),
  Keyword: node('Keyword', routed(), c => ({ type: 'Keyword', value: c[0].value })),
}))`

  // Less's value dispatch adds its escape call and keeps the CSS query-function arms.
  const LESS = `import { rules, node, dispatch, when, otherwise, endsWith, routed, token, regex, literal, sequence, optional, trivia, compose } from 'parseman' with { type: 'macro' }
import { css } from './base.js'
const ws = trivia(regex(/[ \\t\\n]+/))
const identOrFunction = token(sequence(regex(/-?[a-z][a-z0-9-]*/), optional(literal('('))))
export const less = compose([css, rules({ trivia: ws }, g => ({
  Value: dispatch(
    identOrFunction,
    when('e(', g.EscapeCall),
    when('media(', g.MediaTest),
    when('style(', g.StyleTest),
    when(endsWith('('), g.GenericFunction),
    otherwise(g.Keyword),
  ),
  EscapeCall: node('Escape', sequence(routed(), regex(/"[^"]*"/), literal(')')), c => ({ type: 'Escape', value: c[1].value.slice(1, -1) })),
  Declaration: node('Declaration', sequence(regex(/[a-z-]+/), literal(':'), g.Value), c => ({ type: 'Declaration', name: c[0].value, value: c[2] })),
}))])`

  const all = engines(BASE, LESS)

  it('routes media( and style( to the base rules', () => {
    expect(agree(all, 'Value', 'media(print)').value).toEqual(['media(', { type: 'Call', name: 'media', query: 'print' }])
    expect(agree(all, 'Value', 'style(--x: 1)').value).toEqual(['style(', { type: 'Call', name: 'style', query: ['--x', '1'] }])
  })

  it('keeps the dialect arm and the base fallbacks', () => {
    expect(agree(all, 'Value', 'e("a")').value).toEqual(['e(', { type: 'Escape', value: 'a' }])
    expect(agree(all, 'Value', 'rgb(0)').value).toEqual(['rgb(', { type: 'Call', name: 'rgb', args: '0' }])
    expect(agree(all, 'Value', 'auto').value).toEqual(['auto', { type: 'Keyword', value: 'auto' }])
  })

  it('routes through the dispatch when another dialect rule reaches it', () => {
    expect(agree(all, 'Declaration', 'a: media(print)').value)
      .toEqual({ type: 'Declaration', name: 'a', value: { type: 'Call', name: 'media', query: 'print' } })
  })
})

describe('an inherited parent over an overridden slot', () => {
  const BASE = `import { rules, node, choice, regex, literal, sequence, optional, oneOrMore, oneOrMoreSep } from 'parseman' with { type: 'macro' }
export const css = rules(g => ({
  HasPseudo: node('Pseudo', sequence(literal(':has('), g.SelectorOnlyPseudoArgument, literal(')')), c => ({ type: 'Pseudo', name: 'has', args: c[1] })),
  SelectorOnlyPseudoArgument: node('SelectorList', oneOrMoreSep(g.RelativeSelector, regex(/, */)), c => c),
  RelativeSelector: node('RelativeSelector', sequence(optional(regex(/[>+~] */)), g.ComplexSelector), c => c.length === 1 ? c[0] : { lead: c[0].value.trim(), selector: c[1] }),
  ComplexSelector: node('Complex', oneOrMoreSep(g.CompoundSelector, regex(/ *[>+~] *| +/)), c => c),
  CompoundSelector: node('Compound', oneOrMore(g.SimpleSelector), c => c),
  SimpleSelector: choice(g.ClassSelector, g.TypeSelector),
  ClassSelector: node('Class', regex(/\\.[a-z-]+/), c => c[0].value),
  TypeSelector: node('Type', regex(/[a-z]+/), c => c[0].value),
}))`

  // Less widens the simple-selector slot with interpolation, and its selector branch
  // references CSS's RelativeSelector rather than a copy of it.
  const LESS = `import { rules, node, choice, regex, literal, sequence, optional, compose } from 'parseman' with { type: 'macro' }
import { css } from './base.js'
export const less = compose([css, rules(g => ({
  SimpleSelector: choice(g.ClassSelector, g.TypeSelector, g.SelectorInterpolation),
  SelectorInterpolation: node('Interpolation', regex(/@\\{[a-z]+\\}/), c => ({ var: c[0].value.slice(2, -1) })),
  SelectorBranch: node('SelectorBranch', sequence(g.RelativeSelector, optional(g.ExtendPseudo)), c => ({ selector: c[0], extend: c[1] ?? null })),
  ExtendPseudo: node('Extend', sequence(literal(':extend('), regex(/[^)]+/), literal(')')), c => c[1].value),
}))])`

  const all = engines(BASE, LESS)

  it("reads the dialect's slot through the base's own parents", () => {
    expect(agree(all, 'HasPseudo', ':has(> @{b} .x, .y)').value).toEqual({
      type: 'Pseudo',
      name: 'has',
      args: [{ lead: '>', selector: [[{ var: 'b' }], ['.x']] }, [['.y']]],
    })
  })

  it('reads it through a dialect rule that references the inherited parent', () => {
    expect(agree(all, 'SelectorBranch', '~ a@{b}:extend(.c)').value).toEqual({
      selector: { lead: '~', selector: [['a', { var: 'b' }]] },
      extend: '.c',
    })
  })
})

describe('a field() reached through rule hops', () => {
  const BASE = `import { rules, node, field, regex, literal, sequence, oneOrMoreSep } from 'parseman' with { type: 'macro' }
export const css = rules(g => ({
  Function: node('Call', sequence(regex(/[a-z]+\\(/), g.FunctionArguments, literal(')')), c => ({ name: c[0].value.slice(0, -1), args: c[1] })),
  FunctionArguments: node('Arguments', g.functionArgumentList, (c, fields) => ({
    items: c,
    separators: [fields?.separator ?? []].flat().map(s => s.value),
  })),
  functionArgumentList: oneOrMoreSep(g.FunctionArgument, g.functionArgumentSeparator),
  functionArgumentSeparator: field('separator', regex(/, */)),
  FunctionArgument: node('Argument', regex(/[a-z0-9]+/), c => c[0].value),
}))`

  // Less accepts `;` as well as `,` between arguments.
  const LESS = `import { rules, field, regex, compose } from 'parseman' with { type: 'macro' }
import { css } from './base.js'
export const less = compose([css, rules(g => ({
  functionArgumentSeparator: field('separator', regex(/[;,] */)),
}))])`

  const all = engines(BASE, LESS)

  it('delivers the overridden separator field to the inherited node', () => {
    expect(agree(all, 'Function', 'mix(a; b, c)').value).toEqual({
      name: 'mix',
      args: { items: ['a', 'b', 'c'], separators: ['; ', ', '] },
    })
  })

  it('delivers a single separator', () => {
    expect(agree(all, 'FunctionArguments', 'a;b').value).toEqual({ items: ['a', 'b'], separators: [';'] })
  })
})

describe('a failure reads the same on every engine', () => {
  const FN = `import { rules, node, field, regex, literal, sequence, oneOrMoreSep } from 'parseman' with { type: 'macro' }
export const css = rules(g => ({
  Function: node('Call', sequence(regex(/[a-z]+\\(/), g.FunctionArguments, literal(')')), c => c[1]),
  FunctionArguments: node('Arguments', g.functionArgumentList, c => c),
  functionArgumentList: oneOrMoreSep(g.FunctionArgument, field('separator', regex(/, */))),
  FunctionArgument: node('Argument', regex(/[a-z0-9]+/), c => c[0].value),
}))`
  const FN_LESS = `import { rules, regex, compose } from 'parseman' with { type: 'macro' }
import { css } from './base.js'
export const less = compose([css, rules(g => ({
  FunctionArgument: regex(/[a-z0-9@]+/),
}))])`

  it('names the item a list wanted, where a list is what failed', () => {
    const all = engines(FN, FN_LESS)
    const failed = agree(all, 'Function', 'mix(')
    expect(failed.span.start).toBe(4)
    expect(failed.expected).toEqual(['/[a-z0-9@]+/'])
  })

  const SUPPORTS = `import { rules, regex, literal, sequence, choice, trivia } from 'parseman' with { type: 'macro' }
const ws = trivia(regex(/[ \\t\\n]+/))
export const css = rules({ trivia: ws }, g => ({
  Supports: sequence(literal('@supports'), g.SupportsCondition),
  SupportsCondition: choice(g.SupportsNot, g.SupportsInParens),
  SupportsNot: sequence(literal('not'), g.SupportsInParens),
  SupportsInParens: choice(g.SupportsDeclaration, g.SupportsGroup),
  SupportsDeclaration: sequence(literal('('), regex(/[a-z-]+/), literal(':'), regex(/[a-z0-9]+/), literal(')')),
  SupportsGroup: sequence(literal('('), g.SupportsCondition, literal(')')),
}))`
  const SUPPORTS_LESS = `import { rules, regex, choice, compose, trivia } from 'parseman' with { type: 'macro' }
import { css } from './base.js'
const ws = trivia(regex(/[ \\t\\n]+/))
export const less = compose([css, rules({ trivia: ws }, g => ({
  SupportsInParens: choice(g.SupportsDeclaration, g.SupportsGroup, g.SupportsInterpolation),
  SupportsInterpolation: regex(/@\\{[a-z]+\\}/),
}))])`

  it('lists a token once, where two arms open with it', () => {
    const all = engines(SUPPORTS, SUPPORTS_LESS)
    const failed = agree(all, 'Supports', '@supports [x]')
    expect(failed.span.start).toBe(10)
    expect(failed.expected).toContain('"not"')
    expect(failed.expected.filter(e => e === '"("')).toHaveLength(1)
  })

  it('fails where a dispatch inside a choice committed', () => {
    const arm = P.dispatch(
      P.token(P.sequence(P.regex(/[a-z]+/), P.optional(P.literal('(')))),
      P.when('url(', P.node('Url', P.sequence(P.routed(), P.literal(')')), c => c)),
      P.otherwise(P.node('Keyword', P.routed(), c => c)),
    )
    const value = P.choice(arm, P.regex(/[0-9]+/))
    const walked = walk(value, 'url(x')
    expect(walked.span.start).toBe(4)
    expect(shape(P.run(value, 'url(x'))).toEqual(shape(walked))
  })
})
