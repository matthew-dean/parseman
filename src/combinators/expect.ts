import type { Combinator, ParseContext, ParseResult, ParserMeta, ParseError } from '../types.ts'

export type { ParseError }

/**
 * Statically derive the "expected" token set from a combinator's structure,
 * so a failure can name what it wanted without running anything:
 *
 *   literal('}')        -> ['"}"']
 *   keywords(['a','b']) -> ['"a"', '"b"']
 *   choice(x, y)        -> expected(x) ++ expected(y)   (all alternatives)
 *   sequence(a, b, …)   -> expected(a)                  (only the first term can fail first)
 *   label('s', x)       -> ['s']                        (an explicit name wins)
 *
 * This is what lets expect() report a meaningful, IDENTICAL expectation in both
 * the interpreter and the compiled output (the compiled path does not rebuild the
 * runtime `expected` array, so it reads this precomputed set instead).
 */
export function deriveExpected(c: Combinator<unknown>): string[] {
  const def = c._def
  switch (def.tag) {
    case 'literal':   return [JSON.stringify(def.value)]
    case 'regex':     return [`/${def.source}/`]
    case 'keywords':  return def.words.map(w => JSON.stringify(w))
    case 'label':     return [def.label]
    case 'choice':    return def.parsers.flatMap(deriveExpected)
    case 'sequence':  return def.parsers.length > 0 ? deriveExpected(def.parsers[0]!) : []
    case 'node':
    case 'grammar':
    case 'trivia':
    case 'token':
    case 'optional':
    case 'many':
    case 'oneOrMore':
    case 'transform':
    case 'not':       return deriveExpected(def.parser)
    case 'lazy': {
      // An EXTERNAL ref (a rule from a composed base grammar) has no local
      // definition yet — its `thunk()` throws until fusion supplies it. Fall back
      // to the rule name as the expected label instead of descending.
      const name = (c as { _ruleName?: string })._ruleName
      try { return deriveExpected(def.thunk()) }
      catch { return name ? [name] : [] }
    }
    default:          return []
  }
}

/**
 * Required-token combinator. Tries `combinator`; on success returns it verbatim.
 * On failure it does NOT fail — it records a {@link ParseError} (the statically
 * derived expected set, or `label` when given) into `ctx._errors` and RECOVERS IN
 * PLACE, returning a zero-width success so the enclosing sequence continues as if
 * the token were present.
 *
 * Use it to mark required delimiters/terminators (`}` `)` `;`, a selector before a
 * block) so a missing one is reported with position + expectation rather than
 * aborting the whole parse or being silently swallowed by a catch-all.
 *
 *   sequence(literal('{'), declList, expect(literal('}')))
 *
 * Errors are only collected when the parse runs with `{ recover: true }`; without
 * it, expect() still recovers in place but records nothing (zero overhead beyond
 * the inner attempt).
 */
export function expect<T>(combinator: Combinator<T>, label?: string): Combinator<T | ParseError> {
  const expected = label !== undefined ? [label] : deriveExpected(combinator)
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  return {
    _tag: 'expect',
    _meta: meta,
    _def: { tag: 'expect', parser: combinator as Combinator<unknown>, label, expected },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T | ParseError> {
      const result = combinator.parse(input, pos, ctx)
      if (result.ok) return result as ParseResult<T | ParseError>
      const error: ParseError = { _tag: 'parseError', span: { start: pos, end: pos }, expected }
      ctx._errors?.push(error)
      return { ok: true, value: error, span: { start: pos, end: pos } }
    },
  }
}

/** True when `value` is a recovery {@link ParseError} node. */
export function isParseError(value: unknown): value is ParseError {
  return typeof value === 'object' && value !== null && (value as ParseError)._tag === 'parseError'
}
