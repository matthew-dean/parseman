import { describe, it, expect } from 'vitest'
import { parseJSONC } from '../../examples/json/jsonc.ts'

describe('JSONC parser (JSON with comments)', () => {
  it('parses plain JSON unchanged', () => {
    expect(parseJSONC('{"a":1}')).toEqual({ a: 1 })
    expect(parseJSONC('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('strips line comments', () => {
    const input = `{
      // this is a comment
      "key": "value"
    }`
    expect(parseJSONC(input)).toEqual({ key: 'value' })
  })

  it('strips block comments', () => {
    const input = `{ /* block */ "key": /* another */ 42 }`
    expect(parseJSONC(input)).toEqual({ key: 42 })
  })

  it('handles trailing comment after value', () => {
    const input = `{
      "host": "localhost", // dev server
      "port": 8080         // default port
    }`
    expect(parseJSONC(input)).toEqual({ host: 'localhost', port: 8080 })
  })

  it('handles multi-line block comment', () => {
    const input = `[
      /* these are
         the scores */
      1, 2, 3
    ]`
    expect(parseJSONC(input)).toEqual([1, 2, 3])
  })
})
