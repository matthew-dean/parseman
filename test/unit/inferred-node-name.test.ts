import { describe, expect, it } from 'vitest'
import { compile, cstBuildHost, node, regex, rules, run } from '../../src/index.ts'

describe('node() inferred rule names', () => {
  it('uses the containing rules() key as the structural CST type', () => {
    const g = rules(() => ({
      Ident: node(regex(/[a-z]+/)),
    }))

    const r = run(g.Ident, 'abc', { build: cstBuildHost() })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({ _tag: 'node', type: 'Ident' })
  })

  it('compile(): uses the containing rules() key as the structural CST type', () => {
    const g = rules(() => ({
      Ident: node(regex(/[a-z]+/)),
    }))

    const r = compile(g.Ident).parseWithContext('abc', { trackLines: false, build: cstBuildHost() }, 0)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({ _tag: 'node', type: 'Ident' })
  })

  it('keeps explicit node types as the override', () => {
    const g = rules(() => ({
      Ident: node('CustomIdent', regex(/[a-z]+/)),
    }))

    const r = run(g.Ident, 'abc', { build: cstBuildHost() })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({ _tag: 'node', type: 'CustomIdent' })
  })

  it('requires an explicit type when node() is used outside rules()', () => {
    const p = node(regex(/[a-z]+/))

    expect(() => run(p, 'abc', { build: cstBuildHost() })).toThrow(/node\("Type"/)
  })
})
