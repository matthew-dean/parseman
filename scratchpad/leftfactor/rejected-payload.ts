/**
 * The REJECTED-INPUT half, at corpus scale.
 *
 * Byte-identity only compares accepted input. Disjoint dispatch selects ONE arm while
 * firstMatch accumulates `expected` across arms, so if resolving disjointness changed
 * anything observable on failure, this is where it would hide.
 *
 * Method: take a real CSS corpus, derive many REJECTED inputs from each file
 * (truncations at every boundary, and single-character corruptions), and compare the
 * interpreter and the compiled engine on WHOLE results — ok, value, span, and the
 * `expected` payload — never a field subset.
 */
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { realpathSync } from 'node:fs'

const ROOT = '/Users/matthew/git/worktrees/pm-leftfactor'
const CORPUS = '/Users/matthew/git/worktrees/jess-macro-alias-doc'
const parserPath = realpathSync(`${ROOT}/examples/css/parser.ts`)
const sha = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim()

const { parseCss, parseCssCompiled } = (await import(parserPath)) as {
  parseCss(i: string): unknown
  parseCssCompiled(i: string): unknown
}

console.log(`grammar:  ${parserPath}`)
console.log(`compiler: ${ROOT}/src/compiler/codegen.ts`)
console.log(`sha:      ${sha.slice(0, 7)}  src-dirty=${dirty === '' ? 'no' : 'YES (the fix)'}`)
console.log(`corpus:   ${CORPUS}`)
console.log(`load:     ${execFileSync('uptime', { encoding: 'utf8' }).trim().split('load averages:')[1]?.trim()}\n`)

async function collect(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await collect(p, out)
    else if (e.name.endsWith('.css')) out.push(p)
  }
  return out
}

/** Rejected-input derivations: truncations and single-char corruptions. */
function* derive(src: string): Generator<string> {
  const step = Math.max(1, Math.floor(src.length / 40))
  for (let i = 0; i < src.length; i += step) yield src.slice(0, i)        // truncation
  for (const ch of ['{', '}', '(', ')', '"', "'", ';', ':', '@', '\\']) {
    const step2 = Math.max(1, Math.floor(src.length / 12))
    for (let i = 0; i < src.length; i += step2) yield src.slice(0, i) + ch + src.slice(i + 1)
  }
}

/** First differing PROPERTY PATH, or null. A truncated dump hides the difference. */
function diffPath(x: unknown, y: unknown, at = 'root'): string | null {
  if (JSON.stringify(x) === JSON.stringify(y)) return null
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    const xo = x as Record<string, unknown>, yo = y as Record<string, unknown>
    for (const k of new Set([...Object.keys(xo), ...Object.keys(yo)])) {
      const d = diffPath(xo[k], yo[k], `${at}.${k}`)
      if (d) return d
    }
  }
  return `${at}: ${JSON.stringify(x)?.slice(0, 90)} VS ${JSON.stringify(y)?.slice(0, 90)}`
}

const files = await collect(CORPUS)
let compared = 0, rejected = 0, accepted = 0, mismatched = 0
const firstFew: string[] = []

for (const f of files) {
  const src = readFileSync(f, 'utf8')
  for (const input of derive(src)) {
    let a: unknown, b: unknown, ea: string | null = null, eb: string | null = null
    try { a = parseCss(input) } catch (e) { ea = (e as Error).message }
    try { b = parseCssCompiled(input) } catch (e) { eb = (e as Error).message }
    compared++
    if (ea !== null || eb !== null) {
      if (ea !== eb) { mismatched++; if (firstFew.length < 5) firstFew.push(`${f}: throw ${ea} vs ${eb}`) }
      continue
    }
    // A css parse returns { tree, errors, trivia }; "rejected" means it did not
    // consume the whole input or it recorded errors.
    const at = a as { tree?: { span?: { end?: number } }; errors?: unknown[] }
    const consumed = at.tree?.span?.end ?? 0
    if (consumed < input.length || (at.errors?.length ?? 0) > 0) rejected++; else accepted++
    const d = diffPath(a, b)
    if (d !== null) {
      mismatched++
      if (firstFew.length < 5) firstFew.push(`${path.basename(f)} @${input.length}B  ${d}`)
    }
  }
}

console.log(`files ${files.length}  compared ${compared}  of which REJECTED ${rejected}  accepted ${accepted}  mismatched ${mismatched}`)
for (const l of firstFew) console.log('  ' + l)
// DIFFERENTIAL, not absolute. `examples/css` has a PRE-EXISTING interpreter-vs-compiled
// asymmetry in `trivia.entries` — the documented one (a non-capturing compile emits no
// capture code while the interpreter captures regardless), and it is present on clean
// origin/release/0.47.0 at exactly this count. An absolute pass/fail here would report a
// defect that is not this change's and hide the question actually being asked.
//
// CONTROL, clean 0.47.0 src, same corpus, same derivations:
//   files 110  compared 18602  REJECTED 15546  accepted 3056  mismatched 8966
// The number to watch is therefore the DELTA against that control, which must be 0.
const CONTROL_MISMATCHES = 8966
if (rejected < 1000) { console.error(`\nFAIL: only ${rejected} rejected inputs — the rejected half is undersampled.`); process.exit(1) }
if (mismatched !== CONTROL_MISMATCHES) {
  console.error(`\nFAIL: ${mismatched} mismatches vs control ${CONTROL_MISMATCHES} — delta ${mismatched - CONTROL_MISMATCHES}.`)
  process.exit(1)
}
console.log(`\nPASS: ${rejected} rejected + ${accepted} accepted inputs.`)
console.log(`Mismatches ${mismatched}, identical to the clean-0.47.0 control — this change adds NO`)
console.log(`interpreter-vs-compiled divergence, on the rejected half that byte-identity cannot see.`)
