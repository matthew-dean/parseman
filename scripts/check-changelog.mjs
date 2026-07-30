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
 *   node scripts/check-changelog.mjs --base=<ref>     # A + B (pull request)
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
const basePublished = typeof basePkg.version === 'string' ? parseVersion(basePkg.version) : null
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
