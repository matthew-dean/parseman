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
import { renderDiagnosis, diagnosisLines } from '../../src/analysis/diagnose-render.ts'
import { fixReportLines } from '../../src/analysis/fix-render.ts'
import { codeFrame, plain, render, render as render2 } from '../../src/analysis/terminal.ts'
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
    expect(r.blocked).toContain('no files were given to check against')
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

  it('delimits not(not(X)) past a parenthesis inside a STRING LITERAL', () => {
    // A raw paren counter closes one level early on `literal(')')`, so `oldText` becomes
    // the unbalanced `not(not(literal(')'))`. `applyFixEdits` cannot catch that — it
    // compares against the same mis-delimited span — so `--apply` would write a wrong
    // edit into the user's file. The whole contract of this module is that an edit
    // applied to the wrong site is worse than no edit at all.
    const g = choice(sequence(not(not(literal(')'))), literal(')')), literal('y'))
    const text = "const g = choice(sequence(not(not(literal(')'))), literal(')')), literal('y'))\n"
    const r = proposeFixes(g, {
      corpus: [{ name: 'a', text: ')' }, { name: 'b', text: 'y' }],
      source: { path: 'g.ts', text },
    })
    const f = r.verified.find(x => x.code === 'double-not')
    expect(f?.edit?.oldText).toBe("not(not(literal(')')))")
    expect(f?.edit?.newText).toBe("peek(literal(')'))")
    const applied = applyFixEdits(text, r.verified)
    expect(applied.applied).toBe(1)
    expect(applied.text).toContain("sequence(peek(literal(')')), literal(')'))")
  })

  it('DECLINES a not(not(X)) site whose extent a `/` makes undecidable', () => {
    // Telling a regex literal from division needs the full expression grammar, and a
    // regex body may hold unbalanced parens. Declining names the site and prints the
    // rewrite; guessing would delimit the wrong text.
    const g = choice(sequence(not(not(regex(/[(]/))), literal('(')), literal('y'))
    const r = proposeFixes(g, {
      corpus: [{ name: 'a', text: '(' }, { name: 'b', text: 'y' }],
      source: { path: 'g.ts', text: 'const g = not(not(regex(/[(]/)))\n' },
    })
    expect(r.verified.some(x => x.code === 'double-not')).toBe(false)
    expect(r.located.some(l => l.reason.includes('regular expression'))).toBe(true)
  })

  it('gives two choices of ONE rule distinct candidate ids', () => {
    // `analyzeGating` spells a rule's second choice `rule#1` precisely because a rule can
    // hold several. An id built from the rule name alone collides across them, and the
    // report then renders two distinct sites as one — which is what a reader greps and
    // what `--apply` attribution reads.
    const m = rules(() => ({
      Doc: sequence(
        choice(regex(/if(?!\w)/), regex(/[a-z]+/)),
        choice(regex(/while(?![\w-])/), regex(/[0-9]+/)),
      ),
    })) as Record<string, Combinator<unknown>>
    const r = proposeFixes(m.Doc!, { corpus: [{ name: 'a', text: 'ifwhile' }] })
    const ids = [...r.verified, ...r.located].map(x => x.id)
    expect(ids.length).toBeGreaterThan(1)
    expect(new Set(ids).size).toBe(ids.length)
    // And each site names the choice it actually sits in, not the rule's first one.
    for (const f of r.verified) expect(f.id.startsWith(`${f.choiceId}#arm`)).toBe(true)
    expect(new Set(r.verified.map(f => f.choiceId)).size).toBeGreaterThan(1)
  })

  it('refuses an edit when the same spelling occurs twice', () => {
    const text = 'a = regex(/if(?!\\w)/)\nb = regex(/if(?!\\w)/)\n'
    const r = proposeFixes(choice(regex(/if(?!\w)/), regex(/[a-z]+/)), {
      corpus: [{ name: 'a', text: 'if' }],
      source: { path: 'g.ts', text },
    })
    expect(r.verified).toEqual([])
    expect(r.located.some(l => l.reason.includes('appears 2 times'))).toBe(true)
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
    const rows = fixReportLines(r, { name: 'g.ts' })
    // The plain form is the lines' own span text. There is no second code path that
    // could drift from the styled one, which is the whole reason spans exist.
    expect(plain(rows).includes(ESC)).toBe(false)
    expect(render(rows, { color: false })).toBe(plain(rows))
    expect(render(rows, { color: true }).includes(ESC)).toBe(true)
  })

  it('STYLED AND PLAIN DIFFER ONLY IN STYLING — strip the escapes and they are equal', () => {
    // The invariant the whole terminal layer exists to hold. It has been broken twice by
    // linecraft component layout (`Styled` left-trimming a cell, a `Grid` reflowing a
    // long one) and both times the styled line lost CONTENT, not just colour. Strip and
    // compare is the only assertion that catches that.
    const d = diagnoseGrammar(keywordGrammar())
    const sets = new Map<string, readonly string[]>()
    const cost = new Map()
    for (const c of d.gating.choices) {
      const arms = choiceArms(c)!
      const fs = armFirstSets(arms)
      sets.set(c.id, fs.map(x => (x.firstSet.kind === 'any' ? 'ANY' : x.firstSet.kind)))
      cost.set(c.id, measureChoiceCost(c, corpus, fs))
    }
    const opts = { name: 'g.ts', armFirstSets: sets, cost, width: 80 }
    const lines = diagnosisLines(d, opts)
    const stripped = render(lines, { ...opts, color: true })
      .replace(new RegExp(`${ESC}\\]8;;.*?${ESC}\\\\`, 'g'), '')
      .replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
      .split('\n').map(l => l.replace(/ +$/, '')).join('\n')
    expect(stripped).toBe(plain(lines))
  })

  it('states each cause ONCE, however many sites it has', () => {
    const d = diagnoseGrammar(keywordGrammar())
    const text = renderDiagnosis(d, { name: 'g.ts', width: 80 })
    // The regression that prompted the rewrite: three explanations rendered nine times.
    for (const f of d.findings) {
      for (const detail of f.details) {
        const i = detail.indexOf('\nfix: ')
        if (i === -1) continue
        const sentence = detail.slice(i + 6).split('. ')[0]!
        const hits = text.split(sentence).length - 1
        expect(hits).toBeLessThanOrEqual(1)
      }
    }
  })

  it('prints ONE accept snapshot, not one per site', () => {
    const d = diagnoseGrammar(keywordGrammar())
    const text = renderDiagnosis(d, { name: 'g.ts', width: 80 })
    expect(text.split('{ accept: [').length - 1).toBeLessThanOrEqual(1)
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

  // The header's cause/gating summary is emitted as ONE unwrapped line whose length is
  // its own content — measured at 93 columns for every requested width from 40 to 80.
  // Every OTHER row honours `width`. The exception is pinned BY NAME rather than hidden
  // under a slack constant, so a row that overshoots for any other reason fails here.
  it('keeps every row inside the requested width, except the unwrapped header summary', () => {
    const d = diagnoseGrammar(keywordGrammar())
    const width = 80
    for (const l of diagnosisLines(d, { name: 'g.ts', width })) {
      const text = l.map(x => x.text).join('')
      if (text.includes('choices already gate')) continue
      expect(text.length, text).toBeLessThanOrEqual(width)
    }
  })
})

describe('the output is written for someone who has never read parseman', () => {
  const render = (): string => {
    const g = keywordGrammar()
    const d = diagnoseGrammar(g)
    const sets = new Map<string, readonly string[]>()
    const labels = new Map<string, readonly string[]>()
    const cost = new Map()
    for (const c of d.gating.choices) {
      const arms = choiceArms(c)!
      const fs = armFirstSets(arms)
      sets.set(c.id, fs.map(x => (x.firstSet.kind === 'any' ? 'ANY' : "'x'")))
      labels.set(c.id, arms.map(a => a._def.tag))
      cost.set(c.id, measureChoiceCost(c, corpus, fs))
    }
    return renderDiagnosis(d, { name: 'g.ts', width: 80, armFirstSets: sets, armLabels: labels, cost })
  }

  it('never prints the model\'s vocabulary raw', () => {
    const text = render()
    // Each of these was in the output and meant nothing to a reader who had not read
    // the source. They are allowed inside a longer sentence, never as a bare label.
    expect(text).not.toContain('ANY —')
    expect(text).not.toContain('entered at ALL')
    expect(text).not.toContain('first-set')
    expect(text).not.toMatch(/\bungated\b/)
    expect(text).not.toContain('dispatch')
  })

  it('defines "arm" exactly once, before anything uses it', () => {
    const text = render()
    const defs = text.split('one alternative of a choice').length - 1
    expect(defs).toBe(1)
    expect(text.indexOf('one alternative of a choice')).toBeLessThan(text.indexOf('arm 0'))
  })

  it('gives every number a unit', () => {
    const text = render()
    for (const line of text.split('\n')) {
      // A bare number at the end of a line is the failure mode: `… ALL 81`.
      expect(line).not.toMatch(/\b(?:tried at all|entered at all|reached at)\s+[\d,]+\s*$/)
    }
    expect(text).toMatch(/places in your corpus/)
  })

  it('states the consequence, not only the observation', () => {
    // Whatever the cause, the group text has to say what it COSTS, not just what it is.
    expect(render()).toMatch(/instead of skipping it|undoes the ones that do not match|cannot skip the arm/)
  })

  it('ends with a one-line summary carrying the exit code in words', () => {
    const lines = render().trimEnd().split('\n')
    expect(lines[lines.length - 1]).toMatch(/problem/)
    expect(lines[lines.length - 1]).toMatch(/exiting 1/)
  })

  it('marks a finding fixable ONLY when a rewrite was proven, and names the command', () => {
    const g = keywordGrammar()
    const proved = proposeFixes(g, { corpus })
    const fixable = new Set(proved.verified.map(f => f.id))
    expect(fixable.size).toBeGreaterThan(0)
    const d = diagnoseGrammar(g)
    const withWrench = renderDiagnosis(d, { name: 'g.ts', width: 80, fixable, fixCommand: 'parseman fix g.ts' })
    expect(withWrench).toContain('🔧')
    expect(withWrench).toContain('parseman fix g.ts')
    // …and NEVER when nothing was proven. Offering a fix that does not exist would
    // destroy the one guarantee the feature has.
    const without = renderDiagnosis(d, { name: 'g.ts', width: 80 })
    expect(without).not.toContain('🔧')
  })

  it('keeps every line inside the requested width', () => {
    for (const line of render().split('\n')) expect([...line].length).toBeLessThanOrEqual(80)
  })
})

describe('terminal hyperlinks', () => {
  const ESC2 = String.fromCharCode(27)

  it('are emitted only in the styled path, and are zero-width', () => {
    const lines = [[{ text: 'a/b.ts:1:2  ', style: { color: 'cyan' as const }, link: '/abs/a/b.ts' }]]
    expect(plain(lines)).toBe('a/b.ts:1:2')
    expect(plain(lines).includes('/abs/')).toBe(false)
    const styled = render2(lines, { color: true })
    expect(styled).toContain('/abs/a/b.ts')
    // Stripping BOTH escape families must return the plain text: a link adds no content.
    const bare = styled
      .replace(new RegExp(`${ESC2}\\]8;;.*?${ESC2}\\\\`, 'g'), '')
      .replace(new RegExp(`${ESC2}\\[[0-9;]*m`, 'g'), '')
    expect(bare).toBe(plain(lines))
  })

  it('can be turned off without changing the visible text', () => {
    const lines = [[{ text: 'a/b.ts:1:2', link: '/abs/a/b.ts' }]]
    expect(render2(lines, { color: true, links: false })).toBe(plain(lines))
  })
})
