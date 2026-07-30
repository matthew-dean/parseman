#!/usr/bin/env node
/**
 * Fail on RAW control bytes in tracked text sources.
 *
 * WHY THIS EXISTS AS A GATE. A control byte inside a template literal — `` `${a}\x00${b}` ``
 * written with the ACTUAL 0x00 byte rather than the escape — makes the whole file BINARY
 * to every text tool:
 *
 *   - `git diff --numstat` reports `-  -` instead of line counts, and GitHub refuses to
 *     render the blob, so the file cannot be reviewed in a PR at all;
 *   - `grep -rn` over `src/` SKIPS it silently. Not "binary file matches" — no output and
 *     exit 0. A sweep for defects in that file reports the file is clean.
 *
 * This has now happened twice. Commit `ed81612` removed the pattern from
 * `src/analysis/gating.ts` and `src/analysis/duplication.ts`, with a commit message
 * explaining precisely this failure mode — and it came straight back in
 * `src/compiler/degradation.ts` and stayed in `src/combinators/choice.ts`, where it made
 * the largest new file of the 0.45.0 release invisible to review. A fix without a gate
 * bought one release. Hence the gate.
 *
 * The fix is never "delete the delimiter" — it is to write the ESCAPE (backslash-u-0000),
 * which is plain ASCII in the source and produces the identical string at runtime; or
 * better, to stop needing a magic delimiter at all (`JSON.stringify([a, b])` is injective
 * and printable, and needs no argument about which characters cannot occur).
 *
 * TAB (0x09), LF (0x0A) and CR (0x0D) are legitimate text and are allowed.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Everything except TAB, LF, CR. */
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/** Extensions that are text by contract. Binary fixtures are not our business. */
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sh|css|html|txt|pegjs|ne)$/

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(f => f !== '' && TEXT_EXT.test(f))

const findings = []
for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'latin1')
  } catch {
    continue // deleted between ls-files and here
  }
  if (!CONTROL_RE.test(text)) continue
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = CONTROL_RE.exec(lines[i])
    if (!m) continue
    const byte = m[0].charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()
    const shown = lines[i].replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, c =>
      `<0x${c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}>`)
    findings.push(`${file}:${i + 1}: raw control byte 0x${byte}\n    ${shown.trim().slice(0, 160)}`)
  }
}

if (findings.length > 0) {
  console.error(`check-control-bytes: ${findings.length} raw control byte(s) in tracked text files.\n`)
  for (const f of findings) console.error(f)
  console.error(
    '\nA raw control byte makes the file BINARY: `git diff --numstat` shows `- -`, GitHub will'
    + '\nnot render it, and `grep -rn` skips it SILENTLY (no output, exit 0).'
    + '\nWrite the escape (`\\u0000`) instead of the byte, or drop the magic delimiter entirely'
    + '\n(`JSON.stringify([a, b])` is injective and printable).',
  )
  process.exit(1)
}

console.log(`check-control-bytes: ok (${files.length} text files clean)`)
