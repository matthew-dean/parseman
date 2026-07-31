/**
 * `src/analysis/choice-cost-render.ts` — the human layer over the choice-cost reports.
 *
 * Pure rendering: report in, string out. So every case here builds a literal report and
 * asserts on the EXACT rendered text — wording, number formatting, column widths, line
 * ORDER and ANSI bytes — because those are the only things this module decides. Nothing
 * here runs the analyser, so nothing here can drift with the grammar.
 *
 * ANSI is written as \u001B escapes, never as raw control bytes: a raw ESC makes the
 * file binary to git and is rejected by `pnpm check:control-bytes`.
 */
import { describe, it, expect } from 'vitest'
import {
  groupDigits, bytes, leftFactorPreview, renderChoiceInventory, renderWastedWork,
} from '../../src/analysis/choice-cost-render.ts'
import type {
  ChoiceInventoryReport, ChoiceInventoryEntry, PrefixGroup,
  WastedWorkReport, WastedWorkArm, WastedWorkSite,
} from '../../src/analysis/choice-cost.ts'

const ESC = '\u001B'
const BOLD = `${ESC}[1m`
const DIM = `${ESC}[2m`
const RED = `${ESC}[31m`
const YELLOW = `${ESC}[33m`
const CYAN = `${ESC}[36m`
const RESET = `${ESC}[0m`

// ── fixtures ─────────────────────────────────────────────────────────────────

const entry = (o: Partial<ChoiceInventoryEntry> & { siteKey: string }): ChoiceInventoryEntry => ({
  site: { rule: o.siteKey, path: '' },
  arity: 2,
  strategy: 'firstMatch',
  disjoint: false,
  gated: false,
  groups: [],
  armDeclines: [],
  factored: false,
  unfactoredArms: 0,
  ...o,
})

const group = (render: string, members: readonly number[]): PrefixGroup =>
  ({ key: JSON.stringify(render), render, members })

const inventory = (o: Partial<ChoiceInventoryReport> = {}): ChoiceInventoryReport => ({
  schema: 'parseman.choice-inventory/1',
  rules: 1234,
  choiceSites: 5678,
  factoredSites: 90,
  backlogSites: 12,
  backlogArms: 34,
  unresolvedRoots: [],
  entries: [],
  ...o,
})

const arm = (o: Partial<WastedWorkArm> & { siteKey: string; arm: number; label: string }): WastedWorkArm => ({
  site: { rule: o.siteKey, path: '' },
  attempts: 0,
  failures: 0,
  wastedBytes: 0,
  firstCharGated: false,
  gatedAttempts: 0,
  gatedFailures: 0,
  gatedWastedBytes: 0,
  ...o,
})

const site = (o: Partial<WastedWorkSite> & { siteKey: string }): WastedWorkSite => ({
  site: { rule: o.siteKey, path: '' },
  strategy: 'firstMatch',
  arity: 2,
  instrumented: true,
  attempts: 0,
  failures: 0,
  wastedBytes: 0,
  gatedAttempts: 0,
  gatedFailures: 0,
  gatedWastedBytes: 0,
  ...o,
})

const wasted = (o: Partial<WastedWorkReport> = {}): WastedWorkReport => ({
  schema: 'parseman.wasted-work/1',
  corpusFiles: 0,
  corpusBytes: 0,
  parsedOk: 0,
  parsedFailed: 0,
  instrumentedSites: 0,
  uninstrumentableSites: 0,
  unresolvedRoots: [],
  totalWastedBytes: 0,
  totalGatedWastedBytes: 0,
  arms: [],
  inversions: [],
  sites: [],
  ...o,
})

// ── formatting primitives ────────────────────────────────────────────────────

describe('groupDigits', () => {
  it('groups from the right in threes and truncates toward zero', () => {
    expect(groupDigits(0)).toBe('0')
    expect(groupDigits(999)).toBe('999')
    expect(groupDigits(1000)).toBe('1,000')
    expect(groupDigits(4182)).toBe('4,182')
    expect(groupDigits(1234567)).toBe('1,234,567')
    expect(groupDigits(12345678)).toBe('12,345,678')
    expect(groupDigits(999.9)).toBe('999')
  })

  it('keeps the sign outside the grouping', () => {
    expect(groupDigits(-1)).toBe('-1')
    expect(groupDigits(-1234567)).toBe('-1,234,567')
  })
})

describe('bytes', () => {
  it('switches unit at each binary boundary', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(1023)).toBe('1,023 B')
    expect(bytes(1024)).toBe('1.0 kB')
    expect(bytes(1024 * 1024 - 1)).toBe('1024.0 kB')
    expect(bytes(1024 * 1024)).toBe('1.0 MB')
    expect(bytes(1376256)).toBe('1.3 MB')
  })

  it('fixes one decimal, never scientific or locale notation', () => {
    expect(bytes(1536)).toBe('1.5 kB')
    expect(bytes(1024 * 1024 * 1024)).toBe('1024.0 MB')
  })
})

// ── leftFactorPreview ────────────────────────────────────────────────────────

describe('leftFactorPreview', () => {
  it('declines when the site is already factored', () => {
    expect(leftFactorPreview(entry({
      siteKey: 'A', factored: true, arity: 2, groups: [group('"@"', [0, 1])],
    }))).toBeNull()
  })

  it('declines with no groups or with more than one group', () => {
    expect(leftFactorPreview(entry({ siteKey: 'A', groups: [] }))).toBeNull()
    expect(leftFactorPreview(entry({
      siteKey: 'A', arity: 4, groups: [group('"@"', [0, 1]), group('"#"', [2, 3])],
    }))).toBeNull()
  })

  it('declines a PARTIAL group — fewer members than arms', () => {
    expect(leftFactorPreview(entry({
      siteKey: 'A', arity: 3, groups: [group('"@"', [0, 1])],
    }))).toBeNull()
  })

  it('renders a literal prefix rewrite covering every arm', () => {
    expect(leftFactorPreview(entry({
      siteKey: 'A', arity: 2, groups: [group('"@"', [0, 1])],
    }))).toBe(
      'sequence(\n' +
      '  literal("@"),\n' +
      '  choice(\n' +
      '    sequence(…arm[0] tail…),\n' +
      '    sequence(…arm[1] tail…),\n' +
      '  ),\n' +
      ')',
    )
  })

  it('wraps a regex render in regex() and preserves member order', () => {
    expect(leftFactorPreview(entry({
      siteKey: 'A', arity: 3, groups: [group('/[-\\w]+/', [2, 0, 1])],
    }))).toBe(
      'sequence(\n' +
      '  regex(/[-\\w]+/),\n' +
      '  choice(\n' +
      '    sequence(…arm[2] tail…),\n' +
      '    sequence(…arm[0] tail…),\n' +
      '    sequence(…arm[1] tail…),\n' +
      '  ),\n' +
      ')',
    )
  })

  it('substitutes <prefix> for an empty render', () => {
    const out = leftFactorPreview(entry({
      siteKey: 'A', arity: 2, groups: [group('', [0, 1])],
    }))
    expect(out).not.toBeNull()
    expect(out!.split('\n')[1]).toBe('  <prefix>,')
  })
})

// ── renderChoiceInventory ────────────────────────────────────────────────────

describe('renderChoiceInventory', () => {
  it('renders the header with grouped counts and the empty-backlog tail', () => {
    expect(renderChoiceInventory(inventory()).split('\n')).toEqual([
      'shared-prefix inventory',
      '  Static grammar shape only. A site listed here may already cost nothing at runtime:',
      '  compiled output gates each arm on its first character. Rank with profileWastedWork().',
      '  1,234 rules, 5,678 choice sites',
      '  90 left-factored by the compiler',
      '  12 sites where alternatives share a leading term and the compiler DECLINED (34 arms)',
      '',
      '  no declined shared prefixes.',
    ])
  })

  it('excludes factored sites, group-less sites, and the two non-backlog decline reasons', () => {
    const out = renderChoiceInventory(inventory({
      entries: [
        entry({ siteKey: 'Factored', factored: true, groups: [group('"@"', [0, 1])] }),
        entry({ siteKey: 'NoGroups', declineReason: 'fewer-than-two-arms' }),
        entry({ siteKey: 'Disjoint', groups: [group('"@"', [0, 1])], declineReason: 'disjoint-dispatch' }),
        entry({ siteKey: 'Preempted', groups: [group('"@"', [0, 1])], declineReason: 'strategy-preempted' }),
      ],
    }))
    expect(out).toContain('  no declined shared prefixes.')
    for (const k of ['Factored', 'NoGroups', 'Disjoint', 'Preempted']) expect(out).not.toContain(k)
  })

  it('ranks by unfactoredArms descending, ties broken by siteKey ascending', () => {
    const out = renderChoiceInventory(inventory({
      entries: [
        entry({ siteKey: 'Alpha › choice[0]', unfactoredArms: 2, groups: [group('"@"', [0, 1])], declineReason: 'leads-differ' }),
        entry({ siteKey: 'Bravo › choice[1]', unfactoredArms: 5, groups: [group('"#"', [0, 1])], declineReason: 'gated-arms' }),
        entry({ siteKey: 'Alfa › choice[9]', unfactoredArms: 2, groups: [group("'x'", [0, 1])], declineReason: 'leads-differ' }),
      ],
    }))
    const keys = out.split('\n').filter(l => l.includes('› choice[')).map(l => l.trim().split('  ')[0])
    expect(keys).toEqual(['Bravo › choice[1]', 'Alfa › choice[9]', 'Alpha › choice[0]'])
  })

  it('renders one entry in full — group line, decline sentence, arm declines', () => {
    const out = renderChoiceInventory(inventory({
      entries: [entry({
        siteKey: 'StylesheetAtRule › dispatch[0]',
        arity: 3,
        strategy: 'sharedPrefix',
        unfactoredArms: 2,
        groups: [group('"@"', [0, 2])],
        declineReason: 'arms-not-factorable',
        armDeclines: [{ arm: 1, reason: 'not-a-sequence', detail: '' }],
      })],
    }))
    expect(out.split('\n').slice(6)).toEqual([
      '',
      '  StylesheetAtRule › dispatch[0]  3 arms · sharedPrefix',
      '    arms 0, 2 all begin with "@"',
      '    declined: at least one arm cannot contribute a leading term (see below)',
      '      arm[1] — arm is not a sequence, so there is no leading term to lift out',
      '',
    ])
    // Partial group (2 members, 3 arms) => no rewrite offered.
    expect(out).not.toContain('candidate rewrite')
  })

  it('renders each group of a multi-group entry on its own line', () => {
    const out = renderChoiceInventory(inventory({
      entries: [entry({
        siteKey: 'S', arity: 5, unfactoredArms: 4,
        groups: [group('"@"', [0, 3]), group('/[-\\w]+/', [1, 2])],
        declineReason: 'leads-differ',
      })],
    }))
    expect(out.split('\n').filter(l => l.startsWith('    arms '))).toEqual([
      '    arms 0, 3 all begin with "@"',
      '    arms 1, 2 all begin with /[-\\w]+/',
    ])
  })

  it('appends the rewrite preview, indented six spaces, when the group covers every arm', () => {
    const out = renderChoiceInventory(inventory({
      entries: [entry({
        siteKey: 'S', arity: 2, unfactoredArms: 2,
        groups: [group('"@"', [0, 1])], declineReason: 'leads-differ',
      })],
    }))
    expect(out.split('\n').slice(6)).toEqual([
      '',
      '  S  2 arms · firstMatch',
      '    arms 0, 1 all begin with "@"',
      '    declined: the arms do not all begin with the same term',
      '    candidate rewrite (preview — not applied, not yet digest-verified):',
      '      sequence(',
      '        literal("@"),',
      '        choice(',
      '          sequence(…arm[0] tail…),',
      '          sequence(…arm[1] tail…),',
      '        ),',
      '      )',
      '',
    ])
  })

  it('renders every distinct site-decline sentence', () => {
    const reasons = [
      ['gated-arms', 'an arm carries a runtime gate; per-arm predicates are incompatible with factoring'],
      ['fewer-than-two-arms', 'fewer than two arms'],
      ['arms-not-factorable', 'at least one arm cannot contribute a leading term (see below)'],
      ['leads-differ', 'the arms do not all begin with the same term'],
    ] as const
    for (const [reason, text] of reasons) {
      const out = renderChoiceInventory(inventory({
        entries: [entry({ siteKey: 'S', arity: 9, groups: [group('"@"', [0, 1])], declineReason: reason })],
      }))
      expect(out).toContain(`    declined: ${text}`)
    }
  })

  it('renders every distinct arm-decline sentence, in report order', () => {
    const out = renderChoiceInventory(inventory({
      entries: [entry({
        siteKey: 'S', arity: 9, groups: [group('"@"', [0, 1])], declineReason: 'arms-not-factorable',
        armDeclines: [
          { arm: 3, reason: 'sequence-shorter-than-2', detail: '' },
          { arm: 4, reason: 'lead-case-insensitive-literal', detail: '' },
          { arm: 5, reason: 'lead-not-concrete-terminal', detail: '' },
          { arm: 6, reason: 'not-a-sequence', detail: '' },
        ],
      })],
    }))
    expect(out.split('\n').filter(l => l.startsWith('      arm['))).toEqual([
      '      arm[3] — arm is a one-term sequence; lifting its only term would leave an empty arm',
      '      arm[4] — leading literal is case-insensitive, so the matched text can differ from the literal — a lifted prefix would carry the wrong string',
      '      arm[5] — leading term is not a bare literal or regex; lifting it would change the arm’s value or capture shape',
      '      arm[6] — arm is not a sequence, so there is no leading term to lift out',
    ])
  })

  it('honours limit and reports the remainder with grouped digits', () => {
    const entries = Array.from({ length: 1003 }, (_, i) => entry({
      siteKey: `S${String(i).padStart(4, '0')}`,
      unfactoredArms: 1000 - (i % 3),
      groups: [group('"@"', [0, 1])],
      declineReason: 'leads-differ',
    }))
    const out = renderChoiceInventory(inventory({ entries }), { limit: 2 })
    expect(out).toContain('  … and 1,001 more (the report holds all of them)')
    const rows = (s: string) => s.split('\n').filter(l => /^ {2}S\d{4} {2}/.test(l))
    expect(rows(out).length).toBe(2)
    // Default limit is 20.
    const dflt = renderChoiceInventory(inventory({ entries }))
    expect(rows(dflt).length).toBe(20)
    expect(dflt).toContain('  … and 983 more (the report holds all of them)')
  })

  it('omits the remainder line when everything fits', () => {
    const out = renderChoiceInventory(inventory({
      entries: [entry({ siteKey: 'S', groups: [group('"@"', [0, 1])], declineReason: 'leads-differ' })],
    }), { limit: 5 })
    expect(out).not.toContain('more (the report holds all of them)')
  })

  it('emits no ANSI by default and wraps the right cells when color is on', () => {
    const rep = inventory({
      entries: [entry({
        siteKey: 'S', arity: 2, unfactoredArms: 2,
        groups: [group('"@"', [0, 1])], declineReason: 'leads-differ',
      })],
    })
    expect(renderChoiceInventory(rep)).not.toContain(ESC)
    expect(renderChoiceInventory(rep, { color: false })).not.toContain(ESC)

    const lit = renderChoiceInventory(rep, { color: true }).split('\n')
    expect(lit[0]).toBe(`${BOLD}shared-prefix inventory${RESET}`)
    expect(lit[1]!.startsWith(DIM)).toBe(true)
    // Counts are NEVER painted.
    expect(lit[3]).toBe('  1,234 rules, 5,678 choice sites')
    expect(lit[7]).toBe(`  ${CYAN}S${RESET}  ${DIM}2 arms · firstMatch${RESET}`)
    expect(lit[8]).toBe(`    arms 0, 1 all begin with ${BOLD}"@"${RESET}`)
    expect(lit[9]).toBe(`    ${YELLOW}declined${RESET}: the arms do not all begin with the same term`)
    expect(lit[10]).toBe(`    ${DIM}candidate rewrite (preview — not applied, not yet digest-verified):${RESET}`)
    // The rewrite body itself is unpainted, so it stays paste-able.
    expect(lit[11]).toBe('      sequence(')
  })
})

// ── renderWastedWork ─────────────────────────────────────────────────────────

describe('renderWastedWork', () => {
  it('renders header, banner, corpus and totals with nothing measured', () => {
    expect(renderWastedWork(wasted()).split('\n')).toEqual([
      'wasted work — input bytes re-scanned after a failed alternative',
      '  MEASURED IN THE INTERPRETER. Compiled output gates each arm on its first',
      '  character; 0 entries below never happen in the shipped parser.',
      '  Counts shown are the modelled COMPILED ones. Byte totals are unaffected by the',
      '  gate (a gated-out arm consumes nothing); entry counts and failure RATES are not.',
      '  corpus: 0 files, 0 B (0 parsed, 0 failed)',
      '  sites:  0 instrumented, 0 not instrumentable',
      '  total:  0 B re-scanned',
      '',
      '  no alternative failed on this corpus.',
    ])
  })

  it('omits the gated share when no arm was attempted, and includes it otherwise', () => {
    const noArms = renderWastedWork(wasted())
    expect(noArms).toContain('  character; 0 entries below never happen in the shipped parser.')
    expect(noArms).not.toContain('% of interpreted arm entries')

    const withArms = renderWastedWork(wasted({
      arms: [
        arm({ siteKey: 'S', arm: 0, label: 'a', attempts: 900, gatedAttempts: 0 }),
        arm({ siteKey: 'S', arm: 1, label: 'b', attempts: 100, gatedAttempts: 100 }),
      ],
    }))
    // 900 of 1000 interpreted entries removed by the first-char gate; share is rounded
    // to a whole percent.
    expect(withArms).toContain(
      '  character; 900 entries below never happen in the shipped parser — 90% of interpreted arm entries.',
    )
  })

  it('omits the corpus multiple when corpusBytes is zero and prints it otherwise', () => {
    expect(renderWastedWork(wasted({ totalGatedWastedBytes: 4096, totalWastedBytes: 4096, corpusBytes: 0 })).split('\n')[7])
      .toBe('  total:  4.0 kB re-scanned')
    expect(renderWastedWork(wasted({ totalGatedWastedBytes: 4096, totalWastedBytes: 4096, corpusBytes: 2048 })).split('\n')[7])
      .toBe('  total:  4.0 kB re-scanned — 2.00x the corpus')
  })

  it('appends the interpreted total only when it differs from the gated total', () => {
    expect(renderWastedWork(wasted({ totalGatedWastedBytes: 4096, totalWastedBytes: 4096 })))
      .not.toContain('interpreted:')
    expect(renderWastedWork(wasted({ totalGatedWastedBytes: 4096, totalWastedBytes: 8192 })))
      .toContain('  total:  4.0 kB re-scanned  (interpreted: 8.0 kB)')
  })

  it('warns PARTIAL only when roots went unresolved', () => {
    expect(renderWastedWork(wasted())).not.toContain('PARTIAL')
    const rep = wasted({ unresolvedRoots: ['g.A', 'g.B', 'g.C'] })
    expect(renderWastedWork(rep)).toContain(
      '  PARTIAL: 3 rule(s) could not be resolved and were NOT walked — the total below is a lower bound',
    )
    expect(renderWastedWork(rep, { color: true })).toContain(`  ${YELLOW}PARTIAL${RESET}: 3 rule(s)`)
  })

  it('drops sites where nothing was wasted on either measure', () => {
    const out = renderWastedWork(wasted({
      sites: [
        site({ siteKey: 'ZeroSite', gatedWastedBytes: 0, wastedBytes: 0 }),
        site({ siteKey: 'InterpOnly', gatedWastedBytes: 0, wastedBytes: 4096 }),
      ],
    }))
    expect(out).not.toContain('ZeroSite')
    expect(out).toContain('InterpOnly')
    expect(out).not.toContain('no alternative failed on this corpus.')
  })

  describe('the ranked table', () => {
    const s1 = 'Site › dispatch[0]'   // 18 chars
    const s2 = 'Other › dispatch[1]'  // 19 chars

    const report = wasted({
      corpusFiles: 4271,
      corpusBytes: 689152,
      parsedOk: 4200,
      parsedFailed: 71,
      instrumentedSites: 1200,
      uninstrumentableSites: 7,
      totalWastedBytes: 1378304,
      totalGatedWastedBytes: 1378304,
      sites: [
        site({ siteKey: s1, gatedWastedBytes: 1376256, wastedBytes: 1376256 }),
        site({ siteKey: s2, gatedWastedBytes: 2048, wastedBytes: 2048 }),
      ],
      // Deliberately out of arm order — the renderer must sort.
      arms: [
        arm({ siteKey: s1, arm: 1, label: 'RoutedLayerBlock', attempts: 4182, gatedAttempts: 4182 }),
        arm({ siteKey: s2, arm: 0, label: 'PreludeTail', attempts: 30, failures: 30, gatedAttempts: 12, gatedFailures: 12, gatedWastedBytes: 2048, wastedBytes: 2048 }),
        arm({ siteKey: s1, arm: 3, label: 'CustomPropertyValue', attempts: 50, failures: 50, gatedAttempts: 50, gatedFailures: 50 }),
        arm({ siteKey: s1, arm: 0, label: 'RoutedAtRuleStatement', attempts: 4271, failures: 4182, gatedAttempts: 4271, gatedFailures: 4182, gatedWastedBytes: 1376256, wastedBytes: 1376256 }),
        arm({ siteKey: s1, arm: 2, label: 'NeverReached', attempts: 900, failures: 900, gatedAttempts: 0 }),
      ],
    })

    it('prints the corpus and site summary lines exactly', () => {
      const lines = renderWastedWork(report).split('\n')
      expect(lines[5]).toBe('  corpus: 4,271 files, 673.0 kB (4,200 parsed, 71 failed)')
      expect(lines[6]).toBe('  sites:  1,200 instrumented, 7 not instrumentable')
      expect(lines[7]).toBe('  total:  1.3 MB re-scanned — 2.00x the corpus')
    })

    it('prints the per-arm legend once, before the first site', () => {
      expect(renderWastedWork(report).split('\n').slice(8, 12)).toEqual([
        '',
        '  per arm: "entered" counts what the COMPILED parser reaches; the parenthesised',
        '  number is the interpreted count, shown only where the first-char gate differs.',
        '',
      ])
    })

    it('renders each site with its share, and each arm sorted by index with its verdict', () => {
      expect(renderWastedWork(report).split('\n').slice(12)).toEqual([
        // siteKey padded to 19 (the longest of the two), bytes right-aligned in 10,
        // share right-aligned in 7 after a leading space.
        `  ${'Site › dispatch[0]'.padEnd(19)} ${'1.3 MB'.padStart(10)} ${'99.9%'.padStart(7)}`,
        `     0  ${'RoutedAtRuleStatement'.padEnd(30)} ${'failed 4,182 / 4,271'.padEnd(34)} ${'1.3 MB'.padStart(10)}`,
        `     1  ${'RoutedLayerBlock'.padEnd(30)} ${'matched 4,182'.padEnd(34)} `,
        `     2  ${'NeverReached'.padEnd(30)} ${'never entered when compiled'.padEnd(34)} `,
        `     3  ${'CustomPropertyValue'.padEnd(30)} ${'failed ALL 50'.padEnd(34)} `,
        '',
        `  ${'Other › dispatch[1]'.padEnd(19)} ${'2.0 kB'.padStart(10)} ${'0.1%'.padStart(7)}`,
        // gatedAttempts !== attempts => the interpreted count is shown in parentheses.
        `     0  ${'PreludeTail'.padEnd(30)} ${'failed ALL 12 (30 interp)'.padEnd(34)} ${'2.0 kB'.padStart(10)}`,
        '',
      ])
    })

    it('paints only the site key, share and verdict cells — and pads BEFORE painting', () => {
      const lines = renderWastedWork(report, { color: true }).split('\n')
      expect(lines[12]).toBe(
        `  ${CYAN}${'Site › dispatch[0]'.padEnd(19)}${RESET} ${'1.3 MB'.padStart(10)}${DIM} ${'99.9%'.padStart(7)}${RESET}`,
      )
      // failed-some => no colour at all on the verdict.
      expect(lines[13]).toBe(
        `     0  ${'RoutedAtRuleStatement'.padEnd(30)} ${'failed 4,182 / 4,271'.padEnd(34)} ${'1.3 MB'.padStart(10)}`,
      )
      expect(lines[14]).toBe(
        `     1  ${'RoutedLayerBlock'.padEnd(30)} ${DIM}${'matched 4,182'.padEnd(34)}${RESET} `,
      )
      expect(lines[15]).toBe(
        `     2  ${'NeverReached'.padEnd(30)} ${DIM}${'never entered when compiled'.padEnd(34)}${RESET} `,
      )
      expect(lines[16]).toBe(
        `     3  ${'CustomPropertyValue'.padEnd(30)} ${RED}${'failed ALL 50'.padEnd(34)}${RESET} `,
      )
    })

    it('stripping the SGR escapes reproduces the uncoloured rendering byte for byte', () => {
      const strip = (s: string) => s.split(ESC + '[').map((p, i) => i === 0 ? p : p.slice(p.indexOf('m') + 1)).join('')
      expect(strip(renderWastedWork(report, { color: true }))).toBe(renderWastedWork(report))
    })

    it('honours limit, narrowing the key column to the shown rows', () => {
      const lines = renderWastedWork(report, { limit: 1 }).split('\n')
      // Only s1 is shown, so the column is 18 wide, not 19.
      expect(lines[12]).toBe(`  Site › dispatch[0] ${'1.3 MB'.padStart(10)} ${'99.9%'.padStart(7)}`)
      // DEFECT PINNED, NOT ENDORSED: `choice-cost-render.ts:263` says "1 more siteS" —
      // the count is singular and the noun is not. This records today's bytes; fixing
      // the wording means updating this one expectation.
      expect(lines[lines.length - 1]).toBe('  … and 1 more sites (the report holds all of them)')
      expect(lines.some(l => l.includes('Other › dispatch[1]'))).toBe(false)
    })

    it('omits the remainder line when every ranked site fits', () => {
      expect(renderWastedWork(report)).not.toContain('more sites (the report holds all of them)')
    })
  })

  it('drops the share column entirely when the gated total is zero', () => {
    const out = renderWastedWork(wasted({
      totalGatedWastedBytes: 0,
      totalWastedBytes: 4096,
      sites: [site({ siteKey: 'OnlyInterp', wastedBytes: 4096, gatedWastedBytes: 0 })],
      arms: [arm({ siteKey: 'OnlyInterp', arm: 0, label: 'x', attempts: 5, failures: 5, wastedBytes: 4096 })],
    })).split('\n')
    expect(out[12]).toBe(`  OnlyInterp ${'0 B'.padStart(10)}`)
    expect(out[13]).toBe(`     0  ${'x'.padEnd(30)} ${'never entered when compiled'.padEnd(34)} `)
  })

  it('truncates a site key at 52 and an arm label at 30', () => {
    const longKey = 'VeryLongRuleName › node(Something) › choice[12] › dispatch[3] › arm'
    const longLabel = 'AnExtremelyLongAlternativeLabelThatOverflows'
    expect(longKey.length).toBeGreaterThan(52)
    const out = renderWastedWork(wasted({
      totalGatedWastedBytes: 1024,
      totalWastedBytes: 1024,
      sites: [site({ siteKey: longKey, gatedWastedBytes: 1024, wastedBytes: 1024 })],
      arms: [arm({ siteKey: longKey, arm: 10, label: longLabel, attempts: 3, failures: 3, gatedAttempts: 3, gatedFailures: 3, gatedWastedBytes: 1024 })],
    })).split('\n')
    expect(out[12]).toBe(
      `  ${longKey.slice(0, 52)} ${'1.0 kB'.padStart(10)} ${'100.0%'.padStart(7)}`,
    )
    expect(out[12]).not.toContain('dispatch[3]')
    expect(out[13]).toBe(
      `    10  AnExtremelyLongAlternativeLabe ${'failed ALL 3'.padEnd(34)} ${'1.0 kB'.padStart(10)}`,
    )
  })

  it('omits the inversions block when there are none', () => {
    const out = renderWastedWork(wasted({
      totalGatedWastedBytes: 1024, totalWastedBytes: 1024,
      sites: [site({ siteKey: 'S', gatedWastedBytes: 1024, wastedBytes: 1024 })],
      inversions: [],
    }))
    expect(out).not.toContain('ordering inversions')
  })

  it('renders inversions in report order, with 0 B for an arm that re-scanned nothing', () => {
    const key = 'Value › dispatch[2]'
    const out = renderWastedWork(wasted({
      totalGatedWastedBytes: 1024, totalWastedBytes: 1024,
      sites: [site({ siteKey: key, gatedWastedBytes: 1024, wastedBytes: 1024 })],
      inversions: [
        arm({ siteKey: key, arm: 8, label: 'CustomPropertyValue', attempts: 925, failures: 925, gatedAttempts: 925, gatedFailures: 925 }),
        arm({ siteKey: key, arm: 0, label: 'RoutedAtRuleStatement', attempts: 19, failures: 19, gatedAttempts: 19, gatedFailures: 19, gatedWastedBytes: 4096 }),
      ],
    })).split('\n')
    const at = out.indexOf('  ordering inversions — arm failed EVERY compiled entry while a later arm matched')
    expect(at).toBeGreaterThan(0)
    expect(out.slice(at + 1)).toEqual([
      '  ranked by entries, not bytes: an arm can fail 100% of the time and re-scan nothing.',
      `    ${key.padEnd(19)} arm  8  ${'CustomPropertyValue'.padEnd(26)} ${'925'.padStart(8)} entries  ${'0 B'.padStart(10)}`,
      `    ${key.padEnd(19)} arm  0  ${'RoutedAtRuleStatement'.padEnd(26)} ${'19'.padStart(8)} entries  ${'4.0 kB'.padStart(10)}`,
    ])
  })

  it('truncates an inversion label at 26 and caps the list at limit', () => {
    const key = 'S'
    const out = renderWastedWork(wasted({
      totalGatedWastedBytes: 1024, totalWastedBytes: 1024,
      sites: [site({ siteKey: key, gatedWastedBytes: 1024, wastedBytes: 1024 })],
      inversions: [
        arm({ siteKey: key, arm: 0, label: 'ThisLabelIsDefinitelyLongerThanTwentySix', attempts: 1, failures: 1, gatedAttempts: 1, gatedFailures: 1 }),
        arm({ siteKey: key, arm: 1, label: 'b', attempts: 1, failures: 1, gatedAttempts: 1, gatedFailures: 1 }),
        arm({ siteKey: key, arm: 2, label: 'c', attempts: 1, failures: 1, gatedAttempts: 1, gatedFailures: 1 }),
      ],
    }), { limit: 1 }).split('\n')
    expect(out[out.length - 2]).toBe(
      `    S arm  0  ${'ThisLabelIsDefinitelyLonge'.padEnd(26)} ${'1'.padStart(8)} entries  ${'0 B'.padStart(10)}`,
    )
    expect(out[out.length - 1]).toBe('    … and 2 more')
  })

  it('paints the inversions heading and key when color is on, and nothing when off', () => {
    const rep = wasted({
      totalGatedWastedBytes: 1024, totalWastedBytes: 1024,
      sites: [site({ siteKey: 'S', gatedWastedBytes: 1024, wastedBytes: 1024 })],
      inversions: [arm({ siteKey: 'S', arm: 0, label: 'a', attempts: 1, failures: 1, gatedAttempts: 1, gatedFailures: 1 })],
    })
    expect(renderWastedWork(rep)).not.toContain(ESC)
    const lit = renderWastedWork(rep, { color: true })
    expect(lit).toContain(`${BOLD}wasted work — input bytes re-scanned after a failed alternative${RESET}`)
    expect(lit).toContain(`${BOLD}  ordering inversions — arm failed EVERY compiled entry while a later arm matched${RESET}`)
    expect(lit).toContain(`    ${CYAN}S${RESET} arm  0  `)
    // The banner is yellow-then-dim, in that order.
    const lines = lit.split('\n')
    expect(lines[1]!.startsWith(YELLOW)).toBe(true)
    expect(lines[2]!.startsWith(YELLOW)).toBe(true)
    expect(lines[3]!.startsWith(DIM)).toBe(true)
    expect(lines[4]!.startsWith(DIM)).toBe(true)
  })

  it('is deterministic — no dates, same bytes every call', () => {
    const rep = wasted({
      corpusFiles: 3, corpusBytes: 2048, totalGatedWastedBytes: 1024, totalWastedBytes: 2048,
      sites: [site({ siteKey: 'S', gatedWastedBytes: 1024, wastedBytes: 2048 })],
      arms: [arm({ siteKey: 'S', arm: 0, label: 'a', attempts: 9, failures: 9, gatedAttempts: 4, gatedFailures: 4, gatedWastedBytes: 1024 })],
    })
    expect(renderWastedWork(rep)).toBe(renderWastedWork(rep))
    expect(renderWastedWork(rep)).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})
