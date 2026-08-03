/**
 * CHOICE-COST GATE — wasted work, ratcheted.
 * ==========================================
 *
 * `src/analysis/choice-cost.ts` measures how many input bytes a grammar re-scans
 * because an ordered-choice arm was tried and failed. This file is what makes that
 * number a build failure instead of a report nobody runs.
 *
 * WHY THIS METRIC CAN BE GATED AT ALL
 * -----------------------------------
 * It is a COUNT of input bytes, not a timing. The same grammar over the same corpus
 * yields the same number on an idle laptop and on a runner at load 10 — the profile
 * is asserted byte-identical across two separate node processes by
 * test/unit/choice-cost.test.ts. So there is no noise band to argue about, no
 * reference commit to build, and no rebaseline when the hardware changes. That is a
 * different class of gate from `perf:workloads`, which has to run a sign test across
 * three passes to say anything at all.
 *
 * WHAT IT IS NOT: A TIME GATE
 * ---------------------------
 * Wasted bytes rank ORDERING, not CPU. The jess lane that acted on this instrument's
 * #1 finding cut rescanned bytes by 69.8% and measured ZERO wall-clock change. That
 * is the expected outcome, not a refutation: a byte that is rescanned by a failing
 * arm is usually already hot in cache, and the interpreter's per-arm overhead is
 * dominated by dispatch rather than by the scan. This gate exists to stop grammar
 * SHAPE from rotting — an arm quietly migrating to the front of a hot choice, a
 * refactor that adds a fifth alternative to a site entered a million times. Do not
 * expect `perf:workloads` to move when this one does, and do not read a flat
 * benchmark as evidence that a finding here was wrong.
 *
 * TWO-SIDED, AND WHY
 * ------------------
 * `bench/size-guard.ts` established the shape in 0.45 and this follows it exactly:
 * the committed number is a BAND, not a floor. Growing past it fails; shrinking below
 * it ALSO fails, with "bank the win". The second half is the one that rots when it is
 * left to a comment — `bench/grammar-density/config.json` and
 * `bench/workloads/config.json` both carried a polite request to bump and both sat
 * unbumped for ten releases. If a reorder takes `statement › choice[1]` from 7,846
 * wasted bytes to 2,000 and the baseline stays at 7,846, then 5,846 bytes of fresh
 * headroom silently become budget, and the gate reads green through the whole of the
 * next regression.
 *
 * SLACK is 0.1%, matching size-guard. It is NOT a noise allowance — the noise floor
 * here is exactly zero — it exists only so incidental churn does not thrash the
 * baseline in both directions.
 *
 * WHAT IS MEASURED, AND WHY ONLY THESE TWO
 * ----------------------------------------
 * The corpus is `bench/workloads/fixtures/{site.css,app.less}` — the SAME hand-
 * authored files the realistic-workload perf gate already replays. Reusing them is
 * deliberate and costs zero new committed bytes: they are hand-written rather than
 * copied from any project (see the header of each file), so there is no licence to
 * carry, and they were built to reproduce the construct mix of a real stylesheet,
 * which is exactly what a wasted-work measurement depends on.
 *
 * The two rows SPAN the range rather than sampling it, measured on arrival:
 *
 *     row    corpus       wasted bytes   per corpus byte
 *     css    15,859 B            511 B          0.032x     the low-rollback control
 *     less   17,095 B         17,169 B          1.004x     the ambiguous dialect
 *
 * A 31x spread between two grammars over the same problem domain is what makes the
 * pair worth gating: when less moves and css does not, the cost is in speculation;
 * when both move, it is in something shared. A single blended row would say neither.
 *
 * DELIBERATELY EXCLUDED, with the reason so nobody re-derives it:
 *   - `examples/graphql` builds its grammar from THREE separate `rules()` calls plus
 *     free-standing combinators, so there is no single rule map to walk and every
 *     site would be reported unnamed. That is a naming problem, not a capability
 *     problem, and fixing it means restructuring the example.
 *   - `examples/json` has a one-rule map and would gate fine, but no committed JSON
 *     corpus exists and the css row already supplies the low-rollback control. It is
 *     the cheapest row to add if breadth is ever wanted.
 *   - jess's four dialect grammars are where the instrument found its headline result
 *     (`Value › node(Value)`, 37.5 kB), and they stay OUT of this repo. They are
 *     composed, multi-artifact grammars that would need a linker fuse to profile, and
 *     they are jess's to gate. See "WHERE THE OTHER TIER LIVES" below.
 *
 * WHERE THE OTHER TIER LIVES
 * --------------------------
 * `checkWastedWork` is exported from the package root precisely so jess can run this
 * same policy against its own fixtures without vendoring anything. parseman gates the
 * grammars it can build and diagnose from a bare clone; jess gates jess's. The split
 * follows the owner's inclusion rule — what helps DEVELOP grammars lives here, what
 * only supports one downstream project's testing does not.
 *
 * INVERSIONS ARE FATAL HERE, FROM DAY ONE
 * ---------------------------------------
 * `failOnInversions` is ON. The policy defaults it off because switching it on over an
 * existing backlog produces a gate that is red on arrival, and a red-on-arrival gate
 * gets disabled rather than fixed. That reasoning does not apply: BOTH gated grammars
 * measure ZERO inversions today. The backlog is empty, so the check is turned on to
 * keep it empty — which is the condition the policy's own comment names.
 *
 * NO CEILING IS ENFORCED IN 0.46 — and the target is still printed
 * ---------------------------------------------------------------
 * The natural line is 1.0x: above it, the parser re-scans more bytes than the file
 * contains. `less` sits at 1.004x — fractionally over on arrival. Enforcing 1.0x today
 * would ship a permanently-red required check, which this repo has already learned
 * trains everyone to ignore CI. So the target is MEASURED and REPORTED every run and
 * the ratchet is what blocks, exactly as size-guard treats its 10x target.
 *
 * REBASELINING
 * ------------
 *   pnpm choicecost:baseline     rewrites bench/choice-cost-baseline.json
 *   pnpm choicecost:report       the full ranked developer view, gates nothing
 *
 * The baseline is a committed file reviewed like any other diff. Nothing here writes
 * one on a gate run.
 *
 * FAILS CLOSED
 * ------------
 * A missing/malformed/empty baseline, a missing corpus file, an empty corpus file, a
 * grammar that fails to build, a corpus that fails to parse, zero instrumentable
 * sites, or an incomplete grammar walk are all HARD FAILURES. There is no path
 * through this file that reports success without having measured something.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  analyzeChoiceInventory,
  buildWastedWorkBaseline,
  checkWastedWork,
  profileWastedWork,
  renderWastedWork,
  type Combinator,
  type WastedWorkPolicy,
  type WastedWorkReport,
} from '../src/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const GATE = 'choice-cost'
const BASELINE_PATH = join(ROOT, 'bench', 'choice-cost-baseline.json')

/** Matches `bench/size-guard.ts`. Not noise — the noise floor is zero. Headroom only
 *  so a one-byte incidental change does not thrash the baseline in both directions. */
const RATCHET_SLACK_PCT = 0.1

/** Reported, never fatal in 0.46. See NO CEILING IS ENFORCED in the header. */
const TARGET_RATIO = 1.0

const POLICY: WastedWorkPolicy = {
  driftTolerancePct: RATCHET_SLACK_PCT,
  // ON because both gated grammars measure zero inversions today; see the header.
  failOnInversions: true,
  // ceilingRatio deliberately unset — see NO CEILING IS ENFORCED.
}

function fail(msg: string): never {
  console.error(`\n${GATE}: FAILED\n  ${msg}\n`)
  process.exit(1)
}

type GrammarSpec = {
  id: string
  /** Module exporting the rule map, relative to this file. */
  module: string
  /** Export name of the `rules()` map — the MAP, not the entry combinator. */
  mapExport: string
  entry: string
  /** Repo-relative, so the report never carries a machine-dependent path. */
  corpus: string
  /** One line, printed beside the row: why this grammar is in the gated set. */
  why: string
}

const SPECS: GrammarSpec[] = [
  {
    id: 'css',
    module: '../examples/css/parser.ts',
    mapExport: 'cssRules',
    entry: 'Stylesheet',
    corpus: 'bench/workloads/fixtures/site.css',
    why: 'the low-rollback control — when this moves too, the cost is not speculation',
  },
  {
    id: 'less',
    module: '../bench/workloads/less.ts',
    mapExport: 'lessRules',
    entry: 'Stylesheet',
    corpus: 'bench/workloads/fixtures/app.less',
    why: 'genuinely ambiguous statement position; where ordering cost actually lives',
  },
]

async function measure(spec: GrammarSpec): Promise<{ report: WastedWorkReport; backlogArms: number }> {
  const corpusPath = join(ROOT, spec.corpus)
  if (!existsSync(corpusPath)) {
    fail(
      `${spec.id}: corpus is MISSING at ${spec.corpus}.\n`
      + '  A corpus that cannot be read is a gate failure, never a skip — otherwise deleting\n'
      + '  a fixture silently shrinks the gated set and the gate goes on reporting green.',
    )
  }
  const text = readFileSync(corpusPath, 'utf8')
  if (text.length === 0) fail(`${spec.id}: corpus ${spec.corpus} is EMPTY — zero wasted bytes over zero input is not a measurement.`)

  let mod: Record<string, unknown>
  try {
    // A file URL, not a bare path: ESM specifiers are URLs, and an absolute Windows
    // path (`C:\…`) is rejected by the loader with ERR_UNSUPPORTED_ESM_URL_SCHEME.
    mod = (await import(pathToFileURL(join(HERE, spec.module)).href)) as Record<string, unknown>
  } catch (e) {
    fail(
      `${spec.id}: grammar FAILED TO BUILD from ${spec.module} — ${(e as Error).message.split('\n')[0]}\n`
      + '  Fix the grammar; do not drop it from the gated set.',
    )
  }

  const map = mod[spec.mapExport]
  if (map === undefined || map === null || typeof map !== 'object') {
    fail(
      `${spec.id}: ${spec.module} does not export a rule map called \`${spec.mapExport}\`.\n`
      + '  Analysis walks a grammar by NAME so a site can be reported as `Value › node(Value)`\n'
      + '  rather than anonymously. Export the whole `rules()` result, not just the entry rule.',
    )
  }

  const ruleEntries = Object.entries(map as Record<string, unknown>) as Array<[string, Combinator<unknown>]>

  let report: WastedWorkReport
  try {
    report = profileWastedWork({
      rules: ruleEntries,
      entry: spec.entry,
      corpus: [{ id: spec.corpus, text }],
    })
  } catch (e) {
    fail(`${spec.id}: profiling threw — ${(e as Error).message.split('\n')[0]}`)
  }

  if (report.parsedFailed > 0) {
    fail(
      `${spec.id}: the corpus did NOT parse (${report.parsedFailed} of ${report.corpusFiles} file(s) failed).\n`
      + '  Every number below would then describe an ERROR path rather than the grammar, so\n'
      + '  this is a failure rather than a smaller measurement.',
    )
  }

  // One argument: `analyzeChoiceInventory` walks every rule in the map and has
  // no entry parameter. The `spec.entry` that used to be passed here was
  // silently discarded by the call, so dropping it is a no-op at runtime.
  const inv = analyzeChoiceInventory(ruleEntries)
  return { report, backlogArms: inv.backlogArms }
}

type BaselineFile = ReturnType<typeof buildWastedWorkBaseline>

function gitRev(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

const n = (v: number): string => v.toLocaleString('en-US')
const RULE = '─'.repeat(76)

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const update = argv.includes('--update')
  const reportOnly = argv.includes('--report')

  const reports: Record<string, WastedWorkReport> = {}
  const backlog: Record<string, number> = {}
  for (const spec of SPECS) {
    const { report, backlogArms } = await measure(spec)
    reports[spec.id] = report
    backlog[spec.id] = backlogArms
  }

  // ── the developer view: the full ranked list, gating nothing ──────────────
  if (reportOnly) {
    for (const spec of SPECS) {
      console.log(`\n${'═'.repeat(78)}\n${spec.id}  ·  ${spec.corpus}\n${'═'.repeat(78)}`)
      console.log(renderWastedWork(reports[spec.id]!))
    }
    return
  }

  // ── rebaseline: explicit, and its output is a reviewable diff ─────────────
  if (update) {
    const next = buildWastedWorkBaseline(reports, {
      gitRev: gitRev(),
      updatedAt: new Date().toISOString().slice(0, 10),
    })
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n')
    console.log(`${GATE}: wrote bench/choice-cost-baseline.json (${Object.keys(next.totals).length} corpora, ${Object.keys(next.sites).length} sites)`)
    console.log(`${GATE}: every number in it is now a BAND of ±${RATCHET_SLACK_PCT}% — it may not grow, and if`)
    console.log(`${GATE}: it falls the gate will require this file to be written again.`)
    console.log(`${GATE}: review it in the diff; rebaselining is a deliberate, reviewable act.`)
    return
  }

  // ── the gate ──────────────────────────────────────────────────────────────
  if (!existsSync(BASELINE_PATH)) {
    fail(
      'bench/choice-cost-baseline.json is MISSING.\n'
      + '  A gate with no baseline measures nothing, and passing here is exactly how a budget\n'
      + '  stops being enforced. Create it with `pnpm choicecost:baseline` and commit it.',
    )
  }
  let baseline: unknown
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  } catch (e) {
    fail(`bench/choice-cost-baseline.json is UNREADABLE — ${(e as Error).message.split('\n')[0]}`)
  }

  const verdict = checkWastedWork(reports, baseline, POLICY)
  const b = baseline as BaselineFile

  // ---- the measured table -------------------------------------------------
  console.log(`\n${GATE}  vs committed baseline ${b.gitRev ?? '?'} (${b.updatedAt ?? '?'})  ·  band ±${RATCHET_SLACK_PCT}%  ·  ${TARGET_RATIO}x target: reported, not blocking in 0.46`)
  console.log(`  ${RULE}`)
  console.log('  grammar     corpus        wasted    per byte    sites   backlog   vs baseline')
  console.log(`  ${RULE}`)
  for (const spec of SPECS) {
    const r = reports[spec.id]!
    const base = b.totals?.[spec.id]
    const ratio = r.corpusBytes > 0 ? r.totalWastedBytes / r.corpusBytes : 0
    const d = base && base.totalWastedBytes > 0 ? (r.totalWastedBytes / base.totalWastedBytes - 1) * 100 : undefined
    const note = d === undefined ? 'unbaselined' : `${d >= 0 ? '+' : ''}${d.toFixed(2)}%`
    console.log(
      '  ' + spec.id.padEnd(11) +
      (n(r.corpusBytes) + ' B').padStart(10) +
      (n(r.totalWastedBytes) + ' B').padStart(12) +
      (ratio.toFixed(3) + 'x').padStart(12) +
      String(r.instrumentedSites).padStart(9) +
      String(backlog[spec.id] ?? 0).padStart(10) +
      note.padStart(14) +
      (ratio > TARGET_RATIO ? `   over ${TARGET_RATIO}x` : ''),
    )
  }
  console.log(`  ${RULE}`)
  for (const spec of SPECS) console.log(`  ${spec.id.padEnd(6)} ${spec.why}`)

  // ---- standing debt against the target: WARNED, never blocking -----------
  const over = SPECS.filter(s => reports[s.id]!.corpusBytes > 0 && reports[s.id]!.totalWastedBytes / reports[s.id]!.corpusBytes > TARGET_RATIO)
  if (over.length > 0) {
    console.log(`\n  ⚠  WARNING — ${over.length} grammar(s) re-scan more bytes than their input contains`)
    console.log(`  ${RULE}`)
    console.log(`  Above ${TARGET_RATIO}x, every byte of the file is on average rescanned once by an arm`)
    console.log('  that then failed. Ratcheted at today\'s number so it cannot grow, but NOT')
    console.log('  accepted — this warning does not go away by rebaselining.')
    console.log('')
    for (const spec of over) {
      const r = reports[spec.id]!
      const ratio = r.totalWastedBytes / r.corpusBytes
      const budget = Math.round(r.corpusBytes * TARGET_RATIO)
      console.log(`    ${spec.id.padEnd(8)} ${ratio.toFixed(3)}x — must fall by ${n(r.totalWastedBytes - budget)} B to reach ${TARGET_RATIO}x`)
      const worst = [...r.sites].sort((x, y) => y.gatedWastedBytes - x.gatedWastedBytes).slice(0, 3).filter(s => s.gatedWastedBytes > 0)
      for (const s of worst) {
        console.log(`             ${n(s.gatedWastedBytes).padStart(8)} B  ${s.siteKey}`)
      }
      console.log(`             → start at the top of that list; \`pnpm choicecost:report\` shows it per ARM,`)
      console.log('               with each arm\'s attempts and failure rate.')
    }
  }

  if (verdict.ok) {
    console.log(`\n  ✓ ${GATE}: ${verdict.checkedCorpora} corpora, ${verdict.checkedSites} sites, all within ±${RATCHET_SLACK_PCT}% of the committed numbers.\n`)
    return
  }

  // ---- breaches, grouped so each group carries ONE remedy ------------------
  const by = (k: string) => verdict.breaches.filter(x => x.kind === k)
  const say = (s: string): void => { console.error(s) }

  const invalid = by('invalid-baseline')
  if (invalid.length > 0) {
    say(`\n  ✗ INVALID BASELINE — the committed file cannot be used as a baseline`)
    say(`  ${RULE}`)
    for (const x of invalid) say(`    ${x.key}: ${x.detail}`)
    say('')
    say('    → Nothing was compared. This is a failure and not a pass, because a gate')
    say('      that shrugs at a broken baseline is a gate that enforces nothing.')
  }

  const unmeasurable = by('unmeasurable')
  if (unmeasurable.length > 0) {
    say(`\n  ✗ UNMEASURABLE — ${unmeasurable.length} corpus/corpora produced no usable number`)
    say(`  ${RULE}`)
    for (const x of unmeasurable) say(`    ${x.key}: ${x.detail}`)
    say('')
    say('    → Every one of these is a way of NOT having measured. A zero here means the')
    say('      instrument did not run, not that the grammar is clean.')
  }

  const ceiling = by('ceiling')
  if (ceiling.length > 0) {
    say(`\n  ✗ CEILING — ${ceiling.length} corpus/corpora above the hard cap`)
    say(`  ${RULE}`)
    for (const x of ceiling) say(`    ${x.key}: ${x.detail}`)
  }

  const grew = by('drift')
  if (grew.length > 0) {
    say(`\n  ✗ REGRESSED — ${grew.length} number(s) grew past the committed band`)
    say(`  ${RULE}`)
    say('    A choice arm is re-scanning more input than it used to. Either an arm moved')
    say('    earlier in a hot choice, or a new alternative was added in front of one.')
    say('')
    for (const x of grew) say(`    ${x.key}\n      ${x.detail}`)
    say('')
    say('    → `pnpm choicecost:report` ranks every ARM at these sites by wasted bytes and')
    say('      shows attempts and failure rate, so the offending arm names itself.')
    say('    → If the growth is intended and paid for, raise the number with')
    say('      `pnpm choicecost:baseline` — that is a reviewable diff and needs sign-off.')
  }

  const shrank = by('shrank')
  if (shrank.length > 0) {
    const total = shrank.filter(x => !x.key.includes('::')).length
    say(`\n  ✗ BANK THE WIN — ${shrank.length} number(s) fell BELOW the committed band`)
    say(`  ${RULE}`)
    say('    This is good news failing the build on purpose. The grammar got cheaper and')
    say('    the baseline did not move with it, so the difference is now silent headroom')
    say('    for the next regression to grow into — and the gate would read green through')
    say('    all of it.')
    say('')
    for (const x of shrank.slice(0, 12)) say(`    ${x.key}\n      ${x.detail}`)
    if (shrank.length > 12) say(`    … and ${shrank.length - 12} more`)
    say('')
    say(`    → Run \`pnpm choicecost:baseline\` and commit it${total > 0 ? '' : ' (per-site only — the totals held)'}.`)
    say('      Lowering a number needs no sign-off. It is mandatory, and this check is what')
    say('      makes it happen instead of a comment politely asking someone to remember.')
  }

  const inversions = by('inversion')
  if (inversions.length > 0) {
    say(`\n  ✗ ORDERING INVERSION — ${inversions.length} arm(s) failed EVERY attempt while a later arm matched`)
    say(`  ${RULE}`)
    say('    An arm that never once succeeded is sitting in front of one that does. Every')
    say('    byte it re-scanned was unpaid work, on every parse.')
    say('')
    for (const x of inversions) say(`    ${x.key}\n      ${x.detail}`)
    say('')
    say('    → Before reordering, CHECK THE ARMS OVERLAP. This is the trap the jess lane hit:')
    say('      at its #1 site, arms 0↔1 and 4↔5 both overlapped and the obvious swap changed')
    say('      what the grammar accepted. An order-preserving fix — narrowing the failing')
    say('      arm\'s lead so it stops being entered — is the safe shape.')
    say('    → This check was switched on with the backlog at ZERO, so this arm is new.')
  }

  const unbaselined = by('unbaselined')
  if (unbaselined.length > 0) {
    say(`\n  ✗ UNBASELINED — ${unbaselined.length} measured thing(s) the baseline has never seen`)
    say(`  ${RULE}`)
    for (const x of unbaselined.slice(0, 12)) say(`    ${x.key}\n      ${x.detail}`)
    if (unbaselined.length > 12) say(`    … and ${unbaselined.length - 12} more`)
    say('')
    say('    → A new choice site appeared. Baseline it deliberately with')
    say('      `pnpm choicecost:baseline`; passing an unmeasured site is how a budget rots.')
  }

  const stale = by('stale')
  if (stale.length > 0) {
    say(`\n  ✗ STALE — ${stale.length} baselined entr(ies) match nothing measured`)
    say(`  ${RULE}`)
    for (const x of stale.slice(0, 12)) say(`    ${x.key}\n      ${x.detail}`)
    if (stale.length > 12) say(`    … and ${stale.length - 12} more`)
    say('')
    say('    → A rule was renamed or removed. Ignoring it silently shrinks the gated set.')
    say('      Rebaseline if the removal was intended.')
  }

  say('')
  process.exit(1)
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return resolve(entry) === resolve(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (invokedDirectly) {
  main().catch(e => fail(`unhandled: ${(e as Error).stack ?? String(e)}`))
}
