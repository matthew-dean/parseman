/**
 * Automatic list recovery — tolerant `sepBy` / `many` for editor-grade parsing.
 *
 * Plain `sepBy` / `many` stop at the first item they can't parse. Inside a
 * delimited list (`[ … ]`, `{ … }`, an argument list) that means one malformed
 * element truncates the whole list, which is exactly the wrong behavior for an
 * IDE re-parsing broken input. These variants instead skip a bad element up to
 * the next separator (or the list terminator), record a `ParseError` in its
 * place, and keep going — so the rest of the list still parses.
 *
 * They are built entirely from existing combinators (`recover`, `sepBy`, `many`,
 * `not`, `sequence`, `transform`), so the compiler and CST capture handle them
 * with no special cases — the macro build behaves identically to the interpreter.
 *
 * The `until` terminator (the list's closing delimiter, matched but not consumed)
 * is required: it's how an *empty* list is told apart from a *malformed* first
 * element. `until` must not overlap with what a valid item can start with.
 */
import type { Combinator } from '../types.ts'
import { sequence } from './sequence.ts'
import { choice } from './choice.ts'
import { many, sepBy } from './repeat.ts'
import { not } from './not.ts'
import { recover, type ParseError } from './recover.ts'
import { transform } from './map.ts'

/**
 * One tolerant element: fail cleanly at the terminator (so the list can end),
 * otherwise parse the item or recover the junk before it up to `sentinel`.
 */
function tolerantElement<T>(
  item: Combinator<T>,
  sentinel: Combinator<unknown>,
  until: Combinator<unknown>,
): Combinator<T | ParseError> {
  const el = transform(
    sequence(not(until), recover(item, sentinel)),
    ([, value]) => value,
  )
  // Let the macro inline this library-internal unwrap instead of embedding the
  // closure (codegen reads map-fn source from def.fnSrc; see balanced()).
  if (el._def.tag === 'transform') el._def.fnSrc = '([, value]) => value'
  return el as Combinator<T | ParseError>
}

/**
 * Like `sepBy`, but tolerant: a malformed element is skipped up to the next
 * `separator` or `until` and recorded as a `ParseError` in the result array,
 * instead of ending the list. An empty list (next token is `until`) yields `[]`
 * with no error.
 *
 *   const elements = sepByRecover(value, literal(','), literal(']'))
 *   const array = sequence(literal('['), elements, literal(']'))
 *   // "[1,,3]" → [1, ParseError, 3] ; error collected via { recover: true }
 */
export function sepByRecover<T>(
  item: Combinator<T>,
  separator: Combinator<unknown>,
  until: Combinator<unknown>,
): Combinator<(T | ParseError)[]> {
  const sentinel = choice(separator, until)
  return sepBy(tolerantElement(item, sentinel, until), separator)
}

/**
 * Like `many`, but tolerant: junk that isn't a valid item (and isn't the `until`
 * terminator) is skipped up to `until` and recorded as a `ParseError`, instead
 * of stopping the repetition. With no separator to resync on, a bad run is
 * captured as a single error up to the terminator.
 *
 *   const items = manyRecover(statement, literal('}'))
 */
export function manyRecover<T>(
  item: Combinator<T>,
  until: Combinator<unknown>,
): Combinator<(T | ParseError)[]> {
  return many(tolerantElement(item, until, until))
}
