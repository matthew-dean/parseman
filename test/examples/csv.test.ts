import { describe, it, expect } from 'vitest'
import { parseCSV, compiledCSV } from '../../examples/csv/parser.ts'
import { parse } from '../../src/index.ts'

function parseBoth(input: string) {
  const interpreted = parseCSV(input)
  const compiled = compiledCSV.parse(input)
  return { interpreted, compiled }
}

describe('CSV parser — interpreter', () => {
  it('parses a single row', () => {
    expect(parseCSV('a,b,c\n')).toEqual([['a', 'b', 'c']])
  })

  it('parses multiple rows', () => {
    expect(parseCSV('a,b\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('parses without trailing newline', () => {
    expect(parseCSV('x,y,z')).toEqual([['x', 'y', 'z']])
  })

  it('handles empty fields', () => {
    expect(parseCSV(',,')).toEqual([['', '', '']])
  })

  it('handles quoted fields', () => {
    expect(parseCSV('"hello","world"\n')).toEqual([['hello', 'world']])
  })

  it('handles quoted field with embedded comma', () => {
    expect(parseCSV('"a,b",c\n')).toEqual([['a,b', 'c']])
  })

  it('handles quoted field with escaped quote', () => {
    expect(parseCSV('"say ""hi""",ok\n')).toEqual([['say "hi"', 'ok']])
  })

  it('handles CRLF line endings', () => {
    expect(parseCSV('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('parses realistic CSV', () => {
    const input = `name,age,city\nAlice,30,New York\nBob,25,"Los Angeles"\n`
    expect(parseCSV(input)).toEqual([
      ['name', 'age', 'city'],
      ['Alice', '30', 'New York'],
      ['Bob', '25', 'Los Angeles'],
    ])
  })
})

describe('CSV parser — interpreter vs compiled parity', () => {
  const cases = [
    'a,b,c\n',
    '"quoted","with,comma"\n',
    'x,y\nz,w\n',
    ',,,\n',
    '"say ""hi""",plain\n',
    'a,b\r\nc,d\r\n',
  ]

  for (const input of cases) {
    it(`parity: ${JSON.stringify(input)}`, () => {
      const { interpreted, compiled } = parseBoth(input)
      expect(compiled.ok).toBe(true)
      if (compiled.ok) expect(compiled.value).toEqual(interpreted)
    })
  }
})
