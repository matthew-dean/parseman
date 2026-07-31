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
  /** True when the edits were written to disk, so the header says so. */
  applied?: boolean
  /** Absolute path of the edited source, used ONLY for the frame's terminal hyperlink. */
  sourceRoot?: string
}

export function fixReportLines(r: FixReport, opts: FixRenderOptions = {}): Line[] {
  const name = opts.name ?? 'grammar'
  const width = opts.width ?? DEFAULT_WIDTH
  const out: Line[] = []

  if (!r.ok) {
    out.push([t('✗ ', TONE.loud), t(name, TONE.strong), t(' — no fix can be verified', TONE.bad)])
    for (const l of wrap(r.blocked ?? 'the verification loop could not run', width - 4, '  ')) out.push([t(l)])
    out.push([t('  Nothing is offered: an unverified rewrite is not a fix.', TONE.quiet)])
    return out
  }

  const engines = r.engines.join(' + ')
  if (r.verified.length === 0 && r.located.length === 0) {
    out.push([t('✓ ', TONE.good), t(name, TONE.strong), t(' — nothing to fix', TONE.good)])
    out.push([t(`  no rewritable site found; corpus ${groupDigits(r.corpus.samples)} sample(s), `
      + `${groupDigits(r.corpus.bytes)} bytes`, TONE.quiet)])
    return out
  }

  out.push([
    t(opts.applied === true ? '✓ ' : '● ', opts.applied === true ? TONE.good : TONE.warn),
    t(name, TONE.strong),
    t(' — ', TONE.quiet),
    t(`${groupDigits(r.verified.length)} verified fix${r.verified.length === 1 ? '' : 'es'}`, TONE.good),
    t(r.located.length > 0
      ? `, ${groupDigits(r.located.length)} located site${r.located.length === 1 ? '' : 's'} with no rewrite`
      : '', TONE.warn),
  ])
  out.push([t(`  re-parsed ${groupDigits(r.corpus.samples)} sample(s) / ${groupDigits(r.corpus.bytes)} bytes`
    + ` on ${engines} — output identical`, TONE.faint)])
  if (opts.applied !== true && r.verified.length > 0) {
    out.push([t('  PREVIEW', TONE.strong), t(' — nothing was written. Re-run with ', TONE.quiet),
      t('--apply', TONE.strong), t(' to write these edits.', TONE.quiet)])
  }

  for (const f of r.verified) out.push(...verifiedLines(f, opts))
  for (const l of r.located) out.push(...locatedLines(l, opts))

  if (r.frozen.length > 0) {
    out.push(rule(width, TONE.frame))
    out.push([t(` ${groupDigits(r.frozen.length)} subtree(s) reused verbatim (no faithful rebuild): `
      + r.frozen.slice(0, 6).map(f => `${f.rule}/${f.tag}`).join(', ')
      + (r.frozen.length > 6 ? ', …' : ''), TONE.faint)])
  }
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
  if (b.antiPatternsAfter !== b.antiPatternsBefore) effects.push(`anti-patterns ${b.antiPatternsBefore} → ${b.antiPatternsAfter}`)
  if (b.ungatedChoicesAfter !== b.ungatedChoicesBefore) effects.push(`ungated choices ${b.ungatedChoicesBefore} → ${b.ungatedChoicesAfter}`)
  if (b.gatedChoicesAfter !== b.gatedChoicesBefore) effects.push(`choices gating on first char ${b.gatedChoicesBefore} → ${b.gatedChoicesAfter}`)
  // The first-set line earns its place only when the set MOVED. Printing `'i' → 'i'`
  // under a heading called "why" is how a diagnostic loses trust.
  if (f.armFirstSetBefore !== f.armFirstSetAfter) {
    effects.push(`arm ${f.armIndex} dispatches on ${f.armFirstSetBefore} → ${f.armFirstSetAfter}`)
  }
  if (f.choiceGatesBefore !== f.choiceGatesAfter) {
    effects.push(`${f.choiceId} gates: ${f.choiceGatesBefore} → ${f.choiceGatesAfter}`)
  }
  const effect = effects.join(' · ')

  out.push(blank())
  out.push(rule(width, TONE.frame))
  out.push([
    t(' ✔ ', TONE.good),
    t('ACTIONABLE', { color: 'green', bold: true }),
    t('  '),
    t(f.id, TONE.ident),
    t(`  ${f.code}`, TONE.faint),
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
      endColumn: f.edit.column + f.edit.oldText.length,
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
  if (b.codegenBytesBefore !== null && b.codegenBytesAfter !== null && b.codegenBytesAfter !== b.codegenBytesBefore) {
    const d = b.codegenBytesAfter - b.codegenBytesBefore
    out.push([t('   cost    ', TONE.faint),
      t(`compiled artifact ${d > 0 ? '+' : ''}${groupDigits(d)} B`, TONE.faint)])
  }
  out.push([t('   proven  ', TONE.quiet),
    t(`applied, recompiled, ${groupDigits(f.evidence.samples)} sample(s) re-parsed on `
      + `${f.evidence.engines.join(' + ')} — output identical`, TONE.good)])
  return out
}

function locatedLines(l: LocatedFinding, opts: FixRenderOptions): Line[] {
  const out: Line[] = []
  const width = opts.width ?? DEFAULT_WIDTH
  out.push(blank())
  out.push(rule(width, TONE.frame))
  out.push([
    t(' ◑ ', TONE.warn),
    t('LOCATED', { color: 'yellow', bold: true }),
    t('     '),
    t(l.id, TONE.ident),
    t(`  ${l.code}`, TONE.faint),
  ])
  out.push([t('   site    ', TONE.faint), t(l.site, TONE.quiet)])
  const lines = wrap(l.reason, width - 12, '')
  out.push([t('   reason  ', TONE.quiet), t(lines[0] ?? '', TONE.warn)])
  for (const x of lines.slice(1)) out.push([t('           '), t(x, TONE.warn)])
  return out
}
