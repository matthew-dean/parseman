import { describe, it, expect } from 'vitest'
import { parseJSONL } from '../../examples/json/jsonl.ts'

describe('JSONL parser', () => {
  it('parses a single line', () => {
    expect(parseJSONL('{"a":1}')).toEqual([{ a: 1 }])
  })

  it('parses multiple lines', () => {
    const input = `{"id":1}\n{"id":2}\n{"id":3}`
    expect(parseJSONL(input)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('handles mixed value types', () => {
    const input = `42\n"hello"\ntrue\nnull`
    expect(parseJSONL(input)).toEqual([42, 'hello', true, null])
  })

  it('handles arrays and objects on each line', () => {
    const input = `[1,2,3]\n{"x":true}`
    expect(parseJSONL(input)).toEqual([[1, 2, 3], { x: true }])
  })
})
