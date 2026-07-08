import { describe, it, expect } from 'vitest'
import { node } from '../../src/combinators/node.ts'
import { literal } from '../../src/combinators/literal.ts'
import { compile } from '../../src/compiler/codegen.ts'
import { Stylesheet } from '../../examples/css/parser.ts'
import { analyzeMkInlineBuild, emitInlineMkNodeExpr } from '../../src/compiler/inline-build.ts'

function localMk(
  type: string,
  children: ReadonlyArray<unknown>,
  rawChildren: ReadonlyArray<unknown>,
  span: { start: number; end: number },
  triviaLog: readonly number[],
) {
  return {
    _tag: 'node' as const,
    type,
    span,
    children: [...children],
    rawCount: rawChildren.length,
    localTriviaLen: triviaLog.length,
  }
}

function mk(
  type: string,
  children: ReadonlyArray<unknown>,
  rawChildren: ReadonlyArray<unknown>,
  span: { start: number; end: number },
  triviaLog: readonly number[],
) {
  return localMk(type, children, rawChildren, span, triviaLog)
}

describe('inline mk build', () => {
  it('detects mk wrapper from runtime build fn', () => {
    const p = node('Ruleset', literal('x'), (c, _fields, s, r, tl) => mk('Ruleset', c, r, s, tl))
    expect(analyzeMkInlineBuild(p._def as Extract<typeof p._def, { tag: 'node' }>)).toBe('Ruleset')
  })

  it('rejects callee type mismatch', () => {
    const p = node('Ruleset', literal('x'), (c, _fields, s, r, tl) => localMk('Other', c, r, s, tl))
    expect(analyzeMkInlineBuild(p._def as Extract<typeof p._def, { tag: 'node' }>)).toBeNull()
  })

  it('accepts loose callee shape (e.g. bundled import alias)', () => {
    const alias = { mk: localMk }
    const p = node('Ruleset', literal('x'), (c, _fields, s, r, tl) => alias.mk('Ruleset', c, r, s, tl))
    expect(analyzeMkInlineBuild(p._def as Extract<typeof p._def, { tag: 'node' }>)).toBe('Ruleset')
  })

  it('rejects a STRICT mk(...) shape whose literal type differs from node type', () => {
    // The build fn source matches MK_BUILD_RE (the strict `(c,r,s,tl) => mk('X', ...)`
    // shape) but the literal type passed to `mk` is not the node's own `type` —
    // e.g. copy-pasted build fn with a stale type string. Must return null (the
    // `mkType === def.type ? def.type : null` ternary's else branch), not silently
    // accept the mismatched type.
    const p = node('Foo', literal('x'), (c, _fields, s, r, tl) => localMk('Bar', c, r, s, tl))
    expect(analyzeMkInlineBuild(p._def as Extract<typeof p._def, { tag: 'node' }>)).toBeNull()
  })

  it('CSS grammar inlines all node builds', () => {
    const src = compile(Stylesheet).source
    expect(src).not.toMatch(/_build\[\d+\]/)
    expect((src.match(/type: "/g) ?? []).length).toBeGreaterThan(10)
  })

  it('emits object literal for a single node rule', () => {
    const p = node('Num', literal('1'), (c, _fields, s, r, tl) => localMk('Num', c, r, s, tl))
    const src = compile(p).source
    expect(src).toContain('type: "Num"')
    expect(src).toContain('rawCount: _raw')
    expect(src).not.toMatch(/_build\[\d+\]/)
  })
})

describe('emitInlineMkNodeExpr', () => {
  it('matches mk() field shape', () => {
    expect(emitInlineMkNodeExpr('Foo', '_ch', '_raw', 'pos', 'end', '_tl')).toBe(
      '{ _tag: \'node\', type: "Foo", span: { start: pos, end: end }, children: _ch, rawCount: _raw.length, localTriviaLen: _tl.length }',
    )
  })
})
