import { describe, expect, it } from 'vitest'
import { createParseContext } from '../../src/parse-context.ts'
import type { LexBodyRecognizer } from '../../src/table/lex-body.ts'
import {
  buildLexProgramRunner,
  LEX_NODE_CHOICE4,
  LEX_NODE_SEQUENCE2,
  LEX_NODE_SEQUENCE3,
  LEX_NODE_TERMINAL,
  lexProgramDigest,
} from '../../src/table/lex-program.ts'
import type { LexProgramSpec } from '../../src/table/program.ts'

describe('fixed lexical choice diagnostics', () => {
  it('keeps only the deepest arm expectations and merges exact-depth ties', () => {
    const text = ['a', 'b', 'x', 'y', 'c', 'z']
    const matchers: LexBodyRecognizer[] = text.map(value => (input, pos) =>
      input.startsWith(value, pos) ? (pos + value.length) * 2 : -1)
    const expected = text.map(value => [JSON.stringify(value)])
    const words = [
      LEX_NODE_TERMINAL, 0, 0, 0,
      LEX_NODE_TERMINAL, 1, 1, 0,
      LEX_NODE_SEQUENCE2,

      LEX_NODE_TERMINAL, 0, 0, 0,
      LEX_NODE_TERMINAL, 2, 2, 0,
      LEX_NODE_TERMINAL, 3, 3, 0,
      LEX_NODE_SEQUENCE3,

      LEX_NODE_TERMINAL, 0, 0, 0,
      LEX_NODE_TERMINAL, 4, 4, 0,
      LEX_NODE_SEQUENCE2,

      LEX_NODE_TERMINAL, 0, 0, 0,
      LEX_NODE_TERMINAL, 2, 2, 0,
      LEX_NODE_TERMINAL, 5, 5, 0,
      LEX_NODE_SEQUENCE3,

      LEX_NODE_CHOICE4, 6,
      -1, 0, -1, 0, -1, 0, -1, 0,
    ]
    expected.push(text.map(value => JSON.stringify(value)))
    const spec = [2, lexProgramDigest(words), ...words] as LexProgramSpec
    const runner = buildLexProgramRunner(spec, matchers, [], expected)
    const ctx = createParseContext()

    expect(runner('axq', 0, ctx)).toBe(-1)
    expect(ctx._fe).toBe(0)
    expect(ctx._fx).toEqual(['"y"', '"z"'])
  })
})
