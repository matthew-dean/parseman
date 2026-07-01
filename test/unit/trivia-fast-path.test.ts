import { describe, it, expect } from 'vitest'
import { regex } from '../../src/combinators/regex.ts'
import { choice } from '../../src/combinators/choice.ts'
import { oneOrMore } from '../../src/combinators/repeat.ts'
import { trivia } from '../../src/combinators/map.ts'
import { parser } from '../../src/combinators/grammar.ts'
import { literal } from '../../src/combinators/literal.ts'
import { sequence } from '../../src/combinators/sequence.ts'
import { node } from '../../src/combinators/node.ts'
import { compile } from '../../src/compiler/codegen.ts'
import { analyzeTriviaFastPath } from '../../src/compiler/trivia-fast-path.ts'

describe('trivia fast path — detection', () => {
  const ws = regex(/[ \t\n\r\f]+/)
  const comment = regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)

  const lineComment = regex(/\/\/[^\n\r]*/)

  it('detects CSS rw shape (ws + block comment)', () => {
    const rw = trivia(oneOrMore(choice(ws, comment)))
    expect(analyzeTriviaFastPath(rw)).toEqual({ ws: true, blockComment: true, lineComment: false })
  })

  it('detects Less rw shape (ws + block + line comment, 3 arms)', () => {
    const rw = trivia(oneOrMore(choice(ws, comment, lineComment)))
    expect(analyzeTriviaFastPath(rw)).toEqual({ ws: true, blockComment: true, lineComment: true })
  })

  it('detects ws + line-comment only', () => {
    const rw = trivia(oneOrMore(choice(ws, lineComment)))
    expect(analyzeTriviaFastPath(rw)).toEqual({ ws: true, blockComment: false, lineComment: true })
  })

  it('does not fast-path merged alternation regex (one arm per parse)', () => {
    const rw = trivia(regex(/[ \t\n\r\f]+|\/\*(?:[^*]|\*(?!\/))*\*\//))
    expect(analyzeTriviaFastPath(rw)).toBeNull()
  })

  it('detects ws-only trivia', () => {
    expect(analyzeTriviaFastPath(trivia(regex(/[ \t]+/)))).toEqual({ ws: true, blockComment: false, lineComment: false })
    expect(analyzeTriviaFastPath(trivia(oneOrMore(ws)))).toEqual({ ws: true, blockComment: false, lineComment: false })
  })

  it('returns null for non-matching trivia', () => {
    expect(analyzeTriviaFastPath(trivia(regex(/\s+/)))).toBeNull()
    expect(analyzeTriviaFastPath(trivia(regex(/#[0-9a-f]+/)))).toBeNull()
    // an unrecognized third arm disqualifies the whole choice
    expect(analyzeTriviaFastPath(trivia(oneOrMore(choice(ws, comment, regex(/#[0-9a-f]+/)))))).toBeNull()
  })
})

describe('trivia fast path — codegen', () => {
  it('emits charCodeAt loop for capturing CST grammar with CSS-like trivia', () => {
    const ws = regex(/[ \t\n\r\f]+/)
    const comment = regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)
    const rw = trivia(oneOrMore(choice(ws, comment)))
    const p = node(
      'Root',
      parser({ trivia: rw }, sequence(literal('a'), literal('b'))),
      () => null,
    )
    const src = compile(p).source
    expect(src).toContain('function _tf0(input, _pos, _ctx, _cap)')
    expect(src).toContain('charCodeAt(_e + 1) === 42')
    expect(src).not.toMatch(/function _tf0[\s\S]*_re\d+\.exec/)
  })
})
