import { describe, it, expect } from 'vitest'
import {
  choice,
  compile,
  expect as expectToken,
  isParseError,
  label,
  literal,
  parse,
  recover,
  regex,
  sequence,
} from '../../src/index.ts'
import type { Combinator, ParseResult } from '../../src/types.ts'
import type { ParseError } from '../../src/index.ts'

type ModeResult = {
  mode: string
  result: ParseResult<unknown> & { errors?: ParseError[] }
}

function parseModes(p: Combinator<unknown>, input: string): ModeResult[] {
  return [
    { mode: 'interpreter', result: parse(p, input) as ModeResult['result'] },
    { mode: 'compiled', result: compile(p).parse(input) as ModeResult['result'] },
  ]
}

function recoverModes(p: Combinator<unknown>, input: string): ModeResult[] {
  return [
    { mode: 'interpreter', result: parse(p, input, { recover: true }) as ModeResult['result'] },
    { mode: 'compiled', result: compile(p).parseWithErrors(input) as ModeResult['result'] },
  ]
}

describe('diagnostics parity — interpreter vs compiled', () => {
  it('uses quoted literals in final failure expected sets', () => {
    const p = literal(']')

    for (const { mode, result } of parseModes(p, '}')) {
      expect(result.ok, mode).toBe(false)
      if (!result.ok) {
        expect(result.expected, mode).toEqual(['"]"'])
        expect(result.span, mode).toEqual({ start: 0, end: 0 })
      }
    }
  })

  it('uses labels instead of raw regex source in final failures', () => {
    const p = label('string', regex(/"(?:[^\\"]|\\.)*"/))

    for (const { mode, result } of parseModes(p, '123')) {
      expect(result.ok, mode).toBe(false)
      if (!result.ok) expect(result.expected, mode).toEqual(['string'])
    }
  })

  it('preserves the inner failure offset for labeled composite parsers', () => {
    const p = label('pair', sequence(literal('a'), literal('b')))

    for (const { mode, result } of parseModes(p, 'ac')) {
      expect(result.ok, mode).toBe(false)
      if (!result.ok) {
        expect(result.expected, mode).toEqual(['pair'])
        expect(result.span, mode).toEqual({ start: 1, end: 1 })
      }
    }
  })

  it('combines friendly labels and literals through choice failures', () => {
    const p = choice(
      label('identifier', regex(/[a-z_][a-z0-9_]*/i)),
      label('number', regex(/-?(?:0|[1-9]\d*)/)),
      literal('null'),
    )

    for (const { mode, result } of parseModes(p, '?')) {
      expect(result.ok, mode).toBe(false)
      if (!result.ok) {
        expect(result.expected, mode).toEqual(['identifier', 'number', '"null"'])
        expect(result.span, mode).toEqual({ start: 0, end: 0 })
      }
    }
  })

  it('reports the failing sequence term at the correct offset', () => {
    const p = sequence(literal('let'), literal(' '), label('identifier', regex(/[a-z]+/)))

    for (const { mode, result } of parseModes(p, 'let 123')) {
      expect(result.ok, mode).toBe(false)
      if (!result.ok) {
        expect(result.expected, mode).toEqual(['identifier'])
        expect(result.span, mode).toEqual({ start: 4, end: 4 })
      }
    }
  })

  it('records derived expect() diagnostics with friendly labels', () => {
    const p = sequence(literal('['), expectToken(label('item', regex(/[a-z]+/))), literal(']'))

    for (const { mode, result } of recoverModes(p, '[]')) {
      expect(result.ok, mode).toBe(true)
      if (result.ok) {
        expect(result.errors, mode).toHaveLength(1)
        expect(result.errors![0]).toMatchObject({
          _tag: 'parseError',
          expected: ['item'],
          span: { start: 1, end: 1 },
        })
        expect(isParseError(result.errors![0])).toBe(true)
      }
    }
  })

  it('records custom expect() diagnostics without adding literal quotes', () => {
    const p = sequence(literal('['), expectToken(literal(']'), 'closing bracket'))

    for (const { mode, result } of recoverModes(p, '[')) {
      expect(result.ok, mode).toBe(true)
      if (result.ok) {
        expect(result.errors, mode).toHaveLength(1)
        expect(result.errors![0]!.expected).toEqual(['closing bracket'])
        expect(result.errors![0]!.span).toEqual({ start: 1, end: 1 })
      }
    }
  })

  it('records recover() diagnostics with friendly labels and skipped spans', () => {
    const p = sequence(
      recover(label('statement', regex(/[a-z]+/)), literal(';')),
      literal(';'),
    )

    for (const { mode, result } of recoverModes(p, '123;')) {
      expect(result.ok, mode).toBe(true)
      if (result.ok) {
        const [err] = result.value as [ParseError, string]
        expect(isParseError(err), mode).toBe(true)
        expect(err.expected, mode).toEqual(['statement'])
        expect(err.span, mode).toEqual({ start: 0, end: 3 })
      }
    }
  })

  it('keeps regex escaping out of user-facing labels', () => {
    const p = choice(
      label('string', regex(/"(?:[^\\"]|\\(?:[bfnrtv"\\/]|u[0-9a-fA-F]{4}))*"/)),
      label('number', regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)),
    )

    for (const { mode, result } of parseModes(p, '\\')) {
      expect(result.ok, mode).toBe(false)
      if (!result.ok) {
        expect(result.expected, mode).toEqual(['string', 'number'])
        expect(result.expected.join(' '), mode).not.toContain('\\\\')
      }
    }
  })
})
