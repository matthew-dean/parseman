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
  const kinds = (rw: ReturnType<typeof trivia>) =>
    analyzeTriviaFastPath(rw)?.map(s => s.kind) ?? null

  it('detects CSS rw shape (ws + block comment)', () => {
    expect(kinds(trivia(oneOrMore(choice(ws, comment))))).toEqual(['chars', 'delimited'])
  })

  it('detects Less rw shape (ws + block + line comment, 3 arms)', () => {
    expect(kinds(trivia(oneOrMore(choice(ws, comment, lineComment))))).toEqual(['chars', 'delimited', 'until'])
  })

  it('detects ws + line-comment only', () => {
    expect(kinds(trivia(oneOrMore(choice(ws, lineComment))))).toEqual(['chars', 'until'])
  })

  it('derives a char-class run structurally (any class, not a hardcoded ws set)', () => {
    // digits: not whitespace, still lowers to a char-scan run.
    const shapes = analyzeTriviaFastPath(trivia(oneOrMore(regex(/[0-9]+/))))
    expect(shapes).toEqual([{ kind: 'chars', ranges: [[48, 57]], minOne: true }])
  })

  it('does not fast-path merged alternation regex (one arm per parse)', () => {
    const rw = trivia(regex(/[ \t\n\r\f]+|\/\*(?:[^*]|\*(?!\/))*\*\//))
    expect(analyzeTriviaFastPath(rw)).toBeNull()
  })

  it('detects ws-only trivia', () => {
    expect(kinds(trivia(regex(/[ \t]+/)))).toEqual(['chars'])
    expect(kinds(trivia(oneOrMore(ws)))).toEqual(['chars'])
  })

  it('returns null for non-matching trivia', () => {
    // `\s+` is a shorthand class the char-class parser doesn't model → null.
    expect(analyzeTriviaFastPath(trivia(regex(/\s+/)))).toBeNull()
    // a direct non-run regex (leading `#` literal) is not a bare char-class run.
    expect(analyzeTriviaFastPath(trivia(regex(/#[0-9a-f]+/)))).toBeNull()
  })

  it('accepts an escape-aware string arm (shared completion-checked match)', () => {
    // Strings are now safe in a trivia loop: the scan is completion-checked, so
    // an unterminated string leaves `end === start` and the loop stops (parity
    // with the interpreter) instead of consuming to EOF.
    expect(kinds(trivia(oneOrMore(choice(ws, regex(/'(?:[^'\\]|\\.)*'/)))))).toEqual(['chars', 'string'])
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
