/**
 * Regression: a `withCtx` whose INNER parser is MULTIPLY-REACHABLE self-aliased
 * into infinite recursion.
 *
 * `withCtx` codegen wraps its inner parser in a named function (`_wcfN`) so the
 * inner can run against a modified ctx, pre-registering `inner → _wcfN` in
 * `ctx.namedParsers` FIRST so any OTHER reference to that same inner reuses the
 * one named fn. It then emitted the inner BODY through the hoist wrapper
 * `emit()` — which re-found that very pre-registration and emitted a SELF-CALL
 * (`_wcfN` calls `_wcfN`) whenever the inner was hoistable AND referenced ≥2×
 * (`usage.counts > 1`, e.g. a shared `declarationList` reached from several
 * rules). The `_wcfN` body became a call to itself → stack overflow on ANY input.
 *
 * The fix emits the inner body DIRECTLY (`emitDispatch`, never re-entering the
 * hoist wrapper on the just-registered parser), mirroring `emit()`'s own
 * register-then-emitDispatch pattern. RED before (RangeError) / GREEN after.
 *
 * This also removes the need for the grammar-side `label(...)` workaround (a
 * transparent, non-hoistable wrapper) that used to be required around a shared
 * withCtx inner — the raw inner now hoists correctly.
 */
import { describe, it, expect } from 'vitest'
import { choice, sequence, literal, label, withCtx, compile } from '../../src/index.ts'

describe('withCtx inner hoist (self-alias regression)', () => {
  // A shared inner combinator (hoistable `choice`, size ≥ HOIST_MIN_SUBTREE),
  // referenced from THREE positions: the withCtx wrapper plus two siblings —
  // so `usage.counts > 1` and the hoist path fires on it.
  const makeGrammar = (inner: ReturnType<typeof choice>) =>
    choice(
      withCtx({ inner: true }, inner),
      sequence(inner, literal('x')),
      sequence(inner, literal('y')),
    )

  it('the compiled _wcf inner fn does not call itself', () => {
    const shared = choice(literal('a'), literal('b'), literal('c'))
    const p = compile(makeGrammar(shared))
    // Isolate the `_wcfN` function BODY (brace-matched, not a fragile regex) and
    // assert it never calls itself — a self-alias body would recurse forever.
    const decl = p.source.match(/function (_wcf\d+)\(/)
    expect(decl).not.toBeNull()
    const fnName = decl![1]
    const start = p.source.indexOf(`function ${fnName}(`)
    // Walk braces from the opening `{` to its match.
    const open = p.source.indexOf('{', start)
    let depth = 0
    let end = open
    for (let i = open; i < p.source.length; i++) {
      const ch = p.source[i]
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    const fnBody = p.source.slice(open + 1, end)
    expect(fnBody).not.toContain(`${fnName}(input`)
  })

  it('parses without a stack overflow (RED: RangeError before the fix)', () => {
    const shared = choice(literal('a'), literal('b'), literal('c'))
    const p = compile(makeGrammar(shared))
    expect(p.parse('a').ok).toBe(true)   // withCtx arm
    expect(p.parse('bx').ok).toBe(true)  // sibling arm reusing the shared inner
    expect(p.parse('cy').ok).toBe(true)
  })

  it('raw inner and label()-wrapped inner now parse identically (workaround unneeded)', () => {
    // The old workaround wrapped the shared inner in a transparent `label(...)`
    // (non-hoistable) so the self-alias couldn't form. With the fix, the RAW
    // inner behaves the same — no wrapper required.
    const shared = choice(literal('a'), literal('b'), literal('c'))
    const raw = compile(makeGrammar(shared))
    const wrapped = compile(makeGrammar(label('w', shared) as ReturnType<typeof choice>))
    for (const input of ['a', 'bx', 'cy']) {
      expect(raw.parse(input).ok).toBe(wrapped.parse(input).ok)
    }
  })
})
