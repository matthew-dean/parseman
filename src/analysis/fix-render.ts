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
 * LOCATED sites print too, and they print the REASON, never advice. A site that cannot
 * be rewritten is still worth knowing about — that is the difference between "here is
 * exactly where the problem is" and silence.
 *
 * Like `diagnose-render.ts`, this emits ROWS and never an escape byte; `terminal.ts`
 * owns every interaction with a terminal.
 */
import type { FixReport, VerifiedFix, LocatedFinding } from './fix.ts'
import { TONE, codeFrame, groupDigits, render, row, wrap, type RenderTarget, type Row } from './terminal.ts'

export type FixRenderOptions = RenderTarget & {
  name?: string
  /** True when the edits were written to disk, so the header says so. */
  applied?: boolean
  /** Absolute path of the edited source, used ONLY for the frame's terminal hyperlink. */
  sourceRoot?: string
}

export function fixReportRows(r: FixReport, opts: FixRenderOptions = {}): Row[] {
  const name = opts.name ?? 'grammar'
  const out: Row[] = []

  if (!r.ok) {
    out.push(row(`✗ ${name} — no fix can be verified`, TONE.bad))
    for (const l of wrap(r.blocked ?? 'the verification loop could not run', 76, '  ')) out.push(row(l))
    out.push(row('  Nothing is offered: an unverified rewrite is not a fix.', TONE.quiet))
    return out
  }

  const engines = r.engines.join(' + ')
  if (r.verified.length === 0 && r.located.length === 0) {
    out.push(row(`✓ ${name} — nothing to fix`, TONE.good))
    out.push(row(`  no rewritable site found; corpus ${groupDigits(r.corpus.samples)} sample(s), `
      + `${groupDigits(r.corpus.bytes)} bytes`, TONE.quiet))
    return out
  }

  out.push(row(
    `${opts.applied === true ? '✓' : '●'} ${name} — `
    + `${groupDigits(r.verified.length)} verified fix${r.verified.length === 1 ? '' : 'es'}`
    + `${r.located.length > 0 ? `, ${groupDigits(r.located.length)} located site${r.located.length === 1 ? '' : 's'} with no rewrite` : ''}`,
    opts.applied === true ? TONE.good : TONE.warn,
  ))
  out.push(row(
    `  verified by re-parsing ${groupDigits(r.corpus.samples)} sample(s) / ${groupDigits(r.corpus.bytes)} bytes`
    + ` on ${engines}; output identical`, TONE.quiet,
  ))
  if (opts.applied !== true && r.verified.length > 0) {
    out.push(row('  PREVIEW — nothing was written. Re-run with --apply to write these edits.', TONE.quiet))
  }
  out.push(row(''))

  for (const f of r.verified) out.push(...verifiedRows(f, opts))
  for (const l of r.located) out.push(...locatedRows(l))

  if (r.frozen.length > 0) {
    out.push(row(`  ${groupDigits(r.frozen.length)} subtree(s) reused verbatim (no faithful rebuild): `
      + r.frozen.slice(0, 6).map(f => `${f.rule}/${f.tag}`).join(', ')
      + (r.frozen.length > 6 ? ', …' : ''), TONE.quiet))
  }
  return out
}

export function renderFixReport(r: FixReport, opts: FixRenderOptions = {}): string {
  return render(fixReportRows(r, opts), opts)
}

function verifiedRows(f: VerifiedFix, opts: FixRenderOptions): Row[] {
  const out: Row[] = []
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

  out.push(row(`ACTIONABLE ${f.id}  ${f.code}`, { color: 'green', bold: true }))
  // The grammar SOURCE is the world this fix lives in, so show it as a frame with the
  // caret under the term being replaced rather than as a bare `path:line:col`. The
  // frame's own message carries the measured effect, so no line is spent repeating the
  // heading directly above it.
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
    }, opts, '  '))
  }
  else {
    out.push(row(`  - ${f.before}`, TONE.bad))
    out.push(row(`  + ${f.after}`, TONE.good))
    out.push(row(`  effect  ${effect}`))
  }
  if (b.codegenBytesBefore !== null && b.codegenBytesAfter !== null && b.codegenBytesAfter !== b.codegenBytesBefore) {
    const d = b.codegenBytesAfter - b.codegenBytesBefore
    out.push(row(`  cost    compiled artifact ${d > 0 ? '+' : ''}${groupDigits(d)} B`, TONE.quiet))
  }
  out.push(row(`  proven  applied, recompiled, ${groupDigits(f.evidence.samples)} sample(s) re-parsed on `
    + `${f.evidence.engines.join(' + ')} — output identical`))
  out.push(row(''))
  return out
}

function locatedRows(l: LocatedFinding): Row[] {
  const out: Row[] = []
  out.push(row(`LOCATED    ${l.id}  ${l.code}`, { color: 'yellow', bold: true }))
  out.push(row(`  site    ${l.site}`, TONE.quiet))
  const lines = wrap(l.reason, 66, '')
  out.push(row(`  reason  ${lines[0] ?? ''}`))
  for (const x of lines.slice(1)) out.push(row(`          ${x}`))
  out.push(row(''))
  return out
}
