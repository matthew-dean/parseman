import type { LexicalOutcomeMatch } from '../compiler/token-alphabet.ts'

export type RuntimeRangeOutcomeKind =
  | 'direct'
  | 'ascii-prefix'
  | 'function-open-excluding-url-calc'

/**
 * The one proof boundary shared by the compiler and table runtime for outcome
 * predicates that can be decided from an already-recognized source range.
 *
 * Keep this module parser-free and allocation-free at parse time. The compiler
 * calls it before publishing a dispatch site; closure/emitted assemblers call
 * it only while rebuilding a program's matcher pool. Returning a matcher kind,
 * rather than merely a boolean, prevents those readers from duplicating the
 * two bounded-regex spelling proofs.
 */
export function runtimeRangeOutcomeKind(
  match: LexicalOutcomeMatch,
): RuntimeRangeOutcomeKind | undefined {
  if (match.kind !== 'matches') return 'direct'
  const rawFlags = match.caseInsensitive && !match.flags.includes('i') ? `${match.flags}i` : match.flags
  const flags = new RegExp('', rawFlags.replace(/g/g, '')).flags
  if (match.value === '^(?!(?:url|calc)\\($).+\\($' && flags === 'i') {
    return 'function-open-excluding-url-calc'
  }
  return /^\^([A-Za-z0-9_-]+)$/.test(match.value) && (flags === '' || flags === 'i')
    ? 'ascii-prefix'
    : undefined
}
