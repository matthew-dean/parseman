import { describe, expect, it } from 'vitest'
import { fixReportLines, renderFixReport } from '../../src/analysis/fix-render.ts'
import { plain } from '../../src/analysis/terminal.ts'
import type { FixReport, VerifiedFix, LocatedFinding, FixEdit } from '../../src/analysis/fix.ts'

const ESC = String.fromCharCode(27)

const base: FixReport = {
  schema: 'parseman.fix/1',
  ok: true,
  blocked: null,
  corpus: { samples: 1, bytes: 12 },
  engines: ['interpreted'],
  verified: [],
  located: [],
  frozen: [],
}

const report = (over: Partial<FixReport>): FixReport => ({ ...base, ...over })

const fix = (over: Partial<VerifiedFix> = {}): VerifiedFix => ({
  id: 'Doc#arm0',
  code: 'keyword-regex',
  rule: 'Doc',
  armIndex: 0,
  before: 'regex(/if(?!\\w)/)',
  after: "word('if', '\\w')",
  armFirstSetBefore: 'any',
  armFirstSetAfter: "'i'",
  choiceId: 'Doc',
  choiceGatesBefore: 'no',
  choiceGatesAfter: 'yes',
  benefit: {
    ungatedChoicesBefore: 2,
    ungatedChoicesAfter: 1,
    antiPatternsBefore: 3,
    antiPatternsAfter: 2,
    gatedChoicesBefore: 0,
    gatedChoicesAfter: 1,
    codegenBytesBefore: 1000,
    codegenBytesAfter: 900,
  },
  evidence: { samples: 1, bytes: 12, engines: ['interpreted'], outputUnchanged: true },
  ...over,
})

const loc = (over: Partial<LocatedFinding> = {}): LocatedFinding => ({
  id: 'Doc#arm1',
  code: 'double-not',
  rule: 'Doc',
  armIndex: 1,
  site: 'not(not(…))',
  reason: 'it is anchored',
  ...over,
})

const edit: FixEdit = {
  path: 'src/grammar.ts',
  line: 42,
  column: 11,
  start: 100,
  end: 117,
  oldText: 'regex(/if(?!\\w)/)',
  newText: "word('if', '\\w')",
  lineText: '  const If = regex(/if(?!\\w)/)',
}

const EFFECT = 'removes 1 of the 3 arms that hide their first character'
  + ' · 1 fewer choice(s) the parser must guess at'
  + ' · 1 more choice(s) decided from one character'
  + " · arm 0 now starts with a known character ('i')"
  + ' · Doc can now be decided from the next character alone'

const lines = (out: string): string[] => out.split('\n')

/**
 * The renderer inflects the VERB with the noun: "1 change that is safe to make" beside
 * "3 changes that are safe to make", and "1 place that needs you" beside "2 places that
 * need you". `diagnose-render.ts` follows the same rule for "1 other choice already
 * picks".
 *
 * The assertions below spell out the exact bytes, because a rendering test that cannot
 * tell you what was printed is not doing its job.
 */

describe('fixReportLines — blocked reports', () => {
  it('renders the fallback reason when ok is false and blocked is null', () => {
    const out = renderFixReport(report({ ok: false, blocked: null }))
    expect(lines(out)).toEqual([
      '✗ grammar — nothing can be offered, because nothing could be checked',
      '  the verification loop could not run',
      '  parseman only offers a change after it has applied it, rebuilt the parser and',
      '  confirmed your files still parse to exactly the same thing. It could not do that',
      '  here, so it is offering nothing rather than guessing.',
    ])
  })

  it('renders the supplied blocked reason, wrapped, and honours name', () => {
    const out = renderFixReport(
      report({ ok: false, blocked: 'the corpus was empty, so there was nothing to compare against' }),
      { name: 'less-parser' },
    )
    expect(lines(out)[0]).toBe(
      '✗ less-parser — nothing can be offered, because nothing could be checked')
    expect(lines(out)[1]).toBe(
      '  the corpus was empty, so there was nothing to compare against')
    expect(lines(out)).toHaveLength(5)
  })

  it('wraps a long blocked reason at width - 4 with a two-space indent', () => {
    const out = renderFixReport(
      report({ ok: false, blocked: 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll' }),
      { width: 30 },
    )
    expect(lines(out).slice(1, 4)).toEqual([
      '  aaaa bbbb cccc dddd eeee',
      '  ffff gggg hhhh iiii jjjj',
      '  kkkk llll',
    ])
  })

  it('ignores verified fixes entirely when ok is false', () => {
    const out = renderFixReport(report({ ok: false, blocked: 'nope', verified: [fix()] }))
    expect(out).not.toContain('SAFE TO APPLY')
    expect(out).not.toContain('Doc#arm0')
  })
})

describe('fixReportLines — clean reports', () => {
  it('renders the two-line clean report with grouped corpus digits', () => {
    const out = renderFixReport(report({ corpus: { samples: 1234, bytes: 5678901 } }))
    expect(lines(out)).toEqual([
      '✓ grammar — nothing here can be rewritten',
      '  Checked against 1,234 of your files (5,678,901 bytes). '
      + 'No change parseman knows how to make applies here.',
    ])
  })

  it('is NOT clean when only located findings exist', () => {
    const out = renderFixReport(report({ located: [loc()] }))
    expect(out).not.toContain('nothing here can be rewritten')
    expect(lines(out)[0]).toBe('● grammar — 0 changes that are safe to make, 1 place that needs you')
  })
})

describe('fixReportLines — one verified fix, no edit', () => {
  const out = renderFixReport(report({ verified: [fix()] }))

  it('renders the exact report, line for line', () => {
    expect(lines(out)).toEqual([
    '● grammar — 1 change that is safe to make',
      '  Every change below was applied, the parser rebuilt, and your 1 file (12 bytes)',
      '  parsed again with interpreted — the result was identical every time. A change',
      '  that altered the result was thrown away and is not shown.',
      '  Nothing has been written. Add --apply to make these edits.',
      '',
      '─'.repeat(80),
      ' 🔧 SAFE TO APPLY  Doc#arm0',
      '   - regex(/if(?!\\w)/)',
      "   + word('if', '\\w')",
      `   effect  ${EFFECT}`,
      '   size    the generated parser shrinks by 100 bytes',
      '   checked this exact change was made, the parser rebuilt, and your 1 file',
      '           parsed again — identical result',
      '',
      '🔧 1 safe to apply  ·  add --apply to make them  ·  exiting 0 (nothing written)',
    ])
  })

  it('puts the minus line strictly before the plus line', () => {
    const ls = lines(out)
    expect(ls.findIndex(l => l.startsWith('   - '))).toBeLessThan(
      ls.findIndex(l => l.startsWith('   + ')))
  })
})

describe('fixReportLines — effect assembly', () => {
  const effectOf = (f: VerifiedFix): string => {
    const l = lines(renderFixReport(report({ verified: [f] }))).find(x => x.startsWith('   effect  '))
    return (l ?? '').slice('   effect  '.length)
  }

  it('omits every clause whose measurement did not move', () => {
    expect(effectOf(fix({
      benefit: {
        ungatedChoicesBefore: 2, ungatedChoicesAfter: 2,
        antiPatternsBefore: 3, antiPatternsAfter: 3,
        gatedChoicesBefore: 1, gatedChoicesAfter: 1,
        codegenBytesBefore: 500, codegenBytesAfter: 500,
      },
      armFirstSetBefore: "'i'",
      armFirstSetAfter: "'i'",
      choiceGatesBefore: 'yes',
      choiceGatesAfter: 'yes',
    }))).toBe('')
  })

  it('reports the anti-pattern clause using the BEFORE count', () => {
    expect(effectOf(fix({
      benefit: { ...fix().benefit, antiPatternsBefore: 9, antiPatternsAfter: 8 },
    }))).toContain('removes 1 of the 9 arms that hide their first character')
  })

  it('reports ungated choices as a DROP and gated choices as a RISE', () => {
    const e = effectOf(fix({
      benefit: {
        ...fix().benefit,
        ungatedChoicesBefore: 7, ungatedChoicesAfter: 3,
        gatedChoicesBefore: 1, gatedChoicesAfter: 6,
      },
    }))
    expect(e).toContain('4 fewer choice(s) the parser must guess at')
    expect(e).toContain('5 more choice(s) decided from one character')
  })

  it('names the arm index and the AFTER first set', () => {
    expect(effectOf(fix({ armIndex: 4, armFirstSetAfter: "'x'|'y'" })))
      .toContain("arm 4 now starts with a known character ('x'|'y')")
  })

  it('names the enclosing choice id when the gating verdict moved', () => {
    expect(effectOf(fix({ choiceId: 'Selector', choiceGatesBefore: 'no', choiceGatesAfter: 'recoverable' })))
      .toContain('Selector can now be decided from the next character alone')
  })

  it('joins clauses with a middle dot in measurement order', () => {
    expect(effectOf(fix())).toBe(EFFECT)
    expect(effectOf(fix()).indexOf('removes 1 of the 3 arms'))
      .toBeLessThan(effectOf(fix()).indexOf('1 fewer choice(s)'))
    expect(effectOf(fix()).indexOf('1 fewer choice(s)'))
      .toBeLessThan(effectOf(fix()).indexOf('1 more choice(s)'))
    expect(effectOf(fix()).indexOf('1 more choice(s)'))
      .toBeLessThan(effectOf(fix()).indexOf('arm 0 now starts'))
    expect(effectOf(fix()).indexOf('arm 0 now starts'))
      .toBeLessThan(effectOf(fix()).indexOf('Doc can now be decided'))
  })
})

describe('fixReportLines — codegen size line', () => {
  const sizeOf = (f: VerifiedFix): string | undefined =>
    lines(renderFixReport(report({ verified: [f] }))).find(x => x.startsWith('   size    '))

  it('says grows, with a grouped absolute delta, when the parser gets bigger', () => {
    expect(sizeOf(fix({ benefit: { ...fix().benefit, codegenBytesBefore: 1000, codegenBytesAfter: 13500 } })))
      .toBe('   size    the generated parser grows by 12,500 bytes')
  })

  it('says shrinks when the parser gets smaller', () => {
    expect(sizeOf(fix({ benefit: { ...fix().benefit, codegenBytesBefore: 4000, codegenBytesAfter: 1500 } })))
      .toBe('   size    the generated parser shrinks by 2,500 bytes')
  })

  it('omits the line when the size is unchanged or unmeasured', () => {
    expect(sizeOf(fix({ benefit: { ...fix().benefit, codegenBytesBefore: 900, codegenBytesAfter: 900 } })))
      .toBeUndefined()
    expect(sizeOf(fix({ benefit: { ...fix().benefit, codegenBytesBefore: null, codegenBytesAfter: 900 } })))
      .toBeUndefined()
    expect(sizeOf(fix({ benefit: { ...fix().benefit, codegenBytesBefore: 1000, codegenBytesAfter: null } })))
      .toBeUndefined()
  })
})

describe('fixReportLines — evidence line', () => {
  it('pluralises the file count and groups its digits', () => {
    const out = renderFixReport(report({
      verified: [fix({ evidence: { samples: 4096, bytes: 99, engines: ['interpreted'], outputUnchanged: true } })],
    }))
    expect(out).toContain(
      '   checked this exact change was made, the parser rebuilt, and your 4,096 files')
  })

  it('uses the singular for exactly one file', () => {
    expect(renderFixReport(report({ verified: [fix()] })))
      .toContain('and your 1 file')
  })
})

describe('fixReportLines — several verified fixes', () => {
  const out = renderFixReport(report({
    corpus: { samples: 3, bytes: 4096 },
    engines: ['interpreted', 'compiled'],
    verified: [fix({ id: 'A#arm0' }), fix({ id: 'B#arm1' }), fix({ id: 'C#arm2' })],
  }))

  it('counts them in the header and the footer, plural', () => {
    expect(lines(out)[0]).toBe('● grammar — 3 changes that are safe to make')
    expect(lines(out).at(-1)).toBe(
      '🔧 3 safe to apply  ·  add --apply to make them  ·  exiting 0 (nothing written)')
  })

  it('collapses both engines into the phrase "both engines"', () => {
    expect(out).toContain('parsed again with both engines')
    expect(out).not.toContain('interpreted + compiled —')
  })

  it('pluralises the corpus file count in the preamble', () => {
    expect(lines(out).slice(1, 4)).toEqual([
      '  Every change below was applied, the parser rebuilt, and your 3 files (4,096',
      '  bytes) parsed again with both engines — the result was identical every time. A',
      '  change that altered the result was thrown away and is not shown.',
    ])
  })

  it('renders each block in report order, one heading each', () => {
    const ls = lines(out)
    const at = (id: string): number => ls.findIndex(l => l.endsWith(id))
    expect(at('A#arm0')).toBeGreaterThan(0)
    expect(at('A#arm0')).toBeLessThan(at('B#arm1'))
    expect(at('B#arm1')).toBeLessThan(at('C#arm2'))
    expect(ls.filter(l => l.includes('SAFE TO APPLY'))).toHaveLength(3)
    expect(ls.filter(l => l === '─'.repeat(80))).toHaveLength(3)
  })
})

describe('fixReportLines — a single engine name is printed verbatim', () => {
  it('prints just "compiled" when that is the only engine', () => {
    expect(renderFixReport(report({ engines: ['compiled'], verified: [fix()] })))
      .toContain('parsed again with compiled — the result')
  })
})

describe('fixReportLines — located findings', () => {
  it('renders the NEEDS YOU block with here and why, in that order', () => {
    const out = renderFixReport(report({ located: [loc()] }))
    const ls = lines(out)
    expect(ls.slice(-6)).toEqual([
      '─'.repeat(80),
      ' ✋ NEEDS YOU      Doc#arm1',
      '   here    not(not(…))',
      '   why     No change can be offered here: it is anchored',
      '',
      '🔧 0 safe to apply, 1 need you  ·  add --apply to make them  ·  exiting 0 (nothing written)',
    ])
  })

  it('never turns a reason into advice or a diff', () => {
    const out = renderFixReport(report({ located: [loc()] }))
    expect(out).not.toContain('SAFE TO APPLY')
    expect(out).not.toContain('   - ')
    expect(out).not.toContain('   + ')
  })

  it('wraps a long reason under an aligned hanging indent', () => {
    const out = renderFixReport(report({
      located: [loc({ reason: 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn' })],
    }))
    const ls = lines(out)
    const i = ls.findIndex(l => l.startsWith('   why     '))
    expect(ls[i]).toBe(
      '   why     No change can be offered here: aaaa bbbb cccc dddd eeee ffff gggg')
    expect(ls[i + 1]).toBe('           hhhh iiii jjjj kkkk llll mmmm nnnn')
  })

  it('pluralises the place count and orders verified blocks before located ones', () => {
    const out = renderFixReport(report({
      verified: [fix({ id: 'V#arm0' })],
      located: [loc({ id: 'L#arm1' }), loc({ id: 'L#arm2' })],
    }))
    const ls = lines(out)
    expect(ls[0]).toBe('● grammar — 1 change that is safe to make, 2 places that need you')
    expect(ls.findIndex(l => l.endsWith('V#arm0'))).toBeLessThan(
      ls.findIndex(l => l.endsWith('L#arm1')))
    expect(ls.findIndex(l => l.endsWith('L#arm1'))).toBeLessThan(
      ls.findIndex(l => l.endsWith('L#arm2')))
    expect(ls.at(-1)).toBe(
      '🔧 1 safe to apply, 2 need you  ·  add --apply to make them  ·  exiting 0 (nothing written)')
  })
})

describe('fixReportLines — frozen note', () => {
  const froz = (n: number): { rule: string; tag: string }[] =>
    Array.from({ length: n }, (_, i) => ({ rule: `R${i}`, tag: 'dispatch' }))

  it('is absent when nothing was frozen', () => {
    expect(renderFixReport(report({ verified: [fix()] }))).not.toContain('left untouched')
  })

  it('lists all of them, with no ellipsis, at the 6-entry threshold', () => {
    const out = renderFixReport(report({ verified: [fix()], frozen: froz(6) }), { width: 400 })
    expect(out).toContain(
      '  6 part(s) of the grammar were left untouched because parseman cannot rebuild '
      + 'them exactly and will not guess: R0 (dispatch), R1 (dispatch), R2 (dispatch), '
      + 'R3 (dispatch), R4 (dispatch), R5 (dispatch)')
    expect(out).not.toContain('dispatch), …')
  })

  it('truncates to the first six and appends an ellipsis one past the threshold', () => {
    const out = renderFixReport(report({ verified: [fix()], frozen: froz(7) }), { width: 400 })
    expect(out).toContain(
      '  7 part(s) of the grammar were left untouched because parseman cannot rebuild '
      + 'them exactly and will not guess: R0 (dispatch), R1 (dispatch), R2 (dispatch), '
      + 'R3 (dispatch), R4 (dispatch), R5 (dispatch), …')
    expect(out).not.toContain('R6 (dispatch)')
  })

  it('groups the digits of a large frozen count', () => {
    const out = renderFixReport(report({ verified: [fix()], frozen: froz(1234) }), { width: 200 })
    expect(out).toContain('  1,234 part(s) of the grammar were left untouched')
  })

  it('sits after every finding block and before the footer', () => {
    const ls = lines(renderFixReport(report({ verified: [fix()], frozen: froz(1) }), { width: 200 }))
    const i = ls.findIndex(l => l.includes('left untouched'))
    expect(i).toBeGreaterThan(ls.findIndex(l => l.includes('SAFE TO APPLY')))
    expect(i).toBeLessThan(ls.findIndex(l => l.startsWith('🔧 ')))
  })
})

describe('fixReportLines — applied count', () => {
  it('switches the header glyph, drops the --apply nudge and says written to disk', () => {
    const ls = lines(renderFixReport(report({ verified: [fix()] }), { applied: 1 }))
    expect(ls[0]).toBe('✓ grammar — 1 change that is safe to make')
    expect(ls.join('\n')).not.toContain('Nothing has been written')
    expect(ls.at(-1)).toBe('✓ 1 safe to apply  ·  written to disk')
  })

  it('a PARTIAL write names the count written and the count skipped', () => {
    // `applyFixEdits` skips an edit whose span moved under it. Reporting "written to
    // disk" over that would tell the reader the file holds all three when it holds two.
    const ls = lines(renderFixReport(report({ verified: [fix(), fix(), fix()] }), { applied: 2 }))
    expect(ls[0]).toBe('✓ grammar — 3 changes that are safe to make')
    expect(ls.at(-1)).toBe('✓ 3 safe to apply  ·  2 written to disk, 1 skipped (the source moved under the edit)')
  })

  it('applied: 0 is treated exactly like an absent count', () => {
    expect(renderFixReport(report({ verified: [fix()] }), { applied: 0 }))
      .toBe(renderFixReport(report({ verified: [fix()] })))
  })

  it('omits the --apply nudge when there is nothing verified to apply', () => {
    const out = renderFixReport(report({ located: [loc()] }))
    expect(out).not.toContain('Nothing has been written')
  })
})

describe('fixReportLines — width', () => {
  it('sizes the block rules to the requested width', () => {
    expect(renderFixReport(report({ verified: [fix()] }), { width: 40 }))
      .toContain('─'.repeat(40))
    expect(renderFixReport(report({ verified: [fix()] }), { width: 40 }))
      .not.toContain('─'.repeat(41))
  })

  it('wraps the evidence line harder at a narrow width', () => {
    const wide = lines(renderFixReport(report({ verified: [fix()] }), { width: 80 }))
      .filter(l => l.startsWith('           ')).length
    const narrow = lines(renderFixReport(report({ verified: [fix()] }), { width: 40 }))
      .filter(l => l.startsWith('           ')).length
    expect(narrow).toBeGreaterThan(wide)
    expect(narrow).toBe(3)
  })

  it('wraps the located reason harder at a narrow width', () => {
    const ls = lines(renderFixReport(report({ located: [loc()] }), { width: 40 }))
    const i = ls.findIndex(l => l.startsWith('   why     '))
    expect(ls[i]).toBe('   why     No change can be offered')
    expect(ls[i + 1]).toBe('           here: it is anchored')
  })
})

describe('fixReportLines — a fix carrying a source edit', () => {
  const withEdit = report({ verified: [fix({ edit })] })

  it('draws a code frame instead of the -/+ diff', () => {
    const out = renderFixReport(withEdit)
    expect(out).not.toContain('   - regex(')
    expect(out).not.toContain('   effect  ')
    expect(out).toContain('src/grammar.ts')
    expect(out).toContain('42')
    expect(out).toContain('const If = regex(')
  })

  it('carries the replacement text and the measured effect into the frame', () => {
    const out = renderFixReport(withEdit)
    expect(out).toContain("→ word('if', '\\w')")
    expect(out).toContain('removes 1 of the 3 arms that hide their first character')
  })

  it('still prints the size and checked lines below the frame', () => {
    const ls = lines(renderFixReport(withEdit))
    const frame = ls.findIndex(l => l.includes('src/grammar.ts'))
    expect(frame).toBeGreaterThan(0)
    expect(ls.findIndex(l => l.startsWith('   size    '))).toBeGreaterThan(frame)
    expect(ls.findIndex(l => l.startsWith('   checked '))).toBeGreaterThan(frame)
  })

  it('keeps the plain form free of escape bytes and of the absolute path', () => {
    const out = renderFixReport(withEdit, { sourceRoot: '/abs/root/src/grammar.ts' })
    expect(out).not.toContain(ESC)
    expect(out).not.toContain('/abs/root/')
  })

  it('indents every frame line by three spaces', () => {
    const ls = lines(renderFixReport(withEdit))
    const start = ls.findIndex(l => l.includes('SAFE TO APPLY')) + 1
    const end = ls.findIndex(l => l.startsWith('   size    '))
    expect(end).toBeGreaterThan(start)
    const frame = ls.slice(start, end).filter(l => l !== '')
    expect(frame.length).toBeGreaterThanOrEqual(4)
    expect(frame.every(l => l.startsWith('   '))).toBe(true)
  })
})

describe('renderFixReport — colour and links', () => {
  it('emits no escape byte at all when colour is off', () => {
    const out = renderFixReport(report({ verified: [fix({ edit })], located: [loc()], frozen: [{ rule: 'R', tag: 'guard' }] }))
    expect(out).not.toContain(ESC)
  })

  it('emits escapes when colour is on, over identical visible text', () => {
    const r = report({ verified: [fix()], located: [loc()] })
    const coloured = renderFixReport(r, { color: true })
    expect(coloured).toContain(ESC)
    const stripped = coloured
      .split('\n')
      .map(l => l.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), ''))
      .join('\n')
    expect(stripped).toBe(renderFixReport(r))
  })

  it('puts the absolute path in the frame hyperlink only with colour and links on', () => {
    const r = report({ verified: [fix({ edit })] })
    expect(renderFixReport(r, { color: true, links: true, sourceRoot: '/abs/root/src/grammar.ts' }))
      .toContain('/abs/root/src/grammar.ts')
    expect(renderFixReport(r, { color: true, links: false, sourceRoot: '/abs/root/src/grammar.ts' }))
      .not.toContain('/abs/root/src/grammar.ts')
    expect(renderFixReport(r, { color: false, links: true, sourceRoot: '/abs/root/src/grammar.ts' }))
      .not.toContain('/abs/root/src/grammar.ts')
  })

  it('falls back to the edit path when no sourceRoot is supplied', () => {
    const out = renderFixReport(report({ verified: [fix({ edit })] }), { color: true, links: true })
    expect(out).toContain('src/grammar.ts')
    expect(out).not.toContain('/abs/root')
  })
})

describe('fixReportLines — line list shape', () => {
  it('is the same content renderFixReport prints without colour', () => {
    const r = report({ verified: [fix()], located: [loc()], frozen: [{ rule: 'R', tag: 'guard' }] })
    expect(plain(fixReportLines(r))).toBe(renderFixReport(r))
  })

  it('marks the separator between blocks with a genuinely empty line', () => {
    const ls = fixReportLines(report({ verified: [fix()] }))
    expect(ls.filter(l => l.length === 0)).toHaveLength(2)
  })
})
