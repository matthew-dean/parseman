import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { markUnusedValues } from '../compiler/value-usage.ts'
import { createParseContext } from '../parse-context.ts'
import { scalarOf, scalarResult } from './scalar.ts'

export type ParseOptions = {
  trackLines?: boolean
  recover?: boolean
}

export type ParserOptions = ParseOptions & {
  trivia?: Combinator<unknown> | null
  rootCapture?: 'opaque'
  captureTrivia?: boolean
  captureTriviaKinds?: readonly string[]
}

export interface ParsemanParser<T> extends Combinator<T> {
  parse(input: string): ParseResult<T>
  parse(input: string, pos: number, ctx: ParseContext): ParseResult<T>
}

export function parser<T>(opts: ParserOptions, root: Combinator<T>): ParsemanParser<T> {
  const clearTrivia = opts.trivia === null
  const opaqueRootCapture = opts.rootCapture === 'opaque'
  if (opaqueRootCapture && opts.trivia === undefined) {
    throw new TypeError('parser({ rootCapture: \'opaque\' }) requires an explicit trivia scope.')
  }
  const scopeTrivia = clearTrivia ? undefined : (opts.trivia ?? undefined)
  const scopeLabels = scopeTrivia?._meta?.triviaKindLabels
  const trackLinesPolicy = opts.trackLines === true ? 'on'
    : opts.trackLines === false ? 'off' : 'inherit'
  const captureKinds = clearTrivia ? undefined : opts.captureTriviaKinds
  const {
    triviaKindLabels: _inheritedTriviaKindLabels,
    rootTriviaClassified: _inheritedRootTriviaClassified,
    ...rootMeta
  } = root._meta
  const rootScalar = scalarOf(root)
  const parseScalar = (input: string, pos: number, ctx: ParseContext): number => {
    const savedTrivia = ctx.trivia
    const savedLabels = ctx.triviaKindLabels
    if (clearTrivia) {
      ctx.trivia = undefined
      ctx.triviaKindLabels = undefined
    } else if (scopeTrivia !== undefined) {
      ctx.trivia = scopeTrivia
      ctx.triviaKindLabels = scopeLabels
    }
    const end = rootScalar(input, pos, ctx)
    ctx.trivia = savedTrivia
    ctx.triviaKindLabels = savedLabels
    return end
  }

  return {
    _tag: 'grammar',
    _meta: {
      ...rootMeta,
      ...(scopeLabels ? { triviaKindLabels: scopeLabels } : {}),
      ...(scopeTrivia?._meta?.rootTriviaClassified ? { rootTriviaClassified: true as const } : {}),
    },
    _def: {
      tag: 'grammar',
      parser: root as Combinator<unknown>,
      triviaParser: scopeTrivia,
      clearTrivia,
      ...(opaqueRootCapture ? { rootCapture: 'opaque' as const } : {}),
      ...(opts.captureTrivia ? { captureTrivia: true } : {}),
      trackLines: opts.trackLines ?? false,
      constructionTrackLines: trackLinesPolicy,
      ...(captureKinds === undefined ? {} : { constructionCaptureTriviaKinds: captureKinds }),
    },
    _parseScalar: parseScalar,
    parse(input: string, pos?: number, ctx?: ParseContext): ParseResult<T> {
      const start = pos ?? 0
      const context = ctx ?? createParseContext()
      return scalarResult(parseScalar(input, start, context), start, context)
    },
  }
}

export function noTrivia<T>(root: Combinator<T>): ParsemanParser<T> {
  return parser({ trivia: null }, root)
}

const _analyzed = new WeakSet<Combinator<unknown>>()

export function parse<T>(
  combinator: Combinator<T>, input: string, _opts: ParseOptions = {},
): ParseResult<T> {
  if (!_analyzed.has(combinator)) {
    _analyzed.add(combinator)
    markUnusedValues(combinator)
  }
  const ctx = createParseContext()
  const grammarTrivia = combinator._meta.grammarTrivia
  if (grammarTrivia !== undefined) {
    ctx.trivia = grammarTrivia
    ctx.triviaKindLabels = grammarTrivia._meta.triviaKindLabels
  }
  ctx.scanSkip = combinator._meta.grammarScanSkip
  return scalarResult(scalarOf(combinator)(input, 0, ctx), 0, ctx)
}
