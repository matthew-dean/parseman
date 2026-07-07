/**
 * Compile-size regression gate: a COMPOUND combinator shared by object identity
 * (e.g. `const value = choice(...)`) referenced through nested `many`/`sequence`
 * must be emitted ONCE as a named function and CALLED at each reference — never
 * pasted inline at every site. Inlining multiplies through each nesting level
 * (value × product × sum × …), which is what blew the compiled Less grammar's
 * `calc()` body up to ~786 KB for a single rule and the whole parser to ~5 MB.
 *
 * These are red→green gates: on the pre-hoist codegen the nested grammar expands
 * ~19× its flat counterpart; with identity-hoisting it stays ~2×. The generous
 * bounds catch a catastrophic re-explosion while tolerating ordinary codegen
 * drift. See `HOIST_MIN_SUBTREE` / the `emit()` sharing wrapper in codegen.ts.
 */
import { describe, it, expect } from 'vitest'
import { literal, regex, sequence, choice, many, oneOrMore, sepBy, parse } from '../../src/index.ts'
import { compile } from '../../src/compiler/codegen.ts'

/** An 8-arm value alternation — a fresh object each call, so a grammar can reuse
 * ONE instance (shared) or several distinct ones. Subtree size ≥ HOIST threshold. */
const mkValue = () =>
  choice(
    regex(/AAAA/), regex(/BBBB/), regex(/CCCC/), regex(/DDDD/),
    regex(/EEEE/), regex(/FFFF/), regex(/GGGG/), regex(/HHHH/),
  )

/** The `calc()` shape: one shared `value` reached from many positions through
 * nested `many`/`sequence`. Inlining pastes `value` at every position; hoisting
 * emits it once. */
function calcShaped() {
  const value = mkValue()
  const product = sequence(value, many(sequence(literal('*'), value)))
  const sum = sequence(product, many(sequence(literal('+'), product)))
  const list = sequence(sum, many(sequence(literal(','), sum)))
  return oneOrMore(list)
}

describe('compile-size gate — shared combinator is hoisted, not multiplied', () => {
  it('nested reuse stays within a small multiple of a single use (calc shape)', () => {
    const flatLen = compile(sequence(mkValue(), literal(';'))).source.length
    const nestedLen = compile(calcShaped()).source.length
    // Hoisted: ~2×. Pre-fix inlining: ~19×. Fail well before that.
    expect(nestedLen / flatLen).toBeLessThan(4)
  })

  it('the shared value body appears a bounded number of times, not once per position', () => {
    const src = compile(calcShaped()).source
    // The 8-arm choice lowers to a codePointAt dispatch. Inlined at ~16 positions
    // that block would appear ~16×; hoisted into one function it appears a handful
    // of times at most (the value fn + a couple of structural dispatches).
    const dispatches = (src.match(/codePointAt/g) ?? []).length
    expect(dispatches).toBeLessThan(8)
  })

  it('a sepBy value list does not multiply its element parser', () => {
    const value = mkValue()
    // sepBy emits its element parser twice (first + loop); nesting two sepBys over
    // the SAME value would inline it 4× without hoisting.
    const inner = sepBy(value, literal(','))
    const outer = sepBy(sequence(literal('('), inner, literal(')')), literal(';'))
    const flatLen = compile(sequence(mkValue(), literal(';'))).source.length
    expect(compile(outer).source.length / flatLen).toBeLessThan(4)
  })

  it('the hoisted parser is still correct (parses the shared grammar)', () => {
    const g = calcShaped()
    for (const input of ['AAAA', 'AAAA*BBBB', 'AAAA*BBBB+CCCC', 'AAAA+BBBB,CCCC*DDDD']) {
      const r = parse(g, input)
      expect(r.ok, input).toBe(true)
      if (r.ok) expect(r.span.end).toBe(input.length)
    }
  })
})
