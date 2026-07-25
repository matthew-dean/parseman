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
 * ── WHAT IT CHECKS ──────────────────────────────────────────────────────────────
 * A. RELEASE INTEGRITY — always, needs no git history:
 *      1. CHANGELOG.md's FIRST `##` heading names a real version, never `Unreleased`.
 *      2. That version equals `package.json`'s.
 *      3. `src/version.ts`'s `PARSEMAN_VERSION` equals it too — the artifact stamp
 *         and the fuse-time version lock read it (`docs/design/artifact-format.md`).
 *
 * B. BUMP GATE — only with `--base=<ref>`, i.e. in a pull request:
 *      4. If the change touches the PUBLISHED SURFACE (`src/**`, or a package.json
 *         field a consumer receives), the version must go UP relative to the base.
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
 *   node scripts/check-changelog.mjs                  # A only (prepublishOnly, local)
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

/** Parse `1.2.3` / `v1.2.3-rc.1` into comparable parts, or `null` if it isn't one. */
const parseVersion = (raw) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null, raw: m[0].replace(/^v/, '') }
}

/** −1 / 0 / 1. A prerelease sorts BELOW its release, per semver. */
const compareVersions = (a, b) => {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre < b.pre ? -1 : 1
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

if (headingVersion.raw !== version) {
  fail(
    `CHANGELOG.md's top section is ${headingVersion.raw} but package.json says ${version}.\n` +
      `  The newest changelog section must BE the version being shipped — a matching\n` +
      `  heading further down the file only proves the version was released once before.`,
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

console.log(`✓ CHANGELOG.md's top section is ${version}, matching package.json and src/version.ts.`)

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

let pkgSurfaceChanged = []
if (changed.includes('package.json')) {
  let basePkg
  try {
    basePkg = JSON.parse(git('show', `${baseSha}:package.json`))
  } catch {
    basePkg = {}
  }
  pkgSurfaceChanged = PUBLISHED_PKG_FIELDS.filter(
    (k) => JSON.stringify(basePkg[k]) !== JSON.stringify(pkg[k]),
  )
}

const publishedSurfaceChanged = srcTouched.length > 0 || pkgSurfaceChanged.length > 0

if (!publishedSurfaceChanged) {
  console.log(
    `✓ no published surface changed (${changed.length} file(s): none under src/, no consumer-facing\n` +
      '  package.json field) — no version bump required.',
  )
  process.exit(0)
}

const why = [
  srcTouched.length > 0 ? `${srcTouched.length} file(s) under src/` : null,
  pkgSurfaceChanged.length > 0 ? `package.json ${pkgSurfaceChanged.join(', ')}` : null,
].filter(Boolean).join(' and ')

let basePkgVersion
try {
  basePkgVersion = JSON.parse(git('show', `${baseSha}:package.json`)).version
} catch {
  basePkgVersion = undefined
}

const baseVersion = typeof basePkgVersion === 'string' ? parseVersion(basePkgVersion) : null
const headVersion = parseVersion(version)

if (!headVersion) fail(`package.json version "${version}" is not a semantic version.`)

const bumped = baseVersion === null || compareVersions(headVersion, baseVersion) > 0

if (bumped) {
  console.log(
    `✓ published surface changed (${why}) and the version went ${basePkgVersion ?? '?'} → ${version}.`,
  )
  process.exit(0)
}

if (EXEMPT) {
  console.log(
    `⚠ RELEASE GATE WAIVED — the published surface changed (${why}) and the version did NOT go up\n` +
      `  (${basePkgVersion} → ${version}), but the \`release-exempt\` label is set on this PR.\n` +
      '  Valid only for a revert of a release, or a chained PR whose bump lives underneath it.\n' +
      '  Whoever merges this owns the next release carrying the bump.',
  )
  process.exit(0)
}

fail(
  `this PR changes the published surface (${why}) but does not bump the version.\n` +
    `  base ${basePkgVersion ?? '(unknown)'} → head ${version}\n` +
    '\n' +
    '  Every PR lands releasable. Bump package.json AND src/version.ts together, and open\n' +
    '  the changelog section that names the new version — pre-1.0, a behaviour change goes\n' +
    '  in the MINOR (this project has said so since 0.1.0; see CHANGELOG.md\'s preamble).\n' +
    '\n' +
    '  If the bump genuinely belongs elsewhere — you are reverting a release, or this PR is\n' +
    '  chained on one that already bumped — add the `release-exempt` label to the PR. That\n' +
    '  is the hatch; it is on the PR where a reviewer can see it.',
)
