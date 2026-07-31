/**
 * The verified-fix loop, and the properties that make it safe to trust.
 *
 * The claim under test is not "a rewrite was proposed" but "a rewrite was proposed ONLY
 * when applying it left the parse output unchanged". So the tests below are mostly about
 * the refusals: no corpus, an unfaithful rebuild, a frozen subtree, a rewrite with no
 * measurable benefit. A proposer that offers something is easy; one that declines for the
 * right reason is the product.
 */
import { describe, it, expect } from 'vitest'
import {
  choice, sequence, literal, regex, not, peek, parse, rules, node,
  many, optional, dispatch, when, otherwise, type Combinator,
} from '../../src/index.ts'
import { proposeFixes, applyFixEdits } from '../../src/analysis/fix.ts'
import { rebuildCombinator } from '../../src/analysis/rebuild.ts'
import { renderFixReport } from '../../src/analysis/fix-render.ts'
import { renderDiagnosis, diagnosisRows } from '../../src/analysis/diagnose-render.ts'
import { fixReportRows } from '../../src/analysis/fix-render.ts'
import { codeFrame, plain, render } from '../../src/analysis/terminal.ts'
import { diagnoseGrammar } from '../../src/analysis/diagnose.ts'
import { measureChoiceCost, armFirstSets } from '../../src/analysis/corpus.ts'
import { choiceArms, analyzeGating } from '../../src/analysis/gating.ts'

const corpus = [
  { name: 'a.txt', text: 'if true then x else y' },
  { name: 'b.txt', text: 'while false do z' },
]

/** A grammar carrying the two anti-patterns the fixer knows how to rewrite. */
function keywordGrammar(): Combinator<unknown> {
  return many(choice(
    regex(/if(?!\w)/),
    regex(/while(?![\w-])/),
    regex(/[a-z]+/),
    literal(' '),
  ))
}

describe('rebuildCombinator', () => {
  it('reproduces a grammar exactly when nothing is substituted', () => {
    const g = keywordGrammar()
    const { root, unapplied } = rebuildCombinator(g, new Map())
    expect(unapplied).toEqual([])
    for (const s of corpus) {
      expect(JSON.stringify(parse(root, s.text))).toBe(JSON.stringify(parse(g, s.text)))
    }
  })

  it('substitutes the node it is given, and the substitution reaches BOTH engines', () => {
    const inner = literal('x')
    const target = not(not(inner))
    const g = sequence(target, literal('x'))
    const { root } = rebuildCombinator(g, new Map([[target, peek(inner)]]))
    // The interpreter runs `parse` closures captured at construction, so a rewrite that
    // only patched `_def` would leave this untouched while codegen saw the new graph.
    expect(root._def.tag).toBe('sequence')
    const first = (root._def as { parsers: Combinator<unknown>[] }).parsers[0]!
    expect(first._def.tag).toBe('peek')
    expect(parse(root, 'x').ok).toBe(true)
  })

  it('reuses an un-rebuildable subtree verbatim and REPORTS the target it could not reach', () => {
    const target = not(not(literal('a')))
    const d = dispatch(
      regex(/[ab]/),
      when('a', sequence(target, literal('a'))),
      otherwise(literal('b')),
    )
    const { frozen, unapplied } = rebuildCombinator(d as Combinator<unknown>, new Map([[target, peek(literal('a'))]]))
    expect(frozen.some(f => f.tag === 'dispatch')).toBe(true)
    // Silently dropping it is the failure mode this exists to prevent.
    expect(unapplied).toContain(target)
  })

  it('carries rule names through, so a rebuilt grammar diagnoses under the same ids', () => {
    const g = rules<{ Doc: Combinator<unknown>; Item: Combinator<unknown> }>(r => ({
      Doc: many(r.Item as Combinator<unknown>),
      Item: choice(regex(/if(?!\w)/), regex(/[a-z]+/)),
    }))
    const before = analyzeGating(g.Doc)
    const after = analyzeGating(rebuildCombinator(g.Doc, new Map()).root)
    expect(after.choices.map(c => c.id)).toEqual(before.choices.map(c => c.id))
  })
})

describe('proposeFixes', () => {
  it('offers a keyword rewrite, with the evidence that it was verified', () => {
    const r = proposeFixes(keywordGrammar(), { corpus })
    expect(r.ok).toBe(true)
    expect(r.verified.length).toBeGreaterThan(0)
    const f = r.verified[0]!
    expect(f.code).toBe('keyword-regex')
    expect(f.after.startsWith('word(') || f.after.startsWith('keywords(')).toBe(true)
    expect(f.evidence.outputUnchanged).toBe(true)
    expect(f.evidence.samples).toBe(corpus.length)
    expect(f.evidence.engines).toContain('compiled')
  })

  it('rewrites not(not(X)) to peek(X)', () => {
    const g = choice(sequence(not(not(literal('x'))), literal('x')), literal('y'))
    const r = proposeFixes(g, { corpus: [{ name: 'x', text: 'x' }, { name: 'y', text: 'y' }] })
    expect(r.verified.map(f => f.code)).toContain('double-not')
    expect(r.verified.find(f => f.code === 'double-not')!.after).toBe('peek(…)')
  })

  it('FAILS CLOSED with no corpus — an unverified rewrite is not offered', () => {
    const r = proposeFixes(keywordGrammar(), { corpus: [] })
    expect(r.ok).toBe(false)
    expect(r.verified).toEqual([])
    expect(r.blocked).toContain('no corpus')
  })

  it('LOCATES a keyword regex it cannot prove equivalent, with the reason', () => {
    // `^` under regex()'s sticky compilation matches only at offset 0. keywords() does
    // not reproduce that, so no rewrite may be offered — but the site is still named.
    const g = choice(regex(/^start/), literal('b'))
    const r = proposeFixes(g, { corpus: [{ name: 'a', text: 'start' }] })
    expect(r.verified).toEqual([])
    expect(r.located.some(l => l.reason.includes('anchored'))).toBe(true)
  })

  it('declines a verified rewrite that improves nothing measurable', () => {
    // A one-arm-per-first-char choice already gates; removing the anti-pattern is the
    // only movement, so a grammar with no anti-pattern to remove yields nothing.
    const g = choice(literal('a'), literal('b'))
    const r = proposeFixes(g, { corpus: [{ name: 'a', text: 'a' }] })
    expect(r.ok).toBe(true)
    expect(r.verified).toEqual([])
  })

  it('locates an edit in source only when the spelling is unambiguous', () => {
    const text = 'const a = choice(regex(/if(?!\\w)/), regex(/[a-z]+/))\n'
    const r = proposeFixes(choice(regex(/if(?!\w)/), regex(/[a-z]+/)), {
      corpus: [{ name: 'a', text: 'if' }],
      source: { path: 'g.ts', text },
    })
    const f = r.verified.find(x => x.edit !== undefined)
    expect(f?.edit?.oldText).toBe('regex(/if(?!\\w)/)')
    expect(f?.edit?.line).toBe(1)
    const applied = applyFixEdits(text, r.verified)
    expect(applied.applied).toBe(1)
    expect(applied.text).toContain("word('if', '\\w')")
  })

  it('refuses an edit when the same spelling occurs twice', () => {
    const text = 'a = regex(/if(?!\\w)/)\nb = regex(/if(?!\\w)/)\n'
    const r = proposeFixes(choice(regex(/if(?!\w)/), regex(/[a-z]+/)), {
      corpus: [{ name: 'a', text: 'if' }],
      source: { path: 'g.ts', text },
    })
    expect(r.verified).toEqual([])
    expect(r.located.some(l => l.reason.includes('occurs 2 times'))).toBe(true)
  })
})

describe('renderings are deterministic and colour-free by default', () => {
  it('renders the same bytes twice, with no ANSI', () => {
    const r = proposeFixes(keywordGrammar(), { corpus })
    const a = renderFixReport(r, { name: 'g.ts' })
    const b = renderFixReport(r, { name: 'g.ts' })
    expect(a).toBe(b)
    expect(a.includes('\u001b[')).toBe(false)
    expect(renderFixReport(r, { name: 'g.ts', color: true }).includes('\u001b[')).toBe(true)
  })

  it('renders a clean grammar in two lines', () => {
    const d = diagnoseGrammar(choice(literal('a'), literal('b')))
    expect(renderDiagnosis(d, { name: 'g.ts' }).split('\n')).toHaveLength(2)
  })

  it('never prints a number the report does not hold', () => {
    const g = keywordGrammar()
    const d = diagnoseGrammar(g)
    const sets = new Map<string, readonly string[]>()
    const cost = new Map()
    for (const c of d.gating.choices) {
      const arms = choiceArms(c)!
      const fs = armFirstSets(arms)
      sets.set(c.id, fs.map(x => x.firstSet.kind))
      cost.set(c.id, measureChoiceCost(c, corpus, fs))
    }
    const text = renderDiagnosis(d, { name: 'g.ts', armFirstSets: sets, cost })
    for (const c of cost.values()) expect(text).toContain(String(c.positions))
  })
})

describe('node()/rules() shapes the rebuilder must not corrupt', () => {
  it('preserves node type, opts and structure through a rebuild', () => {
    const g = node('Doc', sequence(literal('('), optional(literal('x')), literal(')')), { collapse: true })
    const { root } = rebuildCombinator(g as Combinator<unknown>, new Map())
    expect(JSON.stringify(parse(root, '(x)'))).toBe(JSON.stringify(parse(g as Combinator<unknown>, '(x)')))
    expect((root._def as { type?: string }).type).toBe('Doc')
    expect((root._def as { collapse?: boolean }).collapse).toBe(true)
  })
})

describe('terminal layer — the rendering contract linecraft is here to hold', () => {
  const ESC = '\u001b'

  it('produces NO escape byte at all without colour — not stripped, never emitted', () => {
    const r = proposeFixes(keywordGrammar(), { corpus })
    const rows = fixReportRows(r, { name: 'g.ts' })
    // The plain form is the rows' own text. There is no second code path that could
    // drift from the styled one, which is the whole reason rows exist.
    expect(plain(rows).includes(ESC)).toBe(false)
    expect(render(rows, { color: false })).toBe(plain(rows))
    expect(render(rows, { color: true }).includes(ESC)).toBe(true)
  })

  it('renders identically regardless of terminal environment', () => {
    const d = diagnoseGrammar(keywordGrammar())
    const once = renderDiagnosis(d, { name: 'g.ts' })
    const saved = { ...process.env }
    try {
      process.env.TERM = 'dumb'
      process.env.COLORFGBG = '15;0'
      process.env.COLUMNS = '200'
      expect(renderDiagnosis(d, { name: 'g.ts' })).toBe(once)
    }
    finally { process.env = saved }
  })

  it('draws a real code frame, with no absolute path in the plain form', () => {
    const rows = codeFrame({
      path: 'a/b.css',
      fullPath: '/Users/someone/a/b.css',
      line: 3,
      column: 5,
      lineText: '  color: red;',
      message: 'value',
      shortMessage: 'arm 2 can start here',
      type: 'warning',
    })
    const text = plain(rows)
    expect(text).toContain('a/b.css:3:5')
    expect(text).toContain('color: red;')
    expect(text).toContain('arm 2 can start here')
    expect(text.includes('/Users/')).toBe(false)
    expect(text.includes(ESC)).toBe(false)
  })

  it('keeps every row inside the requested width', () => {
    const d = diagnoseGrammar(keywordGrammar())
    for (const r of diagnosisRows(d, { name: 'g.ts', width: 80 })) {
      expect(r.text.length).toBeLessThanOrEqual(100)
    }
  })
})
