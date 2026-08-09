import {
  choice, classifiedTrivia, dispatch, endsWith, literal, makeWhen, matches, node, noTrivia, optional,
  otherwise, regex, routed, rules, sequence, token, transform, when,
  type Combinator,
} from '../../src/index.ts'

/**
 * The token-stream contract is deliberately expressed without compiler/table
 * implementation types.  Planner and runtime experiments may change their
 * packing, but they must keep these three identities separate:
 *
 *  - a family owns one atomic source range language;
 *  - an outcome is global within that family and parser-free;
 *  - an ordered site route owns the continuation, commitment and routed span.
 */
export type TokenPredicate =
  | { readonly kind: 'exact'; readonly value: string; readonly ci?: true }
  | { readonly kind: 'suffix'; readonly value: string; readonly ci?: true }
  | { readonly kind: 'regex'; readonly source: string; readonly flags: string }
  | { readonly kind: 'otherwise'; readonly excluding: readonly string[] }

export type TokenOutcomeContract = {
  readonly id: string
  readonly family: string
  readonly predicate: TokenPredicate
}

export type TokenRouteContract = {
  /** Site-local PEG arm identity. Never replace this with parser identity. */
  readonly index: number
  readonly accepted: readonly string[]
  readonly continuation: string
  readonly routed: boolean
}

export type TokenSiteContract = {
  readonly id: string
  readonly family: string
  readonly outcomes: readonly string[]
  readonly routes: readonly TokenRouteContract[]
  readonly noRoute?: readonly string[]
}

export type TokenFamilyContract = {
  readonly id: string
  readonly language: string
  readonly atomicRange: true
  readonly refusesSharingWith: readonly string[]
}

const family = (
  id: string, language: string, refusesSharingWith: readonly string[] = [],
): TokenFamilyContract => ({ id, language, atomicRange: true, refusesSharingWith })

export const JESS_TOKEN_FAMILIES = Object.freeze({
  cssIdentOrFunction: family(
    'css-ident-or-function',
    'CSS Identifier (escapes included) followed by an optional glued "("',
    ['less-interpolated-ident-or-function', 'css-query-ident-or-function'],
  ),
  lessIdentOrFunction: family(
    'less-interpolated-ident-or-function',
    'Less InterpolatedValueStart (unescaped prefix only) followed by an optional glued "("',
    ['css-ident-or-function', 'less-at-prelude-ident-or-function'],
  ),
  cssPseudo: family(
    'css-pseudo-ident-or-function',
    'CSS Identifier (escapes included) followed by an optional glued "(" after the colon token',
    ['less-pseudo-open'],
  ),
  lessPseudo: family(
    'less-pseudo-open',
    'one or two colons plus an unescaped Less identifier and optional glued "("',
    ['css-pseudo-ident-or-function'],
  ),
  cssQuery: family(
    'css-query-ident-or-function',
    'CSS Identifier plus optional glued "(", excluding reserved bare query keywords',
    ['css-ident-or-function', 'less-query-ident-or-function'],
  ),
  lessQuery: family(
    'less-query-ident-or-function',
    'Less query identifier plus optional glued "(", excluding url(',
    ['css-query-ident-or-function', 'less-interpolated-ident-or-function'],
  ),
  cssAtKeyword: family(
    'css-at-rule-keyword',
    'CSS at-identifier after the authored reserved/import/conditional exclusions',
    ['less-at-rule-name', 'css-generic-at-rule-name', 'css-statement-at-rule-name'],
  ),
  cssGenericAtName: family(
    'css-generic-at-rule-name',
    'CSS at-identifier excluding typed, conditional and import names',
    ['css-at-rule-keyword', 'css-statement-at-rule-name'],
  ),
  cssStatementAtName: family(
    'css-statement-at-rule-name',
    'CSS at-identifier excluding import',
    ['css-at-rule-keyword', 'css-generic-at-rule-name'],
  ),
  lessAtPrelude: family(
    'less-at-prelude-ident-or-function',
    'unescaped static Less identifier followed by optional glued "("',
    ['less-interpolated-ident-or-function'],
  ),
  lessAtName: family(
    'less-at-rule-name',
    'unescaped Less at-identifier after Less-specific exclusions',
    ['css-at-rule-keyword'],
  ),
  mediaContainerHeader: family(
    'media-container-at-keyword',
    'the atomic @media or @container keyword range',
  ),
  numeric: family(
    'css-less-numeric',
    'one maximal glued NumberToken plus optional DimensionUnit or percent suffix',
    ['any numeric spelling containing trivia/comment between number and suffix'],
  ),
} satisfies Record<string, TokenFamilyContract>)

const exact = (id: string, fam: string, value: string, ci = false): TokenOutcomeContract => ({
  id, family: fam, predicate: { kind: 'exact', value, ...(ci ? { ci: true as const } : {}) },
})
const suffix = (id: string, fam: string, value: string, ci = false): TokenOutcomeContract => ({
  id, family: fam, predicate: { kind: 'suffix', value, ...(ci ? { ci: true as const } : {}) },
})
const other = (id: string, fam: string, excluding: readonly string[]): TokenOutcomeContract => ({
  id, family: fam, predicate: { kind: 'otherwise', excluding },
})

const CSS = JESS_TOKEN_FAMILIES.cssIdentOrFunction.id
const LESS = JESS_TOKEN_FAMILIES.lessIdentOrFunction.id
const NUM = JESS_TOKEN_FAMILIES.numeric.id
const CSS_PSEUDO = JESS_TOKEN_FAMILIES.cssPseudo.id
const LESS_PSEUDO = JESS_TOKEN_FAMILIES.lessPseudo.id
const CSS_QUERY = JESS_TOKEN_FAMILIES.cssQuery.id
const LESS_QUERY = JESS_TOKEN_FAMILIES.lessQuery.id
const CSS_AT = JESS_TOKEN_FAMILIES.cssAtKeyword.id
const LESS_AT_PRELUDE = JESS_TOKEN_FAMILIES.lessAtPrelude.id
const LESS_AT_NAME = JESS_TOKEN_FAMILIES.lessAtName.id
const MEDIA = JESS_TOKEN_FAMILIES.mediaContainerHeader.id

/**
 * Representative global outcomes. Exact grouped keys are intentionally split
 * value-by-value: a site groups IDs into one route, never into one outcome.
 */
export const JESS_TOKEN_OUTCOMES = Object.freeze([
  exact('css:url-open', CSS, 'url(', true),
  exact('css:var-open', CSS, 'var(', true),
  exact('css:calc-open', CSS, 'calc(', true),
  suffix('css:function-open', CSS, '('),
  other('css:value-ident', CSS, ['css:url-open', 'css:var-open', 'css:calc-open', 'css:function-open']),
  other('css:header-ident', CSS, ['css:url-open', 'css:function-open']),

  exact('less:url-open', LESS, 'url(', true),
  exact('less:calc-open', LESS, 'calc(', true),
  exact('less:each-open', LESS, 'each(', true),
  suffix('less:function-open', LESS, '('),
  {
    id: 'less:statement-function-open', family: LESS,
    predicate: { kind: 'regex', source: '^(?!(?:url|calc)\\($).+\\($', flags: 'i' },
  },
  other('less:value-ident', LESS, ['less:url-open', 'less:calc-open', 'less:function-open']),

  exact('css-pseudo:nth-child-open', CSS_PSEUDO, 'nth-child(', true),
  exact('css-pseudo:is-open', CSS_PSEUDO, 'is(', true),
  suffix('css-pseudo:function-open', CSS_PSEUDO, '('),
  other('css-pseudo:ident', CSS_PSEUDO, ['css-pseudo:nth-child-open', 'css-pseudo:is-open', 'css-pseudo:function-open']),

  suffix('css-query:function-open', CSS_QUERY, '('),
  other('css-query:ident', CSS_QUERY, ['css-query:function-open']),
  exact('less-query:calc-open', LESS_QUERY, 'calc(', true),
  suffix('less-query:function-open', LESS_QUERY, '('),
  other('less-query:ident', LESS_QUERY, ['less-query:calc-open', 'less-query:function-open']),

  exact('css-at:layer', CSS_AT, '@layer', true),
  exact('css-at:page', CSS_AT, '@page', true),
  other('css-at:generic', CSS_AT, ['css-at:layer', 'css-at:page']),
  exact('less-at-prelude:url-open', LESS_AT_PRELUDE, 'url(', true),
  exact('less-at-prelude:calc-open', LESS_AT_PRELUDE, 'calc(', true),
  suffix('less-at-prelude:function-open', LESS_AT_PRELUDE, '('),
  other('less-at-prelude:ident', LESS_AT_PRELUDE, [
    'less-at-prelude:url-open', 'less-at-prelude:calc-open', 'less-at-prelude:function-open',
  ]),
  exact('less-at-name:namespace', LESS_AT_NAME, '@namespace', true),
  exact('less-at-name:layer', LESS_AT_NAME, '@layer', true),
  other('less-at-name:generic', LESS_AT_NAME, ['less-at-name:namespace', 'less-at-name:layer']),
  exact('header:media', MEDIA, '@media', true),
  exact('header:container', MEDIA, '@container', true),

  exact('less-pseudo:is-open', LESS_PSEUDO, ':is(', true),
  suffix('less-pseudo:function-open', LESS_PSEUDO, '('),
  other('less-pseudo:bare', LESS_PSEUDO, ['less-pseudo:is-open', 'less-pseudo:function-open']),

  {
    id: 'numeric:number', family: NUM,
    predicate: { kind: 'regex', source: '^[+-]?(?:\\d*\\.\\d+(?:[eE][+-]?\\d+)?|\\d+(?:[eE][+-]?\\d+)?|\\d+)$', flags: '' },
  },
  {
    id: 'numeric:dimension', family: NUM,
    predicate: { kind: 'regex', source: '^[+-]?(?:\\d*\\.\\d+(?:[eE][+-]?\\d+)?|\\d+(?:[eE][+-]?\\d+)?|\\d+)-?[_a-z\\u0080-\\uffff][-_a-z0-9\\u0080-\\uffff]*$', flags: 'i' },
  },
  {
    id: 'numeric:percentage', family: NUM,
    predicate: { kind: 'regex', source: '^[+-]?(?:\\d*\\.\\d+(?:[eE][+-]?\\d+)?|\\d+(?:[eE][+-]?\\d+)?|\\d+)%$', flags: '' },
  },
] satisfies readonly TokenOutcomeContract[])

const route = (
  index: number, accepted: readonly string[], continuation: string, routed = true,
): TokenRouteContract => ({ index, accepted, continuation, routed })

/** Sites whose identity relationships are required by the real Jess grammars. */
export const JESS_TOKEN_SITES = Object.freeze([
  {
    id: 'css.Value', family: CSS,
    outcomes: ['css:url-open', 'css:var-open', 'css:calc-open', 'css:function-open', 'css:value-ident'],
    routes: [
      route(0, ['css:url-open'], 'UrlFunction'),
      route(1, ['css:calc-open'], 'MathFunction'),
      route(2, ['css:var-open'], 'VarFunction'),
      route(3, ['css:function-open'], 'GenericFunction'),
      route(4, ['css:value-ident'], 'IdentBlockOrKeyword'),
    ],
  },
  {
    id: 'css.TypedValue/Header', family: CSS,
    outcomes: ['css:url-open', 'css:function-open', 'css:header-ident'],
    routes: [
      route(0, ['css:url-open'], 'TypedUrl'),
      route(1, ['css:function-open'], 'TypedGenericFunction'),
      route(2, ['css:header-ident'], 'TypedIdentifier'),
    ],
  },
  {
    id: 'less.Value', family: LESS,
    outcomes: ['less:url-open', 'less:calc-open', 'less:function-open', 'less:value-ident'],
    routes: [
      route(0, ['less:url-open'], 'URL'),
      route(1, ['less:calc-open'], 'CalcFunction'),
      route(2, ['less:function-open'], 'GenericFunction'),
      route(3, ['less:value-ident'], 'Identifier'),
    ],
  },
  {
    id: 'less.FunctionStatement', family: LESS,
    outcomes: ['less:each-open', 'less:statement-function-open'],
    routes: [
      route(0, ['less:each-open'], 'EachFunctionStatement'),
      route(1, ['less:statement-function-open'], 'GenericFunctionStatement'),
    ],
    noRoute: ['IDENT', 'url(', 'calc(', 'malformed opener'],
  },
  {
    id: 'css.PseudoSelector', family: CSS_PSEUDO,
    outcomes: ['css-pseudo:nth-child-open', 'css-pseudo:is-open', 'css-pseudo:function-open', 'css-pseudo:ident'],
    routes: [
      route(0, ['css-pseudo:nth-child-open'], 'PseudoArgument'),
      route(1, ['css-pseudo:is-open'], 'SelectorArgument'),
      route(2, ['css-pseudo:function-open'], 'GenericPseudoArgument'),
      route(3, ['css-pseudo:ident'], 'BarePseudo'),
    ],
  },
  {
    id: 'css.QueryTerm', family: CSS_QUERY,
    outcomes: ['css-query:function-open', 'css-query:ident'],
    routes: [route(0, ['css-query:function-open'], 'QueryFunction'), route(1, ['css-query:ident'], 'QueryKeyword')],
    noRoute: ['reserved bare layer', 'reserved bare only'],
  },
  ...(['css.DeclarationListAtRule', 'css.ConditionalGroupAtRule', 'css.StylesheetAtRule'] as const).map(id => ({
    id, family: CSS_AT,
    outcomes: ['css-at:layer', 'css-at:page', 'css-at:generic'],
    routes: [
      route(0, ['css-at:layer'], `${id}:Layer`),
      route(1, ['css-at:page'], `${id}:Page`),
      route(2, ['css-at:generic'], `${id}:Generic`),
    ],
  })),
  {
    id: 'less.QueryIdentOrFunction', family: LESS_QUERY,
    outcomes: ['less-query:calc-open', 'less-query:function-open', 'less-query:ident'],
    routes: [
      route(0, ['less-query:calc-open'], 'CalcFunction'),
      route(1, ['less-query:function-open'], 'GenericFunction'),
      route(2, ['less-query:ident'], 'QueryKeyword'),
    ],
    noRoute: ['url('],
  },
  {
    id: 'less.AtRulePreludeIdentOrFunction', family: LESS_AT_PRELUDE,
    outcomes: [
      'less-at-prelude:url-open', 'less-at-prelude:calc-open',
      'less-at-prelude:function-open', 'less-at-prelude:ident',
    ],
    routes: [
      route(0, ['less-at-prelude:url-open'], 'RoutedPlainUrl'),
      route(1, ['less-at-prelude:calc-open'], 'CalcFunction'),
      route(2, ['less-at-prelude:function-open'], 'GenericFunction'),
      route(3, ['less-at-prelude:ident'], 'AtRulePreludeKeyword'),
    ],
  },
  {
    id: 'less.AtRuleStatement', family: LESS_AT_NAME,
    outcomes: ['less-at-name:namespace', 'less-at-name:layer', 'less-at-name:generic'],
    routes: [
      route(0, ['less-at-name:namespace'], 'NamespaceAtRule'),
      route(1, ['less-at-name:layer'], 'LayerAtRule'),
      route(2, ['less-at-name:generic'], 'GenericAtRule'),
    ],
  },
  {
    id: 'less.MediaContainerBlock', family: MEDIA,
    outcomes: ['header:media', 'header:container'],
    routes: [route(0, ['header:media'], 'MediaBlock'), route(1, ['header:container'], 'ContainerBlock')],
  },
  ...(['less.PseudoSelector', 'less.StaticPseudoDispatch'] as const).map(id => ({
    id, family: LESS_PSEUDO,
    outcomes: ['less-pseudo:is-open', 'less-pseudo:function-open', 'less-pseudo:bare'],
    routes: [
      route(0, ['less-pseudo:is-open'], `${id}:SelectorArgument`),
      route(1, ['less-pseudo:function-open'], `${id}:FunctionArgument`),
      route(2, ['less-pseudo:bare'], `${id}:Bare`),
    ],
  })),
  {
    id: 'css-less.NumericDimension', family: NUM,
    outcomes: ['numeric:number', 'numeric:dimension'],
    routes: [route(0, ['numeric:number', 'numeric:dimension'], 'DimensionMaterializer', false)],
    noRoute: ['numeric:percentage'],
  },
  {
    id: 'css-less.NumericPercentage', family: NUM,
    outcomes: ['numeric:percentage'],
    routes: [route(0, ['numeric:percentage'], 'PercentageMaterializer', false)],
    noRoute: ['numeric:number', 'numeric:dimension'],
  },
] satisfies readonly TokenSiteContract[])

export function outcomeById(id: string): TokenOutcomeContract {
  const found = JESS_TOKEN_OUTCOMES.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`unknown token outcome ${JSON.stringify(id)}`)
  return found
}

function fold(value: string): string { return value.replace(/[A-Z]/g, c => c.toLowerCase()) }

export function predicateMatches(predicate: TokenPredicate, value: string): boolean {
  switch (predicate.kind) {
    case 'exact': return (predicate.ci ? fold(value) : value) === (predicate.ci ? fold(predicate.value) : predicate.value)
    case 'suffix': return (predicate.ci ? fold(value) : value).endsWith(predicate.ci ? fold(predicate.value) : predicate.value)
    case 'regex': return new RegExp(predicate.source, predicate.flags).test(value)
    case 'otherwise': return predicate.excluding.every(id => !predicateMatches(outcomeById(id).predicate, value))
  }
}

export function compatibleOutcomeIds(site: TokenSiteContract, value: string): string[] {
  return site.outcomes.filter(id => predicateMatches(outcomeById(id).predicate, value))
}

export function selectedRoute(site: TokenSiteContract, value: string): TokenRouteContract | undefined {
  const compatible = new Set(compatibleOutcomeIds(site, value))
  return site.routes.find(candidate => candidate.accepted.some(id => compatible.has(id)))
}

/* ── Jess-shaped source-authority fixture ─────────────────────────────── */

const cssName = regex(/-?(?:[_a-z]|[\u0080-\uffff]|\\[0-9a-f]{1,6}[ \t]?|\\[^\r\n0-9a-f])(?:[-_a-z0-9]|[\u0080-\uffff]|\\[0-9a-f]{1,6}[ \t]?|\\[^\r\n0-9a-f])*/i)
const lessName = regex(/-?[_a-z\u0080-\uffff][-_a-z0-9\u0080-\uffff]*/i)
const number = regex(/[+-]?(?:\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?|\d+)/)
const unit = regex(/-?[_a-zA-Z\u0080-\uffff](?:[-_a-zA-Z0-9\u0080-\uffff])*/)

const routedTail = (tail: string): Combinator<unknown> => sequence(routed(), literal(tail))

function valueDispatch(selector: Combinator<string>): Combinator<unknown> {
  const ci = makeWhen({ caseInsensitive: true })
  return dispatch(
    selector,
    ci(['url(', 'var(', 'calc('], routedTail(':x')),
    when(endsWith('('), routedTail(':f')),
    otherwise(routedTail(':i')),
  )
}

export function jessTokenContractGrammar(hostMode: 'ast' | 'cst' = 'ast') {
  const cssIdentOrFunction = token(noTrivia(sequence(cssName, optional(literal('(')))))
  const lessIdentOrFunction = token(noTrivia(sequence(lessName, optional(literal('(')))))
  const ci = makeWhen({ caseInsensitive: true })
  const genericStatement = routedTail(':s')
  const eachStatement = routedTail(':e')
  const duplicateBranch = routedTail(':d')
  const trivia = classifiedTrivia({
    whitespace: regex(/[ \t\r\n]+/),
    blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
  })

  return rules({ hostMode, trivia }, () => ({
    CssValue: valueDispatch(cssIdentOrFunction),
    CssHeader: dispatch(
      cssIdentOrFunction,
      ci('url(', routedTail(':u')),
      when(endsWith('('), routedTail(':h')),
      otherwise(routedTail(':n')),
    ),
    LessValue: dispatch(
      lessIdentOrFunction,
      ci('url(', routedTail(':u')),
      ci('calc(', routedTail(':c')),
      when(endsWith('('), routedTail(':f')),
      otherwise(routedTail(':i')),
    ),
    FunctionStatement: dispatch(
      lessIdentOrFunction,
      ci('each(', eachStatement),
      when(matches(/^(?!(?:url|calc)\($).+\($/i), genericStatement),
    ),
    DuplicateRoutes: dispatch(
      lessIdentOrFunction,
      when(endsWith('('), duplicateBranch),
      when(endsWith('('), routedTail(':z')),
    ),
    ReusedParserRoutes: dispatch(
      lessIdentOrFunction,
      when(matches(/^a/i), duplicateBranch),
      when(matches(/^b/i), duplicateBranch),
    ),
    CssPercentage: node('Dimension', noTrivia(sequence(number, literal('%'))), (_c, _f, span) => ({ kind: 'percentage', span })),
    CssDimension: node('Dimension', noTrivia(sequence(number, optional(unit))), (_c, _f, span) => ({ kind: 'dimension', span })),
    LessPercentage: transform(token(noTrivia(sequence(number, literal('%')))), value => ({ kind: 'percentage', value })),
    LessDimension: node('Dimension', noTrivia(sequence(number, optional(unit))), (_c, _f, span) => ({ kind: 'dimension', span })),
    NumericValue: choice(
      node('Percentage', noTrivia(sequence(number, literal('%')))),
      node('Dimension', noTrivia(sequence(number, optional(unit)))),
    ),
    TokenNode: node('TokenNode', sequence(literal('['), valueDispatch(cssIdentOrFunction), literal(']')),
      (children, _fields, span, rawChildren, triviaLog) => ({ children, rawChildren, span, triviaLog }),
      { captureTrivia: true }),
  }))
}

/** Contract cases used by every engine and by deliberate RED plants. */
export const JESS_TOKEN_CASES = Object.freeze({
  CssValue: ['url(:x', 'URL(:x', 'var(:x', 'calc(:x', 'ordinary(:f', 'name:i', '\\66 oo(:f', 'ordinary:x'],
  CssHeader: ['url(:u', 'ordinary(:h', 'name:n', 'calc(:h', 'url(:h'],
  LessValue: ['url(:u', 'calc(:c', 'ordinary(:f', 'each(:f', 'name:i', '@{x}(:f'],
  FunctionStatement: ['each(:e', 'EaCh(:e', 'ordinary(:s', 'url(:s', 'calc(:s', 'bare', 'each(:s', 'ordinary:x'],
  DuplicateRoutes: ['ordinary(:d', 'ordinary(:z', 'bare'],
  ReusedParserRoutes: ['alpha:d', 'beta:d', 'charlie:d'],
  CssPercentage: ['10%', '-.5%', '10 %', 'x'],
  CssDimension: ['10px', '-.5em', '10', '10 %', 'x'],
  LessPercentage: ['10%', '-.5%', '10 %', 'x'],
  LessDimension: ['10px', '-.5em', '10', '10 %', 'x'],
  NumericValue: ['10%', '10px', '10', '-.5em', 'x'],
  TokenNode: ['[ url(:x ]', '[\\66 oo(:f]', '[ ordinary:x ]'],
} satisfies Record<string, readonly string[]>)
