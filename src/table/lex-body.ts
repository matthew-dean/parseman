import type { LexBodySpec } from './program.ts'

/** -1 fails. A success is `end * 2 + suffixMatched`, so the reader can
 * reproduce optional()'s swallowed suffix failure without allocating a tuple. */
export type LexBodyRecognizer = (input: string, pos: number) => number

/** Build one selected lexical body from its numeric table row. Recognition is
 * pure; diagnostics, token boundary state, source value and CST publication
 * remain owned by the reader's OP_LEX_BODY shell. */
export function buildLexBodyRecognizer(
  spec: LexBodySpec,
  constants: readonly unknown[],
): LexBodyRecognizer {
  const raw = constants[spec[0]]
  if (!(raw instanceof RegExp)) {
    throw new TypeError('table lexical body does not reference a RegExp constant')
  }
  if (!Number.isInteger(spec[1]) || spec[1] < 0 || spec[1] > 0xFFFF) {
    throw new TypeError('table lexical body suffix is not one UTF-16 code unit')
  }
  const re = raw.sticky ? new RegExp(raw.source, raw.flags) : new RegExp(raw.source, `${raw.flags.replace(/[gy]/g, '')}y`)
  const suffix = spec[1]
  return (input, pos) => {
    re.lastIndex = pos
    if (!re.test(input)) return -1
    const end = re.lastIndex
    return input.charCodeAt(end) === suffix ? (end + 1) * 2 + 1 : end * 2
  }
}
