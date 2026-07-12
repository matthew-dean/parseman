import type { Combinator, ParseFail, ParseContext, ParseResult, RecoveryHelpers } from '../types.ts'
import { recoverScan, matchesAt, orSentinel, firstSetSentinel } from '../recovery/scan.ts'

/** Recovery helpers for a COMPILED tolerant completion probe (see run.ts). */
const REC: RecoveryHelpers = { scan: recoverScan, at: matchesAt, or: orSentinel, sentinel: firstSetSentinel }

/** Anything `completionsAt` can probe: an interpreter combinator OR a `compile()`d
 * grammar. A grammar compiled with `{ recovery: true }` records the probe on its fast
 * path, so completions work on the published compiled artifact — no interpreter needed. */
type CompletionsTarget =
  | Combinator<unknown>
  | { parseWithContext(input: string, ctx: ParseContext, pos?: number): ParseResult<unknown> }

/**
 * Returns the set of expected tokens at the given cursor offset.
 * Useful for implementing IDE completions.
 *
 * Runs the parser on input truncated at `offset` with a probe that tracks the
 * highest-position failure seen, even when sepBy/many backtrack past the cursor.
 * Returns the expected tokens from that deepest failure.
 *
 * Works on the interpreter combinator OR a `compile(g, { recovery: true })` grammar
 * (the probe is recorded on the compiled fast path). Returns an empty array when the
 * input up to `offset` parses completely with no failures at or before the cursor.
 *
 * The returned strings use the same labels as ParseFail.expected:
 * quoted literals like `"\"{\""` and regex patterns like `"/[0-9]+/"`.
 */
export function completionsAt(
  target: CompletionsTarget,
  input: string,
  offset: number,
  options: { tolerant?: boolean } = {},
): string[] {
  const probe: { offset: number; best: ParseFail | null } = { offset, best: null }
  // In tolerant mode, list recovery keeps the enclosing node parsing past a bad
  // element so the failure at the cursor is actually recorded — the completion set
  // is otherwise empty when a permissive top rule "succeeds" with an unconsumed tail.
  const ctx: ParseContext = { trackLines: false, _probe: probe, ...(options.tolerant ? { _tolerant: true, _rec: REC } : {}) }
  const sliced = input.slice(0, offset)
  const result = 'parseWithContext' in target
    ? target.parseWithContext(sliced, ctx, 0)
    : target.parse(sliced, 0, ctx)

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
