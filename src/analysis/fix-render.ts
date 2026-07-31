/**
 * The human layer over `FixReport`.
 *
 * The claim this rendering has to carry is unusual, so it is made explicitly and never
 * by implication: a fix shown here was APPLIED to the grammar, the grammar was
 * RECOMPILED, the corpus was RE-PARSED, and the output did not move. Every offered
 * rewrite prints that evidence next to it, with the sample and byte counts, because
 * "proven" without a corpus size is a word, not a fact.
 *
 * The diff is the primary interface. `--fix` writing to a file is a second, explicit
 * step; what a reader gets by default is what would change, in the form they would read
 * it in a review.
 *
 * LOCATED sites print too, and they print the REASON, never advice. A site that cannot
 * be rewritten is still worth knowing about — that is the difference between "here is
 * exactly where the problem is" and silence.
 */
import type { FixReport, VerifiedFix, LocatedFinding } from './fix.ts'
import { groupDigits } from './diagnose-render.ts'

export type FixRenderOptions = {
  color?: boolean
  name?: string
  /** True when the edits were written to disk, so the header says so. */
  applied?: boolean
}

const ANSI = {
  dim: '\u001b[2m', bold: '\u001b[1m', red: '\u001b[31m',
  green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m', reset: '\u001b[0m',
} as const
type Paint = (code: keyof typeof ANSI, s: string) => string
const painter = (on: boolean): Paint => (code, s) => (on ? `${ANSI[code]}${s}${ANSI.reset}` : s)

const wrapAt = (text: string, width: number, indent: string): string[] => {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(w => w !== '')) {
    if (line === '') line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else { out.push(indent + line); line = word }
  }
  if (line !== '') out.push(indent + line)
  return out
}

export function renderFixReport(r: FixReport, opts: FixRenderOptions = {}): string {
  const c = painter(opts.color === true)
  const name = opts.name ?? 'grammar'
  const out: string[] = []

  if (!r.ok) {
    out.push(`${c('red', '✗')} ${c('bold', name)} — no fix can be verified`)
    out.push(...wrapAt(r.blocked ?? 'the verification loop could not run', 76, '  '))
    out.push(c('dim', '  Nothing is offered: an unverified rewrite is not a fix.'))
    return out.join('\n')
  }

  const engines = r.engines.join(' + ')
  if (r.verified.length === 0 && r.located.length === 0) {
    out.push(`${c('green', '✓')} ${c('bold', name)} — nothing to fix`)
    out.push(c('dim', `  no rewritable site found; corpus ${groupDigits(r.corpus.samples)} sample(s), ${groupDigits(r.corpus.bytes)} bytes`))
    return out.join('\n')
  }

  out.push(
    `${opts.applied === true ? c('green', '✓') : c('yellow', '●')} ${c('bold', name)} — `
    + `${groupDigits(r.verified.length)} verified fix${r.verified.length === 1 ? '' : 'es'}`
    + `${r.located.length > 0 ? `, ${groupDigits(r.located.length)} located site${r.located.length === 1 ? '' : 's'} with no rewrite` : ''}`,
  )
  out.push(c('dim',
    `  verified by re-parsing ${groupDigits(r.corpus.samples)} sample(s) / ${groupDigits(r.corpus.bytes)} bytes on ${engines};`
    + ' output identical'))
  if (opts.applied !== true && r.verified.length > 0) {
    out.push(c('dim', '  PREVIEW — nothing was written. Re-run with --apply to write these edits.'))
  }
  out.push('')

  for (const f of r.verified) out.push(...renderVerified(f, c))
  for (const l of r.located) out.push(...renderLocated(l, c))

  if (r.frozen.length > 0) {
    out.push(c('dim', `  ${groupDigits(r.frozen.length)} subtree(s) reused verbatim (no faithful rebuild): `
      + r.frozen.slice(0, 6).map(f => `${f.rule}/${f.tag}`).join(', ')
      + (r.frozen.length > 6 ? ', …' : '')))
  }
  return out.join('\n')
}

function renderVerified(f: VerifiedFix, c: Paint): string[] {
  const out: string[] = []
  out.push(`${c('green', 'ACTIONABLE')} ${c('cyan', f.id)}  ${c('dim', f.code)}`)
  if (f.edit !== undefined) {
    out.push(c('dim', `  ${f.edit.path}:${f.edit.line}:${f.edit.column}`))
    out.push(`  ${c('red', `- ${f.edit.oldText}`)}`)
    out.push(`  ${c('green', `+ ${f.edit.newText}`)}`)
  }
  else {
    out.push(`  ${c('red', `- ${f.before}`)}`)
    out.push(`  ${c('green', `+ ${f.after}`)}`)
  }
  const b = f.benefit
  const effects: string[] = []
  if (b.antiPatternsAfter !== b.antiPatternsBefore) effects.push(`anti-patterns ${b.antiPatternsBefore} → ${b.antiPatternsAfter}`)
  if (b.ungatedChoicesAfter !== b.ungatedChoicesBefore) effects.push(`ungated choices ${b.ungatedChoicesBefore} → ${b.ungatedChoicesAfter}`)
  if (b.gatedChoicesAfter !== b.gatedChoicesBefore) effects.push(`choices gating on first char ${b.gatedChoicesBefore} → ${b.gatedChoicesAfter}`)
  // The first-set line earns its place only when the set MOVED. Printing
  // `'i' → 'i'` under a heading called "why" is how a diagnostic loses trust.
  if (f.armFirstSetBefore !== f.armFirstSetAfter) {
    effects.push(`arm ${f.armIndex} dispatches on ${c('red', f.armFirstSetBefore)} → ${c('green', f.armFirstSetAfter)}`)
  }
  if (f.choiceGatesBefore !== f.choiceGatesAfter) {
    effects.push(`${f.choiceId} gates: ${c('red', f.choiceGatesBefore)} → ${c('green', f.choiceGatesAfter)}`)
  }
  out.push(`  ${c('bold', 'effect')}  ${effects.join(' · ')}`)
  if (b.codegenBytesBefore !== null && b.codegenBytesAfter !== null && b.codegenBytesAfter !== b.codegenBytesBefore) {
    const dlt = b.codegenBytesAfter - b.codegenBytesBefore
    out.push(`  ${c('dim', 'cost')}    compiled artifact ${dlt > 0 ? '+' : ''}${groupDigits(dlt)} B`)
  }
  out.push(`  ${c('bold', 'proven')}  applied, recompiled, ${groupDigits(f.evidence.samples)} sample(s) re-parsed on `
    + `${f.evidence.engines.join(' + ')} — output identical`)
  out.push('')
  return out
}

function renderLocated(l: LocatedFinding, c: Paint): string[] {
  const out: string[] = []
  out.push(`${c('yellow', 'LOCATED')}    ${c('cyan', l.id)}  ${c('dim', l.code)}`)
  out.push(`  ${c('dim', 'site')}    ${l.site}`)
  const lines = wrapAt(l.reason, 66, '')
  out.push(`  ${c('dim', 'reason')}  ${lines[0] ?? ''}`)
  for (const x of lines.slice(1)) out.push(`          ${x}`)
  out.push('')
  return out
}
