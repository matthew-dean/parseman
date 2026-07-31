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
 *     arm 0  regex(/[^;{]+/)          ANY        ← entered at all 1,204 positions
 *     arm 1  word('screen')           's'
 *
 * — nobody reading that needs a paragraph telling them arm 0 is the problem.
 *
 * SHORT ON SUCCESS
 * ----------------
 * A clean grammar renders in two lines. This matters more than the failure rendering,
 * because it is what people see most, and because parseman has already learned the
 * lesson the expensive way: importing one example grammar used to print ~51 lines of
 * correct, detailed, unread gating advice. Volume is the enemy of readability.
 *
 * DETERMINISM BINDS THE RENDERING
 * -------------------------------
 * Stable ordering (the report's own), no timings, no dates, no absolute paths, and
 * colour is an explicit option rather than sniffed from `isTTY` — a renderer whose bytes
 * depend on where it is piped cannot be diffed or snapshotted. The CLI decides colour;
 * this function only obeys.
 */
import type { GrammarDiagnosis, DiagnosisFinding } from './diagnose.ts'
import type { ChoiceCorpusCost } from './corpus.ts'

export type DiagnoseRenderOptions = {
  /** ANSI colour. Default false — never auto-detected here. */
  color?: boolean
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
}

const ANSI = {
  dim: '\u001b[2m', bold: '\u001b[1m', red: '\u001b[31m',
  green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m', reset: '\u001b[0m',
} as const

type Paint = (code: keyof typeof ANSI, s: string) => string
const painter = (on: boolean): Paint => (code, s) => (on ? `${ANSI[code]}${s}${ANSI.reset}` : s)

/** Deterministic thousands grouping — `toLocaleString()` differs between machines. */
export function groupDigits(n: number): string {
  const s = String(Math.trunc(Math.abs(n)))
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ','
    out += s[i]
  }
  return (n < 0 ? '-' : '') + out
}

const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length))

/** Hard-wrap on spaces at `width`, prefixing every line with `indent`. */
function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(w => w !== '')) {
      if (line === '') line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else { out.push(indent + line); line = word }
    }
    out.push(indent + line)
  }
  return out
}

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
  // Stop at the first sentence break that is not inside a code span like `keywords([...])`.
  // Prefer a full stop. A semicolon only ends the instruction when there is no
  // sentence at all — cutting `…at fuse time; if still ANY…` at the semicolon leaves
  // an instruction that stops before it says what to do.
  // A full stop, or nothing. Cutting at a semicolon leaves `…at fuse time;` — an
  // instruction that stops before it says what to do. When there is no sentence
  // boundary the whole note is short enough to print, and then there is no note to
  // defer: `firstSentence(x) === x` is the renderer's signal not to add a marker.
  const m = /^(.*?[a-z)\]'][.])\s/.exec(s)
  return (m?.[1] ?? s).trim()
}

export function renderDiagnosis(d: GrammarDiagnosis, opts: DiagnoseRenderOptions = {}): string {
  const c = painter(opts.color === true)
  const limit = opts.limit ?? 20
  const name = opts.name ?? 'grammar'
  const s = d.summary
  const out: string[] = []

  // SUCCESS IS TWO LINES. It is the rendering people see most, and the one usually
  // neglected into a wall of zero-valued tables.
  if (d.ok && s.unanalysable === 0) {
    const parts = [`${groupDigits(s.gated)}/${groupDigits(s.totalChoices)} choices gate on first char`]
    if (s.recoverable > 0) parts.push(`${groupDigits(s.recoverable)} recoverable`)
    if (s.accepted > 0) parts.push(`${groupDigits(s.accepted)} accepted`)
    if (s.deferred > 0) parts.push(`${groupDigits(s.deferred)} deferred to the fusing artifact`)
    if (s.staleAccepts > 0) parts.push(`${groupDigits(s.staleAccepts)} stale accept line(s) to prune`)
    out.push(`${c('green', '✓')} ${c('bold', name)} — nothing to fix`)
    out.push(c('dim', `  ${parts.join(' · ')}`))
    return out.join('\n')
  }

  const blocking = d.findings.filter(f => f.severity === 'blocking')
  out.push(
    `${c('red', '✗')} ${c('bold', name)} — ${groupDigits(blocking.length)} blocking finding${blocking.length === 1 ? '' : 's'}`
    + ` over ${groupDigits(s.totalChoices)} choice${s.totalChoices === 1 ? '' : 's'}`
    + c('dim', ` (${groupDigits(s.gated)} gate, ${groupDigits(s.recoverable)} recoverable)`),
  )
  // Unanalysable FIRST and unconditionally: "no findings" over a grammar that was never
  // walked is precisely the failure being reported, and must not read as a clean bill.
  if (s.unanalysable > 0) {
    out.push(c('yellow', `  PARTIAL — ${groupDigits(s.unanalysable)} rule(s) could not be examined.`
      + ' An empty finding list below does NOT mean the grammar is clean.'))
  }

  // Notes are collected while rendering and printed once at the end, keyed A, B, C… in
  // first-encounter order (the report's order, so this stays deterministic).
  const notes: string[] = []
  const noteId = (text: string): string => {
    let i = notes.indexOf(text)
    if (i === -1) { notes.push(text); i = notes.length - 1 }
    return String.fromCharCode(65 + i)
  }

  const shown = d.findings.slice(0, limit)
  let lastCode = ''
  for (const f of shown) {
    if (f.code !== lastCode) {
      lastCode = f.code
      const n = d.findings.filter(x => x.code === f.code).length
      const h = CODE_HEADLINE[f.code]
      out.push('')
      out.push(`${f.severity === 'blocking' ? c('red', '✗') : c('dim', '·')} ${c('bold', `${groupDigits(n)} ${h?.title ?? f.code.toUpperCase()}${n === 1 ? '' : 'S'}`)}`)
      if (h !== undefined) out.push(...wrap(h.blurb, WIDTH, '  ').map(l => c('dim', l)))
    }
    out.push('')
    out.push(...renderFinding(f, c, opts, noteId))
  }
  if (d.findings.length > limit) {
    out.push('')
    out.push(c('dim', `  … ${groupDigits(d.findings.length - limit)} more finding(s); --limit ${d.findings.length} shows them, --json holds them all`))
  }

  if (notes.length > 0) {
    out.push('')
    out.push(c('bold', 'notes'))
    notes.forEach((text, i) => {
      const lines = wrap(text, WIDTH - 5, '')
      out.push(`  ${c('bold', String.fromCharCode(65 + i))}  ${lines[0] ?? ''}`)
      for (const l of lines.slice(1)) out.push(`     ${l}`)
    })
  }

  if (!d.ok && d.acceptSnapshot.length > 0) {
    out.push('')
    out.push(c('dim', '  all intentional? paste this and the gate goes green:'))
    out.push(c('dim', `    { accept: [${d.acceptSnapshot.map(i => `'${i}'`).join(', ')}] }`))
  }
  return out.join('\n')
}

function renderFinding(
  f: DiagnosisFinding,
  c: Paint,
  opts: DiagnoseRenderOptions,
  noteId: (text: string) => string,
): string[] {
  const out: string[] = []
  const cost = opts.cost?.get(f.id)
  const sets = opts.armFirstSets?.get(f.id)
  const labels = opts.armLabels?.get(f.id)

  out.push(`  ${c('cyan', f.rule === f.id ? f.id : f.id)}${cost === undefined ? '' : c('dim', `   ${groupDigits(cost.positions)} corpus positions can enter it`)}`)

  // WORLD 1 — the grammar site: the ordering, with each arm's dispatch key beside it.
  // Padding happens BEFORE colour, or the escape bytes count toward the column width.
  if (sets !== undefined) {
    const lw = Math.min(30, Math.max(6, ...(labels ?? ['']).map(l => l.length)))
    sets.forEach((fs, i) => {
      const armCost = cost?.arms[i]
      const key = fs === 'ANY' ? c('red', pad('ANY', 14)) : pad(fs.length > 14 ? `${fs.slice(0, 13)}…` : fs, 14)
      const note = fs === 'ANY'
        ? c('red', armCost === undefined ? '← nothing excludes this arm' : `← entered at all ${groupDigits(armCost.positions)}`)
        : armCost === undefined ? '' : c('dim', `${groupDigits(armCost.positions)} pos`)
      out.push(`      ${c('dim', `arm ${pad(String(i), 2)}`)} ${pad((labels?.[i] ?? '').slice(0, lw), lw)} ${key} ${note}`.trimEnd())
    })
  }

  // WORLD 2 — the input that pays for it, located exactly. Stated as what it is: a
  // character count, an upper bound on entries, never "this choice ran N times".
  if (cost !== undefined) {
    // Point at a place a REAL arm wants, not at byte 0. An ANY arm's "first site" is
    // always the first character of the corpus, which tells the reader nothing; the
    // first position a FINITE arm can start on is the position whose cost is the
    // finding — that arm is what should run there, and the broad arm runs first.
    const broad = cost.arms.find(a => a.any)
    const concrete = cost.arms.find(a => !a.any && a.firstSite !== undefined)
    const shown = concrete ?? cost.arms.find(a => a.firstSite !== undefined)
    if (shown?.firstSite !== undefined) {
      const site = shown.firstSite
      const why = broad !== undefined && concrete !== undefined
        ? `arm ${concrete.index} can start here; arm ${broad.index} is entered first`
        : `first input arm ${shown.index} can start on`
      out.push(`      ${c('dim', `↳ ${site.sample}:${site.line}:${site.column}`)}  ${c('dim', why)}`)
      out.push(`         ${site.lineText.replace(/\t/g, ' ').slice(0, 68)}`)
      out.push(`         ${' '.repeat(Math.max(0, Math.min(68, site.column - 1)))}${c('red', '^')}`)
    }
  }

  // Every arm-level line first, then ONE `do` per distinct instruction. A choice with
  // four overlapping pairs used to print the same left-factoring sentence four times,
  // which is how a correct diagnostic turns into something skimmed past.
  const instructions: string[] = []
  for (const detail of f.details) {
    const [head, ...rest] = detail.split('\nfix: ')
    if (sets === undefined) out.push(...wrap(head!, WIDTH, '      '))
    else if (head!.includes('overlap on')) out.push(`      ${c('yellow', head!.split('\n')[0]!)}`)
    if (rest.length > 0) {
      const full = rest.join(' ')
      if (!instructions.includes(full)) instructions.push(full)
    }
  }
  for (const full of instructions) {
    const one = firstSentence(full)
    const lines = wrap(one === full ? one : `${one} [${noteId(full)}]`, WIDTH - 8, '')
    out.push(`    ${c('bold', 'do')}  ${lines[0] ?? ''}`)
    for (const l of lines.slice(1)) out.push(`        ${l}`)
  }
  if (f.acceptKey !== undefined) {
    out.push(c('dim', `    ok as-is? { accept: ['${f.acceptKey}'] }`))
  }
  return out
}
