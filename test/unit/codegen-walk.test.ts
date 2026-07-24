import { describe, it, expect } from 'vitest'
import {
  compile, skip, literal, ref, sequence, optional, node, gate, withCtx,
} from '../../src/index.ts'

describe('codegen tree walks', () => {
  it('compiles skip() and produces a working parser', () => {
    const p = skip(literal('foo'), literal(' '))
    const compiled = compile(p)
    expect(compiled.source.length).toBeGreaterThan(0)
    expect(compiled.parse('foo ')).toEqual({
      ok: true,
      value: 'foo',
      span: { start: 0, end: 4 },
    })
  })

  it('compiles an undefined ref (countLazyRefs thunk catch) without throwing', () => {
    const slot = ref<unknown>()
    const compiled = compile(slot)
    expect(compiled.source).toContain('function')
  })

  it('compiles a node tree containing skip and gate wrappers', () => {
    const Inner = node('Inner', skip(literal('a'), literal(' ')), () => null)
    const p = withCtx({ ok: true }, sequence(gate(s => !!(s as { ok: boolean }).ok), Inner))
    const src = compile(p).source
    expect(src.length).toBeGreaterThan(100)
    expect(compile(p).parse('a ').ok).toBe(true)
  })

  it('compiles recursive ref cluster used from a node rule', () => {
    const item = ref<unknown>()
    item.define(sequence(literal('['), optional(item), literal(']')))
    const Tree = node('Tree', item, () => null)
    const compiled = compile(Tree)
    expect(compiled.parse('[]').ok).toBe(true)
    expect(compiled.parse('[[]]').ok).toBe(true)
  })

  it('compiles an undefined ref used twice via runtime fallback', () => {
    const slot = ref<string>()
    const p = sequence(slot, slot)
    const src = compile(p).source
    expect(src).toContain('_rp[')
    expect(src).not.toContain('function _pf')
  })

  it('compiles gate() inside withCtx', () => {
    const p = withCtx({ ok: true }, sequence(gate(s => !!(s as { ok: boolean }).ok), literal('x')))
    const compiled = compile(p)
    expect(compiled.source).toContain('_mf[')
    expect(compiled.parse('x').ok).toBe(true)
  })
})
