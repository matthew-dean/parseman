#!/usr/bin/env node
/**
 * Release gate — a change lands ALREADY RELEASABLE, or it does not land.
 *
 * Design and rationale: `docs/design/release-gates.md`.
 *
 * ── WHY THIS MOVED LEFT ─────────────────────────────────────────────────────────
 * This script used to run only as `prepublishOnly`, and only asked "does CHANGELOG.md
 * mention the version in package.json, anywhere?". Both properties were wrong:
 *
 *   - Running at PUBLISH time is far too late. Every PR was free to leave `main` in a
 *     merged-but-unreleasable state, and the first person to notice was whoever tried
 *     to ship. Three consecutive releases went out that way.
 *   - "anywhere in the file" passes trivially while a `## Unreleased` section sits on
 *     top holding the change that was never versioned. That is exactly how 0.36.0's
 *     content sat on `main` under a heading that names no version.
 *
 * So the check now runs on every PR (see `.github/workflows/ci.yml`, job
 * `release-gate`) and asserts the two things that make `main` shippable at all times.
 *
 * ── MERGING IS NOT PUBLISHING ───────────────────────────────────────────────────
 * The gate used to compare the head version against THE BASE BRANCH's: any PR touching
 * `src/**` had to bump `package.json`. That made a version number the price of MERGING,
 * and it contradicts how this project actually spends numbers.
 *
 * Numbers are spent at PUBLISH. When several PRs merge between two releases, a
 * bump-per-merge burns one number per PR and only the last one ever ships — every
 * earlier number collapses into it. That is not hypothetical: 0.37 through 0.41 were
 * bumped and never published, and all of that work went out as one 0.37.0. The gate was
 * manufacturing exactly the waste it looks like discipline.
 *
 * Worse, the two halves contradicted each other. A had to hold on `main` at all times,
 * so a PR that could not bump was forced to file its entry under a heading naming an
 * ALREADY PUBLISHED version — documenting changes into a release that demonstrably does
 * not contain them. The only way out was the `release-exempt` label, on a PR that is
 * neither a revert nor chained, which is a lie in a place reviewers read.
 *
 * So the invariant is now CHANGELOG-relative rather than branch-relative: `main` always
 * carries an open section naming the NEXT, unpublished version, and every PR files into
 * it. The number is spent once per release cycle, by whoever publishes, no matter how
 * many PRs land into that cycle. `--publish` is where the numbers must all agree, which
 * is the moment they actually have to.
 *
 * ── WHAT IT CHECKS ──────────────────────────────────────────────────────────────
 * A. RELEASE INTEGRITY — always, needs no git history:
 *      1. CHANGELOG.md's FIRST `##` heading names a real version, never `Unreleased`.
 *         The version it names is the RELEASE UNDER CONSTRUCTION.
 *      2. It is >= `package.json`'s version — equal when nothing unreleased is pending,
 *         greater when a section is open. Never lower: that is history being rewritten.
 *      3. `src/version.ts`'s `PARSEMAN_VERSION` equals `package.json`'s — the artifact
 *         stamp and the fuse-time version lock read it
 *         (`docs/design/artifact-format.md`). These two move together, at publish.
 *
 * A'. PUBLISH INTEGRITY — with `--publish`, i.e. `prepublishOnly`:
 *      4. The heading, `package.json` and `src/version.ts` must be EQUAL. This is the
 *         moment the number is spent, and the moment they all have to agree.
 *
 * B. BUMP GATE — only with `--base=<ref>`, i.e. in a pull request:
 *      5. If the change touches the PUBLISHED SURFACE (`src/**`, or a package.json
 *         field a consumer receives), the release under construction must be a version
 *         that is NOT yet published — i.e. the top heading is strictly above
 *         `package.json`. Opening that section is a one-time cost per release cycle,
 *         not a per-PR one.
 *
 * C. BENCH ANCHOR GATE — only with `--base=<ref>`, and only on a RELEASE PR:
 *      6. Every perf gate's `referenceSha` must name the PREVIOUS RELEASE — the
 *         first-parent commit on the base branch that set `package.json` to the
 *         version the base publishes. See `docs/design/perf-gates.md`.
 *
 *    Both config files have said "bump this at every release, in the release PR"
 *    in a JSON comment since they were written, and both were missed for TEN
 *    releases: `bench/grammar-density/config.json` still pointed at v0.33.0 and
 *    `bench/workloads/config.json` at v0.35.0 when 0.45.0 was prepped. A gate
 *    anchored ten releases back still reads `ok` — it just measures against a
 *    baseline that has already absorbed every regression since, so the accumulated
 *    headroom becomes the error bar. `rollback/dense` sat at -62% against v0.33.0:
 *    a fresh change could have made that path 2.6x SLOWER and the gate would have
 *    said `ok`. The absolute-baseline rule was satisfied in letter while its
 *    RESOLUTION was destroyed, silently, and nothing in the repo noticed.
 *
 *    A policy in a comment that depends on a human remembering it is not a policy.
 *    This is that policy, executed. It fires only on a release PR, which is the one
 *    PR where the bump is due, so ordinary PRs never see it.
 *
 *    It has NO hatch, including `--exempt`. The correct response to it going red is
 *    to bump the anchor, and then to report whatever the newly-strict gate surfaces.
 *    Re-anchoring to a newer baseline makes a gate STRICTER and may expose a
 *    regression the stale anchor was hiding — that is the gate working. Both configs
 *    already say it: "Do NOT bump it to silence a red gate."
 *
 *    Everything else — tests, benches, examples, fixtures, scripts, docs, notes,
 *    CI config, lockfile, tsconfig — is exempt, because none of it can change what a
 *    consumer installs. That exemption is the whole reason this gate can be required:
 *    a gate that fires on a typo fix in a comment gets bypassed, and then the gates
 *    that matter get bypassed with it.
 *
 * ── THE ESCAPE HATCH ────────────────────────────────────────────────────────────
 * `--exempt` waives B only, and is wired to the `release-exempt` PR label so the
 * waiver is visible on the PR itself rather than buried in a `--no-verify`. It exists
 * for the two cases where "version must go up" is genuinely wrong: a REVERT of a
 * release, and a CHAINED PR whose bump lives in the PR underneath it.
 *
 * A never has a hatch. `Unreleased` is not a state this repo ships from.
 *
 * Usage:
 *   node scripts/check-changelog.mjs                  # A only (local preflight)
 *   node scripts/check-changelog.mjs --publish        # A + A' (prepublishOnly)
 *   node scripts/check-changelog.mjs --base=<ref>     # A + B + C (pull request)
 *   node scripts/check-changelog.mjs --base=<ref> --exempt
 *   node scripts/check-changelog.mjs --root=<dir>     # point at another checkout
 *
 * Exit code 0 = releasable, 1 = not.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

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
 * Fields a CONSUMER receives. A diff that touches any of these changes the installed
 * package even when `src/` is untouched — adding an export, dropping a dependency,
 * widening `engines`. `version` is excluded on purpose: it is the bump itself, not a
 * reason to require one.
 */
const PUBLISHED_PKG_FIELDS = [
  'name', 'type', 'main', 'module', 'types', 'exports', 'files', 'bin',
  'dependencies', 'peerDependencies', 'optionalDependencies', 'engines', 'license',
]

/**
 * The lifecycle hooks npm runs on a CONSUMER's machine — `preinstall`/`install`/
 * `postinstall` when parseman is installed as a dependency, and `prepare` when it is
 * installed from a git URL. Changing one changes what executes on install, which is
 * a consumer-visible change even when nothing in `src/` moved.
 *
 * Only these four, not the whole `scripts` object: `test`, `lint`, `bench:*` and
 * friends churn constantly and reach nobody, and a gate that demanded a release for
 * renaming a bench script is exactly the noise this design refuses to introduce.
 */
const CONSUMER_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

const lifecycleProjection = (pkgJson) =>
  CONSUMER_LIFECYCLE_SCRIPTS.map((k) => `${k}=${pkgJson?.scripts?.[k] ?? ''}`).join('\n')

/**
 * Files that decide what `dist/` CONTAINS, without being in it. `src/**` is the input
 * to the build; these are the build. A change to the build script — which drives
 * esbuild inline — can change every shipped byte: different externals, a dropped
 * entry point, a changed target, while `src/` and `package.json` sit still, and a
 * rule that only watched `src/` would call that "no published surface changed".
 *
 * Named individually rather than exempting `scripts/` wholesale: the rest of that
 * directory (this file, the coverage guard, the doc verifier) is CI machinery that
 * reaches no consumer.
 *
 * `tsconfig.json` is here for an INHERITED reason, not a direct one. The shipped
 * declarations come from `tsc -p tsconfig.build.json` (see `scripts/build.mjs`), and
 * `tsconfig.build.json` is four lines that `extends` the root config — so `target`,
 * `lib`, `strict`, `exactOptionalPropertyTypes` and friends reach `dist/*.d.ts`
 * through the extends chain. Watching only the file that does the extending would
 * let a consumer-visible change to the emitted types merge unbumped.
 */
const BUILD_INPUTS = ['scripts/build.mjs', 'tsconfig.build.json', 'tsconfig.json']

/** Parse `1.2.3` / `v1.2.3-rc.1` into comparable parts, or `null` if it isn't one. */
const parseVersion = (raw) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null, raw: m[0].replace(/^v/, '') }
}

/**
 * SemVer §11 precedence for the dot-separated identifiers of a prerelease tag.
 * Numeric identifiers compare NUMERICALLY, so `rc.10` is above `rc.2`; a plain string
 * comparison puts it below and would read a legitimate advance as a downgrade.
 * Numeric sorts below alphanumeric, and when one set is a prefix of the other the
 * longer one wins.
 */
const comparePrerelease = (a, b) => {
  const x = a.split('.')
  const y = b.split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    if (x[i] === y[i]) continue
    const xNum = /^\d+$/.test(x[i])
    const yNum = /^\d+$/.test(y[i])
    if (xNum && yNum) return +x[i] < +y[i] ? -1 : 1
    if (xNum !== yNum) return xNum ? -1 : 1
    return x[i] < y[i] ? -1 : 1
  }
  return 0
}

/** −1 / 0 / 1. A prerelease sorts BELOW its release, per semver. */
const compareVersions = (a, b) => {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return comparePrerelease(a.pre, b.pre)
}

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

// The FIRST level-2 heading is the release under construction. Anything below it is
// history. Tolerate `## [v0.36.0] - …` as well as `## 0.36.0 — …`.
const firstHeading = /^##\s+(.+)$/m.exec(changelog)
if (!firstHeading) fail('CHANGELOG.md has no `##` release heading at all.')

const headingText = firstHeading[1].trim()
const headingToken = headingText.replace(/^\[/, '').split(/[\s\]]/)[0]
const headingVersion = parseVersion(headingToken)

if (!headingVersion) {
  fail(
    `CHANGELOG.md's top section is "## ${headingText}", which names no version.\n` +
      `  Every change lands released: rename it to "## ${version} — <date>" and bump\n` +
      `  package.json + src/version.ts to match. "Unreleased" is not a state this repo\n` +
      `  ships from, and it is not a state main is allowed to sit in.`,
  )
}

const headingVsPkg = compareVersions(headingVersion, parseVersion(version) ?? headingVersion)

if (headingVsPkg < 0) {
  fail(
    `CHANGELOG.md's top section is ${headingVersion.raw} but package.json says ${version}.\n` +
      `  The top section can be AHEAD of package.json (a release under construction), never\n` +
      `  behind it — behind means history is being rewritten, or a published version lost\n` +
      `  its section.`,
  )
}

if (PUBLISH && headingVsPkg !== 0) {
  fail(
    `cannot publish: CHANGELOG.md's top section is ${headingVersion.raw} but package.json says ${version}.\n` +
      `  This is the moment the number is spent, so it is the moment they must agree. Bump\n` +
      `  package.json AND src/version.ts to ${headingVersion.raw} and date the heading.`,
  )
}

// A MISSING src/version.ts is a harder failure than a mis-stamped one, and used to be
// no failure at all: the whole convergence check sat behind `existsSync`, including
// under `--publish`, where A' says all three sites must be EQUAL. Deleting the file
// therefore satisfied the rule by removing one of the things it compares. Contrast
// package.json and CHANGELOG.md above, both of which `fail()` when absent.
//
// The one place absence is legitimate is a checkout that has no `src/` at all — the
// fixture repos in `test/unit/release-gate.test.ts` drive exactly that to cover the
// stamp rule's edges. So it is required whenever `src/` exists, which is every real
// checkout of this repo.
if (!existsSync(VERSION_TS_PATH) && existsSync(resolve(ROOT, 'src'))) {
  fail(
    'src/version.ts is missing, but src/ exists. PARSEMAN_VERSION is the ARTIFACT VERSION\n' +
      '  LOCK (docs/design/artifact-format.md) — every generated artifact is stamped with it and\n' +
      '  `fusedBody` refuses to link across a mismatch. Absent, there is nothing to converge on,\n' +
      '  and this gate would have passed by having one less thing to check.',
  )
}

if (existsSync(VERSION_TS_PATH)) {
  const stamp = /PARSEMAN_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(readFileSync(VERSION_TS_PATH, 'utf8'))
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

console.log(
  headingVsPkg === 0
    ? `✓ CHANGELOG.md's top section is ${version}, matching package.json and src/version.ts.`
    : `✓ CHANGELOG.md has ${headingVersion.raw} open for construction over published ${version}`
      + ' (package.json and src/version.ts agree; they move together at publish).',
)

// ── B. Bump gate ────────────────────────────────────────────────────────────────

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
  console.log('✓ nothing changed against the base — no bump required.')
  process.exit(0)
}

const srcTouched = changed.filter((f) => f.startsWith('src/'))
const buildTouched = changed.filter((f) => BUILD_INPUTS.includes(f))

// Read unconditionally: the base's `version` is the LAST PUBLISHED marker for check B
// below, and that is needed whether or not this diff touches package.json at all.
let basePkg
try {
  basePkg = JSON.parse(git('show', `${baseSha}:package.json`))
} catch {
  basePkg = {}
}

const basePublished = typeof basePkg.version === 'string' ? parseVersion(basePkg.version) : null

// ── C. Bench anchor gate ────────────────────────────────────────────────────────
//
// Runs BEFORE B, and before B's early exits, so it cannot be skipped by a release PR
// that somehow reads as touching no published surface. It fires on RELEASE PRs only.

/**
 * The perf gates whose `referenceSha` must name the previous release. Each entry is
 * a config path relative to the repo root and the `pnpm` script that reads it. A gate
 * whose config is absent is skipped — this list is allowed to lead or trail the repo.
 */
const ANCHORED_GATES = [
  { config: 'bench/grammar-density/config.json', script: 'pnpm perf:guard:grammars' },
  { config: 'bench/workloads/config.json', script: 'pnpm perf:workloads' },
]

/**
 * The commit that RELEASED `version` on the base branch: walking first-parent back
 * from `baseSha`, the OLDEST commit in the contiguous run whose package.json reads
 * `version` — i.e. the commit that introduced it. First-parent, because the version
 * lives on the merge commit of the release PR and not on its constituent commits.
 * Oldest-in-run, because ordinary PRs merge after a release and carry the same number
 * forward; the release is where the number CHANGED.
 *
 * Verified against the two anchors that were set by hand: v0.33.0 resolves to 7f1ddcd
 * and v0.35.0 to 3562f78, which are exactly the values `bench/grammar-density` and
 * `bench/workloads` were given in their release PRs. The rule is the practice, written
 * down.
 *
 * Returns `null` only when the boundary is genuinely out of reach: the window filled
 * without the version ever changing, which means the history is truncated. Reaching
 * the ROOT still holding `atVersion` is not that — the version was introduced there.
 * A truncated history is a reason to say so, not to wave the release through.
 */
const WALK_LIMIT = 500

const releaseShaFor = (fromSha, atVersion) => {
  let candidate = null
  let walked
  try {
    walked = git('rev-list', '--first-parent', `--max-count=${WALK_LIMIT}`, fromSha).split('\n').filter(Boolean)
  } catch {
    return null
  }
  for (const sha of walked) {
    let v
    try {
      v = JSON.parse(git('show', `${sha}:package.json`)).version
    } catch {
      return candidate
    }
    if (v !== atVersion) return candidate
    candidate = sha
  }
  // Ran off the end still matching. Under the limit that end is the ROOT commit, so
  // `candidate` is where the version began; at the limit the history is truncated.
  return walked.length < WALK_LIMIT ? candidate : null
}

// A RELEASE PR is the shape `--publish` demands: the heading, package.json and
// src/version.ts all name the same version, and it is above what the base publishes.
// A mid-cycle PR (heading open ABOVE package.json) is not one, and never sees this.
const isReleasePr =
  headingVsPkg === 0 && basePublished !== null && compareVersions(headingVersion, basePublished) > 0

// Only the gates this checkout actually HAS. A checkout carrying none of them — a
// fixture, a trimmed clone — has nothing to re-anchor and is not asked to.
const presentGates = ANCHORED_GATES.filter((g) => existsSync(resolve(ROOT, g.config)))

if (isReleasePr && presentGates.length > 0) {
  const expected = releaseShaFor(baseSha, basePublished.raw)

  if (expected === null) {
    fail(
      `cannot locate the commit that released ${basePublished.raw} on the base branch, so the\n` +
        '  bench perf-gate anchors cannot be checked. This gate needs real history: in CI, check\n' +
        '  out with `fetch-depth: 0` (see .github/workflows/ci.yml, job `release-gate`).',
    )
  }

  const wrong = []
  for (const gate of ANCHORED_GATES) {
    const p = resolve(ROOT, gate.config)
    if (!existsSync(p)) continue
    let cfg
    try {
      cfg = JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      fail(`${gate.config} is not valid JSON — cannot read its perf-gate anchor.`)
    }
    const got = cfg.referenceSha
    if (typeof got !== 'string' || got.length < 7) {
      wrong.push({ ...gate, got: got === undefined ? '(absent)' : String(got) })
      continue
    }
    if (!expected.startsWith(got)) wrong.push({ ...gate, got })
  }

  if (wrong.length > 0) {
    const short = expected.slice(0, 7)
    fail(
      `this is the RELEASE PR for ${headingVersion.raw}, so every perf gate must be RE-ANCHORED to the\n` +
        `  previous release — ${basePublished.raw}, released by ${short} — and ${wrong.length} is/are not:\n` +
        '\n' +
        wrong.map((w) => `    ${w.config}\n      referenceSha ${w.got} → should be ${short}`).join('\n') +
        '\n\n' +
        '  These gates measure THIS build against the referenced one, in one interleaved process.\n' +
        '  Against a stale anchor they still read `ok` — they just compare against a baseline that\n' +
        '  already absorbed every regression since, so the accumulated headroom becomes the error\n' +
        '  bar and the gate loses its resolution without losing its green. Both config files have\n' +
        '  carried "bump this at every release, in the release PR" in a comment from the start, and\n' +
        '  both were missed for ten consecutive releases. That is why this is executed and not\n' +
        '  written down.\n' +
        '\n' +
        `  Fix: set referenceSha to ${short} in each file above, update the _referenceNote to name\n` +
        `  ${basePublished.raw}, then RUN the gates (${ANCHORED_GATES.map((g) => g.script).join(', ')}) and\n` +
        '  put the numbers in this PR.\n' +
        '\n' +
        '  A newer anchor is a STRICTER gate and may go red on a regression the old one was hiding.\n' +
        '  That is the gate working. Report the regression; do not move the anchor to silence it.\n' +
        '\n' +
        '  This check has no hatch — `release-exempt` does not waive it.',
    )
  }

  console.log(`✓ perf-gate anchors name ${expected.slice(0, 7)}, the commit that released ${basePublished.raw}.`)
}

// ── D. Peak-record gate ─────────────────────────────────────────────────────────
//
// The anchor gate above enforces the PER-STEP half of the release policy: each
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
// That record is only worth having if it cannot move quietly. The anchor gate exists
// because two configs carried "bump this at every release" in a COMMENT and were
// missed for ten consecutive releases; a comment asking a human to keep the peak
// honest would go the same way. So: any edit to a `peak` block must be named in the
// CHANGELOG, and the two edits that launder a regression into the baseline — moving
// the peak BACKWARD, or widening its allowance — are called out by name.
//
// Unlike C this runs on EVERY PR, not just release PRs: a peak can be moved at any
// time, and the moment it matters is the moment it moves.

const peakGateConfigs = ANCHORED_GATES.filter((g) => existsSync(resolve(ROOT, g.config)))

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
  // The heading section only — history must not be able to satisfy a check about a
  // change being made now.
  const afterHeading = changelog.slice(firstHeading.index + firstHeading[0].length)
  const currentSection = afterHeading.split(/^##\s+/m)[0] ?? ''
  const mentionsPeak = /\bpeak\b/i.test(currentSection)

  if (!mentionsPeak) {
    fail(
      `this PR edits a perf-gate PEAK RECORD and the CHANGELOG's ${headingVersion.raw} section does not\n` +
        '  mention it:\n' +
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
        `  Fix: add a line to the ${headingVersion.raw} section naming the peak change and the measurement\n` +
        '  behind it (run `pnpm perf:workloads --peak` and quote it, load average included).\n' +
        '\n' +
        '  This check has no hatch — `release-exempt` does not waive it.',
    )
  }

  for (const e of peakEdits) console.log(`✓ peak record ${e.kind} in ${e.config} and named in the CHANGELOG — ${e.detail}`)
}
else if (peakGateConfigs.some((g) => readPeak(readFileSync(resolve(ROOT, g.config), 'utf8'), g.config) !== null)) {
  console.log('✓ perf-gate peak records unchanged.')
}

let pkgSurfaceChanged = []
if (changed.includes('package.json')) {
  pkgSurfaceChanged = PUBLISHED_PKG_FIELDS.filter(
    (k) => JSON.stringify(basePkg[k]) !== JSON.stringify(pkg[k]),
  )
  if (lifecycleProjection(basePkg) !== lifecycleProjection(pkg)) {
    pkgSurfaceChanged.push('install-time scripts')
  }
}

const publishedSurfaceChanged =
  srcTouched.length > 0 || buildTouched.length > 0 || pkgSurfaceChanged.length > 0

if (!publishedSurfaceChanged) {
  console.log(
    `✓ no published surface changed (${changed.length} file(s): nothing under src/, no build\n` +
      '  input, no consumer-facing package.json field) — no version bump required.',
  )
  process.exit(0)
}

const why = [
  srcTouched.length > 0 ? `${srcTouched.length} file(s) under src/` : null,
  buildTouched.length > 0 ? `build input ${buildTouched.join(', ')}` : null,
  pkgSurfaceChanged.length > 0 ? `package.json ${pkgSurfaceChanged.join(', ')}` : null,
].filter(Boolean).join(' and ')

// The release under construction must be a version that has NOT been published yet.
//
// This is deliberately CHANGELOG-relative, not branch-relative. A branch-relative rule
// ("head version > base version") makes the bump the price of MERGING: the second PR to
// land between two releases has to bump again, and its number collapses into whatever
// ships. 0.37 through 0.41 all went out as one 0.37.0 that way. Here, the FIRST PR of a
// cycle opens `## <next> — unreleased` and every later PR files into the same open
// section for free. One number per release, spent by whoever publishes.
//
// The "last published" marker is the BASE's package.json, not HEAD's.
//
// It used to be HEAD's, on the reasoning that `--publish` refuses to ship unless
// package.json equals the heading, so on `main` package.json is exactly the last version
// that went out. That is true of `main` and false of a RELEASE PR, which is precisely the
// PR that bumps package.json ahead of npm. Reading HEAD there asks "is the heading above
// the version this PR is trying to publish?", which is 0 by construction — so a correctly
// prepped release (heading, package.json and src/version.ts all at the new version, which
// is exactly what `--publish` demands) failed this check, and failed it with the sentence
// "0.45.0, which is already published" about a version that was not published at all.
//
// Against the BASE, one rule covers both shapes, because both are the same claim — the
// release under construction is not yet published:
//
//   - DEFERRED (a mid-cycle PR): base 0.44.0, heading 0.45.0, package.json still 0.44.0.
//     The section is open and the number is spent later. No PR is forced to bump, which
//     is the whole point of the changelog-relative rule — 0.37 through 0.41 collapsed
//     into one 0.37.0 because a branch-relative rule made a number the price of merging.
//   - RELEASE PR: base 0.44.0, heading 0.45.0, package.json 0.45.0. The number is spent
//     HERE, and `--publish` passes on the merge commit, so the release ships on merge.
//
// Both are legal. What stays illegal is the thing the gate exists to stop: filing into a
// heading that names a version already on npm as of the base.
// If the base's version cannot be read — an unparseable or absent package.json at the
// base commit — fall back to the HEAD comparison rather than passing. An unreadable base
// is a reason to judge conservatively, not a reason to wave the change through: the
// fallback is the stricter of the two rules, so the worst case is a release PR being
// asked to justify itself, never an already-published heading sliding past.
const headingVsBase =
  basePublished === null ? headingVsPkg : compareVersions(headingVersion, basePublished)

if (headingVsBase > 0) {
  console.log(
    headingVsPkg > 0
      ? `✓ published surface changed (${why}) and ${headingVersion.raw} is open for construction\n` +
        `  over published ${version} — the bump lands at publish, not at merge.`
      : `✓ published surface changed (${why}) and this is a RELEASE of ${headingVersion.raw}\n` +
        `  over published ${basePublished?.raw ?? 'unknown'} — heading, package.json and src/version.ts\n` +
        '  all agree, so `--publish` passes on the merge commit.',
  )
  process.exit(0)
}

if (EXEMPT) {
  console.log(
    `⚠ RELEASE GATE WAIVED — the published surface changed (${why}) and CHANGELOG.md's top\n` +
      `  section is the already-published ${version}, but the \`release-exempt\` label is set.\n` +
      '  Valid only for a revert of a release, or a chained PR whose section lives underneath\n' +
      '  it. Whoever merges this owns the next release carrying the section.',
  )
  process.exit(0)
}

const publishedRaw = basePublished?.raw ?? version

fail(
  `this PR changes the published surface (${why}) but CHANGELOG.md's top section is\n` +
    `  ${headingVersion.raw}, which was already published as of the base (${publishedRaw}) — so the\n` +
    '  change would be documented into a release that does not contain it.\n' +
    '\n' +
    '  Either shape fixes it:\n' +
    '\n' +
    `    DEFER — add "## <next> — unreleased" above the ${publishedRaw} section and file this\n` +
    '    change under it, leaving package.json and src/version.ts alone. They move together\n' +
    '    at PUBLISH, so any number of PRs can land into one cycle without burning a number\n' +
    '    each.\n' +
    '\n' +
    '    RELEASE — if this PR IS the release, name the new version in the heading AND bump\n' +
    '    package.json and src/version.ts to match it, so `--publish` passes on the merge\n' +
    '    commit.\n' +
    '\n' +
    '  Pre-1.0, a behaviour change goes in the MINOR (this project has said so since 0.1.0;\n' +
    "  see CHANGELOG.md's preamble).\n" +
    '\n' +
    '  If a section genuinely belongs elsewhere — you are reverting a release, or this PR is\n' +
    '  chained on one that already opened it — add the `release-exempt` label to the PR. That\n' +
    '  is the hatch; it is on the PR where a reviewer can see it.',
)
