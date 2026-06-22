import type { Combinator, ParseContext, ParseResult, ParserMeta, ParseError } from '../types.ts'

export type { ParseError }

/**
 * Error-recovery combinator. Tries `parser`; on success returns normally.
 * On failure, scans forward one character at a time until `sentinel` matches
 * (or EOF), then returns a ParseError node spanning the skipped range.
 * The sentinel is NOT consumed — the caller's grammar continues from there.
 *
 * Intended for IDE/incremental parsers that must produce a result even on
 * broken input. The error path is not optimized; use only where recovery
 * is genuinely needed, not on hot paths.
 *
 *   const stmt = choice(
 *     ifStmt, whileStmt,
 *     recover(exprStmt, literal(';'))
 *   )
 */
export function recover<T>(
  parser: Combinator<T>,
  sentinel: Combinator<unknown>,
): Combinator<T | ParseError> {
  const meta: ParserMeta = {
    firstSet: { kind: 'any' },
    canMatchNewline: true,
    isTrivia: false,
  }
  return {
    _tag: 'recover',
    _meta: meta,
    _def: { tag: 'recover', parser: parser as Combinator<unknown>, sentinel },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T | ParseError> {
      const result = parser.parse(input, pos, ctx)
      if (result.ok) return result as ParseResult<T | ParseError>

      let scanPos = pos
      while (scanPos < input.length) {
        if (sentinel.parse(input, scanPos, ctx).ok) break
        scanPos++
      }

      const error: ParseError = {
        _tag: 'parseError',
        span: { start: pos, end: scanPos },
        expected: result.expected,
      }
      return { ok: true, value: error, span: { start: pos, end: scanPos } }
    },
  }
}

export function isParseError(value: unknown): value is ParseError {
  return typeof value === 'object' && value !== null && (value as ParseError)._tag === 'parseError'
}
