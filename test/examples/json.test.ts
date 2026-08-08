import { describe, it, expect } from 'vitest'
import { parseJSON, jsonDoc } from '../../examples/json/parser.ts'
import { compile } from '../../src/index.ts'

// Pre-compile once for the parity suite
const compiledJson = compile(jsonDoc)

describe('JSON parser', () => {
  it('parses null', () => expect(parseJSON('null')).toBeNull())
  it('parses true', () => expect(parseJSON('true')).toBe(true))
  it('parses false', () => expect(parseJSON('false')).toBe(false))

  it('parses integers', () => expect(parseJSON('42')).toBe(42))
  it('parses negative numbers', () => expect(parseJSON('-7')).toBe(-7))
  it('parses floats', () => expect(parseJSON('3.14')).toBe(3.14))
  it('parses scientific notation', () => expect(parseJSON('1e10')).toBe(1e10))

  it('parses empty string', () => expect(parseJSON('""')).toBe(''))
  it('parses plain string', () => expect(parseJSON('"hello"')).toBe('hello'))
  it('parses string with escape sequences', () => {
    expect(parseJSON('"line1\\nline2"')).toBe('line1\nline2')
    expect(parseJSON('"tab\\there"')).toBe('tab\there')
    expect(parseJSON('"quote\\"here"')).toBe('quote"here')
  })

  it('parses empty array', () => expect(parseJSON('[]')).toEqual([]))
  it('parses array of primitives', () => expect(parseJSON('[1, 2, 3]')).toEqual([1, 2, 3]))
  it('parses nested array', () => expect(parseJSON('[[1,2],[3,4]]')).toEqual([[1,2],[3,4]]))

  it('parses empty object', () => expect(parseJSON('{}')).toEqual({}))
  it('parses simple object', () => {
    expect(parseJSON('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 })
  })
  it('parses object with whitespace', () => {
    expect(parseJSON('{ "key" : "value" }')).toEqual({ key: 'value' })
  })

  it('parses nested object', () => {
    const input = '{"user":{"name":"Alice","age":30},"active":true}'
    expect(parseJSON(input)).toEqual({ user: { name: 'Alice', age: 30 }, active: true })
  })

  it('parses complex mixed structure', () => {
    const input = JSON.stringify({
      name: 'test',
      scores: [1, 2.5, -3],
      meta: { ok: true, note: null },
    })
    expect(parseJSON(input)).toEqual(JSON.parse(input))
  })

  it('matches JSON.parse on realistic payloads', () => {
    const inputs = [
      JSON.stringify({ users: Array.from({ length: 10 }, (_, i) => ({ id: i, name: `User ${i}`, active: i % 2 === 0 })) }),
      JSON.stringify([1, 'two', null, false, { nested: [3, 4] }]),
      '{"unicode":"\\u0041\\u0042\\u0043"}',
    ]
    for (const input of inputs) {
      expect(parseJSON(input)).toEqual(JSON.parse(input))
    }
  })

  it('throws on invalid input', () => {
    expect(() => parseJSON('{bad}')).toThrow()
    expect(() => parseJSON('')).toThrow()
    expect(() => parseJSON('{} trailing')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// compile() parity — same results as the interpreter on every case
// ---------------------------------------------------------------------------

describe('JSON parser — compile() parity', () => {
  const cases: [string, unknown][] = [
    ['null', null],
    ['true', true],
    ['false', false],
    ['42', 42],
    ['-7', -7],
    ['3.14', 3.14],
    ['"hello"', 'hello'],
    ['[]', []],
    ['[1,2,3]', [1, 2, 3]],
    ['{}', {}],
    ['{"a":1,"b":2}', { a: 1, b: 2 }],
    ['{ "key" : "value" }', { key: 'value' }],
    ['[ 1 , 2 , 3 ]', [1, 2, 3]],
    ['{"a":[1,{"b":true}]}', { a: [1, { b: true }] }],
    [JSON.stringify({ users: [{ id: 0, name: 'Alice', active: true }] }),
      { users: [{ id: 0, name: 'Alice', active: true }] }],
  ]

  for (const [input, expected] of cases) {
    it(`parity: ${input.slice(0, 40)}`, () => {
      const r = compiledJson.parse(input.trim())
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toEqual(expected)
    })
  }

  it('fails on invalid input', () => {
    expect(compiledJson.parse('{bad}').ok).toBe(false)
    expect(compiledJson.parse('').ok).toBe(false)
  })
})
