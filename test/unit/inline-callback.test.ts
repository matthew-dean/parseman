import { describe, it, expect } from 'vitest'
import { transform, sequence, literal, optional, regex, parse } from '../../src/index.ts'
import { compile } from '../../src/compiler/codegen.ts'
import {
  tryInlineUnaryTransform,
  tryInlineDestructureTransform,
  parseArrayDestructure,
} from '../../src/compiler/inline-callback.ts'

describe('inline transform — unary', () => {
  it('inlines parseInt', () => {
    expect(tryInlineUnaryTransform('s => parseInt(s, 10)', '_v')).toBe('parseInt(_v, 10)')
  })

  it('inlines bool compare', () => {
    expect(tryInlineUnaryTransform("s => s === 'true'", '_v')).toBe("_v === 'true'")
  })

  it('inlines nullary', () => {
    expect(tryInlineUnaryTransform('() => null', '_v')).toBe('null')
  })

  it('rejects closure refs', () => {
    expect(tryInlineUnaryTransform('s => outer(s)', '_v')).toBeNull()
  })
})

describe('inline transform — sequence fusion', () => {
  it('inlines destructure object literal', () => {
    const body = tryInlineDestructureTransform(
      "([, t]) => ({ kind: 'ListType' as const, type: t })",
      ['_a', '_b', '_c'],
    )
    expect(body).toBe("({ kind: 'ListType' as const, type: _b })")
  })

  it('inlines ternary on optional second slot', () => {
    const body = tryInlineDestructureTransform(
      '([t, bang]) => bang ? { kind: \'NonNull\' as const, type: t } : t',
      ['_t', '_bang'],
    )
    expect(body).toContain('_bang ?')
    expect(body).toContain('_t')
  })

  it('declines explicit object-key rewrites that would rename public fields', () => {
    const body = tryInlineDestructureTransform(
      '([alias, n]) => ({ alias: alias ?? null, name: n })',
      ['_opt1', '_name'],
    )
    expect(body).toBeNull()
  })
})

describe('inline transform — codegen', () => {
  it('fuses sequence+transform without _arr or _mf', () => {
    const p = transform(
      sequence(literal('['), literal('x'), literal(']')),
      ([, t]) => ({ kind: 'Box' as const, inner: t }),
    )
    const src = compile(p).source
    expect(src).not.toContain('const _arr')
    expect(src).not.toMatch(/_mf\[\d+\]/)
    expect(src).toContain('kind:')
    expect(src).toContain('inner:')
  })

  it('inlines unary transform without _mf', () => {
    const p = transform(literal('42'), () => 42)
    const src = compile(p).source
    expect(src).not.toMatch(/_mf\[\d+\]/)
    expect(src).toContain('const _mapped')
  })

  it('preserves public object keys when destructured transform falls back', () => {
    const ident = regex(/[a-z]+/)
    const p = transform(
      sequence(optional(transform(sequence(ident, literal(':')), ([alias]) => alias)), ident),
      ([alias, n]) => ({ alias: alias ?? null, name: n }),
    )

    const interpreted = parse(p, 'viewer')
    const compiled = compile(p).parse('viewer')

    expect(compiled).toEqual(interpreted)
    expect(compiled.ok && compiled.value).toEqual({ alias: null, name: 'viewer' })
    expect(compiled.ok && Object.keys(compiled.value)).toEqual(['alias', 'name'])
  })
})

describe('parseArrayDestructure', () => {
  it('handles holes', () => {
    expect(parseArrayDestructure(', t', 3)).toEqual([null, 't', null])
  })
})
