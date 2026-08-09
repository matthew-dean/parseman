import type { LexicalOutcomeMatch } from '../compiler/token-alphabet.ts'

export type RuntimeRangeOutcomeKind =
  | 'direct'
  | 'ascii-prefix'
  | 'function-open-excluding-url-calc'

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
    if (flag === 105) folded = true
    else if (flag !== 103) return undefined
  }
  if (value === '^(?!(?:url|calc)\\($).+\\($' && folded) return 'function-open-excluding-url-calc'
  if (value.length < 2 || value.charCodeAt(0) !== 94) return undefined
  for (let i = 1; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122
      || code >= 48 && code <= 57 || code === 95 || code === 45)) return undefined
  }
  return 'ascii-prefix'
}
