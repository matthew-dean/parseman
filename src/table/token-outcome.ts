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
  kind: LexicalOutcomeMatch['kind'],
  value = '',
  flags = '',
  caseInsensitive = false,
): RuntimeRangeOutcomeKind | undefined {
  if (kind !== 'matches') return 'direct'
  let folded = caseInsensitive
  for (let i = 0; i < flags.length; i++) {
    const flag = flags.charCodeAt(i)
    if (flag === 105) folded = true // i
    else if (flag !== 103) return undefined // g is stripped by the wire serializer
  }
  if (value === '^(?!(?:url|calc)\\($).+\\($' && folded) {
    return 'function-open-excluding-url-calc'
  }
  if (value.length < 2 || value.charCodeAt(0) !== 94) return undefined // ^
  for (let i = 1; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122
      || code >= 48 && code <= 57 || code === 95 || code === 45)) return undefined
  }
  return 'ascii-prefix'
}
