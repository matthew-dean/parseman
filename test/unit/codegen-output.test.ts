/**
 * Codegen output shape tests.
 *
 * These snapshot the EXACT JavaScript that compile() and the macro plugin emit.
 * If the generated code changes, these tests fail — run `vitest --update` to accept
 * intentional changes.
 *
 * Separate from parity tests (which verify correctness) — these verify the
 * specific optimizations: charCodeAt prefix checks, codePointAt dispatch,
 * sticky regex, IIFE wrapping, etc.
 */
import { describe, it, expect } from 'vitest'
import { literal, regex, sequence, choice, many, oneOrMore, optional, sepBy } from '../../src/index.ts'
import { compile } from '../../src/compiler/codegen.ts'
import { transformMacro } from '../../src/plugin/index.ts'

function inline(p: Parameters<typeof compile>[0]): string {
  return compile(p).inlineExpression ?? '[not inlinable]'
}

function macro(code: string): string {
  const result = transformMacro(
    `import { ${code.match(/\b(literal|regex|sequence|choice|many|oneOrMore|optional|sepBy)\b/g)?.join(', ') ?? 'literal'} } from 'parseman' with { type: 'macro' }\n${code}`,
    'test.ts',
    new Set(['parseman'])
  )
  return result?.code ?? '[no transform]'
}

// ---------------------------------------------------------------------------
// compile() inline expressions
// ---------------------------------------------------------------------------

describe('codegen — literal', () => {
  it('single char: charCodeAt + end check', () => {
    expect(inline(literal('x'))).toMatchInlineSnapshot(`
      "function(input, _pos, _ctx) {
        let pos = _pos
          if (_pos >= input.length || input.charCodeAt(_pos) !== 120) return { ok: false, expected: [\"\\"x\\"\"], span: { start: _pos, end: _pos } }
          const _v0 = "x"
        return { ok: true, value: _v0, span: { start: _pos, end: _pos + 1 } }
      }"
    `)
  })

  it('2-4 chars: charCodeAt per byte', () => {
    const code = inline(literal('GET'))
    // Three individual charCodeAt checks — no slice
    expect(code).toContain('charCodeAt(_pos) !== 71')   // 'G'
    expect(code).toContain('charCodeAt(_pos + 1) !== 69') // 'E'
    expect(code).toContain('charCodeAt(_pos + 2) !== 84') // 'T'
    expect(code).not.toContain('slice')
  })

  it('long string (>4 chars): startsWith avoids allocation', () => {
    const code = inline(literal('Authorization'))
    // startsWith handles bounds + comparison in one call, no slice allocation
    expect(code).toContain('startsWith("Authorization"')
    expect(code).toContain('"Authorization"')
    expect(code).not.toContain('slice')
    expect(code).not.toContain('charCodeAt')
  })
})

describe('codegen — regex', () => {
  it('emits sticky regex hoisted to closure + lastIndex + exec', () => {
    expect(inline(regex(/[0-9]+/))).toMatchInlineSnapshot(`
      "/* @__PURE__ */ (() => {
        const _re0 = /\\d+/y
        return function(input, _pos, _ctx) {
        let pos = _pos
          _re0.lastIndex = _pos
          const _m0 = _re0.exec(input)
          if (_m0 === null) return { ok: false, expected: ["/[0-9]+/"], span: { start: _pos, end: _pos } }
          const _v1 = _m0[0]
        return { ok: true, value: _v1, span: { start: _pos, end: _pos + _v1.length } }
      }
      })()"
    `)
  })
})

describe('codegen — disjoint choice', () => {
  it('emits codePointAt dispatch with one branch per first char', () => {
    const code = inline(choice(literal('GET'), literal('POST'), literal('DELETE')))
    expect(code).toContain('codePointAt')
    expect(code).toContain('=== 71')   // G
    expect(code).toContain('=== 80')   // P
    expect(code).toContain('=== 68')   // D
    // Each branch only tries its own literal — no fallback loop
    expect(code).toContain('"GET"')
    expect(code).toContain('"POST"')
    expect(code).toContain('"DELETE"')
  })

  it('full output — GET/POST/DELETE', () => {
    expect(inline(choice(literal('GET'), literal('POST'), literal('DELETE')))).toMatchInlineSnapshot(`
      "function(input, _pos, _ctx) {
        let pos = _pos
          const _code0 = _pos < input.length ? (input.codePointAt(_pos) ?? -1) : -1
          let _chv1, _che2 = _pos
          if (_code0 === 71) {
            if (_pos + 3 > input.length || input.charCodeAt(_pos) !== 71 || input.charCodeAt(_pos + 1) !== 69 || input.charCodeAt(_pos + 2) !== 84) return { ok: false, expected: [\"\\"GET\\"\"], span: { start: _pos, end: _pos } }
            const _v3 = "GET"
            _chv1 = _v3; _che2 = _pos + 3
          }
          else if (_code0 === 80) {
            if (_pos + 4 > input.length || input.charCodeAt(_pos) !== 80 || input.charCodeAt(_pos + 1) !== 79 || input.charCodeAt(_pos + 2) !== 83 || input.charCodeAt(_pos + 3) !== 84) return { ok: false, expected: [\"\\"POST\\"\"], span: { start: _pos, end: _pos } }
            const _v4 = "POST"
            _chv1 = _v4; _che2 = _pos + 4
          }
          else if (_code0 === 68) {
            if (!input.startsWith("DELETE", _pos)) return { ok: false, expected: [\"\\"DELETE\\"\"], span: { start: _pos, end: _pos } }
            const _v5 = "DELETE"
            _chv1 = _v5; _che2 = _pos + 6
          }
          else return { ok: false, expected: [\"\\"GET\\"\",\"\\"POST\\"\",\"\\"DELETE\\"\"], span: { start: _pos, end: _pos } }
        return { ok: true, value: _chv1, span: { start: _pos, end: _che2 } }
      }"
    `)
  })
})

describe('codegen — sequence', () => {
  it('emits sequential checks with early return on each failure', () => {
    const code = inline(sequence(literal('x='), regex(/[0-9]+/)))
    expect(code).toContain('"x="')
    expect(code).toContain('_cur1')        // cursor variable
    expect(code).toContain('_arr')          // result array
    // Regex after literal
    expect(code).toContain('lastIndex')
    expect(code).toContain('exec(input)')
  })
})

describe('codegen — many', () => {
  it('emits a while loop with IIFE body for infinite backtracking safety', () => {
    const code = inline(many(literal('ab')))
    expect(code).toContain('while')
    expect(code).toContain('(() => { try')  // IIFE wrapping for safe early-return
    expect(code).toContain('_arr')
  })
})

describe('codegen — optional', () => {
  it('emits IIFE try/catch returning null on failure', () => {
    const code = inline(optional(literal('foo')))
    expect(code).toContain('(() => { try')
    expect(code).toContain('.ok ? ')        // ternary: ok ? value : null
    expect(code).toContain(': null')
  })
})

describe('codegen — sepBy', () => {
  it('emits first-item probe then while loop for rest', () => {
    const code = inline(sepBy(regex(/[0-9]+/), literal(',')))
    expect(code).toContain('_arr0')
    expect(code).toContain('_sb0')    // first item probe
    expect(code).toContain('while')
    expect(code).toContain('_sbs')    // separator probe
    expect(code).toContain('_sbn')    // next-item probe
  })
})

// ---------------------------------------------------------------------------
// Macro plugin output
// ---------------------------------------------------------------------------

describe('macro plugin output', () => {
  it('removes the import and replaces the declaration', () => {
    const result = macro(`const greeting = literal('hello')`)
    expect(result).not.toContain("from 'parseman'")
    expect(result).not.toContain('literal(')   // call replaced
    expect(result).toContain('const greeting =')
    expect(result).toContain('function(input')
    expect(result).toContain('startsWith("hello"')  // 5 chars → startsWith, no charCodeAt
  })

  it('inlines cross-declaration references', () => {
    const result = macro(`
const method = choice(literal('GET'), literal('POST'))
const sp = literal(' ')
const version = literal('HTTP/1.1')
const line = sequence(method, sp, version)
    `.trim())
    expect(result).not.toContain("from 'parseman'")
    expect(result).toContain('const method =')
    expect(result).toContain('const line =')
    // All combinators replaced — no leftover calls
    expect(result).not.toContain('choice(')
    expect(result).not.toContain('sequence(')
    expect(result).not.toContain('literal(')
  })

  it('keeps import when a declaration cannot be inlined (has user function)', () => {
    const result = transformMacro(
      `import { literal, transform } from 'parseman' with { type: 'macro' }
const p = transform(literal('hi'), s => s.toUpperCase())`,
      'test.ts',
      new Set(['parseman'])
    )
    // transform with user fn is not inlinable — plugin should keep (or null)
    if (result !== null) {
      expect(result.code).toContain('transform(')
    }
  })
})
