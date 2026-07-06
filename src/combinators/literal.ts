import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { fromChar, empty } from './first-set.ts'
import { failAt } from './probe.ts'
import { pushCstLeaf, cstCaptureActive } from '../cst/capture-buffer.ts'

/**
 * ASCII case-fold equality — the interpreter twin of the compiler's `foldEq`
 * (and `/i`-flag regex lowering). Folds ASCII letters via bit 0x20, exact-matches
 * everything else. Deliberately NOT `Intl.Collator` (measured ~9× slower, and its
 * Unicode accent-folding is the wrong semantic for a parser). Keeps interpreter /
 * compiled / macro output identical for case-insensitive `literal()`.
 */
function asciiFoldEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    let ca = a.charCodeAt(i)
    let cb = b.charCodeAt(i)
    if (ca >= 65 && ca <= 90) ca += 32
    if (cb >= 65 && cb <= 90) cb += 32
    if (ca !== cb) return false
  }
  return true
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
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
      const end = pos + value.length
      if (end > input.length) {
        return failAt(ctx, [JSON.stringify(value)], pos)
      }
      const slice = input.slice(pos, end)
      const matched = caseInsensitive
        ? asciiFoldEq(slice, value)
        : slice === value
      if (matched) {
        const span = { start: pos, end }
        const leaf = { _tag: 'leaf', value: slice, span }
        if (cstCaptureActive(ctx)) pushCstLeaf(ctx, leaf)
        return { ok: true, value: slice, span }
      }
      return failAt(ctx, [JSON.stringify(value)], pos)
    },
  }
}
