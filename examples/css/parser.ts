/**
 * Jess CSS functional grammar (feature/parseman), adapted for parseman repo perf
 * regression. Builds lightweight CST nodes (not Jess AST) with full trivia
 * capture — matches jess parseCssFn measurement shape.
 *
 * Source of truth: jess/packages/css-parser/src/grammar.ts
 */
import {
  node, regex, literal, sequence, choice, many, oneOrMore, optional,
  scanTo, balanced, parser, trivia, rules, compile,
  type Combinator,
} from '../../src/index.ts'
import type { ParseResult } from '../../src/types.ts'
import { mk, buildLazyTriviaMap, nilNode, type CssNode } from './stub-build.ts'

const ws = regex(/[ \t\n\r\f]+/)
const comment = regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)
const rw = trivia(oneOrMore(choice(ws, comment)))

const ident = regex(/-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*/)
const basicSel = regex(/(?:[.#]?-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*|\d+(?:\.\d+)?%|\*)/)
const combinator = choice(literal('||'), literal('>'), literal('+'), literal('~'), literal('|'))
const pseudoColon = regex(/::?/)
const attrOp = regex(/[*~|^$]?=/)
const attrMod = regex(/[is]/i)
const nth = regex(/even|odd|[-+]?\d*n(?:[ \t\n\r\f]*[+-][ \t\n\r\f]*\d+)?|[-+]?\d+/i)
const singleStr = regex(/'(?:[^'\\]|\\.)*'/)
const doubleStr = regex(/"(?:[^"\\]|\\.)*"/)
const customProp = regex(/--[-_a-zA-Z0-9\u0080-\uffff]*/)
const atKeyword = regex(/@-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*/)
const numPart = regex(/[+-]?(?:\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?|\d+)/)
const colorHex = regex(/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/)
const urlOpen = regex(/url\(/i)
const urlInner = regex(/[^)"'\s]+/)
const anyValueTok = regex(/[+\-*/=<>|~^]+|[^\s;{}\[\]()'",!]+/)

export const {
  Stylesheet,
} = rules((g: {
  AtRuleBlock: Combinator<unknown>
  AtRuleStatement: Combinator<unknown>
  Ruleset: Combinator<unknown>
  SelectorList: Combinator<unknown>
  ComplexSelector: Combinator<unknown>
  CompoundSelector: Combinator<unknown>
  simpleSelector: Combinator<unknown>
  AttributeSelector: Combinator<unknown>
  PseudoSelector: Combinator<unknown>
  pseudoArg: Combinator<unknown>
  Declaration: Combinator<unknown>
  CustomDeclaration: Combinator<unknown>
  declarationList: Combinator<unknown>
  valueList: Combinator<unknown>
  valueSequence: Combinator<unknown>
  value: Combinator<unknown>
  parenBody: Combinator<unknown>
  Dimension: Combinator<unknown>
  Num: Combinator<unknown>
  Color: Combinator<unknown>
  Url: Combinator<unknown>
  Call: Combinator<unknown>
  Paren: Combinator<unknown>
  Quoted: Combinator<unknown>
  anyValue: Combinator<unknown>
  atRuleBody: Combinator<unknown>
}) => {
  const unknownTok = scanTo(choice(literal(';'), literal('{'), literal('}'), literal(',')), { orEOF: true })

  const Stylesheet = node('Stylesheet',
    parser({ trivia: rw }, many(choice(g.AtRuleBlock, g.AtRuleStatement, g.Ruleset, unknownTok))),
    (c, _fields, s, r, tl) => mk('Stylesheet', c, r, s, tl))

  const Ruleset = node('Ruleset',
    parser({ trivia: rw }, sequence(g.SelectorList, literal('{'), g.declarationList, literal('}'))),
    (c, _fields, s, r, tl) => mk('Ruleset', c, r, s, tl))

  const SelectorList = node('SelectorList',
    parser({ trivia: rw }, sequence(g.ComplexSelector, many(sequence(literal(','), g.ComplexSelector)))),
    (c, _fields, s, r, tl) => mk('SelectorList', c, r, s, tl))
  const ComplexSelector = node('ComplexSelector',
    parser({ trivia: rw }, sequence(g.CompoundSelector, many(sequence(optional(combinator), g.CompoundSelector)))),
    (c, _fields, s, r, tl) => mk('ComplexSelector', c, r, s, tl))
  const CompoundSelector = node('CompoundSelector',
    parser({ trivia: rw }, oneOrMore(g.simpleSelector)),
    (c, _fields, s, r, tl) => mk('CompoundSelector', c, r, s, tl))
  const simpleSelector = choice(g.AttributeSelector, g.PseudoSelector, basicSel)

  const AttributeSelector = node('AttributeSelector',
    parser({ trivia: rw }, sequence(
      literal('['), ident,
      optional(sequence(attrOp, choice(singleStr, doubleStr, ident), optional(attrMod))),
      literal(']'),
    )),
    (c, _fields, s, r, tl) => mk('AttributeSelector', c, r, s, tl))
  const PseudoSelector = node('PseudoSelector',
    parser({ trivia: rw }, sequence(pseudoColon, ident, optional(sequence(literal('('), g.pseudoArg, literal(')'))))),
    (c, _fields, s, r, tl) => mk('PseudoSelector', c, r, s, tl))
  const pseudoArg = choice(nth, g.SelectorList, scanTo(literal(')'), { skip: [balanced('(', ')')] }))

  const declarationList = parser({ trivia: rw }, many(choice(
    g.Declaration, g.CustomDeclaration, g.Ruleset, literal(';'),
    sequence(scanTo(choice(literal(';'), literal('{'), literal('}'), literal(',')), { orEOF: true }), optional(literal(';'))),
  )))

  const important = sequence(literal('!'), literal('important'))

  const Declaration = node('Declaration',
    parser({ trivia: rw }, sequence(ident, literal(':'), g.valueList, optional(important), optional(literal(';')))),
    (c, _fields, s, r, tl) => mk('Declaration', c, r, s, tl))
  const CustomDeclaration = node('CustomDeclaration',
    parser({ trivia: rw }, sequence(
      customProp, literal(':'),
      scanTo(choice(literal(';'), literal('}')), { skip: [balanced('(', ')'), balanced('[', ']'), balanced('{', '}')] }),
      optional(literal(';')),
    )),
    (c, _fields, s, r, tl) => mk('CustomDeclaration', c, r, s, tl))

  const valueList = parser({ trivia: rw }, sequence(g.valueSequence, many(sequence(literal(','), g.valueSequence))))
  const valueSequence = parser({ trivia: rw }, oneOrMore(g.value))
  const value = choice(g.Dimension, g.Num, g.Color, g.Url, g.Call, g.Paren, g.Quoted, g.anyValue)

  const Dimension = node('Dimension', sequence(numPart, regex(/-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*|%/)), (c, _fields, s, r, tl) => mk('Dimension', c, r, s, tl))
  const Num = node('Num', regex(/[+-]?(?:\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?|\d+)(?![a-zA-Z\u0080-\uffff%])/), (c, _fields, s, r, tl) => mk('Num', c, r, s, tl))
  const Color = node('Color', colorHex, (c, _fields, s, r, tl) => mk('Color', c, r, s, tl))
  const Url = node('Url',
    parser({ trivia: rw }, sequence(urlOpen, optional(choice(singleStr, doubleStr, urlInner)), literal(')'))),
    (c, _fields, s, r, tl) => mk('Url', c, r, s, tl))
  const parenBody = parser({ trivia: rw }, sequence(optional(g.valueList), literal(')')))
  const Call = node('Call', parser({ trivia: rw }, sequence(ident, optional(sequence(literal('('), g.parenBody)))), (c, _fields, s, r, tl) => mk('Call', c, r, s, tl))
  const Paren = node('Paren', parser({ trivia: rw }, sequence(literal('('), g.parenBody)), (c, _fields, s, r, tl) => mk('Paren', c, r, s, tl))
  const Quoted = node('Quoted', choice(singleStr, doubleStr), (c, _fields, s, r, tl) => mk('Quoted', c, r, s, tl))
  const anyValue = anyValueTok

  const atPrelude = optional(scanTo(choice(literal('{'), literal(';')), {
    skip: [balanced('(', ')'), balanced('[', ']'), singleStr, doubleStr],
  }))
  const AtRuleBlock = node('AtRuleBlock',
    parser({ trivia: rw }, sequence(atKeyword, atPrelude, literal('{'), g.atRuleBody, literal('}'))),
    (c, _fields, s, r, tl) => mk('AtRuleBlock', c, r, s, tl))
  const AtRuleStatement = node('AtRuleStatement',
    parser({ trivia: rw }, sequence(atKeyword, atPrelude, literal(';'))),
    (c, _fields, s, r, tl) => mk('AtRuleStatement', c, r, s, tl))
  const atRuleBody = parser({ trivia: rw }, many(choice(
    g.AtRuleBlock, g.AtRuleStatement, g.Ruleset, g.Declaration, g.CustomDeclaration, literal(';'),
  )))

  return {
    Stylesheet, Ruleset, SelectorList, ComplexSelector, CompoundSelector, simpleSelector,
    AttributeSelector, PseudoSelector, pseudoArg,
    Declaration, CustomDeclaration, declarationList,
    valueList, valueSequence, value, parenBody,
    Dimension, Num, Color, Url, Call, Paren, Quoted, anyValue,
    AtRuleBlock, AtRuleStatement, atRuleBody,
  }
})

export type CssParseResult = {
  tree: CssNode
  errors: Array<{ message: string; offset?: number }>
  trivia: { entries: number }
}

function finishCssParse(
  input: string,
  r: ParseResult<unknown>,
  triviaLog: number[],
): CssParseResult {
  const tree: CssNode = r.ok && typeof r.value === 'object' && r.value !== null && (r.value as CssNode)._tag === 'node'
    ? r.value as CssNode
    : nilNode()
  const errors: Array<{ message: string; offset?: number }> = []
  if (!r.ok) {
    errors.push({ message: (r.expected ?? []).join(', ') || 'Parse error', offset: r.span?.start })
  }
  return { tree, errors, trivia: buildLazyTriviaMap(triviaLog, input) }
}

/** Interpreted — full CST + trivia capture (jess parseCssFn shape). */
export function parseCss(input: string): CssParseResult {
  const triviaLog: number[] = []
  const ctx = { trackLines: false, _triviaLog: triviaLog }
  return finishCssParse(input, Stylesheet.parse(input, 0, ctx), triviaLog)
}

export const compiledCss = compile(Stylesheet)

/** Compiled — full CST + trivia capture (jess parseCssFn shape). */
export function parseCssCompiled(input: string): CssParseResult {
  const triviaLog: number[] = []
  const ctx = { trackLines: false, _triviaLog: triviaLog }
  return finishCssParse(input, compiledCss.parseWithContext(input, ctx, 0), triviaLog)
}
