/**
 * The human layer over `GrammarDiagnosis`.
 *
 * Three layers, not two: `gating.ts`/`corpus.ts` produce data, `diagnose.ts` decides
 * `ok` (the CI verdict), and this file makes either readable. Nothing here computes a
 * finding and nothing here decides pass or fail. A gate consumes the object; a person
 * reads this. If a number appears below that is not in the report, that is a bug here.
 *
 * WHAT THIS TRIES TO BEAT
 * -----------------------
 * rustc points at one source span and explains it well. A parser generator can do
 * something rustc structurally cannot: show the GRAMMAR site and the INPUT that pays for
 * it, side by side, and put the cost between them so the fix argues for itself. The
 * per-arm block below is the whole idea —
 *
 *     arm 0  regex(/[^;{]+/)   ANY   entered at all 1,204 positions
 *     arm 1  word('screen')    's'
 *
 * — nobody reading that needs a paragraph telling them arm 0 is the problem. The input
 * side is a real linecraft code frame, the same component jess renders compiler errors
 * with, so the caret and the file link look the same in both tools.
 *
 * SHORT ON SUCCESS
 * ----------------
 * A clean grammar renders in two lines. This matters more than the failure rendering,
 * because it is what people see most, and because parseman has already learned the
 * lesson the expensive way: importing one example grammar used to print ~51 lines of
 * correct, detailed, unread gating advice. Volume is the enemy of readability.
 *
 * DETERMINISM
 * -----------
 * This file emits ROWS — text plus a semantic tone — and never an escape byte. Turning
 * rows into terminal output is `terminal.ts`'s job, and the uncoloured form is the rows'
 * own text, so it cannot drift from the styled one. Stable ordering (the report's own),
 * no timings, no dates, no absolute paths.
 */
import type { GrammarDiagnosis, DiagnosisFinding } from './diagnose.ts'
import type { ChoiceCorpusCost } from './corpus.ts'
import {
  TONE, codeFrame, groupDigits, pad, render, row, wrap,
  type RenderTarget, type Row,
} from './terminal.ts'

export type DiagnoseRenderOptions = RenderTarget & {
  /** Grammar label for the header. The CLI passes a cwd-relative path. */
  name?: string
  /** Findings to expand. Default 20; the report always holds all of them. */
  limit?: number
  /** Corpus cost per choice id, from `measureChoiceCost`. */
  cost?: ReadonlyMap<string, ChoiceCorpusCost>
  /** Per-arm first-set renderings per choice id, in arm order. */
  armFirstSets?: ReadonlyMap<string, readonly string[]>
  /** Per-arm leading-term labels per choice id, in arm order. */
  armLabels?: ReadonlyMap<string, readonly string[]>
  /** Absolute corpus root, used ONLY for the frame's terminal hyperlink. */
  corpusRoot?: string
}

export { groupDigits }

const WIDTH = 76

/** The shared explanation for a class of finding, printed ONCE above its sites.
 *  Thirteen copies of the same paragraph is how a correct diagnostic becomes unread. */
const CODE_HEADLINE: Record<string, { title: string; blurb: string }> = {
  'ungated-choice': {
    title: 'UNGATED CHOICE',
    blurb: 'No first-char dispatch. Every position that reaches these choices enters their arms '
      + 'in order until one matches; a gated choice jumps straight to the only arm that can.',
  },
  'anti-pattern': {
    title: 'ANTI-PATTERN',
    blurb: 'An arm is spelled in a way that defeats the analysis parseman would otherwise do for free.',
  },
  unanalysable: {
    title: 'UNANALYSABLE',
    blurb: 'These rules were never walked, so NO verdict about them exists — clean or otherwise.',
  },
  degraded: {
    title: 'DEGRADED',
    blurb: 'The compiler took a correct-but-slower path. Same channel as `[parseman] degraded`.',
  },
  'stale-accept': {
    title: 'STALE ACCEPT',
    blurb: 'These accept entries matched no ungated choice: the grammar was fixed, the line was not.',
  },
}

/** First sentence, for the one-line `do`. The full note is printed once at the end. */
function firstSentence(s: string): string {
  // A full stop, or nothing. Cutting at a semicolon leaves `…at fuse time;` — an
  // instruction that stops before it says what to do. When there is no sentence
  // boundary the whole note is short enough to print, and then there is no note to
  // defer: `firstSentence(x) === x` is the renderer's signal not to add a marker.
  const m = /^(.*?[a-z)\]'][.])\s/.exec(s)
  return (m?.[1] ?? s).trim()
}

/** The rows a diagnosis renders to — data, so a caller can compose them into a larger
 *  report without going through a string. */
export function diagnosisRows(d: GrammarDiagnosis, opts: DiagnoseRenderOptions = {}): Row[] {
  const limit = opts.limit ?? 20
  const name = opts.name ?? 'grammar'
  const s = d.summary
  const out: Row[] = []

  // SUCCESS IS TWO LINES. It is the rendering people see most, and the one usually
  // neglected into a wall of zero-valued tables.
  if (d.ok && s.unanalysable === 0) {
    const parts = [`${groupDigits(s.gated)}/${groupDigits(s.totalChoices)} choices gate on first char`]
    if (s.recoverable > 0) parts.push(`${groupDigits(s.recoverable)} recoverable`)
    if (s.accepted > 0) parts.push(`${groupDigits(s.accepted)} accepted`)
    if (s.deferred > 0) parts.push(`${groupDigits(s.deferred)} deferred to the fusing artifact`)
    if (s.staleAccepts > 0) parts.push(`${groupDigits(s.staleAccepts)} stale accept line(s) to prune`)
    out.push(row(`✓ ${name} — nothing to fix`, TONE.good))
    out.push(row(`  ${parts.join(' · ')}`, TONE.quiet))
    return out
  }

  const blocking = d.findings.filter(f => f.severity === 'blocking')
  out.push(row(
    `✗ ${name} — ${groupDigits(blocking.length)} blocking finding${blocking.length === 1 ? '' : 's'}`
    + ` over ${groupDigits(s.totalChoices)} choice${s.totalChoices === 1 ? '' : 's'}`
    + ` (${groupDigits(s.gated)} gate, ${groupDigits(s.recoverable)} recoverable)`,
    TONE.bad,
  ))
  // Unanalysable FIRST and unconditionally: "no findings" over a grammar that was never
  // walked is precisely the failure being reported, and must not read as a clean bill.
  if (s.unanalysable > 0) {
    out.push(row(`  PARTIAL — ${groupDigits(s.unanalysable)} rule(s) could not be examined.`
      + ' An empty finding list below does NOT mean the grammar is clean.', TONE.warn))
  }

  // Notes are collected while rendering and printed once at the end, keyed A, B, C… in
  // first-encounter order (the report's order, so this stays deterministic).
  const notes: string[] = []
  const noteId = (text: string): string => {
    let i = notes.indexOf(text)
    if (i === -1) { notes.push(text); i = notes.length - 1 }
    return String.fromCharCode(65 + i)
  }

  let lastCode = ''
  for (const f of d.findings.slice(0, limit)) {
    if (f.code !== lastCode) {
      lastCode = f.code
      const n = d.findings.filter(x => x.code === f.code).length
      const h = CODE_HEADLINE[f.code]
      out.push(row(''))
      out.push(row(
        `${f.severity === 'blocking' ? '✗' : '·'} ${groupDigits(n)} ${h?.title ?? f.code.toUpperCase()}${n === 1 ? '' : 'S'}`,
        f.severity === 'blocking' ? { color: 'red', bold: true } : TONE.strong,
      ))
      if (h !== undefined) for (const l of wrap(h.blurb, WIDTH, '  ')) out.push(row(l, TONE.quiet))
    }
    out.push(row(''))
    out.push(...findingRows(f, opts, noteId))
  }
  if (d.findings.length > limit) {
    out.push(row(''))
    out.push(row(`  … ${groupDigits(d.findings.length - limit)} more finding(s); `
      + `--limit ${d.findings.length} shows them, --json holds them all`, TONE.quiet))
  }

  if (notes.length > 0) {
    out.push(row(''))
    out.push(row('notes', TONE.strong))
    notes.forEach((text, i) => {
      const lines = wrap(text, WIDTH - 5, '')
      out.push(row(`  ${String.fromCharCode(65 + i)}  ${lines[0] ?? ''}`))
      for (const l of lines.slice(1)) out.push(row(`     ${l}`))
    })
  }

  if (!d.ok && d.acceptSnapshot.length > 0) {
    out.push(row(''))
    out.push(row('  all intentional? paste this and the gate goes green:', TONE.quiet))
    out.push(row(`    { accept: [${d.acceptSnapshot.map(i => `'${i}'`).join(', ')}] }`, TONE.quiet))
  }
  return out
}

export function renderDiagnosis(d: GrammarDiagnosis, opts: DiagnoseRenderOptions = {}): string {
  return render(diagnosisRows(d, opts), opts)
}

function findingRows(
  f: DiagnosisFinding,
  opts: DiagnoseRenderOptions,
  noteId: (text: string) => string,
): Row[] {
  const out: Row[] = []
  const cost = opts.cost?.get(f.id)
  const sets = opts.armFirstSets?.get(f.id)
  const labels = opts.armLabels?.get(f.id)

  out.push(row(
    `  ${f.id}${cost === undefined ? '' : `   ${groupDigits(cost.positions)} corpus positions can enter it`}`,
    TONE.ident,
  ))

  // WORLD 1 — the grammar site: the ordering, with each arm's dispatch key beside it.
  // The BROAD arm is styled as a whole row rather than having one word coloured inside
  // it: a linecraft row carries one style, and the row IS the finding anyway.
  if (sets !== undefined) {
    const lw = Math.min(30, Math.max(6, ...(labels ?? ['']).map(l => l.length)))
    sets.forEach((fs, i) => {
      const armCost = cost?.arms[i]
      const key = fs.length > 14 ? `${fs.slice(0, 13)}…` : fs
      const note = fs === 'ANY'
        ? (armCost === undefined ? 'nothing excludes this arm' : `entered at all ${groupDigits(armCost.positions)}`)
        : armCost === undefined ? '' : `${groupDigits(armCost.positions)} pos`
      out.push(row(
        `      arm ${pad(String(i), 2)} ${pad((labels?.[i] ?? '').slice(0, lw), lw)} ${pad(key, 14)} ${note}`.trimEnd(),
        fs === 'ANY' ? TONE.bad : TONE.quiet,
      ))
    })
  }

  // WORLD 2 — the input that pays for it, as a real source frame with the caret under
  // the position. Point at a place a REAL arm wants, not at byte 0: an ANY arm's "first
  // site" is always the first character of the corpus, which tells the reader nothing.
  if (cost !== undefined) {
    const broad = cost.arms.find(a => a.any)
    const concrete = cost.arms.find(a => !a.any && a.firstSite !== undefined)
    const shown = concrete ?? cost.arms.find(a => a.firstSite !== undefined)
    if (shown?.firstSite !== undefined) {
      const site = shown.firstSite
      const short = broad !== undefined && concrete !== undefined
        ? `arm ${concrete.index} can start here; arm ${broad.index} is entered first`
        : `first input arm ${shown.index} can start on`
      out.push(...codeFrame({
        path: site.sample,
        fullPath: opts.corpusRoot === undefined ? site.sample : `${opts.corpusRoot}/${site.sample}`,
        line: site.line,
        column: site.column,
        lineText: site.lineText.replace(/\t/g, ' '),
        message: cost.arms.filter(a => a.any).length > 0
          ? `arm ${broad!.index} has an ANY first set — entered at all ${groupDigits(cost.positions)} of these positions`
          : `${groupDigits(cost.positions)} corpus positions can enter this choice`,
        shortMessage: short,
        type: 'warning',
      }, opts, '  '))
    }
  }

  // Every arm-level line first, then ONE `do` per distinct instruction. A choice with
  // four overlapping pairs used to print the same left-factoring sentence four times,
  // which is how a correct diagnostic turns into something skimmed past.
  const instructions: string[] = []
  for (const detail of f.details) {
    const [head, ...rest] = detail.split('\nfix: ')
    if (sets === undefined) for (const l of wrap(head!, WIDTH, '      ')) out.push(row(l))
    else if (head!.includes('overlap on')) out.push(row(`      ${head!.split('\n')[0]!}`, TONE.warn))
    if (rest.length > 0) {
      const full = rest.join(' ')
      if (!instructions.includes(full)) instructions.push(full)
    }
  }
  for (const full of instructions) {
    const one = firstSentence(full)
    const lines = wrap(one === full ? one : `${one} [${noteId(full)}]`, WIDTH - 8, '')
    out.push(row(`    do  ${lines[0] ?? ''}`))
    for (const l of lines.slice(1)) out.push(row(`        ${l}`))
  }
  if (f.acceptKey !== undefined) {
    out.push(row(`    ok as-is? { accept: ['${f.acceptKey}'] }`, TONE.quiet))
  }
  return out
}
