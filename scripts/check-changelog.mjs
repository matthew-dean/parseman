#!/usr/bin/env node
/**
 * Release gate — every pull request lands with its CHANGELOG entry, and `main` always
 * records a coherent version. Publishing happens on merge (`.github/workflows/
 * publish.yml`, `scripts/release.mjs`); this gate keeps what it publishes honest.
 *
 * Design and rationale: `docs/design/release-gates.md`.
 *
 * ── WHAT IT CHECKS ──────────────────────────────────────────────────────────────
 * A. RELEASE INTEGRITY — always, needs no git history:
 *      1. CHANGELOG.md's first `##` heading is `## Unreleased` (where pull requests file
 *         their entries) or a release heading. The first RELEASE heading — the top one,
 *         or the one right under Unreleased — names a version.
 *      2. That version equals `package.json`'s: the newest version `main` records is the
 *         last one a pull request declared. Auto-patch releases are recorded on their
 *         `vX.Y.Z` tags, not on `main` (see `scripts/release.mjs`).
 *      3. `src/version.ts`'s `PARSEMAN_VERSION` equals `package.json`'s — the artifact
 *         stamp and the fuse-time version lock read it
 *         (`docs/design/artifact-format.md`).
 *
 * A'. PUBLISH INTEGRITY — with `--publish`, i.e. `prepublishOnly`:
 *      4. The top heading names `package.json`'s version: no `## Unreleased` left. The
 *         publish workflow stamps the release into the tree before `npm publish`.
 *
 * B. ENTRY GATE — only with `--base=<ref>`, i.e. in a pull request:
 *      5. If the change touches what the package SHIPS, it adds an entry under
 *         `## Unreleased` (or under the version it declares). "Ships" is decided by npm:
 *         the changed paths `npm pack` would include under `files`, plus the build
 *         inputs that decide `dist/`, plus the package.json fields a consumer receives.
 *         A version-stamp-only change to `src/version.ts` is not a change.
 *      6. package.json's version never goes DOWN against the base. A pull request may
 *         raise it to declare a minor or a major; it never has to.
 *
 *    Everything else — tests, benches, examples, fixtures, scripts, docs, notes, CI
 *    config, lockfile — is exempt, because none of it can change what a consumer
 *    installs. That exemption is the whole reason this gate can be required: a gate
 *    that fires on a typo fix in a comment gets bypassed, and then the gates that
 *    matter get bypassed with it.
 *
 * D. PEAK-RECORD GATE — only with `--base=<ref>`, on EVERY PR:
 *      7. Every `peak` block is structurally valid, and any EDIT to one is named in an
 *         entry this PR adds — backward moves and widened allowances called out by
 *         name. This governs MOVING the bar. See `docs/design/perf-gates.md`.
 *
 * D'. PEAK-CLAUSE WAIVER — only with `--base=<ref>`, on EVERY PR:
 *      8. A `PERF-PEAK-WAIVER` line in the CHANGELOG's open section lets a DELIBERATE,
 *         BOUGHT drawdown past `pnpm perf:workloads:peak` WITHOUT moving the bar. This
 *         governs LANDING UNDER it. It must name a gate config that has a peak, quote
 *         the measured median AND min, quote numbers that are actually a breach, give a
 *         reason, be ABSENT from the base's CHANGELOG (per-PR, non-sticky), and not be
 *         combined with an edit to the same config's `peak`.
 *
 * The perf gates' `referenceSha` used to be checked here too, on release PRs, because a
 * hand-kept anchor went stale for ten releases. The gates now resolve the previous
 * release from the `v*` tags at run time (`previousRelease` in `bench/ab-harness.ts`),
 * so there is nothing left to keep fresh.
 *
 * ── THE ESCAPE HATCHES ──────────────────────────────────────────────────────────
 * `--exempt` waives B only, and is wired to the `release-exempt` PR label so the
 * waiver is visible on the PR itself rather than buried in a `--no-verify`. It exists
 * for a REVERT (the version may go down, the entry may be a removal) and for a CHAINED
 * PR whose entry lives in the PR underneath it.
 *
 * `PERF-PEAK-WAIVER` waives the PEAK CLAUSE's verdict only (D'), never D's requirement
 * to document a peak edit, and never A or B. See `scripts/peak-waiver.mjs`.
 *
 * A never has a hatch.
 *
 * Usage:
 *   node scripts/check-changelog.mjs                  # A only (local preflight)
 *   node scripts/check-changelog.mjs --publish        # A + A' (prepublishOnly)
 *   node scripts/check-changelog.mjs --base=<ref>     # A + B + D + D' (pull request)
 *   node scripts/check-changelog.mjs --base=<ref> --exempt
 *   node scripts/check-changelog.mjs --root=<dir>     # point at another checkout
 *
 * Exit code 0 = releasable, 1 = not.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { parsePeakWaivers, openSection, isBreach, WAIVER_TAG } from './peak-waiver.mjs'
import {
  parseVersion, compareVersions, headingVersion, pendingEntries, shippedPaths, UNRELEASED,
  consumerFieldChanges, staleEntries, staleDeclaration,
} from './release.mjs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (hit === undefined) return undefined
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}

const rootFlag = flag('root')
const ROOT = typeof rootFlag === 'string' ? resolve(rootFlag) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = typeof flag('base') === 'string' ? flag('base') : undefined
const EXEMPT = flag('exempt') !== undefined
const PUBLISH = flag('publish') !== undefined

const PKG_PATH = resolve(ROOT, 'package.json')
const CHANGELOG_PATH = resolve(ROOT, 'CHANGELOG.md')
const VERSION_TS_PATH = resolve(ROOT, 'src/version.ts')

const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

/**
 * Files that decide what `dist/` CONTAINS, without being in it. `src/**` is the input
 * to the build; these are the build. A change to the build script — which drives
 * esbuild inline — can change every shipped byte while `src/` and `package.json` sit
 * still. `npm pack` cannot see them because they are not packed, so they are named.
 *
 * `tsconfig.json` is here for an INHERITED reason: the shipped declarations come from
 * `tsc -p tsconfig.build.json`, which `extends` the root config, so its compiler
 * options reach `dist/*.d.ts` through the extends chain.
 *
 * The publish workflow does not rely on this list: it compares the built tarball with
 * the published one (`scripts/release.mjs plan`). This is the cheap, install-free
 * pull-request approximation of that comparison.
 */
const BUILD_INPUTS = ['scripts/build.mjs', 'tsconfig.build.json', 'tsconfig.json']

// ── A. Release integrity ────────────────────────────────────────────────────────

if (!existsSync(PKG_PATH)) fail(`package.json not found at ${PKG_PATH}.`)

let pkg
try {
  pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
} catch {
  fail(`${PKG_PATH} is not valid JSON.`)
}
const version = pkg.version

if (typeof version !== 'string') fail('package.json has no "version".')

if (!existsSync(CHANGELOG_PATH)) fail(`CHANGELOG.md not found — cannot release ${version}.`)

const changelog = readFileSync(CHANGELOG_PATH, 'utf8')

const headings = [...changelog.matchAll(/^##\s+.+$/gm)].map((m) => m[0])
if (headings.length === 0) fail('CHANGELOG.md has no `##` release heading at all.')

const unreleased = headings[0].replace(/^##\s+/, '').trim() === UNRELEASED
const releaseHeading = unreleased ? headings[1] : headings[0]
const newest = releaseHeading === undefined ? null : headingVersion(releaseHeading)

if (newest === null) {
  fail(
    `CHANGELOG.md's ${unreleased ? 'heading under `## Unreleased`' : 'top heading'} is ` +
      `"${releaseHeading ?? '(none)'}", which names no version.\n` +
      `  Pull requests file their entries under "## ${UNRELEASED}" at the top; the heading below it\n` +
      `  is the newest release main records, "## ${version} — <date>".`,
  )
}

if (newest !== version) {
  fail(
    `CHANGELOG.md's newest release heading is ${newest} but package.json says ${version}.\n` +
      '  They name the same version: a pull request that declares a new version sets package.json,\n' +
      '  src/version.ts and the heading together. Pending changes go under "## Unreleased".',
  )
}

if (PUBLISH && unreleased) {
  fail(
    `cannot publish with "## ${UNRELEASED}" on top of CHANGELOG.md.\n` +
      '  The publish workflow stamps the release first (`node scripts/release.mjs stamp <version>`),\n' +
      '  which names that section and sets package.json and src/version.ts.',
  )
}

// A MISSING src/version.ts is a harder failure than a mis-stamped one. Deleting the file
// must not satisfy the rule by removing one of the things it compares. The one place
// absence is legitimate is a checkout with no `src/` at all — the fixture repos in
// `test/unit/release-gate.test.ts`.
if (!existsSync(VERSION_TS_PATH) && existsSync(resolve(ROOT, 'src'))) {
  fail(
    'src/version.ts is missing, but src/ exists. PARSEMAN_VERSION is the ARTIFACT VERSION\n' +
      '  LOCK (docs/design/artifact-format.md) — every generated artifact is stamped with it and\n' +
      '  `fusedBody` refuses to link across a mismatch. Absent, there is nothing to converge on,\n' +
      '  and this gate would have passed by having one less thing to check.',
  )
}

const STAMP = /PARSEMAN_VERSION\s*=\s*['"]([^'"]+)['"]/

if (existsSync(VERSION_TS_PATH)) {
  const stamp = STAMP.exec(readFileSync(VERSION_TS_PATH, 'utf8'))
  if (!stamp) fail('src/version.ts does not define PARSEMAN_VERSION.')
  if (stamp[1] !== version) {
    fail(
      `src/version.ts stamps ${stamp[1]} but package.json says ${version}.\n` +
        `  These are bumped TOGETHER: PARSEMAN_VERSION goes into every generated-artifact\n` +
        `  banner and is read by the fuse-time version lock, so a drift mis-stamps\n` +
        `  artifacts or rejects valid same-version links.`,
    )
  }
}

// 4b. A version a release already shipped carries only what that release shipped. The
// pull-request half of the publish plan's stop (`staleEntries` in release.mjs): a PR that
// declared X, then saw another merge ship X, fails here when its CI next runs rather than
// at publish. Needs the `vX.Y.Z` tag, which CI's `fetch-depth: 0` checkout brings; with no
// tag there is nothing to compare.
{
  let tagged = null
  try {
    tagged = execFileSync('git', ['show', `v${version}:CHANGELOG.md`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    tagged = null
  }
  const stale = tagged === null ? [] : staleEntries(changelog, version, tagged)
  if (stale.length > 0) fail(staleDeclaration(version, stale))
}

console.log(
  unreleased
    ? `✓ CHANGELOG.md files pending changes under ${UNRELEASED}, above ${version}; package.json and src/version.ts agree.`
    : `✓ CHANGELOG.md's top section is ${version}, matching package.json and src/version.ts.`,
)

// ── B. Entry gate (set-up) ──────────────────────────────────────────────────────

if (BASE === undefined) process.exit(0)

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

let baseSha
try {
  // Prefer the merge base: it is where this branch actually diverged, so a base
  // branch that moved on underneath the PR cannot manufacture a diff.
  baseSha = git('merge-base', BASE, 'HEAD')
} catch {
  try {
    baseSha = git('rev-parse', BASE)
  } catch {
    fail(
      `cannot resolve --base=${BASE}.\n` +
        `  This gate needs the base commit present. In CI, check out with fetch-depth: 0.`,
    )
  }
}

const changed = git('diff', '--name-only', baseSha, 'HEAD').split('\n').filter(Boolean)

if (changed.length === 0) {
  console.log('✓ nothing changed against the base — no entry required.')
  process.exit(0)
}

const showAtBase = (file) => {
  try {
    return git('show', `${baseSha}:${file}`)
  } catch {
    return null
  }
}

let basePkg
try {
  basePkg = JSON.parse(showAtBase('package.json') ?? '{}')
} catch {
  basePkg = {}
}
const baseVersion = typeof basePkg.version === 'string' ? basePkg.version : null
const baseChangelog = showAtBase('CHANGELOG.md') ?? ''

// The entries this PR ADDS to the section being released. Diffed against the base's
// pending entries, because `main`'s Unreleased can still hold entries an auto-patch
// already shipped: "the section is non-empty" would pass a PR that wrote nothing.
const basePending = new Set(pendingEntries(baseChangelog, baseVersion))
const added = pendingEntries(changelog, baseVersion).filter((e) => !basePending.has(e))
const sectionName = unreleased ? UNRELEASED : version

// The heading section only — history must not be able to satisfy a check about a
// change being made now. Used by the waiver rule (§D').
const currentSection = openSection(changelog)

// ── D. Peak-record gate ─────────────────────────────────────────────────────────
//
// The perf gates' per-step comparison enforces one half of the release policy: each
// release is measured against the one before it. This enforces the other half.
//
// A per-step gate has a blind spot that matters directly under "each release must be
// faster than the last": five consecutive 1% losses are each inside the noise floor,
// no step gets flagged, and the sum is a real 5% regression. The standalone version
// sweep measured exactly that — −5.1% over 0.28.0→0.34.0 with almost every individual
// step insignificant. So each gate config may carry a `peak` block naming the fastest
// release on record, and `pnpm perf:workloads --peak` fails on a drawdown beyond its
// allowance.
//
// That record is only worth having if it cannot move quietly. Two configs carried
// "bump this anchor at every release" in a COMMENT and it was missed for ten
// consecutive releases; a comment asking a human to keep the peak honest would go the
// same way. So: any edit to a `peak` block must be named in an entry the PR adds, and the two edits that launder a regression into the baseline — moving
// the peak BACKWARD, or widening its allowance — are called out by name.
//
// It runs on EVERY PR: a peak can be moved at any time, and the moment it matters is
// the moment it moves.

/** The gate configs that may carry a `peak` block. A config that is absent is skipped. */
const PEAK_GATES = [
  { config: 'bench/grammar-density/config.json' },
  { config: 'bench/workloads/config.json' },
]

const peakGateConfigs = PEAK_GATES.filter((g) => existsSync(resolve(ROOT, g.config)))

const readPeak = (source, label) => {
  let cfg
  try {
    cfg = JSON.parse(source)
  } catch {
    fail(`${label} is not valid JSON — cannot read its perf-gate peak record.`)
  }
  return cfg.peak ?? null
}

const peakEdits = []
for (const gate of peakGateConfigs) {
  const now = readPeak(readFileSync(resolve(ROOT, gate.config), 'utf8'), gate.config)
  if (now === null) continue

  // Structural validation: a malformed peak record is a gate that silently does not
  // gate, which is the failure mode this whole file exists to prevent.
  if (typeof now.sha !== 'string' || now.sha.length < 7) {
    fail(`${gate.config}: \`peak.sha\` must name a commit (got ${JSON.stringify(now.sha)}).`)
  }
  if (typeof now.version !== 'string' || !parseVersion(now.version)) {
    fail(`${gate.config}: \`peak.version\` must name the release at \`peak.sha\` (got ${JSON.stringify(now.version)}).`)
  }
  if (typeof now.allowancePct !== 'number' || !(now.allowancePct > 0)) {
    fail(`${gate.config}: \`peak.allowancePct\` must be a positive number (got ${JSON.stringify(now.allowancePct)}).`)
  }
  try {
    git('rev-parse', '--verify', `${now.sha}^{commit}`)
  } catch {
    fail(
      `${gate.config}: \`peak.sha\` ${now.sha} is not a commit in this repository.\n` +
        '  The peak clause re-measures against that COMMIT — an absolute baseline, not a stored\n' +
        '  millisecond count — so an unresolvable sha is a gate that cannot run. In CI this needs\n' +
        '  `fetch-depth: 0`.',
    )
  }

  let before = null
  try {
    before = readPeak(git('show', `${baseSha}:${gate.config}`), `${gate.config} at ${baseSha.slice(0, 7)}`)
  } catch {
    // The config is new on this branch. A brand-new peak record is still an edit.
  }
  if (before === null) {
    peakEdits.push({ ...gate, kind: 'introduced', detail: `peak ${now.version} (${now.sha.slice(0, 7)}), allowance ${now.allowancePct}%` })
    continue
  }
  if (before.sha === now.sha && before.allowancePct === now.allowancePct && before.version === now.version) continue

  const widened = now.allowancePct > before.allowancePct
  const beforeV = parseVersion(before.version)
  const nowV = parseVersion(now.version)
  const movedBack = beforeV && nowV && compareVersions(nowV, beforeV) < 0
  peakEdits.push({
    ...gate,
    kind: widened || movedBack ? 'LAUNDERING RISK' : 'moved',
    detail:
      `${before.version} (${String(before.sha).slice(0, 7)}) allowance ${before.allowancePct}%` +
      ` → ${now.version} (${now.sha.slice(0, 7)}) allowance ${now.allowancePct}%` +
      (movedBack ? '   [peak moved BACKWARD]' : '') +
      (widened ? '   [allowance WIDENED]' : ''),
  })
}

if (peakEdits.length > 0) {
  // An entry this PR adds: a stale entry still sitting under Unreleased cannot vouch for it.
  const mentionsPeak = /\bpeak\b/i.test(added.join('\n'))

  if (!mentionsPeak) {
    fail(
      `this PR edits a perf-gate PEAK RECORD and no entry it adds under ${sectionName} mentions it:\n` +
        '\n' +
        peakEdits.map((e) => `    ${e.config}\n      ${e.kind}: ${e.detail}`).join('\n') +
        '\n\n' +
        '  The peak record is the committed answer to "what is the fastest this has ever been", and\n' +
        '  it is what makes the drawdown clause an ABSOLUTE bar rather than a differential one. A\n' +
        '  differential bar is the thing that failed: every release compared to the one before it can\n' +
        '  pass forever while the curve bleeds down, because each individual step sits inside the\n' +
        '  noise floor. The sweep measured -5.1% accumulating that way across 0.28.0 -> 0.34.0.\n' +
        '\n' +
        '  Moving the peak FORWARD is the good case — a real improvement becoming the new bar. Say so.\n' +
        '  Moving it BACKWARD, or widening `allowancePct`, means a slower build is being made the\n' +
        '  reference. That may be legitimate — a correctness fix that costs time is a real trade — but\n' +
        '  it is exactly the edit that launders a regression into the baseline, so it gets written down\n' +
        '  with the numbers that justified it.\n' +
        '\n' +
        `  Fix: add a line to the ${sectionName} section naming the peak change and the measurement\n` +
        '  behind it (run `pnpm perf:workloads --peak` and quote it, load average included).\n' +
        '\n' +
        '  If you are NOT trying to re-baseline — the drawdown is deliberate and bought something,\n' +
        '  and you want the peak to STAY where it is — do not move it at all. Revert the change to\n' +
        `  the \`peak\` block and declare a per-PR waiver in the ${sectionName} section instead:\n` +
        '\n' +
        `    ${WAIVER_TAG} bench/workloads/config.json median -164.9% min -158.2% — <why this cost buys something>\n` +
        '\n' +
        '  That lands the breach WITH THE NUMBER VISIBLE and leaves the record intact, which is what\n' +
        '  docs/design/perf-gates.md asks for. It is spent on this PR only. See §D of that document.\n' +
        '\n' +
        '  This check has no hatch — `release-exempt` does not waive it.',
    )
  }

  for (const e of peakEdits) console.log(`✓ peak record ${e.kind} in ${e.config} and named in the CHANGELOG — ${e.detail}`)
}
else if (peakGateConfigs.some((g) => readPeak(readFileSync(resolve(ROOT, g.config), 'utf8'), g.config) !== null)) {
  console.log('✓ perf-gate peak records unchanged.')
}

// ── D'. Peak-clause WAIVER ──────────────────────────────────────────────────────
//
// §D above governs MOVING the bar. This governs LANDING UNDER IT without moving it.
//
// `docs/design/perf-gates.md` closes with the disposition: "Do not widen the threshold
// to make a build pass. Either fix the regression, or land it with the number visible."
// Only the first two of those were ever executable — a deliberate, bought slowdown had
// exactly one route past a red `pnpm perf:workloads:peak`, and that route was to edit
// `peak` or widen `allowancePct`, i.e. to make the slower build the reference. §D calls
// that "LAUNDERING RISK" by name. It permanently destroys the record to get one PR out.
//
// So: the third option, executed. A PR may declare, in the CHANGELOG's open section,
//
//   PERF-PEAK-WAIVER bench/workloads/config.json median -164.9% min -158.2% — <why>
//
// and `bench/workload-perf-guard.ts --peak --base=<ref>` will print its full drawdown
// report and then exit 0 instead of 1. Everything about it is deliberately loud:
//
//   - It is IMPOSSIBLE to write without stating the measured numbers, and the numbers
//     must themselves be a breach of `allowancePct`. You cannot waive a gate without
//     saying how badly you failed it. That is the sentence in perf-gates.md, enforced.
//   - It is PER-PR and NON-STICKY. The line must be ABSENT from the base's CHANGELOG.
//     The next PR inherits the text, so the identical line waives nothing and that PR
//     must re-measure. A waiver is spent on the diff that declares it.
//   - It DOES NOT MOVE THE BASELINE. Waiving and re-anchoring are mutually exclusive —
//     a PR that does both is refused. The breach stays on the record, against the same
//     peak, for everyone after.
//   - A malformed attempt FAILS rather than being ignored. A waiver that does not parse
//     is a contributor who believes they have waived the gate.
//
// It is NOT `release-exempt` and deliberately does not extend it: that label's scope is
// §B only, and widening it is precisely the bypassed-gate failure release-gates.md warns
// about.

const waivers = parsePeakWaivers(currentSection)

if (waivers.length > 0) {
  const peakOf = new Map()
  for (const gate of peakGateConfigs) {
    const p = readPeak(readFileSync(resolve(ROOT, gate.config), 'utf8'), gate.config)
    if (p !== null) peakOf.set(gate.config, p)
  }

  for (const w of waivers) {
    const problems = [...w.problems]

    const peak = w.config === null ? null : peakOf.get(w.config) ?? null
    if (w.config !== null && peak === null) {
      problems.push(
        `names ${w.config}, which carries no \`peak\` block in this checkout — there is no peak clause to waive`,
      )
    }

    if (peak !== null && !isBreach(w, peak.allowancePct)) {
      problems.push(
        `quotes median ${w.medianPct}% / min ${w.minPct}%, which is INSIDE ${w.config}'s`
          + ` ${peak.allowancePct}% allowance — the peak clause breaches on median AND min BOTH beyond it,`
          + ' so this waives nothing. Quote the numbers the gate actually printed.',
      )
    }

    if (baseChangelog.includes(w.line)) {
      problems.push(
        'is ALREADY PRESENT on the base branch, so it is not this PR\'s. A waiver is per-PR and does'
          + ' not carry: re-run `pnpm perf:workloads:peak` and state THIS diff\'s measurement.',
      )
    }

    const alsoEdited = peakEdits.find((e) => e.config === w.config)
    if (alsoEdited !== undefined) {
      problems.push(
        `also EDITS ${w.config}'s peak block in the same PR (${alsoEdited.detail}). Waiving and`
          + ' re-anchoring are mutually exclusive — a waiver exists precisely so the bar does NOT move.'
          + ' Pick one: move the peak (§D) or land under it with the number visible (this).',
      )
    }

    if (problems.length > 0) {
      fail(
        `this PR declares a ${WAIVER_TAG} that is not usable:\n` +
          `\n    ${w.line}\n\n` +
          problems.map((p) => `  - it ${p}`).join('\n') +
          '\n\n' +
          '  The form is:\n' +
          '\n' +
          `    ${WAIVER_TAG} <gate config> median <n>% min <n>% — <why this cost buys something>\n` +
          '\n' +
          '  This hatch is deliberately hard to use. It is the executable form of the closing rule in\n' +
          '  docs/design/perf-gates.md — "either fix the regression, or land it with the number\n' +
          '  visible" — and it is worth having only while it cannot be reached for quietly. A waiver\n' +
          '  that parses loosely is a gate that has been switched off.\n' +
          '\n' +
          '  If you meant to re-baseline instead, move `peak` and name the move in the CHANGELOG (§D).',
      )
    }
  }

  for (const w of waivers) {
    const peak = peakOf.get(w.config)
    const over = (n) => `${(Math.abs(n) / peak.allowancePct).toFixed(1)}x`
    console.log(
      `⚠ PEAK CLAUSE WAIVED for ${w.config} — declared drawdown median ${w.medianPct}% / min ${w.minPct}%,`
        + ` against peak ${peak.version} (${String(peak.sha).slice(0, 7)}) allowance ${peak.allowancePct}%`
        + ` — ${over(w.medianPct)} and ${over(w.minPct)} the allowance.\n`
        + `    reason: ${w.reason}\n`
        + `    The peak record is UNCHANGED and is NOT raised by this: ${peak.version} stays the bar and the\n`
        + '    next PR is measured against it. This waiver is spent on this diff — the identical line on\n'
        + '    the base waives nothing. A waived breach is still a breach on the record.',
    )
  }
}

// ── B. Entry gate ───────────────────────────────────────────────────────────────

const headPv = parseVersion(version)
const basePv = baseVersion === null ? null : parseVersion(baseVersion)
if (headPv !== null && basePv !== null && compareVersions(headPv, basePv) < 0) {
  if (!EXEMPT) {
    fail(
      `package.json goes DOWN, from ${baseVersion} to ${version}.\n` +
        '  A pull request may raise the version to declare a minor or a major, never lower it.\n' +
        '  If this reverts a release, add the `release-exempt` label to the PR.',
    )
  }
  console.log(`⚠ VERSION GOES DOWN (${baseVersion} → ${version}) — waived by \`release-exempt\`.`)
}

// `src/version.ts` changing only its PARSEMAN_VERSION literal is the version moving,
// which the publish decides; anything else in it ships like the rest of src/.
const stampOnly = (file) => {
  const before = showAtBase(file)
  if (before === null || !existsSync(resolve(ROOT, file))) return false
  // `git()` trims its output, so both sides are trimmed.
  const strip = (text) => text.replace(STAMP, 'PARSEMAN_VERSION = ""').trim()
  return strip(before) === strip(readFileSync(resolve(ROOT, file), 'utf8'))
}

const shipped = shippedPaths(pkg, changed).filter((f) => !(f === 'src/version.ts' && stampOnly(f)))
const buildTouched = changed.filter((f) => BUILD_INPUTS.includes(f))

const pkgSurfaceChanged = changed.includes('package.json') ? consumerFieldChanges(basePkg, pkg) : []

if (shipped.length === 0 && buildTouched.length === 0 && pkgSurfaceChanged.length === 0) {
  console.log(
    `✓ nothing the package ships changed (${changed.length} file(s): none packed by \`files\`, no build\n` +
      '  input, no consumer-facing package.json field) — no CHANGELOG entry required.',
  )
  process.exit(0)
}

const why = [
  shipped.length > 0 ? `${shipped.length} packed file(s) (${shipped.slice(0, 3).join(', ')}${shipped.length > 3 ? ', …' : ''})` : null,
  buildTouched.length > 0 ? `build input ${buildTouched.join(', ')}` : null,
  pkgSurfaceChanged.length > 0 ? `package.json ${pkgSurfaceChanged.join(', ')}` : null,
].filter(Boolean).join(' and ')

if (added.length > 0) {
  console.log(`✓ the shipped package changed (${why}) and this PR adds ${added.length} entr${added.length === 1 ? 'y' : 'ies'} under ${sectionName}.`)
  process.exit(0)
}

if (EXEMPT) {
  console.log(
    `⚠ ENTRY GATE WAIVED — the shipped package changed (${why}) and this PR adds no CHANGELOG\n` +
      '  entry, but the `release-exempt` label is set. Valid only for a revert, or a chained PR\n' +
      '  whose entry lives in the PR underneath it.',
  )
  process.exit(0)
}

fail(
  `this PR changes what the package ships (${why}) but adds no CHANGELOG entry.\n` +
    '\n' +
    `  Add one under "## ${UNRELEASED}" at the top of CHANGELOG.md (create the heading if it is not\n` +
    `  there). Merging publishes: the next patch by default, named after this section. To ship\n` +
    '  a minor or a major instead, name that version in the heading and set package.json and\n' +
    '  src/version.ts to it in this PR.\n' +
    '\n' +
    '  Pre-1.0, a behaviour change goes in the MINOR (this project has said so since 0.1.0;\n' +
    "  see CHANGELOG.md's preamble).\n" +
    '\n' +
    '  If the entry genuinely belongs elsewhere — you are reverting, or this PR is chained on one\n' +
    '  that carries it — add the `release-exempt` label to the PR.',
)
