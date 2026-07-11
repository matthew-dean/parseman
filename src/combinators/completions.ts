import type { Combinator, ParseFail, ParseContext } from '../types.ts'

/**
 * Returns the set of expected tokens at the given cursor offset.
 * Useful for implementing IDE completions.
 *
 * Runs the parser on input truncated at `offset` with a probe that tracks the
 * highest-position failure seen, even when sepBy/many backtrack past the cursor.
 * Returns the expected tokens from that deepest failure.
 *
 * Returns an empty array when the input up to `offset` parses completely
 * with no failures at or before the cursor.
 *
 * The returned strings use the same labels as ParseFail.expected:
 * quoted literals like `"\"{\""` and regex patterns like `"/[0-9]+/"`.
 */
export function completionsAt(
  combinator: Combinator<unknown>,
  input: string,
  offset: number,
  options: { tolerant?: boolean } = {},
): string[] {
  const probe: { offset: number; best: ParseFail | null } = { offset, best: null }
  // In tolerant mode, list recovery keeps the enclosing node parsing past a bad
  // element so the failure at the cursor is actually recorded — the completion set
  // is otherwise empty when a permissive top rule "succeeds" with an unconsumed tail.
  const ctx: ParseContext = { trackLines: false, _probe: probe, ...(options.tolerant ? { _tolerant: true } : {}) }
  const result = combinator.parse(input.slice(0, offset), 0, ctx)

  // If the parser consumed everything up to offset successfully, there is nothing
  // to complete — the input is already valid at this position. In tolerant mode the
  // parse "succeeds" (list recovery swallowed the incomplete element at the cursor),
  // so the meaningful expectation lives in the deepest failure the probe recorded
  // while recovering: return that instead of an empty set.
  if (result.ok) return options.tolerant ? (probe.best?.expected ?? []) : []

  // Use whichever failure (probe or top-level) sits at the deeper position.
  const best = deeperFail(probe.best, result)
  return best?.expected ?? []
}

function deeperFail(a: ParseFail | null, b: ParseFail | null): ParseFail | null {
  if (!a) return b
  if (!b) return a
  return a.span.start >= b.span.start ? a : b
}
