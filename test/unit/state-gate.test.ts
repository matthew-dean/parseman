/**
 * withCtx() + guard() tests.
 *
 * Verifies context-scoped parsing: guard() gates on runtime state set
 * by withCtx(). State is lexically scoped — inner parse sees it,
 * outer parse does not.
 */
import { describe, it, expect } from 'vitest'
import { literal, sequence, choice, many, transform, parse } from '../../src/index.ts'
import { guard, withCtx } from '../../src/index.ts'

type Ctx = { inFn: boolean; depth: number }
const readCtx = (u: unknown) => u as Ctx ?? { inFn: false, depth: 0 }

describe('guard()', () => {
  it('succeeds when predicate is true', () => {
    const p = guard(() => true)
    const r = parse(p, '')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe(null)
      expect(r.span.end).toBe(0)   // zero-width
    }
  })

  it('fails when predicate is false', () => {
    const p = guard(() => false)
    expect(parse(p, '').ok).toBe(false)
  })

  it('reads ctx.user via predicate', () => {
    const p = guard(u => (u as { flag: boolean })?.flag === true)
    // Without context: fails
    expect(parse(p, '').ok).toBe(false)
  })
})

describe('withCtx()', () => {
  it('sets user context for inner parser', () => {
    let capturedUser: unknown
    const probe = transform(literal('x'), (v, _span) => {
      // can't read ctx here, but guard proves it works
      return v
    })
    // guard inside withCtx sees the user value
    const p = withCtx({ flag: true },
      sequence(guard(u => (u as { flag: boolean }).flag === true), literal('x'))
    )
    const r = parse(p, 'x')
    expect(r.ok).toBe(true)
  })

  it('restores outer context after inner parse', () => {
    // outer: no user ctx → guard() fails
    // inner: user ctx set → guard succeeds
    const guarded = guard((u) => (u as { on: boolean })?.on === true)
    const inner = withCtx({ on: true }, sequence(guarded, literal('x')))

    // inner parse succeeds
    expect(parse(inner, 'x').ok).toBe(true)
    // same guard outside withCtx fails (user is undefined)
    expect(parse(guarded, '').ok).toBe(false)
  })

  it('nested withCtx: inner overrides outer', () => {
    const check = (expected: boolean) =>
      guard(u => (u as { flag: boolean })?.flag === expected)

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
      guard(u => (u as S | undefined)?.inFn === true),
      literal('return'),
    )

    const fnBody = withCtx<S, unknown>({ inFn: true }, returnKw)

    // Inside function context: works
    expect(parse(fnBody, 'return').ok).toBe(true)
    // Outside (no context): guard fails
    expect(parse(returnKw, 'return').ok).toBe(false)
  })
})

describe('guard() + withCtx() — practical: indent-sensitive parsing', () => {
  type IndentCtx = { minIndent: number }

  // A "line at indent >= N" parser: checks indent, parses content
  const lineAt = (n: number) => withCtx<IndentCtx, string>(
    { minIndent: n },
    sequence(
      guard(u => (u as IndentCtx).minIndent <= n),
      literal('  '.repeat(n)),    // exactly n*2 spaces of indent
      transform(literal('line'), v => v),
    )
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
