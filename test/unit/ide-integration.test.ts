/**
 * IDE integration tests — error recovery and completions.
 *
 * Covers:
 *   - recover() pushing to ctx._errors when parse() is called with { recover: true }
 *   - ParseOk.errors being populated from recovered errors
 *   - completionsAt() returning expected tokens at a cursor position
 *   - compile().parseWithErrors() doing the same for compiled parsers
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, choice, many, optional, sepBy,
  transform, parse, compile, recover, isParseError, completionsAt,
} from '../../src/index.ts'

// ---------------------------------------------------------------------------
// Grammar: a tiny statement list
//   program   = (ws statement ws)*
//   statement = recover(assign | expr, semi)
//   assign    = ident ws '=' ws value ws ';'
//   expr      = value ws ';'
//   value     = number | ident
// ---------------------------------------------------------------------------

const ws    = regex(/[ \t]*/)
const ident = regex(/[a-z]+/)
const num   = transform(regex(/[0-9]+/), s => Number(s))
const semi  = literal(';')
const value = choice(num, ident)

const assignInner = sequence(ident, ws, literal('='), ws, value, ws, semi)
const exprInner   = sequence(value, ws, semi)

// recover wraps the outermost fallback — if both assign and expr fail, scan to ';'
const statement = recover(choice(assignInner, exprInner), semi)

const program = many(
  transform(sequence(ws, statement, ws), ([, s]) => s)
)

// ---------------------------------------------------------------------------
// Error collection via parse() with { recover: true }
// ---------------------------------------------------------------------------

describe('recover() + parse({ recover: true })', () => {
  it('no errors on fully valid input', () => {
    const r = parse(program, 'abc;xyz;', { recover: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.errors).toEqual([])
      expect(r.value).toHaveLength(2)
    }
  })

  it('collects one error when one statement is broken', () => {
    // 'abc' with no ';' — recover fires, scans to EOF
    const r = parse(program, 'abc', { recover: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.errors).toHaveLength(1)
      const err = r.errors![0]
      expect(err).toBeDefined()
      expect(err!._tag).toBe('parseError')
      expect(err!.span.start).toBe(0)
      expect(err!.expected.length).toBeGreaterThan(0)
    }
  })

  it('collects errors from multiple bad statements', () => {
    // 'abc  xyz' — neither has a semicolon; recover fires twice
    const r = parse(program, 'abc  xyz', { recover: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.errors!.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('errors field is undefined when { recover: true } is not passed', () => {
    const r = parse(program, 'abc')
    // many() with recover() always returns ok:true (recover swallows errors)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.errors).toBeUndefined()
    }
  })

  it('ParseError is embedded in the value tree regardless of recover option', () => {
    const r = parse(program, 'abc')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const treeErrors = r.value.filter(isParseError)
      expect(treeErrors.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('valid statements before and after a broken one are still parsed', () => {
    const r = parse(program, 'a; bad b; c;', { recover: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // The valid statements ('a;', 'c;') parse correctly
      // 'bad b;' is ambiguous but still succeeds (as expr or assign)
      expect(r.value.length).toBeGreaterThanOrEqual(2)
    }
  })
})

// ---------------------------------------------------------------------------
// compile().parseWithErrors()
// ---------------------------------------------------------------------------

describe('compile().parseWithErrors()', () => {
  const compiled = compile(program)

  it('returns empty errors array on fully valid input', () => {
    const r = compiled.parseWithErrors('abc;xyz;')
    expect(r.errors).toBeDefined()
    expect(r.errors).toHaveLength(0)
  })

  it('collects errors from recover() nodes', () => {
    const r = compiled.parseWithErrors('abc')
    expect(r.errors.length).toBeGreaterThanOrEqual(1)
    const err = r.errors[0]
    expect(err).toBeDefined()
    expect(err!._tag).toBe('parseError')
  })
})

// ---------------------------------------------------------------------------
// completionsAt()
// ---------------------------------------------------------------------------

describe('completionsAt()', () => {
  // Grammar: comma-separated numbers in brackets: [1, 2, 3]
  const num2  = regex(/[0-9]+/)
  const comma = sequence(optional(ws), literal(','), optional(ws))
  const items = sepBy(num2, comma)
  const bracket = sequence(literal('['), optional(items), literal(']'))

  it('returns number pattern after a trailing comma', () => {
    // '[1,' — user just typed comma, next expected is a number
    const completions = completionsAt(bracket, '[1,', 3)
    expect(completions).toContain('/[0-9]+/')
  })

  it('returns comma or close-bracket after a complete item', () => {
    // '[1' — valid number parsed, next expected: ',' or ']'
    const completions = completionsAt(bracket, '[1', 2)
    expect(completions.length).toBeGreaterThan(0)
    // Either ',' or ']' should be expected
    expect(
      completions.some(c => c === '","' || c === '"]"')
    ).toBe(true)
  })

  it('returns empty array when input is fully valid', () => {
    const completions = completionsAt(bracket, '[1,2]', 5)
    expect(completions).toEqual([])
  })

  it('returns open-bracket as first token from offset 0', () => {
    const completions = completionsAt(bracket, '', 0)
    expect(completions).toContain('"["')
  })

  it('works with a keyword choice grammar', () => {
    const keyword = choice(literal('true'), literal('false'), literal('null'))

    // partial match 'tru' — expected is 'true'
    expect(completionsAt(keyword, 'tru', 3)).toContain('"true"')

    // empty input — all three options expected
    const all = completionsAt(keyword, '', 0)
    expect(all).toContain('"true"')
    expect(all).toContain('"false"')
    expect(all).toContain('"null"')
  })

  it('prefers probe failure deeper than top-level after sepBy backtrack', () => {
    // After `[1,2,` the list wants another number (probe @5) but the outer `]`
    // arm fails earlier (@4) once optional(items) ends — completions must use the probe.
    const completions = completionsAt(bracket, '[1,2,', 5)
    expect(completions).toContain('/[0-9]+/')
    expect(completions).not.toContain('"]"')
  })
})
