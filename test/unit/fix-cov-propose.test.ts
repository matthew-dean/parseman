/**
 * `fix.ts` — what gets OFFERED, what gets DECLINED, and where the edit lands.
 *
 * The module's whole claim is that a rewrite reaches the reader only after it was
 * applied, the parser rebuilt and the corpus re-parsed to a byte-identical result. Two
 * things follow, and both are tested here rather than assumed:
 *
 *   - a candidate that cannot be rebuilt (it sits in a frozen subtree), cannot be proven
 *     equivalent (the regex is not a plain keyword), or buys nothing measurable, comes
 *     back as LOCATED with the exact reason — never as silence, and never as advice;
 *   - a source edit is offered only when the site is unambiguous IN THE TEXT, and
 *     `locateEdit` must delimit `not(not(…))` past parentheses hiding in string
 *     literals, template quasis and comments. `applyFixEdits` cannot catch a
 *     mis-delimited span — it compares against the same span — so a wrong `oldText` is
 *     written straight into the user's file. That is the failure this module exists to
 *     prevent, so each hiding place gets its own case.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, dispatch, literal, not, otherwise, regex, ref, rules, scanTo, sequence, startsWith, transform, when,
  type Combinator,
} from '../../src/index.ts'
import { applyFixEdits, proposeFixes, type FixEdit, type VerifiedFix } from '../../src/analysis/fix.ts'

const corpusOf = (...texts: string[]): { name: string; text: string }[] =>
  texts.map((text, i) => ({ name: `s${i}.txt`, text }))

/** The one arm the fixer can rewrite, plus a catch-all so the choice does not gate. */
const kw = (r: RegExp): Combinator<unknown> => choice(regex(r), regex(/[a-z]+/))

/** The rewrite offered for `r`, or the reason none was. */
function outcome(r: Combinator<unknown>, ...texts: string[]): { after?: string; reason?: string; before?: string } {
  const rep = proposeFixes(r, { corpus: corpusOf(...texts) })
  const v = rep.verified[0]
  if (v !== undefined) return { after: v.after, before: v.before }
  const l = rep.located[0]
  return l === undefined ? {} : { reason: l.reason, before: l.site }
}

// ── the rewrite spellings ────────────────────────────────────────────────────

describe('proposeFixes — the keyword rewrite it prints', () => {
  it('rewrites a bare word to keywords()', () => {
    expect(outcome(kw(/if/), 'if')).toEqual({ before: 'regex(/if/)', after: "keywords(['if'])" })
  })

  it('carries /i/ through as caseInsensitive', () => {
    expect(outcome(kw(/if/i), 'if'))
      .toEqual({ before: 'regex(/if/i)', after: "keywords(['if'], { caseInsensitive: true })" })
  })

  it('spells a trailing (?![…]) boundary as word(), with the class body verbatim', () => {
    expect(outcome(kw(/while(?![\w-])/), 'while'))
      .toEqual({ before: 'regex(/while(?![\\w-])/)', after: "word('while', '\\w-')" })
  })

  it('carries a BARE escape boundary through as the class body — (?!\\w) and (?![\\w]) are one assertion', () => {
    expect(outcome(kw(/if(?!\w)/), 'if'))
      .toEqual({ before: 'regex(/if(?!\\w)/)', after: "word('if', '\\w')" })
  })

  it('combines a boundary and /i/ into word(word, class, { caseInsensitive })', () => {
    expect(outcome(kw(/if(?!\w)/i), 'if'))
      .toEqual({ before: 'regex(/if(?!\\w)/i)', after: "word('if', '\\w', { caseInsensitive: true })" })
  })

  it('drops an EMPTY (?![]) class — it asserts nothing, so keywords() needs no boundary', () => {
    // The empty class is the POINT of this case: `[]` matches nothing, so `(?![])` always
    // succeeds and carrying it into keywords() would spell an assertion that is not there.
    // eslint-disable-next-line no-empty-character-class
    expect(outcome(kw(/if(?![])/), 'if'))
      .toEqual({ before: 'regex(/if(?![])/)', after: "keywords(['if'])" })
  })

  it('rewrites a word that leads with punctuation, such as an at-keyword', () => {
    expect(outcome(choice(regex(/@media/), regex(/[a-z@]+/)), '@media'))
      .toEqual({ before: 'regex(/@media/)', after: "keywords(['@media'])" })
  })

  it('never prints the sticky flag regex() compiles with', () => {
    // `regex()` compiles sticky. Printing `/if/iy` would be a rewrite of source the
    // author never wrote, and would not match their file either.
    expect(outcome(kw(/if/i), 'if').before).toBe('regex(/if/i)')
  })
})

// ── the refusals ─────────────────────────────────────────────────────────────

describe('proposeFixes — a site it can name but not rewrite', () => {
  it('refuses any flag but /i/, and says which flags it saw', () => {
    expect(outcome(kw(/if/s), 'if')).toEqual({
      before: 'regex(/if/s)',
      reason: 'the pattern carries flags /s/ — only /i/ has a keywords() equivalent',
    })
  })

  it('refuses a ^-anchored pattern, and says why sticky compilation makes it different', () => {
    expect(outcome(choice(regex(/^start/), literal('b')), 'start')).toEqual({
      before: 'regex(/^start/)',
      reason: 'the pattern is `^`-anchored; under regex()\'s sticky compilation that matches '
        + 'only at offset 0, which keywords() does not reproduce',
    })
  })

  it('refuses a lookahead that is not a character-class boundary', () => {
    expect(outcome(kw(/if(?!x)/), 'if')).toEqual({
      before: 'regex(/if(?!x)/)',
      reason: 'the pattern is not a plain keyword (it uses regex syntax beyond a literal word '
        + 'and a trailing (?![…]) boundary)',
    })
  })

  it('says NOTHING about a regex that was never a keyword-shaped finding', () => {
    // A general recognizer that happens not to be a keyword is not a finding at all;
    // locating it would turn the report into noise.
    const r = proposeFixes(choice(regex(/[abc]+/), literal('z')), { corpus: corpusOf('abc') })
    expect(r.ok).toBe(true)
    expect(r.verified).toEqual([])
    expect(r.located).toEqual([])
  })

  it('declines a verified rewrite that moves no measured number, and says so', () => {
    // `straße` is not keyword-SHAPED to `gating.ts`, so rewriting it removes no
    // anti-pattern and un-gates no choice: safe, and pointless.
    expect(outcome(choice(regex(/straße/i), regex(/[a-z]+/)), 'straße')).toEqual({
      before: 'regex(/straße/i)',
      reason: 'a rewrite here is safe but pointless — it changes nothing measurable, so it is '
        + 'not worth the diff',
    })
  })
})

// ── frozen subtrees ──────────────────────────────────────────────────────────

describe('proposeFixes — a candidate parseman cannot rebuild around', () => {
  it('locates a candidate inside a dispatch, naming the tag that froze it', () => {
    const g = dispatch(
      regex(/[a-z]/),
      when('i', kw(/if(?!\w)/)),
      otherwise(literal('z')),
    ) as Combinator<unknown>
    const r = proposeFixes(g, { corpus: corpusOf('if') })
    expect(r.ok).toBe(true)
    expect(r.verified).toEqual([])
    expect(r.frozen).toEqual([{ tag: 'dispatch', rule: '<entry>' }])
    expect(r.located.map(l => l.reason)).toEqual([
      'it sits inside a dispatch, which parseman cannot rebuild exactly. It will not apply a '
      + 'change it cannot then check, so this one is left for you',
    ])
  })

  it('finds a candidate inside a dispatch MATCHER arm, not only a `when(string)` case', () => {
    // A matcher arm is a separate list on the def; a walk that only reads `cases` would
    // report NOTHING for a site that really is there, which is silence, not a refusal.
    const g = dispatch(
      regex(/[a-z]+/),
      when(startsWith('i'), kw(/if(?!\w)/)),
      otherwise(literal('z')),
    ) as Combinator<unknown>
    const r = proposeFixes(g, { corpus: corpusOf('if') })
    expect(r.located.map(l => l.site)).toEqual(['regex(/if(?!\\w)/)'])
    expect(r.located[0]!.reason).toContain('it sits inside a dispatch')
  })

  it('locates a candidate inside a GATED choice, which has no public reconstruction', () => {
    const g = choice(
      { gate: () => true, combinator: kw(/if(?!\w)/) },
      literal('z'),
    ) as Combinator<unknown>
    const r = proposeFixes(g, { corpus: corpusOf('if') })
    expect(r.frozen).toEqual([{ tag: 'choice(gated)', rule: '<entry>' }])
    expect(r.located).toHaveLength(1)
    expect(r.located[0]!.reason).toContain('it sits inside a choice(gated)')
  })

  it('freezes only the subtree that needs it — a candidate OUTSIDE it is still offered', () => {
    const g = choice(
      sequence(scanTo(literal(';'), { skip: [literal('x')] }), literal(';')),
      kw(/if(?!\w)/),
    ) as Combinator<unknown>
    const r = proposeFixes(g, { corpus: corpusOf('if') })
    expect(r.frozen).toEqual([{ tag: 'scanTo', rule: '<entry>' }])
    expect(r.verified.map(f => f.after)).toEqual(["word('if', '\\w')"])
  })
})

// ── ids, options, evidence ───────────────────────────────────────────────────

describe('proposeFixes — identity and options', () => {
  it('walks a shared choice node ONCE, so one site is reported once', () => {
    const shared = kw(/if(?!\w)/)
    const r = proposeFixes(sequence(shared, literal(' '), shared), { corpus: corpusOf('if if') })
    expect([...r.verified, ...r.located]).toHaveLength(1)
  })

  it('uses entryName for the id of an unnamed entry combinator', () => {
    const anonymous = proposeFixes(kw(/if(?!\w)/), { corpus: corpusOf('if') })
    expect(anonymous.verified.map(f => f.id)).toEqual(['<entry>#arm0'])
    const named = proposeFixes(kw(/if(?!\w)/), { corpus: corpusOf('if'), entryName: 'Doc' })
    expect(named.verified.map(f => f.id)).toEqual(['Doc#arm0'])
    expect(named.verified[0]!.choiceId).toBe('Doc')
  })

  it('prefers a real rule name over entryName', () => {
    const m = rules(() => ({ Doc: kw(/if(?!\w)/) })) as Record<string, Combinator<unknown>>
    const r = proposeFixes(m.Doc!, { corpus: corpusOf('if'), entryName: 'IGNORED' })
    expect(r.verified.map(f => f.id)).toEqual(['Doc#arm0'])
  })

  it('threads accept into the benefit measurement, on BOTH sides of the rewrite', () => {
    // An accepted choice is not counted as ungated, so the same rewrite reports a
    // different (and honest) before/after pair. A dropped `accept` would silently
    // re-count a choice its author already signed off on.
    const plain = proposeFixes(kw(/if(?!\w)/), { corpus: corpusOf('if') })
    expect(plain.verified[0]!.benefit.ungatedChoicesBefore).toBe(1)
    expect(plain.verified[0]!.benefit.ungatedChoicesAfter).toBe(1)
    const accepted = proposeFixes(kw(/if(?!\w)/), { corpus: corpusOf('if'), accept: ['<entry>'] })
    expect(accepted.verified[0]!.benefit.ungatedChoicesBefore).toBe(0)
    expect(accepted.verified[0]!.benefit.ungatedChoicesAfter).toBe(0)
    // The anti-pattern still moves, so the rewrite is still worth offering.
    expect(accepted.verified[0]!.benefit.antiPatternsBefore).toBe(1)
    expect(accepted.verified[0]!.benefit.antiPatternsAfter).toBe(0)
  })

  it('carries the corpus size into the report AND into each fix\'s evidence', () => {
    const r = proposeFixes(kw(/if(?!\w)/), { corpus: corpusOf('if', 'abcd') })
    expect(r.corpus).toEqual({ samples: 2, bytes: 6 })
    expect(r.engines).toEqual(['interpreted', 'compiled'])
    expect(r.verified[0]!.evidence)
      .toEqual({ samples: 2, bytes: 6, engines: ['interpreted', 'compiled'], outputUnchanged: true })
  })

  it('reports the corpus counts even on the blocked report, and offers nothing', () => {
    const r = proposeFixes(kw(/if(?!\w)/), { corpus: [] })
    expect(r).toEqual({
      schema: 'parseman.fix/1',
      ok: false,
      blocked: 'no files were given to check against. Pass --corpus <dir> pointing at some input '
        + 'your grammar parses, and parseman will apply each candidate change, rebuild the parser, '
        + 'and offer only the ones that leave your parse output exactly as it was',
      corpus: { samples: 0, bytes: 0 },
      engines: [],
      verified: [], located: [], frozen: [],
    })
  })

  it('measures the compiled artifact size on both sides', () => {
    const b = proposeFixes(kw(/if(?!\w)/), { corpus: corpusOf('if') }).verified[0]!.benefit
    expect(typeof b.artifactBytesBefore).toBe('number')
    expect(typeof b.artifactBytesAfter).toBe('number')
    expect(b.artifactBytesAfter).not.toBe(b.artifactBytesBefore)
  })

  it('sorts verified and located by id, deterministically', () => {
    const m = rules(() => ({
      Doc: sequence(
        choice(regex(/while(?![\w-])/), regex(/[a-z]+/)),
        choice(regex(/if(?!x)/), regex(/[0-9]+/)),
        choice(regex(/if(?!\w)/), regex(/[a-z]+/)),
      ),
    })) as Record<string, Combinator<unknown>>
    const r = proposeFixes(m.Doc!, { corpus: corpusOf('while1if') })
    const ids = [...r.verified, ...r.located].map(x => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    const verifiedIds = r.verified.map(f => f.id)
    const locatedIds = r.located.map(l => l.id)
    expect(verifiedIds).toEqual(verifiedIds.slice().sort())
    expect(locatedIds).toEqual(locatedIds.slice().sort())
  })

  it('walks past an undefined ref() without throwing, and still reports the rest', () => {
    const undef = ref<unknown>()
    const r = proposeFixes(choice(sequence(literal('a'), undef), kw(/if(?!\w)/)), {
      corpus: corpusOf('if'),
    })
    expect(r.ok).toBe(true)
    expect(r.verified.map(f => f.after)).toEqual(["word('if', '\\w')"])
  })
})

// ── locating the edit in source ──────────────────────────────────────────────

describe('locateEdit — the keyword site', () => {
  it('reports the 1-based line and column, the byte span and the whole source line', () => {
    const text = 'line one\nline two\n  const If = regex(/if(?!\\w)/)\n'
    const r = proposeFixes(kw(/if(?!\w)/), { corpus: corpusOf('if'), source: { path: 'g.ts', text } })
    expect(r.verified[0]!.edit).toEqual<FixEdit>({
      path: 'g.ts',
      line: 3,
      column: 14,
      start: 31,
      end: 48,
      oldText: 'regex(/if(?!\\w)/)',
      newText: "word('if', '\\w')",
      lineText: '  const If = regex(/if(?!\\w)/)',
    })
    expect(text.slice(31, 48)).toBe('regex(/if(?!\\w)/)')
  })

  it('reads the last line of a file with no trailing newline', () => {
    const text = 'a\nregex(/if(?!\\w)/)'
    const r = proposeFixes(kw(/if(?!\w)/), { corpus: corpusOf('if'), source: { path: 'g.ts', text } })
    expect(r.verified[0]!.edit!.line).toBe(2)
    expect(r.verified[0]!.edit!.column).toBe(1)
    expect(r.verified[0]!.edit!.lineText).toBe('regex(/if(?!\\w)/)')
  })

  it('offers NO edit at all when no source was supplied', () => {
    const r = proposeFixes(kw(/if(?!\w)/), { corpus: corpusOf('if') })
    expect(r.verified[0]!.edit).toBeUndefined()
    expect(r.located).toEqual([])
  })

  it('declines, with the manual instruction, when the spelling is not in the file', () => {
    const r = proposeFixes(kw(/if(?!\w)/), {
      corpus: corpusOf('if'),
      source: { path: 'g.ts', text: 'const If = KEYWORDS.if\n' },
    })
    expect(r.verified).toEqual([])
    expect(r.located[0]!.reason).toBe(
      'the change itself is proven safe, but `regex(/if(?!\\w)/)` does not appear literally in '
      + 'g.ts, so parseman cannot tell which text to change (it is probably built from a helper '
      + 'or a shared constant). Make it by hand: regex(/if(?!\\w)/) → word(\'if\', \'\\w\')')
  })
})

describe('locateEdit — the not(not(…)) site', () => {
  /** A grammar whose double-not rewrite verifies, so `locateEdit` is always reached. */
  const dn = (): Combinator<unknown> =>
    choice(sequence(not(not(literal('x'))), literal('x')), literal('y'))

  const at = (text: string): { edit?: FixEdit; reason?: string } => {
    const r = proposeFixes(dn(), { corpus: corpusOf('x', 'y'), source: { path: 'g.ts', text } })
    const v = r.verified.find(f => f.code === 'double-not')
    if (v?.edit !== undefined) return { edit: v.edit }
    return { reason: r.located.find(l => l.code === 'double-not')?.reason ?? '(no finding)' }
  }

  const UNBALANCED = 'the parentheses after `not(not(` do not balance, so parseman cannot tell '
    + 'where the site ends'

  it('balances the plain shape and rewrites it to peek()', () => {
    const { edit } = at("const g = not(not(literal('x')))\n")
    expect(edit?.oldText).toBe("not(not(literal('x')))")
    expect(edit?.newText).toBe("peek(literal('x'))")
    expect(edit?.column).toBe(11)
  })

  it('skips a parenthesis inside a DOUBLE-quoted string', () => {
    const { edit } = at('const g = not(not(literal(")")))\n')
    expect(edit?.oldText).toBe('not(not(literal(")")))')
    expect(edit?.newText).toBe('peek(literal(")"))')
  })

  it('skips a parenthesis hidden behind a backslash escape', () => {
    const { edit } = at("const g = not(not(literal('\\)')))\n")
    expect(edit?.oldText).toBe("not(not(literal('\\)')))")
    expect(edit?.newText).toBe("peek(literal('\\)'))")
  })

  it('skips a parenthesis inside a TEMPLATE literal', () => {
    const { edit } = at('const g = not(not(literal(`a)b`)))\n')
    expect(edit?.oldText).toBe('not(not(literal(`a)b`)))')
    expect(edit?.newText).toBe('peek(literal(`a)b`))')
  })

  it('honours a backslash escape INSIDE a template quasi', () => {
    // The escaped backtick does not end the template, so the `)` after it is still quasi
    // text. Treating it as a real backtick would end the template early and close the
    // paren count on a parenthesis that is not code.
    const { edit } = at('const g = not(not(literal(`a\\`)b`)))\n')
    expect(edit?.oldText).toBe('not(not(literal(`a\\`)b`)))')
    expect(edit?.newText).toBe('peek(literal(`a\\`)b`))')
  })

  it('re-enters code inside a template ${…} and returns to the quasi afterwards', () => {
    const { edit } = at('const g = not(not(literal(`${ {a: 1} })b`)))\n')
    expect(edit?.oldText).toBe('not(not(literal(`${ {a: 1} })b`)))')
    expect(edit?.newText).toBe('peek(literal(`${ {a: 1} })b`))')
  })

  it('skips a parenthesis inside a BLOCK comment', () => {
    const { edit } = at("const g = not(not(literal(/* ) */ 'x')))\n")
    expect(edit?.oldText).toBe("not(not(literal(/* ) */ 'x')))")
    expect(edit?.newText).toBe("peek(literal(/* ) */ 'x'))")
  })

  it('skips a parenthesis inside a LINE comment', () => {
    const { edit } = at("const g = not(not(literal(\n  'x', // )\n)))\n")
    expect(edit?.oldText).toBe("not(not(literal(\n  'x', // )\n)))")
    expect(edit?.newText).toBe("peek(literal(\n  'x', // )\n))")
  })

  it('counts object-literal braces without losing the parenthesis depth', () => {
    const { edit } = at("const g = not(not(transform(literal('x'), () => ({ a: 1 }))))\n")
    expect(edit?.oldText).toBe("not(not(transform(literal('x'), () => ({ a: 1 }))))")
    expect(edit?.newText).toBe("peek(transform(literal('x'), () => ({ a: 1 })))")
  })

  it('DECLINES a site whose extent a `/` makes undecidable, rather than guessing', () => {
    expect(at("const g = not(not(regex(/[(]/)))\n").reason).toBe(
      'the change itself is proven safe, but a `/` inside the `not(not(` site could start a '
      + 'regular expression, and parseman cannot tell where the site ends without reading the '
      + 'whole file as JavaScript. Make it by hand: not(not(…)) → peek(…)')
  })

  it('declines when the parentheses simply do not balance', () => {
    expect(at("const g = not(not(literal('x'))\n").reason).toContain(UNBALANCED)
  })

  it('declines on an unterminated string — the shape is not what it looks like', () => {
    expect(at("const g = not(not(literal('x)))\n").reason).toContain(UNBALANCED)
    expect(at("const g = not(not(literal('x").reason).toContain(UNBALANCED)
  })

  it('declines on an unterminated comment of either kind', () => {
    expect(at("const g = not(not(literal('x') /* )))\n").reason).toContain(UNBALANCED)
    expect(at("const g = not(not(literal('x') // )))").reason).toContain(UNBALANCED)
  })

  it('declines when anything but whitespace sits between the two closing parentheses', () => {
    // `not()` takes one argument, so this is a shape the rewrite does not describe.
    expect(at("const g = not(not(literal('x')) /* here */ )\n").reason).toBe(
      'the change itself is proven safe, but something other than the inner call sits between '
      + 'the `not(not(` parentheses, so parseman cannot tell which text the rewrite replaces. '
      + 'Make it by hand: not(not(…)) → peek(…)')
  })

  it('accepts whitespace between the two closing parentheses', () => {
    const { edit } = at("const g = not(not(literal('x'))\n  )\n")
    expect(edit?.oldText).toBe("not(not(literal('x'))\n  )")
    expect(edit?.newText).toBe("peek(literal('x'))")
  })

  it('declines when the site is not in the file, or is in it twice', () => {
    expect(at('const g = peek(literal("x"))\n').reason)
      .toContain('`not(not(` does not appear literally in g.ts')
    expect(at("const a = not(not(literal('x')))\nconst b = not(not(literal('y')))\n").reason)
      .toContain('`not(not(` appears 2 times in g.ts, and editing the wrong one would be worse '
        + 'than editing none')
  })
})

// ── applying the edits ───────────────────────────────────────────────────────

describe('applyFixEdits', () => {
  const withEdit = (edit: FixEdit): VerifiedFix => ({
    id: `at${edit.start}`, code: 'keyword-regex', rule: 'Doc', armIndex: 0,
    before: edit.oldText, after: edit.newText,
    armFirstSetBefore: 'any', armFirstSetAfter: "'i'",
    choiceId: 'Doc', choiceGatesBefore: 'no', choiceGatesAfter: 'yes',
    benefit: {
      ungatedChoicesBefore: 1, ungatedChoicesAfter: 0,
      antiPatternsBefore: 1, antiPatternsAfter: 0,
      gatedChoicesBefore: 0, gatedChoicesAfter: 1,
      artifactBytesBefore: null, artifactBytesAfter: null,
    },
    evidence: { samples: 1, bytes: 1, engines: ['interpreted'], outputUnchanged: true },
    edit,
  })

  const edit = (start: number, oldText: string, newText: string): FixEdit =>
    ({ path: 'g.ts', line: 1, column: start + 1, start, end: start + oldText.length, oldText, newText, lineText: '' })

  it('is a no-op for an empty fix list', () => {
    expect(applyFixEdits('abc', [])).toEqual({ text: 'abc', applied: 0 })
  })

  it('ignores fixes that carry no edit', () => {
    const noEdit = { ...withEdit(edit(0, 'a', 'z')) }
    delete noEdit.edit
    expect(applyFixEdits('abc', [noEdit])).toEqual({ text: 'abc', applied: 0 })
  })

  it('applies a single edit in place', () => {
    expect(applyFixEdits('aXc', [withEdit(edit(1, 'X', 'YY'))])).toEqual({ text: 'aYYc', applied: 1 })
  })

  it('applies edits RIGHT TO LEFT, so a length change cannot invalidate a later offset', () => {
    // Given in ASCENDING order, and each replacement is a different length. Applying in
    // the order given would shift the second span and corrupt the file — which is the
    // exact way `--apply` used to damage source.
    const text = 'aa BBBB cc DD ee'
    const fixes = [
      withEdit(edit(3, 'BBBB', 'b')),
      withEdit(edit(11, 'DD', 'dddddd')),
    ]
    expect(applyFixEdits(text, fixes)).toEqual({ text: 'aa b cc dddddd ee', applied: 2 })
    // …and the same result whichever order the caller happened to hand them over in.
    expect(applyFixEdits(text, [...fixes].reverse())).toEqual({ text: 'aa b cc dddddd ee', applied: 2 })
  })

  it('applies ADJACENT edits without eating the boundary between them', () => {
    expect(applyFixEdits('abcd', [withEdit(edit(0, 'ab', 'X')), withEdit(edit(2, 'cd', 'YYY'))]))
      .toEqual({ text: 'XYYY', applied: 2 })
  })

  it('SKIPS an edit whose text moved under it, and still applies the others', () => {
    // The span check is the only thing standing between a stale report and a corrupted
    // file, so a mismatch must skip rather than write.
    const stale = withEdit(edit(0, 'ZZ', 'q'))
    const good = withEdit(edit(3, 'cc', 'C'))
    expect(applyFixEdits('aa cc', [stale, good])).toEqual({ text: 'aa C', applied: 1 })
  })

  it('SKIPS an edit that runs off the end of the text', () => {
    expect(applyFixEdits('ab', [withEdit(edit(1, 'bcd', 'z'))])).toEqual({ text: 'ab', applied: 0 })
  })

  it('round-trips the edit proposeFixes produced', () => {
    const text = 'const If = regex(/if(?!\\w)/)\n'
    const r = proposeFixes(kw(/if(?!\w)/), { corpus: corpusOf('if'), source: { path: 'g.ts', text } })
    expect(applyFixEdits(text, r.verified))
      .toEqual({ text: "const If = word('if', '\\w')\n", applied: 1 })
  })

  it('applies both of two real edits located in one file', () => {
    const text = "const a = regex(/if(?!\\w)/)\nconst b = not(not(literal('x')))\n"
    const g = choice(
      regex(/if(?!\w)/),
      sequence(not(not(literal('x'))), literal('x')),
      regex(/[a-z]+/),
    )
    const r = proposeFixes(g, { corpus: corpusOf('if', 'x'), source: { path: 'g.ts', text } })
    expect(r.verified).toHaveLength(2)
    expect(applyFixEdits(text, r.verified)).toEqual({
      text: "const a = word('if', '\\w')\nconst b = peek(literal('x'))\n",
      applied: 2,
    })
  })
})

// A transform import is used only by the brace-counting source fixture above; keeping the
// reference explicit stops the import from looking accidental.
describe('fixture sanity', () => {
  it('the brace fixture describes a real combinator shape', () => {
    expect(transform(literal('x'), () => ({ a: 1 }))._def.tag).toBe('transform')
  })
})
