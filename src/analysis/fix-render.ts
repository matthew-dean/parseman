/**
 * The human layer over `FixReport`.
 *
 * The claim this rendering has to carry is unusual, so it is made explicitly and never
 * by implication: a fix shown here was APPLIED to the grammar, the grammar was
 * RECOMPILED, the corpus was RE-PARSED, and the output did not move. Every offered
 * rewrite prints that evidence next to it, with the sample and byte counts, because
 * "proven" without a corpus size is a word, not a fact.
 *
 * The diff is the primary interface. `--apply` writing to a file is a second, explicit
 * step; what a reader gets by default is what would change, in the form they would read
 * it in a review.
 *
 * TWO STATES, MADE VISUALLY DISTINCT
 * ----------------------------------
 * ACTIONABLE and LOCATED are the whole model, and in the first cut they were two words
 * in the same colour — which is to say, not a distinction at all until you read them.
 * They now differ in glyph, colour and weight, so a reader triages the report by
 * scanning the left margin rather than by parsing it. LOCATED prints the REASON and
 * never advice: a site that cannot be rewritten is still worth knowing about, and that
 * is the difference between "here is exactly where the problem is" and silence.
 *
 * Like `diagnose-render.ts`, this emits LINES OF SPANS and never an escape byte;
 * `terminal.ts` owns every interaction with a terminal.
 */
import type { FixReport, VerifiedFix, LocatedFinding } from './fix.ts'
import {
  DEFAULT_WIDTH, TONE, blank, codeFrame, groupDigits, render, rule, t, wrap,
  type Line, type RenderTarget,
} from './terminal.ts'

export type FixRenderOptions = RenderTarget & {
  name?: string
  /**
   * How many edits were WRITTEN to disk. A count, not a flag: `applyFixEdits` skips an
   * edit whose span moved under it, so a run can write some of `r.verified` and skip the
   * rest. A boolean here made the report say every verified change had been written
   * whenever any one of them had been — the one number a reader checks after `--apply`,
   * wrong in exactly the case that matters. Absent (or 0) means nothing was written.
   */
  applied?: number
  /** Absolute path of the edited source, used ONLY for the frame's terminal hyperlink. */
  sourceRoot?: string
}

export function fixReportLines(r: FixReport, opts: FixRenderOptions = {}): Line[] {
  const name = opts.name ?? 'grammar'
  const width = opts.width ?? DEFAULT_WIDTH
  const out: Line[] = []

  if (!r.ok) {
    out.push([t('✗ ', TONE.loud), t(name, TONE.strong),
      t(' — nothing can be offered, because nothing could be checked', TONE.bad)])
    for (const l of wrap(r.blocked ?? 'the verification loop could not run', width - 4, '  ')) out.push([t(l)])
    out.push([t('  parseman only offers a change after it has applied it, rebuilt the parser and', TONE.quiet)])
    out.push([t('  confirmed your files still parse to exactly the same thing. It could not do that', TONE.quiet)])
    out.push([t('  here, so it is offering nothing rather than guessing.', TONE.quiet)])
    return out
  }

  const engines = r.engines.join(' + ')
  if (r.verified.length === 0 && r.located.length === 0) {
    out.push([t('✓ ', TONE.good), t(name, TONE.strong), t(' — nothing here can be rewritten', TONE.good)])
    out.push([t(`  Checked against ${groupDigits(r.corpus.samples)} of your files `
      + `(${groupDigits(r.corpus.bytes)} bytes). No change parseman knows how to make applies here.`,
    TONE.quiet)])
    return out
  }

  // A count of edits actually written, and whether that is all of them. `skipped > 0` is
  // the partial case: `applyFixEdits` declined an edit whose span no longer matched.
  const written = opts.applied ?? 0
  const wrote = written > 0
  const skipped = wrote ? r.verified.length - written : 0
  out.push([
    t(wrote ? '✓ ' : '● ', wrote ? TONE.good : TONE.warn),
    t(name, TONE.strong),
    t(' — ', TONE.quiet),
    t(`${groupDigits(r.verified.length)} change${r.verified.length === 1 ? '' : 's'} that `
      + `${r.verified.length === 1 ? 'is' : 'are'} safe to make`, TONE.good),
    t(r.located.length > 0
      ? `, ${groupDigits(r.located.length)} place${r.located.length === 1 ? '' : 's'} that `
        + `${r.located.length === 1 ? 'needs' : 'need'} you`
      : '', TONE.warn),
  ])
  for (const l of wrap(
    `Every change below was applied, the parser rebuilt, and your ${groupDigits(r.corpus.samples)} `
    + `file${r.corpus.samples === 1 ? '' : 's'} (${groupDigits(r.corpus.bytes)} bytes) parsed again with `
    + `${engines === 'interpreted + compiled' ? 'both engines' : engines} — the result was identical `
    + 'every time. A change that altered the result was thrown away and is not shown.',
    width - 2, '  ')) out.push([t(l, TONE.faint)])
  if (!wrote && r.verified.length > 0) {
    out.push([t('  Nothing has been written. Add ', TONE.quiet),
      t('--apply', TONE.strong), t(' to make these edits.', TONE.quiet)])
  }

  for (const f of r.verified) out.push(...verifiedLines(f, opts))
  for (const l of r.located) out.push(...locatedLines(l, opts))

  if (r.frozen.length > 0) {
    out.push(blank())
    for (const l of wrap(
      `${groupDigits(r.frozen.length)} part(s) of the grammar were left untouched because parseman `
      + 'cannot rebuild them exactly and will not guess: '
      + r.frozen.slice(0, 6).map(f => `${f.rule} (${f.tag})`).join(', ')
      + (r.frozen.length > 6 ? ', …' : ''), width - 2, '  ')) out.push([t(l, TONE.faint)])
  }
  out.push(blank())
  out.push([
    t(wrote ? '✓ ' : '🔧 ', TONE.good),
    t(`${groupDigits(r.verified.length)} safe to apply`, TONE.strong),
    t(r.located.length > 0 ? `, ${groupDigits(r.located.length)} need you` : '', TONE.strong),
    // Name the skipped edits. Silently reporting "written to disk" over a partial write
    // is the failure this count exists to prevent: the reader would go on believing the
    // file holds all of them.
    t(wrote
      ? (skipped > 0
          ? `  ·  ${groupDigits(written)} written to disk, ${groupDigits(skipped)} skipped (the source moved under the edit)`
          : '  ·  written to disk')
      : '  ·  add --apply to make them  ·  exiting 0 (nothing written)', TONE.faint),
  ])
  return out
}

export function renderFixReport(r: FixReport, opts: FixRenderOptions = {}): string {
  return render(fixReportLines(r, opts), opts)
}

function verifiedLines(f: VerifiedFix, opts: FixRenderOptions): Line[] {
  const out: Line[] = []
  const width = opts.width ?? DEFAULT_WIDTH
  const b = f.benefit
  const effects: string[] = []
  if (b.antiPatternsAfter !== b.antiPatternsBefore) {
    // The measured delta, not a hard-coded 1: the rewrite replaces a COMBINATOR, and a
    // combinator shared by several arms removes a finding at each of them.
    const removed = b.antiPatternsBefore - b.antiPatternsAfter
    effects.push(`removes ${groupDigits(removed)} of the ${b.antiPatternsBefore} arms that hide their first character`)
  }
  if (b.ungatedChoicesAfter !== b.ungatedChoicesBefore) {
    effects.push(`${b.ungatedChoicesBefore - b.ungatedChoicesAfter} fewer choice(s) the parser must guess at`)
  }
  if (b.gatedChoicesAfter !== b.gatedChoicesBefore) {
    effects.push(`${b.gatedChoicesAfter - b.gatedChoicesBefore} more choice(s) decided from one character`)
  }
  // The first-set line earns its place only when the set MOVED. Printing `'i' → 'i'`
  // under a heading called "why" is how a diagnostic loses trust.
  if (f.armFirstSetBefore !== f.armFirstSetAfter) {
    effects.push(`arm ${f.armIndex} now starts with a known character (${f.armFirstSetAfter})`)
  }
  if (f.choiceGatesBefore !== f.choiceGatesAfter) {
    effects.push(`${f.choiceId} can now be decided from the next character alone`)
  }
  const effect = effects.join(' · ')

  out.push(blank())
  out.push(rule(width, TONE.frame))
  out.push([
    t(' 🔧 ', TONE.good),
    t('SAFE TO APPLY', { color: 'green', bold: true }),
    t('  '),
    t(f.id, TONE.ident),
  ])
  // The grammar SOURCE is the world this fix lives in, so it is a frame with the caret
  // under the term being replaced rather than a bare `path:line:col`. The frame's own
  // message carries the measured effect, so no line repeats the heading above it.
  if (f.edit !== undefined) {
    out.push(...codeFrame({
      path: f.edit.path,
      fullPath: opts.sourceRoot ?? f.edit.path,
      line: f.edit.line,
      column: f.edit.column,
      // INCLUSIVE, per linecraft's CodeDebug (`highlightEnd - highlightStart + 1`), so the
      // last underlined column is the last column of `oldText` — not the one after it.
      endColumn: f.edit.column + Math.max(f.edit.oldText.length - 1, 0),
      lineText: f.edit.lineText.replace(/\t/g, ' '),
      message: effect,
      shortMessage: `→ ${f.edit.newText}`,
      type: 'info',
    }, opts, '   '))
  }
  else {
    out.push([t('   - ', TONE.bad), t(f.before, TONE.bad)])
    out.push([t('   + ', TONE.good), t(f.after, TONE.good)])
    out.push([t('   effect  ', TONE.quiet), t(effect, TONE.strong)])
  }
  if (b.artifactBytesBefore !== null && b.artifactBytesAfter !== null && b.artifactBytesAfter !== b.artifactBytesBefore) {
    const d = b.artifactBytesAfter - b.artifactBytesBefore
    out.push([t('   size    ', TONE.faint),
      t(`the generated parser ${d > 0 ? 'grows' : 'shrinks'} by ${groupDigits(Math.abs(d))} bytes`, TONE.faint)])
  }
  const checked = `this exact change was made, the parser rebuilt, and your `
    + `${groupDigits(f.evidence.samples)} file${f.evidence.samples === 1 ? '' : 's'} parsed again — `
    + 'identical result'
  const cl = wrap(checked, width - 12, '')
  out.push([t('   checked ', TONE.quiet), t(cl[0] ?? '', TONE.good)])
  for (const x of cl.slice(1)) out.push([t('           '), t(x, TONE.good)])
  return out
}

function locatedLines(l: LocatedFinding, opts: FixRenderOptions): Line[] {
  const out: Line[] = []
  const width = opts.width ?? DEFAULT_WIDTH
  out.push(blank())
  out.push(rule(width, TONE.frame))
  out.push([
    t(' ✋ ', TONE.warn),
    t('NEEDS YOU', { color: 'yellow', bold: true }),
    t('      '),
    t(l.id, TONE.ident),
  ])
  out.push([t('   here    ', TONE.faint), t(l.site, TONE.quiet)])
  const lines = wrap(`No change can be offered here: ${l.reason}`, width - 12, '')
  out.push([t('   why     ', TONE.quiet), t(lines[0] ?? '', TONE.warn)])
  for (const x of lines.slice(1)) out.push([t('           '), t(x, TONE.warn)])
  return out
}
