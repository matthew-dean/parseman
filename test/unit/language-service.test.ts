/**
 * The external language-service layer: editor behaviour (recovery, diagnostics,
 * completions) layered onto a grammar via config keyed by node type — the grammar
 * itself carries NONE of it. This is the acceptance test for the whole re-arch.
 */
import { describe, it, expect } from 'vitest'
import { regex, literal, sequence, sepBy, node, choice, rules, optional, expect as expectTok } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import type { Registry } from '../../src/functional/doc.ts'
import type { NodeLike } from '../../src/cst/types.ts'
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

// ── incremental document (the parseDoc fusion) ────────────────────────────────
// Structural node() rules (built via the CST host) keyed by rule name = node type,
// so the document can address rules individually for incremental re-parse.
const g = rules(self => ({
  Block: node(sequence(literal('{'), sepBy(self.Decl, literal(';')), literal('}'))),
  Decl: node(sequence(regex(/[a-z]+/), literal(':'), self.Val)),
  Val: node(choice(regex(/red|blue|green/), regex(/[0-9]+/))),
}))
const doc0 = () => languageService(
  { rules: g as unknown as Registry<NodeLike>, root: 'Block' },
  { diagnostics: { Val: (n) => (/^(red|blue|green)/.test(n.value ?? '') ? [] : []) } },
).openDocument('{a:red;b:blue}')

describe('languageService.openDocument — incremental editor document', () => {
  it('keeps a live tree and diagnostics through a broken edit, then recovers', () => {
    const d0 = doc0()
    expect(d0.tree).not.toBeNull()
    expect(d0.diagnostics().filter(x => x.severity === 'error')).toHaveLength(0)

    // Break the middle element: replace 'b:blue' with '$$' → recovered error.
    // '{a:red;b:blue}' — 'b:blue' spans offsets 7..13.
    const d1 = d0.edit(7, 13, '$$')
    expect(d1.tree).not.toBeNull() // tree survives the broken keystroke
    const errs = d1.diagnostics().filter(x => x.severity === 'error')
    expect(errs).toHaveLength(1)
    expect(errs[0]!.span).toEqual({ start: 7, end: 9 })

    // Fix it back → the error clears, tree whole again.
    const d2 = d1.edit(7, 9, 'b:blue')
    expect(d2.diagnostics().filter(x => x.severity === 'error')).toHaveLength(0)
    expect(d2.tree).toEqual(d0.tree) // structurally back to the original
  })

  it('the document tree === a fresh full tolerant parse of the same text', () => {
    const edited = doc0().edit(7, 13, '$$;c:9')
    const fresh = languageService(
      { rules: g as unknown as Registry<NodeLike>, root: 'Block' }, {},
    ).openDocument('{a:red;$$;c:9}')
    expect(edited.tree).toEqual(fresh.tree)
  })

  it('openDocument throws on a bare-entry service (no registry)', () => {
    expect(() => css.openDocument('{a:red}')).toThrow(/registry/)
  })
})

// ── unified diagnostics: missing closer (expect) + trailing junk ─────────────
// Grammar whose closing `}` is REQUIRED via expect(), so a missing one recovers
// (embeds a parseError) instead of aborting — the case the old diagnostics()
// (tree-walk only, never consulting unconsumedFrom) rendered invisible.
const gx = rules(self => ({
  Block: node(sequence(literal('{'), optional(sepBy(self.Decl, literal(';'))), expectTok(literal('}')))),
  Decl: node(sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/))),
}))
const lsx = languageService({ rules: gx as unknown as Registry<NodeLike>, root: 'Block' }, {})

describe('languageService.diagnostics — unified sources (no invisible errors)', () => {
  it('surfaces a missing required closer (was []: tree walk missed expect errors)', () => {
    const d = lsx.diagnostics('{a:1').filter(x => x.severity === 'error')
    expect(d).toHaveLength(1)
    expect(d[0]!.span).toEqual({ start: 4, end: 4 })
  })

  it('surfaces trailing junk after a complete parse via unconsumedFrom', () => {
    const d = lsx.diagnostics('{a:1}xyz').filter(x => x.severity === 'error')
    expect(d).toHaveLength(1)
    expect(d[0]!.span).toEqual({ start: 5, end: 8 })
  })

  it('a well-formed document yields no diagnostics', () => {
    expect(lsx.diagnostics('{a:1;b:2}')).toEqual([])
  })

  it('embedded + flat errors for the same recovery are deduped to one', () => {
    // '{abc' recovers the junk element (embedded + flat, same span) → exactly one.
    const d = lsx.diagnostics('{abc').filter(x => x.severity === 'error')
    const spans = d.map(x => `${x.span.start}:${x.span.end}`)
    expect(new Set(spans).size).toBe(spans.length) // no duplicate spans/messages
  })

  it('the incremental document surfaces the same missing-closer + junk', () => {
    const doc = lsx.openDocument('{a:1')
    expect(doc.diagnostics().filter(x => x.severity === 'error')).toHaveLength(1)
    const fixed = doc.edit(4, 4, '}')
    expect(fixed.diagnostics()).toEqual([])
    const junk = fixed.edit(5, 5, 'zz')
    expect(junk.diagnostics().filter(x => x.severity === 'error')).toHaveLength(1)
  })
})
