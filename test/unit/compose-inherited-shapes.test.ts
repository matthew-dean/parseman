/**
 * Three compositions a dialect grammar relies on, pinned across a package boundary:
 * the base is macro-built in one module and composed by a dialect in another, the
 * way a CSS grammar and its Less superset ship. Each shape is checked on the macro's
 * build-time table, on runtime `compose()` (the linked interpreter) and on `compile()`
 * of that composition, and the three must build the same values.
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

function agree(all: Engines, entry: string, input: string): unknown {
  const want = P.run(all.interpreter[entry]!, input)
  expect(want.ok, `${entry} on ${JSON.stringify(input)}`).toBe(true)
  for (const engine of ['compile', 'macro'] as const) {
    const got = P.run(all[engine][entry]!, input)
    expect({ ok: got.ok, end: got.span.end, value: got.value }, `${engine}: ${entry} on ${JSON.stringify(input)}`)
      .toEqual({ ok: want.ok, end: want.span.end, value: want.value })
  }
  return want.value
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
    expect(agree(all, 'Value', 'media(print)')).toEqual(['media(', { type: 'Call', name: 'media', query: 'print' }])
    expect(agree(all, 'Value', 'style(--x: 1)')).toEqual(['style(', { type: 'Call', name: 'style', query: ['--x', '1'] }])
  })

  it('keeps the dialect arm and the base fallbacks', () => {
    expect(agree(all, 'Value', 'e("a")')).toEqual(['e(', { type: 'Escape', value: 'a' }])
    expect(agree(all, 'Value', 'rgb(0)')).toEqual(['rgb(', { type: 'Call', name: 'rgb', args: '0' }])
    expect(agree(all, 'Value', 'auto')).toEqual(['auto', { type: 'Keyword', value: 'auto' }])
  })

  it('routes through the dispatch when another dialect rule reaches it', () => {
    expect(agree(all, 'Declaration', 'a: media(print)'))
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
    expect(agree(all, 'HasPseudo', ':has(> @{b} .x, .y)')).toEqual({
      type: 'Pseudo',
      name: 'has',
      args: [{ lead: '>', selector: [[{ var: 'b' }], ['.x']] }, [['.y']]],
    })
  })

  it('reads it through a dialect rule that references the inherited parent', () => {
    expect(agree(all, 'SelectorBranch', '~ a@{b}:extend(.c)')).toEqual({
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
    expect(agree(all, 'Function', 'mix(a; b, c)')).toEqual({
      name: 'mix',
      args: { items: ['a', 'b', 'c'], separators: ['; ', ', '] },
    })
  })

  it('delivers a single separator', () => {
    expect(agree(all, 'FunctionArguments', 'a;b')).toEqual({ items: ['a', 'b'], separators: [';'] })
  })
})
