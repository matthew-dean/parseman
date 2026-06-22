import { describe, it, expect } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'

function transform(code: string) {
  return transformMacro(code, 'test.ts', new Set(['parseman']))
}

describe('transformMacro — import detection', () => {
  it('returns null for files without parseman', () => {
    expect(transform(`const x = 1`)).toBeNull()
  })

  it('returns null for regular (non-macro) parseman imports', () => {
    expect(transform(`import { literal } from 'parseman'`)).toBeNull()
  })

  it('detects with { type: "macro" } syntax', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const greeting = literal('hello')
`.trim()
    const result = transform(code)
    expect(result).not.toBeNull()
  })
})

describe('transformMacro — literal inlining', () => {
  it('inlines a simple literal() call', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const greeting = literal('hello')
`.trim()
    const result = transform(code)!
    // The import should be gone
    expect(result.code).not.toContain("from 'parseman'")
    // The declaration should be replaced with an inline function
    expect(result.code).toContain('const greeting =')
    expect(result.code).toContain('function(input')
    // 'hello' is 5 chars → uses startsWith (no charCodeAt)
    expect(result.code).toContain('startsWith("hello"')
  })

  it('inlines a long literal() (>4 chars uses startsWith)', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const kw = literal('Authorization')
`.trim()
    const result = transform(code)!
    expect(result.code).toContain('"Authorization"')
    expect(result.code).not.toContain("from 'parseman'")
  })

  it('inlines case-insensitive literal', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const method = literal('GET', { caseInsensitive: true })
`.trim()
    const result = transform(code)!
    expect(result.code).toContain('_collator')
    expect(result.code).not.toContain("from 'parseman'")
  })
})

describe('transformMacro — choice inlining', () => {
  it('inlines a disjoint choice', () => {
    const code = `
import { literal, choice } from 'parseman' with { type: 'macro' }
const method = choice(literal('GET'), literal('POST'), literal('DELETE'))
`.trim()
    const result = transform(code)!
    expect(result.code).not.toContain("from 'parseman'")
    // Should have codePointAt dispatch
    expect(result.code).toContain('codePointAt')
  })
})

describe('transformMacro — sequence inlining', () => {
  it('inlines sequence of literals', () => {
    const code = `
import { literal, sequence } from 'parseman' with { type: 'macro' }
const pair = sequence(literal('foo'), literal('bar'))
`.trim()
    const result = transform(code)!
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).toContain('const pair =')
  })
})

describe('transformMacro — cross-declaration references', () => {
  it('inlines a parser that references a previously inlined parser', () => {
    const code = `
import { literal, sequence, choice, regex } from 'parseman' with { type: 'macro' }
const method = choice(literal('GET'), literal('POST'), literal('PUT'))
const sp = literal(' ')
const target = regex(/[^\\s]+/)
const requestLine = sequence(method, sp, target)
`.trim()
    const result = transform(code)!
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).toContain('const method =')
    expect(result.code).toContain('const requestLine =')
  })
})

describe('transformMacro — transform() declarations', () => {
  it('inlines transform() with an inline callback', () => {
    const code = `
import { literal, transform } from 'parseman' with { type: 'macro' }
const upper = transform(literal('hello'), s => s.toUpperCase())
`.trim()
    const result = transform(code)
    // transform with an inline callback is now fully compilable
    expect(result).not.toBeNull()
    expect(result!.code).not.toContain('transform(')
    expect(result!.code).toContain('s => s.toUpperCase()')
    expect(result!.code).toContain('const _mf =')
  })
})

describe('transformMacro — source maps', () => {
  it('returns a source map', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const x = literal('x')
`.trim()
    const result = transform(code)!
    expect(result.map).toBeDefined()
  })
})
