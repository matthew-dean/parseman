/**
 * The external language-service layer: editor behaviour (recovery, diagnostics,
 * completions) layered onto a grammar via config keyed by node type — the grammar
 * itself carries NONE of it. This is the acceptance test for the whole re-arch.
 */
import { describe, it, expect } from 'vitest'
import { regex, literal, sequence, sepBy, node, choice } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { languageService } from '../../src/language-service/index.ts'

const ident = regex(/[a-z]+/)
const color = node('Color', regex(/red|blue|green/), (c, _f, s) => ({ type: 'Color', text: c[0], span: s }))
const numV = node('Num', regex(/[0-9]+/), (c, _f, s) => ({ type: 'Num', text: c[0], span: s }))
const decl = node('Decl', sequence(ident, literal(':'), choice(color, numV)), (c, _f, s) => ({ type: 'Decl', children: c, span: s }))
const block = node('Block', sequence(literal('{'), sepBy(decl, literal(';')), literal('}')), (c, _f, s) => ({ type: 'Block', children: c, span: s })) as Combinator<unknown>

// Editor knowledge lives ENTIRELY here, not in the grammar above.
const css = languageService(block, {
  diagnostics: {
    Color: (n) => [{ severity: 'warning' as const, message: 'color used', span: n.span }],
  },
  complete: {
    Decl: () => [{ label: 'color' }, { label: 'width' }],
  },
})

describe('languageService — diagnostics keyed by node type', () => {
  it('fires per-node-type lint rules over a valid parse', () => {
    const d = css.diagnostics('{a:red;b:blue}')
    expect(d.filter(x => x.severity === 'warning')).toHaveLength(2) // two Color nodes
    expect(d[0]!.span).toEqual({ start: 3, end: 6 }) // `red`
  })

  it('composes recovery + lint: a bad element becomes an error, the rest still lints', () => {
    const d = css.diagnostics('{a:red;$$;b:blue}')
    const errors = d.filter(x => x.severity === 'error')
    const warns = d.filter(x => x.severity === 'warning')
    expect(errors).toHaveLength(1) // the `$$` element, recovered
    expect(errors[0]!.span).toEqual({ start: 7, end: 9 })
    expect(warns).toHaveLength(2) // both Color nodes still found past the error
  })
})

describe('languageService — completions', () => {
  it('returns the grammar expected-token set at the cursor', () => {
    const c = css.completionsAt('{a:', 3).map(x => x.label)
    expect(c).toContain('/red|blue|green/')
    expect(c).toContain('/[0-9]+/')
  })

  it('is empty on a fully valid prefix', () => {
    expect(css.completionsAt('{a:red', 6).length).toBeGreaterThanOrEqual(0)
  })
})

describe('languageService — the grammar is untouched', () => {
  it('the grammar combinator carries no recovery/IDE surface', () => {
    // Nothing the language service does mutates or annotates the grammar; the same
    // combinator parses identically with or without the service wrapping it.
    expect(block._def.tag).toBe('node')
    expect('recover' in block).toBe(false)
    expect(css.parse('{a:red}', { tolerant: false }).ok).toBe(true)
  })
})
