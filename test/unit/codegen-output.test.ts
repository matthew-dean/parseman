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
        if (_pos >= input.length || input.charCodeAt(_pos) !== 120) {
          return { ok: false, expected: ["\\"x\\""], span: { start: _pos, end: _pos } }
        }
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

  it('5-16 chars: still an unrolled charCodeAt chain (cheaper than startsWith at this length)', () => {
    const code = inline(literal('Authorization'))
    expect(code).toContain('charCodeAt')
    expect(code).not.toContain('startsWith')
    expect(code).not.toContain('slice')
  })

  it('pins the exact charCodeAt/startsWith crossover at 16 chars', () => {
    // See PERF_IDEAS.md: 16 chars caps the unrolled chain's generated-source
    // size, well below the runtime crossover (~256-512 chars) since no literal
    // in a real grammar gets remotely close to either.
    const at16 = inline(literal('X-Request-Id-123')) // exactly 16 chars
    expect(at16).toContain('charCodeAt')
    expect(at16).not.toContain('startsWith')

    const at17 = inline(literal('X-Request-Id-1234')) // exactly 17 chars
    expect(at17).toContain('startsWith("X-Request-Id-1234"')
    expect(at17).not.toContain('charCodeAt')
  })

  it('long string (>16 chars): startsWith caps codegen size', () => {
    const code = inline(literal('Content-Disposition'))
    // startsWith handles bounds + comparison in one call, no slice allocation,
    // and keeps the generated source flat instead of an unrolled chain.
    expect(code).toContain('startsWith("Content-Disposition"')
    expect(code).toContain('"Content-Disposition"')
    expect(code).not.toContain('slice')
    expect(code).not.toContain('charCodeAt')
  })
})

describe('codegen — regex', () => {
  it('lowers scannable [0-9]+ to charCodeAt scan (no RegExp.exec)', () => {
    expect(inline(regex(/[0-9]+/))).toMatchInlineSnapshot(`
      "function(input, _pos, _ctx) {
        let pos = _pos
        let _e1 = _pos
        while (_e1 < input.length && ((input.charCodeAt(_e1) >= 48 && input.charCodeAt(_e1) <= 57))) _e1++
        if (!(_e1 > _pos)) {
          return { ok: false, expected: ["/[0-9]+/"], span: { start: _pos, end: _pos } }
        }
        const _v0 = input.slice(_pos, _e1)
        return { ok: true, value: _v0, span: { start: _pos, end: _e1 } }
      }"
    `)
  })

  it('lowers \\s+ to a charCodeAt scan (fixed SPACE_RANGES)', () => {
    const code = inline(regex(/\s+/))
    expect(code).toContain('charCodeAt')
    expect(code).not.toContain('exec(input)')
  })

  it('keeps sticky RegExp.exec for non-scannable shorthands', () => {
    const code = inline(regex(/\S+/))
    expect(code).toContain('const _re0 = /')
    expect(code).toContain('lastIndex')
    expect(code).toContain('exec(input)')
  })
})

describe('codegen — disjoint choice', () => {
  it('emits a switch jump table keyed on each first char', () => {
    const code = inline(choice(literal('GET'), literal('POST'), literal('DELETE')))
    expect(code).toContain('codePointAt')
    expect(code).toContain('switch (')
    expect(code).toContain('case 71:')   // G
    expect(code).toContain('case 80:')   // P
    expect(code).toContain('case 68:')   // D
    expect(code).toContain('default:')
    // Each branch only tries its own literal — no fallback loop
    expect(code).toContain('"GET"')
    expect(code).toContain('"POST"')
    expect(code).toContain('"DELETE"')
  })

  it('full output — GET/POST/DELETE (switch dispatch)', () => {
    expect(inline(choice(literal('GET'), literal('POST'), literal('DELETE')))).toMatchInlineSnapshot(`
      "function(input, _pos, _ctx) {
        let pos = _pos
        const _code0 = _pos < input.length ? (input.codePointAt(_pos) ?? -1) : -1
        let _chv1, _che2 = _pos
        switch (_code0) {
          case 71:
          {
            if (_pos + 3 > input.length || input.charCodeAt(_pos) !== 71 || input.charCodeAt(_pos + 1) !== 69 || input.charCodeAt(_pos + 2) !== 84) {
              return { ok: false, expected: ["\\"GET\\""], span: { start: _pos, end: _pos } }
            }
            const _v3 = "GET"
            _chv1 = _v3
            _che2 = _pos + 3
            break
          }
          case 80:
          {
            if (_pos + 4 > input.length || input.charCodeAt(_pos) !== 80 || input.charCodeAt(_pos + 1) !== 79 || input.charCodeAt(_pos + 2) !== 83 || input.charCodeAt(_pos + 3) !== 84) {
              return { ok: false, expected: ["\\"POST\\""], span: { start: _pos, end: _pos } }
            }
            const _v4 = "POST"
            _chv1 = _v4
            _che2 = _pos + 4
            break
          }
          case 68:
          {
            if (_pos + 6 > input.length || input.charCodeAt(_pos) !== 68 || input.charCodeAt(_pos + 1) !== 69 || input.charCodeAt(_pos + 2) !== 76 || input.charCodeAt(_pos + 3) !== 69 || input.charCodeAt(_pos + 4) !== 84 || input.charCodeAt(_pos + 5) !== 69) {
              return { ok: false, expected: ["\\"DELETE\\""], span: { start: _pos, end: _pos } }
            }
            const _v5 = "DELETE"
            _chv1 = _v5
            _che2 = _pos + 6
            break
          }
          default: return { ok: false, expected: ["\\"GET\\"","\\"POST\\"","\\"DELETE\\""], span: { start: _pos, end: _pos } }
        }
        return { ok: true, value: _chv1, span: { start: _pos, end: _che2 } }
      }"
    `)
  })

  it('keeps if/else range comparisons when an arm is a wide char-class', () => {
    // digit run [0-9]+ (10-wide range) + literal → switch would enumerate 10
    // cases just for the digits arm, so the if/else range form is kept.
    const code = inline(choice(literal('x'), regex(/[0-9]+/)))
    expect(code).toContain('>= 48 && ')     // range comparison for [0-9]
    expect(code).not.toContain('switch (')
  })
})

describe('codegen — sequence', () => {
  it('emits sequential checks with early return on each failure', () => {
    const code = inline(sequence(literal('x='), regex(/[0-9]+/)))
    expect(code).toContain('"x="')
    expect(code).toContain('_cur1')        // cursor variable
    expect(code).toContain('_arr')          // result array
    // Scannable digit run after literal — charCodeAt scan, not RegExp.exec
    expect(code).toContain('charCodeAt')
    expect(code).toContain('input.slice')
    expect(code).not.toContain('exec(input)')
  })
})

describe('codegen — many', () => {
  it('emits a while loop with labeled block body', () => {
    const code = inline(many(literal('ab')))
    expect(code).toContain('while')
    expect(code).toContain('_lbl')      // labeled block for early-exit control flow
    expect(code).toContain('break _lbl')
    expect(code).toContain('_arr')
    expect(code).not.toContain('(() => {')  // no IIFEs in loop body
    expect(code).not.toContain('try')
  })
})

describe('codegen — optional', () => {
  it('emits labeled block with ok var, checked with ternary', () => {
    const code = inline(optional(literal('foo')))
    expect(code).toContain('_lbl')      // labeled block
    expect(code).toContain('break _lbl')
    expect(code).toContain('? ')        // ternary: ok ? value : null
    expect(code).toContain(': null')
    expect(code).not.toContain('(() => {')  // no IIFE
    expect(code).not.toContain('try')
  })
})

describe('codegen — sepBy', () => {
  it('emits first-item probe then while loop for rest', () => {
    const code = inline(sepBy(regex(/[0-9]+/), literal(',')))
    expect(code).toContain('_arr0')
    expect(code).toContain('_lbl')      // labeled blocks for first, sep, next probes
    expect(code).toContain('while')
    expect(code).not.toContain('try')
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
    expect(result).toContain('charCodeAt')  // 5 chars → unrolled chain, not startsWith
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

  it('inlines transform() with an inline callback, removing the import', () => {
    const result = transformMacro(
      `import { literal, transform } from 'parseman' with { type: 'macro' }
const p = transform(literal('hi'), s => s.toUpperCase())`,
      'test.ts',
      new Set(['parseman'])
    )
    // transform with an inline callback is now fully compilable
    expect(result).not.toBeNull()
    expect(result!.code).not.toContain('transform(')
    expect(result!.code).not.toContain('parseman')
    expect(result!.code).toContain('s => s.toUpperCase()')
    expect(result!.code).toContain('const _mf =')
  })

  it('compiles recursive rules() factories with sepBy — import removed, canonical _r_expr fn emitted', () => {
    const result = transformMacro(
      `import { literal, sequence, choice, optional, sepBy, transform, trivia, regex, rules } from 'parseman' with { type: 'macro' }

const ws = trivia(regex(/[ \\t]*/))
const num = transform(regex(/[0-9]+/), s => Number(s))

const { expr } = rules(g => {
  const comma = sequence(ws, literal(','), ws)
  const arr = transform(
    sequence(literal('['), optional(sepBy(g.expr, comma)), literal(']')),
    ([, items]) => items ?? []
  )
  return { expr: choice(arr, num) }
})`,
      'test.ts',
      new Set(['parseman'])
    )
    expect(result).not.toBeNull()
    const out = result!.code
    // Import eliminated — macro fully compiled
    expect(out).not.toContain("from 'parseman'")
    expect(out).not.toContain('rules(')
    // Named function for recursion present — now the rule's CANONICAL name
    // (`_r_<Name>`), so it's addressable/overridable by name (linkable form).
    expect(out).toContain('_r_expr')
    // Transform callbacks inlined at call sites (no _mf indirection)
    expect(out).not.toContain('_mf[')
    expect(out).toContain('Number(')
    expect(out).toContain('?? []')
  })
})
