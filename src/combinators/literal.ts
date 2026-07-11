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
    // Two discrete points, not one spanning range — `asciiFoldEq` accepts only
    // the char and its fold twin, so `[min, max]` would over-approximate (e.g.
    // 'a'/'A' → the whole 65..97 span, pulling B–Z/`[\]^_\`` into dispatch).
    meta.firstSet = firstLower !== undefined && firstUpper !== undefined
      ? firstLower === firstUpper
        ? { kind: 'ranges', ranges: [{ lo: firstLower, hi: firstLower }] }
        : { kind: 'ranges', ranges: [
            { lo: firstLower, hi: firstLower },
            { lo: firstUpper, hi: firstUpper },
          ]}
      : firstSet
  }

  const expected = [JSON.stringify(value)]

  // Single-char case-sensitive literals are the bulk of punctuation-heavy
  // grammars (GraphQL `{ } ( ) : $ @ [ ] ! =`, JSON, CSS). A bare `charCodeAt`
  // compare beats the generic `startsWith` builtin call, and an out-of-bounds
  // `charCodeAt` returns NaN — so the length check folds into the compare.
  const parse = !caseInsensitive && value.length === 1
    ? (() => {
        const code = value.charCodeAt(0)
        return function parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
          if (input.charCodeAt(pos) === code) {
            const span = { start: pos, end: pos + 1 }
            if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value, span })
            return { ok: true, value, span }
          }
          return failAt(ctx, expected, pos)
        }
      })()
    : function parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
        const end = pos + value.length
        if (end > input.length) {
          return failAt(ctx, expected, pos)
        }
        const matchedValue = caseInsensitive ? input.slice(pos, end) : value
        if (caseInsensitive ? asciiFoldEq(matchedValue, value) : input.startsWith(value, pos)) {
          const span = { start: pos, end }
          if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: matchedValue, span })
          return { ok: true, value: matchedValue, span }
        }
        return failAt(ctx, expected, pos)
      }

  return {
    _tag: 'literal',
    _meta: meta,
    _def: { tag: 'literal', value, caseInsensitive },
    parse,
  }
}
