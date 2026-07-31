/**
 * `src/analysis/diagnose-render.ts` — the exact TEXT, not "it rendered something".
 *
 * This file is the human layer: nothing it does is observable except the bytes it
 * produces. So every assertion below is on a literal substring, on line ORDER, on
 * singular-vs-plural wording, or on the presence/absence of an escape byte. A test that
 * only checked `.length > 0` would still pass with every sentence rewritten.
 *
 * The diagnoses are built by hand from a real one so that summary counters, finding
 * shapes and option maps can be driven to the exact combination a branch needs — those
 * combinations do not all occur in a grammar that can be written down here.
 */
import { describe, it, expect } from 'vitest'
import { choice, literal, type Combinator } from '../../src/index.ts'
import { diagnoseGrammar, type GrammarDiagnosis, type DiagnosisFinding } from '../../src/analysis/diagnose.ts'
import { renderDiagnosis, diagnosisLines } from '../../src/analysis/diagnose-render.ts'
import type { ChoiceCorpusCost } from '../../src/analysis/corpus.ts'

const ESC = String.fromCharCode(27)

/** A real diagnosis, used only for the fields this file never reads (`gating`, …). */
const BASE: GrammarDiagnosis = diagnoseGrammar(choice(literal('a'), literal('b')) as Combinator<unknown>)

const diagnosis = (over: {
  ok?: boolean
  summary?: Partial<GrammarDiagnosis['summary']>
  findings?: DiagnosisFinding[]
  acceptSnapshot?: string[]
}): GrammarDiagnosis => ({
  ...BASE,
  ok: over.ok ?? false,
  summary: { ...BASE.summary, ...over.summary },
  findings: over.findings ?? [],
  acceptSnapshot: over.acceptSnapshot ?? [],
})

const finding = (over: Partial<DiagnosisFinding> & Pick<DiagnosisFinding, 'id'>): DiagnosisFinding => ({
  code: 'ungated-choice',
  severity: 'blocking',
  rule: 'Doc',
  message: 'the parser cannot narrow this down',
  details: [],
  ...over,
})

const cost = (over: Partial<ChoiceCorpusCost> & Pick<ChoiceCorpusCost, 'choiceId'>): ChoiceCorpusCost => ({
  positions: 1234,
  corpusPositions: 5000,
  arms: [],
  ...over,
})

describe('the two-line success rendering', () => {
  it('is exactly two lines and names only the counters that are non-zero', () => {
    const d = diagnosis({ ok: true, summary: { gated: 4, totalChoices: 4 } })
    const text = renderDiagnosis(d, { name: 'g.ts' })
    expect(text.split('\n')).toEqual([
      '✓ g.ts — nothing to fix',
      '  4/4 choices gate on first char',
    ])
  })

  it('appends each optional counter, in order, separated by ` · `', () => {
    const d = diagnosis({
      ok: true,
      summary: { gated: 1200, totalChoices: 1300, recoverable: 2, accepted: 3, deferred: 4, staleAccepts: 5 },
    })
    const text = renderDiagnosis(d, { name: 'g.ts' })
    // groupDigits puts a separator in 1,200 — the rendering must not print raw digits.
    expect(text.split('\n')[1]).toBe(
      '  1,200/1,300 choices gate on first char · 2 recoverable · 3 accepted · 4 deferred to the fusing artifact · 5 stale accept line(s) to prune',
    )
  })

  it('is NOT used when a rule could not be examined, even with ok:true', () => {
    const d = diagnosis({ ok: true, summary: { unanalysable: 1, totalChoices: 1, gated: 1 } })
    const text = renderDiagnosis(d, { name: 'g.ts' })
    expect(text).not.toContain('nothing to fix')
    expect(text).toContain('PARTIAL — 1 rule(s) could not be examined')
  })

  it('defaults the grammar label to "grammar"', () => {
    expect(renderDiagnosis(diagnosis({ ok: true, summary: { gated: 0, totalChoices: 0 } })))
      .toContain('✓ grammar — nothing to fix')
  })

  it('emits no escape byte without colour and does emit them with it', () => {
    const d = diagnosis({ ok: true, summary: { gated: 1, totalChoices: 1 } })
    expect(renderDiagnosis(d, { name: 'g.ts' }).includes(ESC)).toBe(false)
    expect(renderDiagnosis(d, { name: 'g.ts', color: true }).includes(ESC)).toBe(true)
  })
})

describe('the failure header, singular and plural', () => {
  it('says "1 problem in 1 choice" for one of each', () => {
    const d = diagnosis({ findings: [finding({ id: 'Doc#0' })], summary: { totalChoices: 1 } })
    const lines = renderDiagnosis(d, { name: 'g.ts', width: 100 }).split('\n')
    expect(lines[0]).toBe('✗ g.ts — 1 problem in 1 choice')
    expect(lines[1]).toBe('  1 underlying cause.')
  })

  it('pluralises problems, choices and causes independently', () => {
    const d = diagnosis({
      findings: [
        finding({ id: 'A#0' }),
        finding({ id: 'B#0', code: 'degraded', severity: 'advisory', message: 'slower route' }),
      ],
      summary: { totalChoices: 3 },
    })
    const lines = renderDiagnosis(d, { name: 'g.ts', width: 100 }).split('\n')
    expect(lines[0]).toBe('✗ g.ts — 2 problems in 3 choices')
    expect(lines[1]).toBe('  2 underlying causes.')
  })

  it('promises "fixing one fixes every choice listed under it" only when causes < findings', () => {
    const two = diagnosis({ findings: [finding({ id: 'A#0' }), finding({ id: 'B#0' })], summary: { totalChoices: 2 } })
    expect(renderDiagnosis(two, { name: 'g.ts', width: 100 }))
      .toContain('1 underlying cause; fixing one fixes every choice listed under it.')
    const one = diagnosis({ findings: [finding({ id: 'A#0' })], summary: { totalChoices: 1 } })
    expect(renderDiagnosis(one, { name: 'g.ts', width: 100 })).toContain('1 underlying cause.')
  })

  it('mentions the already-gated choices only when there are some', () => {
    const withGated = diagnosis({ findings: [finding({ id: 'A#0' })], summary: { totalChoices: 5, gated: 4 } })
    expect(renderDiagnosis(withGated, { name: 'g.ts', width: 100 }))
      .toContain('4 other choices already pick the right')
    const noGated = diagnosis({ findings: [finding({ id: 'A#0' })], summary: { totalChoices: 1, gated: 0 } })
    const t = renderDiagnosis(noGated, { name: 'g.ts', width: 100 })
    expect(t).not.toContain('already pick the right')
    expect(t).toContain('None of this is a correctness bug')
  })

  it('says "1 other choice" in the singular', () => {
    const d = diagnosis({ findings: [finding({ id: 'A#0' })], summary: { totalChoices: 2, gated: 1 } })
    expect(renderDiagnosis(d, { name: 'g.ts', width: 100 })).toContain('1 other choice already picks')
  })
})

describe('grouping by cause', () => {
  it('states a shared cause ONCE and gives every site the same glyph', () => {
    const details = ['arm[0] is ungated\nfix: gate it on the first character']
    const d = diagnosis({
      findings: [finding({ id: 'A#0', details }), finding({ id: 'B#0', details })],
      summary: { totalChoices: 2 },
    })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100 })
    expect(text.split('gate it on the first character').length - 1).toBe(1)
    expect(text).toContain('◆ 2 choices the parser cannot narrow down')
    expect(text.split('◆').length - 1).toBe(3) // the headline plus one per site row
  })

  it('assigns a DIFFERENT glyph per cause, in order', () => {
    const d = diagnosis({
      findings: [
        finding({ id: 'A#0', details: ['x\nfix: first cause'] }),
        finding({ id: 'B#0', details: ['x\nfix: second cause'] }),
      ],
      summary: { totalChoices: 2 },
    })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100 })
    expect(text).toContain('◆ 1 choice the parser cannot narrow down')
    expect(text).toContain('▲ 1 choice the parser cannot narrow down')
  })

  it('keys anti-patterns on the KIND, so one pattern is one group however many words it names', () => {
    const d = diagnosis({
      findings: [
        finding({ id: 'A#arm0', code: 'anti-pattern', message: '[keyword-regex] `if` is a word' }),
        finding({ id: 'B#arm1', code: 'anti-pattern', message: '[keyword-regex] `while` is a word' }),
      ],
      summary: { totalChoices: 2 },
    })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100 })
    expect(text).toContain('2 arms that hide their first character')
    // The kind blurb appears once…
    expect(text.split('These arms match a fixed word using a regular expression').length - 1).toBe(1)
    // …and each site still names ITS OWN word.
    expect(text).toContain('matches `if`')
    expect(text).toContain('matches `while`')
  })

  it('falls back to the finding message when the kind is unknown', () => {
    const d = diagnosis({
      findings: [finding({ id: 'A#arm0', code: 'anti-pattern', message: '[novel-kind] something new happened' })],
      summary: { totalChoices: 1 },
    })
    // The bracketed kind is stripped from the group text.
    expect(renderDiagnosis(d, { name: 'g.ts', width: 100 })).toContain('something new happened')
  })

  it('falls back to the code blurb, then to the raw message, for a code it has no label for', () => {
    const known = diagnosis({ findings: [finding({ id: 'S', code: 'stale-accept' })], summary: { totalChoices: 1 } })
    expect(renderDiagnosis(known, { name: 'g.ts', width: 100 }))
      .toContain('no longer matches any finding')
    expect(renderDiagnosis(known, { name: 'g.ts', width: 100 }))
      .toContain('1 accept-list entry that no longer matches anything')
  })

  it('lists a two-cause finding once, and flags the second cause inline', () => {
    const d = diagnosis({
      findings: [finding({
        id: 'A#0',
        details: ['one\nfix: the primary cause', 'two\nfix: the secondary cause'],
      })],
      summary: { totalChoices: 1 },
    })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100, armFirstSets: new Map([['A#0', ["'a'"]]]) })
    expect(text).toContain('the primary cause')
    expect(text).not.toContain('the secondary cause')
    expect(text).toContain('(+ another cause)')
  })

  it('de-duplicates identical fix: sentences within one finding', () => {
    const d = diagnosis({
      findings: [finding({ id: 'A#0', details: ['one\nfix: same advice', 'two\nfix: same advice'] })],
      summary: { totalChoices: 1 },
    })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100, armFirstSets: new Map([['A#0', ["'a'"]]]) })
    expect(text).not.toContain('(+ another cause)')
  })

  it('marks blocking as "fails the check" and advisory as "worth knowing"', () => {
    const d = diagnosis({
      findings: [
        finding({ id: 'A#0' }),
        finding({ id: 'B', code: 'degraded', severity: 'advisory', message: 'slow route' }),
      ],
      summary: { totalChoices: 2 },
    })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100 })
    expect(text).toContain('fails the check')
    expect(text).toContain('worth knowing')
  })

  it('defines "arm" exactly once, before the first table', () => {
    const d = diagnosis({
      findings: [
        finding({ id: 'A#0', details: ['x\nfix: cause one'] }),
        finding({ id: 'B#0', details: ['y\nfix: cause two'] }),
      ],
      summary: { totalChoices: 2 },
    })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100 })
    expect(text.split('Each numbered line below is one alternative of a choice').length - 1).toBe(1)
  })
})

describe('the arm table and its wording', () => {
  const withSets = (sets: string[], labels?: string[], c?: ChoiceCorpusCost): string => {
    const d = diagnosis({ findings: [finding({ id: 'A#0' })], summary: { totalChoices: 1 } })
    return renderDiagnosis(d, {
      name: 'g.ts',
      width: 100,
      armFirstSets: new Map([['A#0', sets]]),
      ...(labels === undefined ? {} : { armLabels: new Map([['A#0', labels]]) }),
      ...(c === undefined ? {} : { cost: new Map([['A#0', c]]) }),
    })
  }

  it('says a one-character first set in words', () => {
    expect(withSets(["'a'"])).toContain('starts with "a"')
  })

  it('says an ANY first set as "can start with any character"', () => {
    expect(withSets(['ANY'])).toContain('can start with any character')
  })

  it('says an empty first set as "matches nothing"', () => {
    expect(withSets(['(empty)'])).toContain('matches nothing')
  })

  it('lists a small set inline and COUNTS a large one instead', () => {
    expect(withSets(["'a','b','c'"])).toContain('starts with one of a b c')
    expect(withSets(["'a','b','c','d','e'"])).toContain('starts with 5 char ranges')
  })

  it('truncates a long inline set at 19 characters with an ellipsis', () => {
    // Four parts (so it is not counted) whose joined form exceeds 20 characters.
    const text = withSets(["'aaaaaa','bbbbbb','cccccc','dddddd'"])
    expect(text).toContain('starts with one of aaaaaa bbbbbb ccccc…')
    expect(text).not.toContain('dddddd')
  })

  it('numbers arms in order and pads the index', () => {
    const lines = withSets(["'a'", "'b'"]).split('\n').filter(l => l.includes('arm '))
    expect(lines.some(l => l.includes('arm 0 '))).toBe(true)
    expect(lines.some(l => l.includes('arm 1 '))).toBe(true)
  })

  it('adds a per-arm corpus count only when a cost is supplied, and spells the ANY case differently', () => {
    const noCost = withSets(['ANY', "'b'"], ['Any', 'B'])
    expect(noCost).not.toContain('could match at')
    const withCost = withSets(['ANY', "'b'"], ['Any', 'B'], cost({
      choiceId: 'A#0',
      positions: 1500,
      arms: [{ index: 0, any: true, positions: 1500 }, { index: 1, any: false, positions: 40 }],
    }))
    expect(withCost).toContain('→ tried at all 1,500')
    expect(withCost).toContain('→ could match at 40')
  })

  it('spells out the consequence of an ANY arm, naming the arm and the count', () => {
    const text = withSets(["'a'", 'ANY'], ['A', 'Any'], cost({
      choiceId: 'A#0',
      positions: 900,
      arms: [{ index: 0, any: false, positions: 10 }, { index: 1, any: true, positions: 900 }],
    }))
    expect(text).toContain('Because arm 1 can begin with any character, no single-character test can rule it out.')
    expect(text).toContain('900 of those places the parser has to enter it')
  })

  it('says nothing about a consequence when no arm is ANY', () => {
    const text = withSets(["'a'", "'b'"], ['A', 'B'], cost({
      choiceId: 'A#0',
      arms: [{ index: 0, any: false, positions: 10 }, { index: 1, any: false, positions: 12 }],
    }))
    expect(text).not.toContain('can begin with any character')
  })

  it('names the reach of the whole choice on the site line, only when a cost is known', () => {
    expect(withSets(["'a'"], ['A'], cost({ choiceId: 'A#0', positions: 77 })))
      .toContain('—  reached at 77 places in your corpus')
    expect(withSets(["'a'"], ['A'])).not.toContain('reached at')
  })
})

describe('overlap details and unstructured details', () => {
  it('turns an overlap detail into a sentence naming BOTH arms', () => {
    const d = diagnosis({
      findings: [finding({ id: 'A#0', details: ["arm[0] ∩ arm[2] overlap on 'a'-'z'"] })],
      summary: { totalChoices: 1 },
    })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100, armFirstSets: new Map([['A#0', ["'a'", "'b'", "'c'"]]]) })
    expect(text).toContain("arm 0 and arm 2 can both start with 'a'-'z', so that character cannot tell")
  })

  it('uses the overlap for the compact headline too', () => {
    const d = diagnosis({
      findings: [
        finding({ id: 'A#0', details: ['x\nfix: shared'] }),
        finding({ id: 'B#0', details: ["arm[1] ∩ arm[3] overlap on '0'-'9'", 'x\nfix: shared'] }),
      ],
      summary: { totalChoices: 2 },
    })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 120 })
    expect(text).toContain("can both start with '0'-'9'")
    expect(text).toContain('and arm 3')
  })

  it('prints an unparseable "overlap on" detail verbatim', () => {
    const d = diagnosis({
      findings: [finding({ id: 'A#0', details: ['weird overlap on things'] })],
      summary: { totalChoices: 1 },
    })
    expect(renderDiagnosis(d, { name: 'g.ts', width: 100, armFirstSets: new Map([['A#0', ["'a'"]]]) }))
      .toContain('weird overlap on things')
  })

  it('never repeats a fix: detail as a site line — it is the group headline', () => {
    const d = diagnosis({
      findings: [finding({ id: 'A#0', details: ['hidden\nfix: the advice'] })],
      summary: { totalChoices: 1 },
    })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100, armFirstSets: new Map([['A#0', ["'a'"]]]) })
    expect(text.split('the advice').length - 1).toBe(1)
    expect(text).not.toContain('hidden')
  })
})

describe('the compact headline for the non-expanded sites', () => {
  const headline = (f: DiagnosisFinding, opts: Parameters<typeof renderDiagnosis>[1] = {}): string => {
    // Two findings under one cause: the first is expanded, the second is a table row.
    const d = diagnosis({
      findings: [finding({ id: 'FIRST#0', details: ['x\nfix: shared cause'] }), { ...f, details: [...f.details, 'x\nfix: shared cause'] }],
      summary: { totalChoices: 2 },
    })
    return renderDiagnosis(d, { name: 'g.ts', width: 120, armFirstSets: new Map([['FIRST#0', ["'a'"]]]), ...opts })
  }

  it('leads with the ANY arm when there is one, and shouts that it is never skippable', () => {
    const text = headline(finding({ id: 'B#0' }), {
      armFirstSets: new Map([['FIRST#0', ["'a'"]], ['B#0', ["'a'", 'ANY']]]),
      armLabels: new Map([['B#0', ['A', 'TheAnyArm']]]),
    })
    expect(text).toContain('arm 1')
    expect(text).toContain('TheAnyArm')
    expect(text).toContain('any character — never skippable')
  })

  it('replaces that note with the corpus count when a cost is known', () => {
    const text = headline(finding({ id: 'B#0' }), {
      armFirstSets: new Map([['FIRST#0', ["'a'"]], ['B#0', ['ANY']]]),
      cost: new Map([['B#0', cost({ choiceId: 'B#0', arms: [{ index: 0, any: true, positions: 640 }] })]]),
    })
    expect(text).toContain('same — tried at all 640')
    expect(text).not.toContain('never skippable')
  })

  it('names the arm and the matched word for an `#armN` id', () => {
    const text = headline(finding({ id: 'MyRule#arm2', code: 'anti-pattern', message: '[keyword-regex] `then` found' }))
    expect(text).toContain('arm 2')
    expect(text).toContain('of MyRule')
    expect(text).toContain('matches `then`')
  })

  it('leaves the note empty when an `#armN` message names no word', () => {
    const text = headline(finding({ id: 'MyRule#arm2', code: 'anti-pattern', message: '[keyword-regex] nothing quoted' }))
    expect(text).toContain('of MyRule')
    expect(text).not.toContain('matches `')
  })

  it('falls back to the first line of the message, truncated to 40 characters', () => {
    const long = 'x'.repeat(60)
    const text = headline(finding({ id: 'PlainId', message: `${long}\nsecond line` }))
    expect(text).toContain('x'.repeat(40))
    expect(text).not.toContain('x'.repeat(41))
    expect(text).not.toContain('second line')
  })
})

describe('the limit, the accept snapshot and the footer', () => {
  const many = (n: number): DiagnosisFinding[] =>
    Array.from({ length: n }, (_, i) => finding({ id: `R${i}#0`, details: ['x\nfix: one shared cause'] }))

  it('stops at the limit and offers the exact flag that shows the rest', () => {
    const d = diagnosis({ findings: many(9), summary: { totalChoices: 9 } })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100, limit: 3 })
    expect(text).toContain('R0#0')
    expect(text).toContain('R2#0')
    expect(text).not.toContain('R3#0')
    expect(text).toContain('… 6 more site(s) — ')
    expect(text).toContain('--limit 9')
    expect(text).toContain(' shows them, --json holds them all')
  })

  it('says nothing about "more site(s)" when everything fitted', () => {
    const d = diagnosis({ findings: many(2), summary: { totalChoices: 2 } })
    expect(renderDiagnosis(d, { name: 'g.ts', width: 100 })).not.toContain('more site(s)')
  })

  it('prints the accept snapshot as one pasteable line, only when not ok', () => {
    const d = diagnosis({ findings: many(1), acceptSnapshot: ['R0#0', 'R1#0'], summary: { totalChoices: 2 } })
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100 })
    expect(text).toContain('Meant to be this way? Pass this and they stop being reported:')
    expect(text).toContain("{ accept: ['R0#0', 'R1#0'] }")

    const empty = diagnosis({ findings: many(1), acceptSnapshot: [], summary: { totalChoices: 1 } })
    expect(renderDiagnosis(empty, { name: 'g.ts', width: 100 })).not.toContain('Meant to be this way?')
  })

  it('ends with the tally and the exit code in words', () => {
    const d = diagnosis({
      findings: [
        finding({ id: 'A#0' }),
        finding({ id: 'B', code: 'degraded', severity: 'advisory', message: 'slow' }),
      ],
      summary: { totalChoices: 2 },
    })
    const lines = renderDiagnosis(d, { name: 'g.ts', width: 100 }).split('\n')
    expect(lines[lines.length - 1]).toBe('✗ 2 problems, 1 failing the check, 2 causes  ·  exiting 1 (problems found)')
  })

  it('uses the singular in the footer for one problem and one cause', () => {
    const d = diagnosis({ findings: [finding({ id: 'A#0' })], summary: { totalChoices: 1 } })
    const lines = renderDiagnosis(d, { name: 'g.ts', width: 100 }).split('\n')
    expect(lines[lines.length - 1]).toBe('✗ 1 problem, 1 failing the check, 1 cause  ·  exiting 1 (problems found)')
  })
})

describe('the wrench — shown only for a PROVED rewrite', () => {
  const d = diagnosis({
    findings: [finding({ id: 'A#0', details: ['x\nfix: cause'] }), finding({ id: 'B#0', details: ['x\nfix: cause'] })],
    summary: { totalChoices: 2 },
  })

  it('marks the fixable site, counts them in the footer and prints the command verbatim', () => {
    const text = renderDiagnosis(d, {
      name: 'g.ts', width: 100,
      fixable: new Set(['B#0']),
      fixCommand: 'parseman fix g.ts --apply',
    })
    expect(text).toContain('🔧 fixable')
    expect(text).toContain('1 of them can be fixed automatically. Run:')
    expect(text).toContain('parseman fix g.ts --apply')
    expect(text).toContain('Each change is applied, the parser rebuilt and your files parsed again')
  })

  it('prints no command when a fix was found but no command was supplied', () => {
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100, fixable: new Set(['B#0']) })
    expect(text).toContain('🔧 fixable')
    expect(text).not.toContain('can be fixed automatically')
  })

  it('prints neither wrench nor command when nothing is fixable', () => {
    const text = renderDiagnosis(d, { name: 'g.ts', width: 100, fixable: new Set(), fixCommand: 'parseman fix g.ts' })
    expect(text).not.toContain('🔧')
    expect(text).not.toContain('parseman fix g.ts')
  })

  it('marks the EXPANDED site with the wrench too', () => {
    const text = renderDiagnosis(d, {
      name: 'g.ts', width: 100,
      armFirstSets: new Map([['A#0', ["'a'"]]]),
      fixable: new Set(['A#0']),
    })
    expect(text.split('🔧 fixable').length - 1).toBe(1)
  })
})

describe('the corpus code frame', () => {
  const framed = (arms: ChoiceCorpusCost['arms'], opts: Parameters<typeof renderDiagnosis>[1] = {}): string => {
    const d = diagnosis({ findings: [finding({ id: 'A#0' })], summary: { totalChoices: 1 } })
    return renderDiagnosis(d, {
      name: 'g.ts', width: 100,
      armFirstSets: new Map([['A#0', arms.map(a => (a.any ? 'ANY' : "'a'"))]]),
      cost: new Map([['A#0', cost({ choiceId: 'A#0', positions: 300, arms })]]),
      ...opts,
    })
  }
  const site = { sample: 'a.css', line: 3, column: 5, lineText: 'a\tb  .x { }' }

  it('points at a CONCRETE arm\'s first site, not the ANY arm\'s byte 0', () => {
    const text = framed([
      { index: 0, any: true, positions: 300, firstSite: { sample: 'a.css', line: 1, column: 1, lineText: 'first' } },
      { index: 1, any: false, positions: 12, firstSite: site },
    ])
    expect(text).toContain('a.css')
    expect(text).toContain('arm 1 matches here; arm 0 is entered first anyway')
    expect(text).toContain('one of the 300 places, in your own input')
    // Tabs are flattened to spaces so the caret column survives.
    expect(text).not.toContain('\t')
  })

  it('uses the neutral wording when no arm is ANY', () => {
    const text = framed([{ index: 0, any: false, positions: 12, firstSite: site }])
    expect(text).toContain('one of those places in your corpus')
    expect(text).toContain('the first place in your corpus this choice is reached')
  })

  it('falls back to the ANY arm\'s site when no concrete arm has one', () => {
    const text = framed([{ index: 0, any: true, positions: 300, firstSite: site }])
    expect(text).toContain('a.css')
    expect(text).toContain('the first place in your corpus this choice is reached')
  })

  it('draws no frame at all when no arm reached the corpus', () => {
    const text = framed([{ index: 0, any: false, positions: 0 }])
    expect(text).not.toContain('a.css')
  })

  it('emits a terminal hyperlink only with colour AND links, and never in the plain form', () => {
    const arms = [{ index: 0, any: false, positions: 3, firstSite: site }]
    const plainText = framed(arms, { corpusRoot: '/abs/root' })
    expect(plainText.includes(ESC)).toBe(false)
    // The absolute root is a LINK target only; it must never reach the diffable output.
    expect(plainText).not.toContain('/abs/root')

    const linked = framed(arms, { corpusRoot: '/abs/root', color: true, links: true })
    expect(linked).toContain('/abs/root/a.css')
    const unlinked = framed(arms, { corpusRoot: '/abs/root', color: true, links: false })
    expect(unlinked.includes(ESC)).toBe(true)
    expect(unlinked).not.toContain('/abs/root/a.css')
  })
})

describe('diagnosisLines is the data behind renderDiagnosis', () => {
  it('renders to exactly the concatenated span text of the lines it returns', () => {
    const d = diagnosis({ findings: [finding({ id: 'A#0' })], summary: { totalChoices: 1 } })
    const opts = { name: 'g.ts', width: 100 }
    const lines = diagnosisLines(d, opts)
    expect(renderDiagnosis(d, opts)).toBe(
      lines.map(l => l.map(s => (s.width === undefined ? s.text : s.text.padEnd(s.width))).join('').replace(/ +$/, '')).join('\n'),
    )
  })

  it('is deterministic — the same diagnosis renders the same bytes every time', () => {
    const d = diagnosis({ findings: [finding({ id: 'A#0' })], summary: { totalChoices: 1 } })
    expect(renderDiagnosis(d, { name: 'g.ts' })).toBe(renderDiagnosis(d, { name: 'g.ts' }))
  })
})
