/**
 * withCtx() + gate() tests.
 *
 * Verifies context-scoped parsing: gate() gates on runtime state set
 * by withCtx(). State is lexically scoped — inner parse sees it,
 * outer parse does not.
 */
import { describe, it, expect } from 'vitest'
import { literal, sequence, choice, many, transform, parse } from '../../src/index.ts'
import { gate, withCtx } from '../../src/index.ts'

type Ctx = { inFn: boolean; depth: number }
const readCtx = (u: unknown) => u as Ctx ?? { inFn: false, depth: 0 }

describe('gate()', () => {
  it('succeeds when predicate is true', () => {
    const p = gate(() => true)
    const r = parse(p, '')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe(null)
      expect(r.span.end).toBe(0)   // zero-width
    }
  })

  it('fails when predicate is false', () => {
    const p = gate(() => false)
    expect(parse(p, '').ok).toBe(false)
  })

  it('reads ctx.state via predicate', () => {
    const p = gate(u => (u as { flag: boolean })?.flag === true)
    // Without context: fails
    expect(parse(p, '').ok).toBe(false)
  })
})

describe('withCtx()', () => {
  it('sets user context for inner parser', () => {
    let capturedUser: unknown
    const probe = transform(literal('x'), (v, _span) => {
      // can't read ctx here, but gate proves it works
      return v
    })
    // gate inside withCtx sees the user value
    const p = withCtx({ flag: true },
      sequence(gate(u => (u as { flag: boolean }).flag === true), literal('x'))
    )
    const r = parse(p, 'x')
    expect(r.ok).toBe(true)
  })

  it('restores outer context after inner parse', () => {
    // outer: no user ctx → gate() fails
    // inner: user ctx set → gate succeeds
    const guarded = gate((u) => (u as { on: boolean })?.on === true)
    const inner = withCtx({ on: true }, sequence(guarded, literal('x')))

    // inner parse succeeds
    expect(parse(inner, 'x').ok).toBe(true)
    // same gate outside withCtx fails (user is undefined)
    expect(parse(guarded, '').ok).toBe(false)
  })

  it('nested withCtx: inner overrides outer', () => {
    const check = (expected: boolean) =>
      gate(u => (u as { flag: boolean })?.flag === expected)

    const p = withCtx({ flag: true },
      sequence(
        check(true),   // outer: true
        withCtx({ flag: false },
          check(false) // inner override: false
        ),
        check(true),   // back to outer: true
      )
    )
    expect(parse(p, '').ok).toBe(true)
  })

  it('context-gated keyword: return only inside function', () => {
    type S = { inFn: boolean }
    const returnKw = sequence(
      gate(u => (u as S | undefined)?.inFn === true),
      literal('return'),
    )

    const fnBody = withCtx<S, unknown>({ inFn: true }, returnKw)

    // Inside function context: works
    expect(parse(fnBody, 'return').ok).toBe(true)
    // Outside (no context): gate fails
    expect(parse(returnKw, 'return').ok).toBe(false)
  })
})

describe('gate() + withCtx() — practical: indent-sensitive parsing', () => {
  type IndentCtx = { minIndent: number }

  // A "line at indent >= N" parser: checks indent, parses content
  const lineAt = (n: number) => withCtx<IndentCtx, string>(
    { minIndent: n },
    transform(
      sequence(
        gate(u => (u as IndentCtx).minIndent <= n),
        literal('  '.repeat(n)),    // exactly n*2 spaces of indent
        literal('line'),
      ),
      ([, , line]) => line,
    ),
  )

  it('parses line at correct indent level', () => {
    const p = lineAt(2)
    expect(parse(p, '    line').ok).toBe(true)   // 4 spaces = indent 2
  })

  it('depth-based guards: nested contexts', () => {
    const root = withCtx<IndentCtx, unknown>({ minIndent: 0 },
      choice(lineAt(0), lineAt(1))
    )
    expect(parse(lineAt(0), 'line').ok).toBe(true)
    expect(parse(lineAt(1), '  line').ok).toBe(true)
  })
})
