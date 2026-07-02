/**
 * node(..., { collapse: true }) — a structural wrapper rule that IS its single
 * child (skips build) but wraps 2+ children. Covers interpreter, compile(), and
 * macro-plugin parity, leaf-vs-node children, nesting, and that build is skipped.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  literal, regex, sequence, many, choice, optional, node, rules, compile, parse,
} from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'

// ── A precedence-ladder-style collapsing rule ───────────────────────────────
const num = regex(/[0-9]+/)
function makeSum(build: (ch: readonly unknown[]) => unknown) {
  // `5` → one child → collapses to the bare leaf value "5"; `5+3` → 3 children → build.
  return node('Sum', sequence(num, many(sequence(literal('+'), num))), (ch) => build(ch), { collapse: true })
}
const sumBuild = (ch: readonly unknown[]) => ({ t: 'sum', n: ch.length })

describe('collapse — interpreter', () => {
  it('single leaf child → the bare string, build NOT called', () => {
    const build = vi.fn(sumBuild)
    const r = parse(makeSum(build), '5')
    expect(r).toEqual({ ok: true, value: '5', span: { start: 0, end: 1 } })
    expect(build).not.toHaveBeenCalled()
  })

  it('two-plus children → build IS called', () => {
    const build = vi.fn(sumBuild)
    const r = parse(makeSum(build), '5+3')
    expect(r.ok && r.value).toEqual({ t: 'sum', n: 3 })
    expect(build).toHaveBeenCalledOnce()
  })

  it('single SUB-NODE child → the node itself (not unwrapped), build NOT called', () => {
    const Inner = node('Inner', num, (_ch, _r, span) => ({ t: 'inner', span }))
    const build = vi.fn((ch: readonly unknown[]) => ({ t: 'outer', ch }))
    const Outer = node('Outer', Inner, build, { collapse: true })
    const r = parse(Outer, '7')
    expect(r.ok && r.value).toEqual({ t: 'inner', span: { start: 0, end: 1 } })
    expect(build).not.toHaveBeenCalled()
  })
})

describe('collapse — default (no option) is unchanged', () => {
  it('build ALWAYS called, even for a single child', () => {
    const build = vi.fn(sumBuild)
    const Sum = node('Sum', sequence(num, many(sequence(literal('+'), num))), (ch) => build(ch))
    const r = parse(Sum, '5')
    expect(r.ok && r.value).toEqual({ t: 'sum', n: 1 })
    expect(build).toHaveBeenCalledOnce()
  })
})

describe('collapse — interpreter vs compile() parity', () => {
  const Sum = makeSum(sumBuild)
  const compiled = compile(Sum)
  for (const input of ['5', '5+3', '10+20+30']) {
    it(`parity for ${JSON.stringify(input)}`, () => {
      const a = parse(Sum, input)
      const b = compiled.parse(input)
      expect(b).toEqual(a)
    })
  }

  it('compiled: single child collapses to the string', () => {
    expect(compiled.parse('42')).toEqual({ ok: true, value: '42', span: { start: 0, end: 2 } })
  })

  it('compiled emits the single-child short-circuit (no build call for 1 child)', () => {
    // the collapse ternary guards the build expression
    expect(compiled.source).toMatch(/length === 1 \?/)
  })
})

describe('collapse — nesting (precedence ladder collapses straight through)', () => {
  // product binds tighter than sum; a bare number should pass through BOTH levels.
  const grammar = rules((g: any) => {
    const Primary = node('Primary', num, (_c, _r, span) => ({ t: 'num', span }))
    const Product = node('Product', sequence(g.Primary, many(sequence(literal('*'), g.Primary))),
      (ch: readonly unknown[]) => ({ t: 'product', n: ch.length }), { collapse: true })
    const Sum = node('Sum', sequence(g.Product, many(sequence(literal('+'), g.Product))),
      (ch: readonly unknown[]) => ({ t: 'sum', n: ch.length }), { collapse: true })
    return { Primary, Product, Sum }
  })

  it('interpreter: bare number collapses through Sum→Product→Primary', () => {
    const r = parse(grammar.Sum, '9')
    expect(r.ok && r.value).toEqual({ t: 'num', span: { start: 0, end: 1 } })
  })

  it('interpreter: 2*3 collapses Sum but builds Product', () => {
    const r = parse(grammar.Sum, '2*3')
    expect(r.ok && r.value).toEqual({ t: 'product', n: 3 })
  })

  it('interpreter: 2+3 builds Sum, each side collapses to num', () => {
    const r = parse(grammar.Sum, '2+3')
    expect(r.ok && r.value).toEqual({ t: 'sum', n: 3 })
  })

  it('compile() parity for the nested ladder', () => {
    const c = compile(grammar.Sum)
    for (const input of ['9', '2*3', '2+3', '2*3+4', '1+2*3+4']) {
      expect(c.parse(input)).toEqual(parse(grammar.Sum, input))
    }
  })
})

describe('collapse — selector-like collapse to bare string', () => {
  // mimics CompoundSelector: a run of simple tokens that is its single token.
  const simple = regex(/[.#]?[a-z][\w-]*/)
  const Compound = node('Compound', sequence(simple, many(simple)),
    (ch: readonly unknown[]) => ({ t: 'compound', n: ch.length }), { collapse: true })
  it('single simple selector → the bare string', () => {
    const r = parse(Compound, '.btn')
    expect(r.ok && r.value).toBe('.btn')
  })
  it('two simples → a compound node', () => {
    const r = parse(Compound, '.btn.active')
    expect(r.ok && r.value).toEqual({ t: 'compound', n: 2 })
  })
})

describe('collapse — macro plugin', () => {
  const code = `
import { regex, sequence, many, literal, node } from 'parseman' with { type: 'macro' }
export const Sum = node('Sum', sequence(regex(/[0-9]+/), many(sequence(literal('+'), regex(/[0-9]+/)))), (ch) => ({ t: 'sum', n: ch.length }), { collapse: true })
`.trim()

  it('compiles the collapse option (import removed, single-child short-circuit emitted)', () => {
    const result = transformMacro(code, 'test.ts')!
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).not.toContain('node(')
    // the compiled inline expression must carry the collapse ternary
    expect(result.code).toMatch(/length === 1 \?/)
    expect(result.warnings).toEqual([])
  })
})
