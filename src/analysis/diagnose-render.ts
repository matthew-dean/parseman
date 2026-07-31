/**
 * The human layer over `GrammarDiagnosis`.
 *
 * Three layers, not two: `gating.ts`/`corpus.ts` produce data, `diagnose.ts` decides
 * `ok` (the CI verdict), and this file makes either readable. Nothing here computes a
 * finding and nothing here decides pass or fail. A gate consumes the object; a person
 * reads this. If a number appears below that is not in the report, that is a bug here.
 *
 * GROUPED BY CAUSE, NOT BY SITE
 * -----------------------------
 * The first version grouped by site: thirteen findings, each carrying its own copy of
 * the explanation, the `do` line and the `ok as-is?` line. Measured on
 * `examples/css/parser.ts`, that was three distinct explanations rendered nine times
 * across 146 lines. Density that comes from repetition is not detail — it is the same
 * sentence again, and it buries the arm tables, which are the part a reader acts on.
 *
 * A cause is now stated ONCE, given a glyph, and followed by its sites. That also
 * disposes of the question a glossary would have answered: the glyph is defined at the
 * head of the only group it labels, so there is nothing to look up. Shipping a glossary
 * AND the inline explanations would just re-create the duplication this removes.
 *
 * WHAT CARRIES MEANING
 * --------------------
 *   colour  — severity, and importance WITHIN a finding. Exactly one span per block is
 *             the brightest thing in it; provenance and accept keys recede.
 *   glyph   — the cause class, so sites are scannable without reading prose.
 *   rules   — group boundaries, so the report is blocks rather than a paragraph.
 *   columns — the arm table is aligned, so an ANY arm or an overlap is visible as a
 *             shape before it is read as text.
 *
 * All of that lives in the STYLED path. The plain path is the same content with the same
 * padding and no escapes, so `docs/samples/` stays diffable and the two cannot drift.
 */
import { examinedNothing, type GrammarDiagnosis, type DiagnosisFinding } from './diagnose.ts'
import type { ChoiceCorpusCost } from './corpus.ts'
import {
  DEFAULT_WIDTH, TONE, blank, codeFrame, groupDigits, pad, render, rule, t, wrap,
  type Line, type RenderTarget, type Tone,
} from './terminal.ts'

export type DiagnoseRenderOptions = RenderTarget & {
  /** Grammar label for the header. The CLI passes a cwd-relative path. */
  name?: string
  /** Sites to expand. Default 20; the report always holds all of them. */
  limit?: number
  /** Corpus cost per choice id, from `measureChoiceCost`. */
  cost?: ReadonlyMap<string, ChoiceCorpusCost>
  /** Per-arm first-set renderings per choice id, in arm order. */
  armFirstSets?: ReadonlyMap<string, readonly string[]>
  /** Per-arm leading-term labels per choice id, in arm order. */
  armLabels?: ReadonlyMap<string, readonly string[]>
  /** Absolute corpus root, used ONLY for the frame's terminal hyperlink. */
  corpusRoot?: string
  /**
   * Finding ids for which `proposeFixes` PROVED a rewrite — applied it, recompiled, and
   * re-parsed the corpus with identical output. Only these may carry the wrench. A
   * candidate that was proposed and rejected must never appear here: offering a fix that
   * does not exist would destroy the one guarantee the feature has.
   */
  fixable?: ReadonlySet<string>
  /** The command that would apply them, printed verbatim so nobody has to guess it. */
  fixCommand?: string
}

export { groupDigits }

/**
 * Cause glyphs, in assignment order.
 *
 * Deliberately distinct in SHAPE, not just in colour: a report has to stay readable for
 * a reader who cannot distinguish red from green, and in a log that has been stripped of
 * colour entirely — which is exactly what `docs/samples/` is.
 */
const GLYPHS = ['◆', '▲', '●', '■', '◇', '△', '○', '□'] as const

/** A short label per finding code, used in a group headline. */
const CODE_LABEL: Record<string, { one: string; many: string }> = {
  'ungated-choice': {
    one: 'choice the parser cannot narrow down',
    many: 'choices the parser cannot narrow down',
  },
  'anti-pattern': { one: 'arm that hides its first character', many: 'arms that hide their first character' },
  unanalysable: { one: 'rule parseman could not examine at all', many: 'rules parseman could not examine at all' },
  degraded: { one: 'place the compiler took a slower route', many: 'places the compiler took a slower route' },
  'stale-accept': {
    one: 'accept-list entry that no longer matches anything',
    many: 'accept-list entries that no longer match anything',
  },
}

/**
 * The cause an anti-pattern finding belongs to, keyed by KIND.
 *
 * The finding's own message names the specific word it found, which is right for the
 * site line and wrong for the group: keying on the whole message split one cause into
 * one group per site, which is the duplication this rendering exists to remove. The
 * group says what the pattern is; the site says where and which word.
 */
const ANTI_KIND_BLURB: Record<string, string> = {
  'keyword-regex':
    'These arms match a fixed word using a regular expression. parseman cannot always tell '
    + 'from a regular expression which character it starts with, so the parser cannot skip '
    + 'the arm when that character rules it out.\n'
    + "To fix: write the word with word('…') or keywords([…]). Same match, same compiled "
    + 'character scan, but parseman then knows the first character.',
  'double-not':
    'These arms use not(not(X)) — a hand-written way of saying "X must come next, but do not '
    + 'consume it". It hides the first character, so the arm can never be skipped, and among '
    + 'arms that share a first character it can pick the wrong one.\n'
    + 'To fix: write peek(X). Same check, and parseman still knows the first character.',
  'leading-not':
    'These arms begin with not(...), which matches no text and so reveals no first character. '
    + 'The parser cannot skip the arm and enters it at every position.\n'
    + 'To fix: put the term that actually consumes text first, and keep not(...) after it as a '
    + 'trailing boundary check.',
}

/**
 * A first set, said in words.
 *
 * `'#','*','-'-'.'` is how the model writes it and is unreadable to anyone who has not
 * met the model. What a reader needs is the sentence: this arm can only begin with these
 * characters, therefore the parser can skip it everywhere else.
 */
function startsWithPhrase(fs: string): string {
  if (fs === 'ANY') return 'can start with any character'
  if (fs === '(empty)') return 'matches nothing'
  const parts = fs.split(',')
  const pretty = parts.map(x => x.replace(/'/g, '')).join(' ')
  if (parts.length === 1) return `starts with "${pretty}"`
  if (parts.length > 4) return `starts with ${groupDigits(parts.length)} char ranges`
  return `starts with one of ${pretty.length > 20 ? `${pretty.slice(0, 19)}…` : pretty}`
}

/** The fallback explanation for a code whose findings carry no `fix:` of their own. */
const CODE_BLURB: Record<string, string> = {
  'ungated-choice': 'The parser cannot tell from the next character which alternative to try, so it '
    + 'tries them in order and undoes the ones that do not match.',
  'anti-pattern': 'The arm is written in a way that hides which character it starts with, so the parser '
    + 'cannot skip it when it cannot match.',
  unanalysable: 'parseman could not read these rules at all, so it has NO opinion about them — good or '
    + 'bad. Anything reported elsewhere is therefore incomplete.',
  degraded: 'The compiler could not use its fast route here and fell back to a slower one that produces '
    + 'the same result.',
  'stale-accept': 'This entry in your accept list no longer matches any finding — the grammar was fixed '
    + 'and the line was left behind. Delete it.',
}

type CauseGroup = {
  glyph: string
  /** The one-per-cause explanation. */
  text: string
  code: string
  severity: 'blocking' | 'advisory'
  findings: DiagnosisFinding[]
}

/** Every `fix:` a finding carries, in order. The first is its primary cause. */
function suggestionsOf(f: DiagnosisFinding): string[] {
  const out: string[] = []
  for (const d of f.details) {
    const i = d.indexOf('\nfix: ')
    if (i === -1) continue
    const s = d.slice(i + 6)
    if (!out.includes(s)) out.push(s)
  }
  return out
}

/**
 * Group findings by primary cause.
 *
 * A finding with two causes is listed ONCE, under its first, with the others flagged
 * inline. Listing it under both would print its arm table twice, which is the
 * duplication this grouping exists to remove.
 */
function groupByCause(findings: readonly DiagnosisFinding[]): CauseGroup[] {
  const groups: CauseGroup[] = []
  const byKey = new Map<string, CauseGroup>()
  for (const f of findings) {
    // An anti-pattern's message names the specific word found at THIS site, which is
    // right for the site line and wrong for the group: keying on it split one pattern
    // into one group per site — the exact duplication this grouping removes. Key on the
    // KIND, and let the site line carry the word.
    const kind = f.code === 'anti-pattern' ? /^\[([^\]]+)\]/.exec(f.message)?.[1] : undefined
    const text = suggestionsOf(f)[0]
      ?? (kind === undefined ? undefined : ANTI_KIND_BLURB[kind])
      ?? (f.code === 'anti-pattern' ? f.message.replace(/^\[[^\]]+\]\s*/, '') : undefined)
      ?? CODE_BLURB[f.code]
      ?? f.message
    // JSON, not a delimiter character: a raw separator inside a template literal made
    // this file binary to git once already (see 9dab15d), and a printable one can still
    // collide with the text it separates.
    const key = JSON.stringify([f.code, kind ?? text])
    let g = byKey.get(key)
    if (g === undefined) {
      g = { glyph: '', text, code: f.code, severity: f.severity, findings: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    g.findings.push(f)
  }
  groups.forEach((g, i) => { g.glyph = GLYPHS[i] ?? String.fromCharCode(65 + i) })
  return groups
}

/** The lines a diagnosis renders to — data, so a caller can compose them into a larger
 *  report without going through a string. */
export function diagnosisLines(d: GrammarDiagnosis, opts: DiagnoseRenderOptions = {}): Line[] {
  const limit = opts.limit ?? 20
  const name = opts.name ?? 'grammar'
  const width = opts.width ?? DEFAULT_WIDTH
  const s = d.summary
  const out: Line[] = []

  // SUCCESS IS TWO LINES. It is the rendering people see most, and the one usually
  // neglected into a wall of zero-valued tables.
  if (d.ok && s.unanalysable === 0) {
    const parts = [`${groupDigits(s.gated)}/${groupDigits(s.totalChoices)} choices gate on first char`]
    if (s.recoverable > 0) parts.push(`${groupDigits(s.recoverable)} recoverable`)
    if (s.accepted > 0) parts.push(`${groupDigits(s.accepted)} accepted`)
    if (s.deferred > 0) parts.push(`${groupDigits(s.deferred)} deferred to the fusing artifact`)
    if (s.staleAccepts > 0) parts.push(`${groupDigits(s.staleAccepts)} stale accept line(s) to prune`)
    out.push([t('✓ ', TONE.good), t(name, TONE.strong), t(' — nothing to fix', TONE.good)])
    out.push([t(`  ${parts.join(' · ')}`, TONE.quiet)])
    return out
  }

  // NOTHING WAS EXAMINED. Rendered as its own report, not as the finding report with a
  // warning bolted on. The finding report's every sentence — "N problems", "underlying
  // cause", "fixing one fixes every choice listed under it", "none of this is a
  // correctness bug" — is a claim about defects parseman FOUND, and there are none:
  // there is one blocking finding per rule it could not read. Printed over an opaque
  // artifact that produced `176 problems, 176 failing the check, 1 cause`, which reads
  // as 176 discovered defects and means the tool inspected zero choices.
  if (examinedNothing(d)) return unexaminedLines(d, name, width, limit)

  const groups = groupByCause(d.findings)
  const blocking = d.findings.filter(f => f.severity === 'blocking')
  /** Findings that are things parseman FOUND — never the rules it could not read. */
  const problems = d.findings.length - s.unanalysable

  out.push([
    t('✗ ', TONE.loud),
    t(name, TONE.strong),
    t(' — ', TONE.quiet),
    // `findings` and `totalChoices` count different things — an anti-pattern is a
    // finding about an ARM, not a choice — so they must not be phrased as a ratio. They
    // were, and a two-arm grammar reported "3 of 1 choices".
    //
    // `unanalysable` is excluded from the problem count on purpose: it is not something
    // parseman FOUND in the grammar, it is a rule parseman could not look at. Counting
    // the two together is what let a report that inspected nothing print a confident
    // problem tally. It is stated separately, on the PARTIAL line below.
    t(`${groupDigits(problems)} problem${problems === 1 ? '' : 's'} `
      + `in ${groupDigits(s.totalChoices)} choice${s.totalChoices === 1 ? '' : 's'}`, TONE.loud),
  ])
  out.push([
    t('  '),
    t(`${groupDigits(groups.length)} underlying cause${groups.length === 1 ? '' : 's'}`, TONE.strong),
    t(groups.length < d.findings.length ? '; fixing one fixes every choice listed under it.' : '.', TONE.quiet),
  ])
  for (const l of wrap(
    (s.gated > 0
      ? `${groupDigits(s.gated)} other choice${s.gated === 1 ? '' : 's'} already pick the right `
        + 'alternative straight from the next character. '
      : '')
    + 'None of this is a correctness bug — the grammar parses the same either way; it is work '
    + 'the parser does and did not need to.',
    width - 2, '  ')) out.push([t(l, TONE.faint)])
  // Unanalysable is called out at the top as well as in its group: "no findings" over a
  // grammar that was never walked is precisely the failure being reported.
  if (s.unanalysable > 0) {
    out.push([t(`  PARTIAL — ${groupDigits(s.unanalysable)} rule(s) could not be examined; `
      + 'an empty list below does NOT mean the grammar is clean.', TONE.warn)])
  }

  // ONE definition of the only term of art that survives, placed immediately before the
  // first table that uses it. A reader meets `arm` here and nowhere earlier.
  let defined = false

  let shown = 0
  for (const g of groups) {
    const tone: Tone = g.severity === 'blocking' ? TONE.bad : TONE.warn
    out.push(blank())
    out.push(rule(width, TONE.frame))
    const fixableHere = g.findings.filter(f => opts.fixable?.has(f.id) === true).length
    out.push([
      t(` ${g.glyph} `, tone),
      t(`${groupDigits(g.findings.length)} `
        + `${g.findings.length === 1 ? CODE_LABEL[g.code]?.one ?? g.code : CODE_LABEL[g.code]?.many ?? g.code}`,
      TONE.strong),
      t(g.severity === 'blocking' ? '   fails the check' : '   worth knowing', TONE.faint),
    ])
    for (const l of wrap(g.text, width - 6, '')) out.push([t('    '), t(l, TONE.quiet)])
    if (!defined) {
      defined = true
      out.push(blank())
      out.push([t('    Each numbered line below is one alternative of a choice — an "arm" — in the',
        TONE.faint)])
      out.push([t('    order the parser tries them.', TONE.faint)])
    }
    out.push(blank())

    // ONE site per cause is expanded — its full arm ordering, and the corpus frame that
    // illustrates the cause. The rest are a table: the same shape repeated thirteen
    // times is what made the first version unreadable, and a reader who needs another
    // site's ordering asks for it by id. `--limit` still governs how many are listed.
    // +2 so the longest cell in a column still has a gap after it. Without it the
    // widest row runs its term straight into the annotation, which is exactly the kind
    // of ragged table this pass exists to remove.
    const idW = Math.min(30, Math.max(...g.findings.map(f => f.id.length))) + 2
    const headW = Math.min(34, Math.max(...g.findings.map(f => headlineOf(f, opts).term.length))) + 2
    let expanded = false
    for (const f of g.findings) {
      if (shown >= limit) break
      shown++
      // Expand only when there IS an ordering to show. An anti-pattern finding names one
      // arm and has no table, so an "expanded" version of it is just a lonelier line.
      if (!expanded && opts.armFirstSets?.get(f.id) !== undefined) {
        expanded = true
        out.push(...siteLines(f, g, opts, true).lines)
        if (g.findings.length > 1) out.push(blank())
        continue
      }
      const h = headlineOf(f, opts)
      out.push([
        t(` ${g.glyph} `, tone),
        t(f.id, TONE.ident, idW),
        t(h.arm, TONE.faint, 8),
        t(h.term, TONE.strong, headW),
        t(h.note, h.loud ? TONE.loud : TONE.faint),
        // LAST, always: the wrench is an emoji and may occupy two terminal columns, so
        // nothing may be aligned after it.
        t(opts.fixable?.has(f.id) === true ? '  🔧 fixable' : '', TONE.good),
      ])
    }
    if (shown >= limit) break
  }

  if (shown < d.findings.length) {
    out.push(blank())
    out.push([t(`  … ${groupDigits(d.findings.length - shown)} more site(s) — `, TONE.quiet),
      t(`--limit ${d.findings.length}`, TONE.strong),
      t(' shows them, --json holds them all', TONE.quiet)])
  }

  // ONE accept line, carrying the whole set. A reader who wants to accept these wants a
  // single pasteable thing, not one line per site saying the same thing differently.
  if (!d.ok && d.acceptSnapshot.length > 0) {
    out.push(blank())
    out.push(rule(width, TONE.frame))
    const snap = `{ accept: [${d.acceptSnapshot.map(i => `'${i}'`).join(', ')}] }`
    out.push([t(' Meant to be this way? Pass this and they stop being reported:', TONE.quiet)])
    for (const l of wrap(snap, width - 3, '')) out.push([t('   '), t(l, TONE.faint)])
  }

  // THE FOOTER, in a linter's shape and for a linter's reason: after a hundred lines the
  // header has scrolled away, and the last thing on screen is what a person actually
  // reads. It carries the tally, the exit code IN WORDS (the number is for the gate, the
  // sentence is for the human) and — only when a rewrite has actually been proved — the
  // exact command that applies it.
  out.push(blank())
  const fixCount = opts.fixable?.size ?? 0
  const parts = [
    `${groupDigits(problems)} problem${problems === 1 ? '' : 's'}`,
    `${groupDigits(blocking.length - s.unanalysable)} failing the check`,
    `${groupDigits(groups.length)} cause${groups.length === 1 ? '' : 's'}`,
    // Never folded into the tally above. A rule that could not be read is a hole in the
    // measurement, and a footer is the last thing a reader sees.
    ...(s.unanalysable > 0 ? [`${groupDigits(s.unanalysable)} rule(s) NOT examined`] : []),
  ]
  out.push([
    t('✗ ', TONE.loud),
    t(parts.join(', '), TONE.strong),
    t(`  ·  exiting 1 (problems found)`, TONE.faint),
  ])
  if (fixCount > 0 && opts.fixCommand !== undefined) {
    out.push([t(' 🔧 ', TONE.good),
      t(`${groupDigits(fixCount)} of them can be fixed automatically. Run:`, TONE.good)])
    for (const l of wrap(opts.fixCommand, width - 6, '')) out.push([t('    '), t(l, TONE.strong)])
    for (const l of wrap('Each change is applied, the parser rebuilt and your files parsed again '
      + 'before it is offered, so nothing is suggested that has not been checked.',
    width - 6, '')) out.push([t('    '), t(l, TONE.faint)])
  }
  return out
}

/** What each `Unanalysable.kind` means and what the reader can do about it. Stated once
 *  per kind, at the head of the group it labels — the same rule the cause groups follow. */
const KIND_BLURB: Record<string, string> = {
  'fused-rule':
    'These rules are compiled functions. Fusion lowers every rule to executable code and '
    + 'discards the combinator graph, so there is nothing left to read.\n'
    + 'To analyse them: point this at the grammar SOURCE, or at a grammar value that still '
    + 'carries its IR (a rules() map, or a compose() result — those keep their pieces).',
  'opaque-artifact':
    'These rules come from a precompiled artifact that carries rule functions rather than '
    + 're-lowerable IR, so its choices cannot be examined.\n'
    + 'To analyse them: recompile the contributing grammar so it carries IR — the macro '
    + 'emits IR by default.',
  'not-a-combinator':
    'The value handed to parseman was not a grammar it knows how to walk.\n'
    + 'To analyse it: pass a combinator, a rules() map, a compose() result, or name the '
    + 'export that holds one with --export.',
}

/**
 * The report for a run that examined NOTHING.
 *
 * Deliberately not the finding report with a banner on top. Everything that report says
 * is a claim about defects found — the tally, the "underlying cause", the "fixing one
 * fixes every choice listed under it", the "none of this is a correctness bug". None of
 * it is true here, and printed together they read as a confident audit of a grammar the
 * tool never opened.
 */
function unexaminedLines(
  d: GrammarDiagnosis, name: string, width: number, limit: number,
): Line[] {
  const out: Line[] = []
  const items = d.gating.unanalysable
  out.push([t('✗ ', TONE.loud), t(name, TONE.strong), t(' — ', TONE.quiet),
    t('COULD NOT ANALYSE', TONE.loud)])
  out.push([t(`  0 choices examined · ${groupDigits(items.length)} `
    + `rule${items.length === 1 ? '' : 's'} unreadable`, TONE.warn)])
  for (const l of wrap(
    'parseman has NO verdict about this grammar — not "clean", not "problems". Every line '
    + 'below is a rule it could not read, not a defect it found.',
    width - 2, '  ')) out.push([t(l, TONE.faint)])

  // Grouped by KIND: the kind is what a reader acts on, and one artifact usually
  // contributes hundreds of rules for one reason.
  const byKind = new Map<string, typeof items[number][]>()
  for (const u of items) {
    const g = byKind.get(u.kind)
    if (g === undefined) byKind.set(u.kind, [u])
    else g.push(u)
  }
  let shown = 0
  for (const [kind, group] of byKind) {
    out.push(blank())
    out.push(rule(width, TONE.frame))
    out.push([
      t(' ■ ', TONE.warn),
      t(`${groupDigits(group.length)} rule${group.length === 1 ? '' : 's'} could not be read`, TONE.strong),
      t(`   [${kind}]`, TONE.faint),
    ])
    for (const l of wrap(KIND_BLURB[kind] ?? group[0]!.reason, width - 6, '')) {
      out.push([t('    '), t(l, TONE.quiet)])
    }
    out.push(blank())
    for (const u of group) {
      if (shown >= limit) break
      shown++
      out.push([t('   '), t(u.rule, TONE.ident)])
    }
    if (shown >= limit) break
  }
  if (shown < items.length) {
    out.push(blank())
    out.push([t(`  … ${groupDigits(items.length - shown)} more — `, TONE.quiet),
      t(`--limit ${items.length}`, TONE.strong), t(' shows them, --json holds them all', TONE.quiet)])
  }

  out.push(blank())
  // The exit code IN WORDS, and it is 2 — not 1. 1 means "measured, and it failed";
  // this run did not measure. See the CLI's exit-code contract.
  out.push([t('✗ ', TONE.loud),
    t(`could not analyse — 0 of ${groupDigits(items.length)} rule(s) examined`, TONE.strong),
    t('  ·  exiting 2 (analysis did not run)', TONE.faint)])
  return out
}

export function renderDiagnosis(d: GrammarDiagnosis, opts: DiagnoseRenderOptions = {}): string {
  return render(diagnosisLines(d, opts), opts)
}

/**
 * The one arm a site is about, for the compact table rows.
 *
 * A reader scanning a group needs the site's NAME and the term that poisons it; the full
 * ordering only matters once they start editing that rule, and the expanded exemplar
 * above shows what that ordering looks like for this cause.
 */
function headlineOf(f: DiagnosisFinding, opts: DiagnoseRenderOptions): {
  arm: string; term: string; note: string; loud: boolean
} {
  const sets = opts.armFirstSets?.get(f.id)
  const labels = opts.armLabels?.get(f.id)
  const cost = opts.cost?.get(f.id)
  const anyIdx = sets?.findIndex(x => x === 'ANY') ?? -1
  if (anyIdx >= 0) {
    const c = cost?.arms[anyIdx]
    return {
      arm: `arm ${anyIdx}`,
      term: (labels?.[anyIdx] ?? '').slice(0, 34),
      note: c === undefined
        ? 'any character — never skippable'
        : `same — tried at all ${groupDigits(c.positions)}`,
      loud: true,
    }
  }
  const overlap = f.details.map(d => d.split('\n')[0]!).find(x => x.includes('overlap on'))
  if (overlap !== undefined) {
    const m = /arm\[(\d+)\] ∩ arm\[(\d+)\] overlap on (.*)$/.exec(overlap)
    if (m !== null) {
      return { arm: `arm ${m[1]}`, term: `and arm ${m[2]}`, note: `can both start with ${m[3]}`, loud: false }
    }
  }
  const m = /^(.*)#arm(\d+)$/.exec(f.id)
  if (m !== null) {
    // The specific thing found at THIS site — the word, from the finding's own message.
    const word = /`([^`]+)`/.exec(f.message)?.[1]
    return { arm: `arm ${m[2]}`, term: `of ${m[1]}`, note: word === undefined ? '' : `matches \`${word}\``, loud: false }
  }
  return { arm: '', term: '', note: f.message.split('\n')[0]!.slice(0, 40), loud: false }
}

/** One site under its cause: the arm ordering, and nothing the group already said. */
function siteLines(
  f: DiagnosisFinding,
  g: CauseGroup,
  opts: DiagnoseRenderOptions,
  wantFrame: boolean,
): { lines: Line[]; framed: boolean } {
  const out: Line[] = []
  const cost = opts.cost?.get(f.id)
  const sets = opts.armFirstSets?.get(f.id)
  const labels = opts.armLabels?.get(f.id)
  let framed = false

  out.push([
    t(` ${g.glyph} `, f.severity === 'blocking' ? TONE.bad : TONE.warn),
    t(f.id, TONE.ident),
    t(cost === undefined
      ? ''
      : `  —  reached at ${groupDigits(cost.positions)} places in your corpus`,
    TONE.faint),
    t(suggestionsOf(f).length > 1 ? '  (+ another cause)' : '', TONE.warn),
    t(opts.fixable?.has(f.id) === true ? '  🔧 fixable' : '', TONE.good),
  ])

  // WORLD 1 — the grammar site: the ordering, one column per meaning. This is the part
  // worth keeping per site; everything that used to surround it was the repetition.
  if (sets !== undefined) {
    const lw = Math.min(26, Math.max(8, ...(labels ?? ['']).map(l => l.length)))
    sets.forEach((fs, i) => {
      const armCost = cost?.arms[i]
      const any = fs === 'ANY'
      // Every column says what it MEANS. `'('` and `ANY` were the model's vocabulary,
      // not a sentence: a reader had to already know what a first-set was to read them.
      const starts = startsWithPhrase(fs)
      const note = armCost === undefined
        ? ''
        : any
          ? `→ tried at all ${groupDigits(cost!.positions)}`
          : `→ could match at ${groupDigits(armCost.positions)}`
      out.push([
        t('     ', undefined),
        t(`arm ${pad(String(i), 2)}`, any ? TONE.bad : TONE.faint, 8),
        t(' '),
        t((labels?.[i] ?? '').slice(0, lw), any ? TONE.strong : TONE.quiet, lw),
        t(' '),
        t(starts, any ? TONE.loud : TONE.quiet, 29),
        t(note, any ? TONE.loud : TONE.faint),
      ])
    })
  }
  // THE CONSEQUENCE, spelled out. The table above is an observation; this is why the
  // reader should care, and it is the entire point of the tool.
  if (sets !== undefined && cost !== undefined) {
    const anyIdx = sets.findIndex(x => x === 'ANY')
    if (anyIdx >= 0) {
      for (const l of wrap(
        `Because arm ${anyIdx} can begin with any character, no single-character test can rule it `
        + `out. At all ${groupDigits(cost.positions)} of those places the parser has to enter it — set `
        + 'up, try, undo — instead of skipping it for nothing.',
        (opts.width ?? DEFAULT_WIDTH) - 7, '')) out.push([t('     '), t(l, TONE.quiet)])
    }
  }

  // Overlaps name a PAIR, which the arm table alone does not show.
  for (const detail of f.details) {
    const first = detail.split('\n')[0]!
    if (first.includes('overlap on')) {
      const m = /arm\[(\d+)\] ∩ arm\[(\d+)\] overlap on (.*)$/.exec(first)
      const text = m === null
        ? first
        : `arm ${m[1]} and arm ${m[2]} can both start with ${m[3]}, so that character cannot tell `
          + 'the parser which to try'
      for (const l of wrap(text, (opts.width ?? DEFAULT_WIDTH) - 7, '')) out.push([t('     '), t(l, TONE.warn)])
    }
    else if (sets === undefined && !detail.includes('\nfix: ')) {
      for (const l of wrap(first, (opts.width ?? DEFAULT_WIDTH) - 6, '')) out.push([t('     '), t(l)])
    }
  }

  // WORLD 2 — the input that pays for it, drawn once per cause. Point at a place a REAL
  // arm wants, not at byte 0: an ANY arm's "first site" is always the first character of
  // the corpus, which tells the reader nothing.
  if (wantFrame && cost !== undefined) {
    const broad = cost.arms.find(a => a.any)
    const concrete = cost.arms.find(a => !a.any && a.firstSite !== undefined)
    const site = (concrete ?? cost.arms.find(a => a.firstSite !== undefined))?.firstSite
    if (site !== undefined) {
      out.push(...codeFrame({
        path: site.sample,
        fullPath: opts.corpusRoot === undefined ? site.sample : `${opts.corpusRoot}/${site.sample}`,
        line: site.line,
        column: site.column,
        lineText: site.lineText.replace(/\t/g, ' '),
        message: broad === undefined
          ? 'one of those places in your corpus'
          : `one of the ${groupDigits(cost.positions)} places, in your own input`,
        shortMessage: broad !== undefined && concrete !== undefined
          ? `arm ${concrete.index} matches here; arm ${broad.index} is entered first anyway`
          : 'the first place in your corpus this choice is reached',
        type: 'warning',
      }, opts, '     '))
      framed = true
    }
  }
  return { lines: out, framed }
}
