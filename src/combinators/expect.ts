import type { Combinator, ParseContext, ParseResult, ParserMeta, ParseError } from '../types.ts'
import { captureError } from '../recovery/scan.ts'
import { matchesEmpty, isZeroWidthAssertion } from './first-set.ts'

export type { ParseError }

/**
 * Statically derive the "expected" token set from a combinator's structure,
 * so a failure can name what it wanted without running anything:
 *
 *   literal('}')        -> ['"}"']
 *   keywords(['a','b']) -> ['"a"', '"b"']
 *   choice(x, y)        -> expected(x) ++ expected(y)   (all alternatives)
 *   sequence(a, b, …)   -> expected(a) ++ … through the NULLABLE prefix
 *   label('s', x)       -> ['s']                        (an explicit name wins)
 *
 * This is what lets expect() report a meaningful, IDENTICAL expectation in both
 * the interpreter and the compiled output (the compiled path does not rebuild the
 * runtime `expected` array, so it reads this precomputed set instead).
 */
export function deriveExpected(c: Combinator<unknown>): string[] {
  return derive(c, new Set())
}

function derive(c: Combinator<unknown>, seen: Set<Combinator<unknown>>): string[] {
  const deriveExpected = (p: Combinator<unknown>): string[] => derive(p, seen)
  const def = c._def
  switch (def.tag) {
    case 'literal':   return [JSON.stringify(def.value)]
    case 'regex':     return [`/${def.source}/`]
    case 'keywords':  return def.words.map(w => JSON.stringify(w))
    case 'label':     return [def.label]
    case 'choice':    return def.parsers.flatMap(deriveExpected)
    // Union through the NULLABLE prefix, mirroring `sequenceFirstSet`. A leading
    // `optional(…)`/`many(…)` can match nothing, so the term after it is equally
    // able to fail first — deriving from term 0 alone named a token the parse
    // never actually required. A leading `not(…)` is zero-width and contributes
    // nothing (its own expectation is about what must NOT be here), but it is
    // nullable, so keep scanning past it. Stop at the first term that must match.
    case 'sequence': {
      const out: string[] = []
      for (const term of def.parsers) {
        if (!isZeroWidthAssertion(term)) out.push(...deriveExpected(term))
        if (!matchesEmpty(term)) break
      }
      return out
    }
    case 'attempt':   return deriveExpected(def.parser)
    // Delegating wrappers whose first-token failure is their inner parser's — must
    // pass through so a start-failure (and the first-set-miss fast-path in attempt/
    // node, which reads this) names the real expected token, not the wrapper tag.
    case 'field':
    case 'withCtx':
    case 'recover':   return deriveExpected(def.parser)
    case 'skip':      return deriveExpected(def.main)
    case 'expect':    return def.expected
    case 'node':
    case 'grammar':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'optional':
    case 'many':
    case 'oneOrMore':
    case 'transform':
    case 'not':
    case 'peek':     return deriveExpected(def.parser)
    case 'lazy': {
      // An EXTERNAL ref (a rule from a composed base grammar) has no local
      // definition yet — its `thunk()` throws until fusion supplies it. Fall back
      // to the rule name as the expected label instead of descending.
      const name = (c as { _ruleName?: string })._ruleName
      // Cycle guard: a RECURSIVE rule re-enters its own definition forever. Reaching
      // one is newly possible now that `sequence` derives through a nullable prefix
      // (`list = choice('end', sequence(optional(item), list))` — term-0-only
      // derivation used to stop short of the self-reference). Falling back to the rule
      // name, exactly as for an unresolved external ref, cuts the cycle. Removed again
      // on the way out, so a rule referenced twice NON-cyclically still derives fully.
      if (seen.has(c)) return name ? [name] : []
      seen.add(c)
      try { return deriveExpected(def.thunk()) }
      catch { return name ? [name] : [] }
      finally { seen.delete(c) }
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
      // Embed the missing-token error as a `parseError` CST child (no-op when CST
      // capture is off), so it rides the tree exactly like list-recovery errors —
      // a tree walk finds every diagnostic and the error survives incremental
      // reuse, rather than living only in the flat ctx._errors side-channel. Gated
      // on tolerant like the list-recovery embed sites, so a strict CST build is
      // byte-identical to before (and stays in parity with the compiled path,
      // which can only embed when the recovery bundle `_rec` is installed).
      if (ctx._tolerant) captureError(ctx, error)
      return { ok: true, value: error, span: { start: pos, end: pos } }
    },
  }
}

/** True when `value` is a recovery {@link ParseError} node. */
export function isParseError(value: unknown): value is ParseError {
  return typeof value === 'object' && value !== null && (value as ParseError)._tag === 'parseError'
}
