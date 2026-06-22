import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { fromChar, empty } from './first-set.ts'

let _collatorCache: Intl.Collator | null = null
function collator(): Intl.Collator {
  if (_collatorCache === null) {
    _collatorCache = new Intl.Collator(undefined, { sensitivity: 'accent' })
  }
  return _collatorCache
}

export type LiteralOptions = {
  caseInsensitive?: boolean
}

export function literal(value: string, opts: LiteralOptions = {}): Combinator<string> {
  const caseInsensitive = opts.caseInsensitive ?? false

  const firstSet = value.length > 0
    ? fromChar(value.codePointAt(0)!)
    : empty()

  const meta: ParserMeta = {
    firstSet,
    canMatchNewline: value.includes('\n'),
    isTrivia: false,
  }

  if (caseInsensitive) {
    const upper = value.toUpperCase()
    const lower = value.toLowerCase()
    const firstUpper = upper.codePointAt(0)
    const firstLower = lower.codePointAt(0)
    meta.firstSet = firstLower !== undefined && firstUpper !== undefined
      ? { kind: 'ranges', ranges: [
          { lo: Math.min(firstLower, firstUpper), hi: Math.max(firstLower, firstUpper) }
        ]}
      : firstSet
  }

  return {
    _tag: 'literal',
    _meta: meta,
    _def: { tag: 'literal', value, caseInsensitive },
    parse(input: string, pos: number, _ctx: ParseContext): ParseResult<string> {
      const end = pos + value.length
      if (end > input.length) {
        return { ok: false, expected: [JSON.stringify(value)], span: { start: pos, end: pos } }
      }
      const slice = input.slice(pos, end)
      const matched = caseInsensitive
        ? collator().compare(slice, value) === 0
        : slice === value
      if (matched) {
        const span = { start: pos, end }
        const leaf = { _tag: 'leaf', value: slice, span }
        if (_ctx._cstLeaves) (_ctx._cstLeaves as typeof leaf[]).push(leaf)
        if (_ctx._cstRawChildren) (_ctx._cstRawChildren as typeof leaf[]).push(leaf)
        return { ok: true, value: slice, span }
      }
      return { ok: false, expected: [JSON.stringify(value)], span: { start: pos, end: pos } }
    },
  }
}
