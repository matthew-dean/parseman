/**
 * node(..., { unwrap/collapse }) — structural wrapper rules that ARE their
 * single child (skipping build) but wrap 2+ children. Covers interpreter,
 * compile(), and macro-plugin parity, leaf-vs-node children, nesting, and that
 * build is skipped.
 */
import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import {
  literal, regex, sequence, many, optional, node, rules, parse, cstBuildHost,
} from '../../src/index.ts'
import type { NodeCombinator } from '../../src/index.ts'
import { compile, compile as compileCodegen } from '../../src/compiler/codegen.ts'
import { transformMacro } from '../../src/plugin/index.ts'

// ── A precedence-ladder-style unwrapping rule ───────────────────────────────
const num = regex(/[0-9]+/)
function makeSum(build: (ch: readonly unknown[]) => unknown) {
  // `5` → one child → unwraps to the bare leaf value "5"; `5+3` → 3 children → build.
  return node('Sum', sequence(num, many(sequence(literal('+'), num))), (ch) => build(ch), { unwrap: true })
}
const sumBuild = (ch: readonly unknown[]) => ({ t: 'sum', n: ch.length })

describe('unwrap — interpreter', () => {
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
    const Outer = node('Outer', Inner, build, { unwrap: true })
    const r = parse(Outer, '7')
    expect(r.ok && r.value).toEqual({ t: 'inner', span: { start: 0, end: 1 } })
    expect(build).not.toHaveBeenCalled()
  })

  it('zero children → build IS called', () => {
    const build = vi.fn(sumBuild)
    const Empty = node('Empty', optional(literal('a')), build, { unwrap: true })
    const r = parse(Empty, '')

    expect(r.ok && r.value).toEqual({ t: 'sum', n: 0 })
    expect(build).toHaveBeenCalledOnce()
  })
})

describe('unwrap — default (no option) is unchanged', () => {
  it('build ALWAYS called, even for a single child', () => {
    const build = vi.fn(sumBuild)
    const Sum = node('Sum', sequence(num, many(sequence(literal('+'), num))), (ch) => build(ch))
    const r = parse(Sum, '5')
    expect(r.ok && r.value).toEqual({ t: 'sum', n: 1 })
    expect(build).toHaveBeenCalledOnce()
  })
})

describe('unwrap — interpreter vs compile() parity', () => {
  const Sum = makeSum(sumBuild)
  const compiled = compile(Sum)
  for (const input of ['5', '5+3', '10+20+30']) {
    it(`parity for ${JSON.stringify(input)}`, () => {
      const a = parse(Sum, input)
      const b = compiled.parse(input)
      expect(b).toEqual(a)
    })
  }

  it('compiled: single child unwraps to the string', () => {
    expect(compiled.parse('42')).toEqual({ ok: true, value: '42', span: { start: 0, end: 2 } })
  })

  it('compiled emits the single-child short-circuit (no build call for 1 child)', () => {
    // the unwrap ternary guards the build expression
    expect(compiled.source).toMatch(/length === 1 \?/)
  })
})

describe('unwrap — nesting (precedence ladder unwraps straight through)', () => {
  // product binds tighter than sum; a bare number should pass through BOTH levels.
  const grammar = rules((g: any) => {
    const Primary = node('Primary', num, (_c, _r, span) => ({ t: 'num', span }))
    const Product = node('Product', sequence(g.Primary, many(sequence(literal('*'), g.Primary))),
      (ch: readonly unknown[]) => ({ t: 'product', n: ch.length }), { unwrap: true })
    const Sum = node('Sum', sequence(g.Product, many(sequence(literal('+'), g.Product))),
      (ch: readonly unknown[]) => ({ t: 'sum', n: ch.length }), { unwrap: true })
    return { Primary, Product, Sum }
  })

  it('interpreter: bare number unwraps through Sum→Product→Primary', () => {
    const r = parse(grammar.Sum, '9')
    expect(r.ok && r.value).toEqual({ t: 'num', span: { start: 0, end: 1 } })
  })

  it('interpreter: 2*3 unwraps Sum but builds Product', () => {
    const r = parse(grammar.Sum, '2*3')
    expect(r.ok && r.value).toEqual({ t: 'product', n: 3 })
  })

  it('interpreter: 2+3 builds Sum, each side unwraps to num', () => {
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

describe('unwrap — selector-like unwrap to bare string', () => {
  // mimics CompoundSelector: a run of simple tokens that is its single token.
  const simple = regex(/[.#]?[a-z][\w-]*/)
  const Compound = node('Compound', sequence(simple, many(simple)),
    (ch: readonly unknown[]) => ({ t: 'compound', n: ch.length }), { unwrap: true })
  it('single simple selector → the bare string', () => {
    const r = parse(Compound, '.btn')
    expect(r.ok && r.value).toBe('.btn')
  })
  it('two simples → a compound node', () => {
    const r = parse(Compound, '.btn.active')
    expect(r.ok && r.value).toEqual({ t: 'compound', n: 2 })
  })
})

describe('unwrap — macro plugin', () => {
  const code = `
import { regex, sequence, many, literal, node } from 'parseman' with { type: 'macro' }
export const Sum = node('Sum', sequence(regex(/[0-9]+/), many(sequence(literal('+'), regex(/[0-9]+/)))), (ch) => ({ t: 'sum', n: ch.length }), { unwrap: true })
`.trim()

  it('compiles the unwrap option (import removed, single-child short-circuit emitted)', () => {
    const result = transformMacro(code, 'test.ts')!
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).not.toContain('node(')
    // CODEGEN SPELLING — a property of the source lowering, not of the grammar or
    // the macro. Repointed at `compile`/`compileRuleMap` on the same grammar so the
    // decision stays tested and codegen stays reachable from the suite.
    // the compiled inline expression must carry the unwrap ternary
    expect(compileCodegen(node('Sum', sequence(regex(/[0-9]+/), many(sequence(literal('+'), regex(/[0-9]+/)))), (ch: readonly unknown[]) => ({ t: 'sum', n: ch.length }), { unwrap: true })).source)
      .toMatch(/length === 1 \?/)
    expect(result.warnings).toEqual([])
  })
})

describe('collapse — exact child passthrough', () => {
  it('rejects ambiguous unwrap+collapse options', () => {
    expect(() => node('Ambiguous', num, sumBuild, { unwrap: true, collapse: true }))
      .toThrow('node() options cannot set both unwrap and collapse')
  })

  it('collapse returns the single child exactly, not a leaf string', () => {
    const Collapsed = node('Collapsed', num, sumBuild, { collapse: true })
    expect(parse(Collapsed, '1')).toEqual({
      ok: true,
      value: { _tag: 'leaf', value: '1', span: { start: 0, end: 1 } },
      span: { start: 0, end: 1 },
    })
  })

  it('zero children → build IS called', () => {
    const build = vi.fn(sumBuild)
    const Empty = node('Empty', optional(literal('a')), build, { collapse: true })
    const r = parse(Empty, '')

    expect(r.ok && r.value).toEqual({ t: 'sum', n: 0 })
    expect(build).toHaveBeenCalledOnce()
  })

  it('collapse keeps sub-nodes exactly', () => {
    const Inner = node('Inner', num, (_ch, _r, span) => ({ _tag: 'node', type: 'Inner', span, children: [] }))
    const Outer = node('Outer', Inner, sumBuild, { collapse: true })
    expect(parse(Outer, '1')).toEqual({
      ok: true,
      value: { _tag: 'node', type: 'Inner', span: { start: 0, end: 1 }, children: [] },
      span: { start: 0, end: 1 },
    })
  })

  it('compile() parity for a single leaf child', () => {
    const Collapsed = node('Collapsed', num, sumBuild, { collapse: true })
    expect(compile(Collapsed).parse('1')).toEqual(parse(Collapsed, '1'))
  })

  it('macro plugin compiles the collapse option', () => {
    const code = `
import { regex, node } from 'parseman' with { type: 'macro' }
export const Collapsed = node('Collapsed', regex(/[0-9]+/), (ch) => ({ t: 'collapsed', n: ch.length }), { collapse: true })
`.trim()
    const result = transformMacro(code, 'test.ts')!
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).not.toContain('node(')
    // CODEGEN SPELLING — a property of the source lowering, not of the grammar or
    // the macro. Repointed at `compile`/`compileRuleMap` on the same grammar so the
    // decision stays tested and codegen stays reachable from the suite.
    expect(compileCodegen(node('Collapsed', regex(/[0-9]+/), (ch: readonly unknown[]) => ({ t: 'collapsed', n: ch.length }), { collapse: true })).source)
      .toMatch(/length === 1 \?/)
    expect(result.warnings).toEqual([])
  })
})

describe('project — indexed child passthrough', () => {
  const Paren = node('Paren', sequence(literal('('), num, literal(')')), { project: 1 })

  it('interpreter: returns the selected semantic child and drops punctuation from the AST value', () => {
    const r = parse(Paren, '(7)')
    expect(r).toEqual({ ok: true, value: '7', span: { start: 0, end: 3 } })
  })

  it('type inference follows the projected sequence slot', () => {
    type ParenTypeOk = typeof Paren extends NodeCombinator<string, 'Paren', never> ? true : false
    type ParenTypeWrong = typeof Paren extends NodeCombinator<string, 'NotParen', never> ? true : false
    expectTypeOf<ParenTypeOk>().toEqualTypeOf<true>()
    expectTypeOf<ParenTypeWrong>().toEqualTypeOf<false>()
    const Inner = node('Inner', regex(/[0-9]+/), () => ({ kind: 'num' as const }))
    const Outer = node('Outer', sequence(literal('('), Inner, literal(')')), { project: 1 })
    type OuterTypeOk = typeof Outer extends NodeCombinator<{ kind: 'num' }, 'Outer', never> ? true : false
    type OuterTypeWrong = typeof Outer extends NodeCombinator<{ kind: 'num' }, 'NotOuter', never> ? true : false
    expectTypeOf<OuterTypeOk>().toEqualTypeOf<true>()
    expectTypeOf<OuterTypeWrong>().toEqualTypeOf<false>()
  })

  it('rejects ambiguous project options', () => {
    expect(() => node('Ambiguous', num, { project: 0, unwrap: true }))
      .toThrow('node() options cannot combine project with unwrap or collapse')
    expect(() => node('Ambiguous', num, { project: 0, collapse: true }))
      .toThrow('node() options cannot combine project with unwrap or collapse')
    expect(() => node('Ambiguous', num, () => null, { project: 0 }))
      .toThrow('node() options cannot combine project with a build callback')
  })

  it('rejects an invalid project index at construction time', () => {
    expect(() => node('Bad', num, { project: -1 })).toThrow('node() project child must be a non-negative integer')
    expect(() => node('Bad', num, { project: 0.5 })).toThrow('node() project child must be a non-negative integer')
  })

  it('reports a missing projected child after a successful empty parse', () => {
    const Empty = node('Empty', optional(literal('a')), { project: 0 })
    expect(() => parse(Empty, '')).toThrow('node("Empty") project child 0 was not captured')
  })

  it('compile() parity for projection', () => {
    expect(compile(Paren).parse('(42)')).toEqual(parse(Paren, '(42)'))
  })

  it('hostMode cst keeps the full node children while ast mode projects', () => {
    const input = '(7)'
    const ast = compile(Paren).parse(input)
    expect(ast.ok && ast.value).toBe('7')

    const cst = compile(Paren, undefined, { hostMode: 'cst' })
      .parseWithContext(input, { trackLines: false, build: cstBuildHost() }, 0)
    expect(cst.ok).toBe(true)
    if (!cst.ok) return
    const cstValue: unknown = cst.value
    expect(cstValue).toMatchObject({ _tag: 'node', type: 'Paren', span: { start: 0, end: 3 } })
    const cstNode = cstValue as { children: ReadonlyArray<{ value?: string }> }
    expect(cstNode.children.map(child => child.value)).toEqual(['(', '7', ')'])
  })

  it('macro plugin compiles project options', () => {
    const code = `
import { regex, sequence, literal, node } from 'parseman' with { type: 'macro' }
export const Paren = node('Paren', sequence(literal('('), regex(/[0-9]+/), literal(')')), { project: 1 })
`.trim()
    const result = transformMacro(code, 'test.ts')!
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).not.toContain("node('Paren'")
    expect(result.code).not.toContain('_build')
    // CODEGEN SPELLING — a property of the source lowering, not of the grammar or
    // the macro. Repointed at `compile`/`compileRuleMap` on the same grammar so the
    // decision stays tested and codegen stays reachable from the suite.
    expect(compileCodegen(node('Paren', sequence(literal('('), regex(/[0-9]+/), literal(')')), { project: 1 })).source)
      .toContain('_ch')
    expect(result.warnings).toEqual([])
  })
})
