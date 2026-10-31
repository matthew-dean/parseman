#!/usr/bin/env node
/**
 * Release on merge: what `.github/workflows/publish.yml` runs on every push to `main`.
 * Design: `docs/design/release-gates.md` § Publishing.
 *
 *   node scripts/release.mjs plan              # prints release=true|false and version=X.Y.Z
 *                                              # (reads npm; builds dist/; touches nothing tracked)
 *   node scripts/release.mjs stamp <version>   # stamps the release into the tree and commits it
 *   node scripts/release.mjs sync              # files released CHANGELOG sections onto main (a PR)
 *
 * `main` only takes pull requests and the workflow has no bypass, so the publish never
 * writes to it. `stamp` commits the version and the dated CHANGELOG heading inside the
 * runner, the workflow publishes that tree and tags that commit `vX.Y.Z`, and the tag is
 * the repository's record of the release. `main` keeps the last version a pull request
 * declared, and its `## Unreleased` section keeps entries an auto-patch already shipped
 * until someone runs `sync` in a PR. Each stamp files those entries under the release
 * that shipped them, read from the previous tag, so every tag's CHANGELOG is exact.
 *
 * Dependency-free on purpose, like `check-changelog.mjs`: a release gate that needs the
 * build to run cannot run when the build is broken.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Versions ────────────────────────────────────────────────────────────────────

/** Parse `1.2.3` / `v1.2.3-rc.1` into comparable parts, or `null` if it isn't one. */
export const parseVersion = (raw) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(raw).trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null, raw: m[0].replace(/^v/, '') }
}

/**
 * SemVer §11 precedence for the dot-separated identifiers of a prerelease tag.
 * Numeric identifiers compare NUMERICALLY, so `rc.10` is above `rc.2`.
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
export const compareVersions = (a, b) => {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return comparePrerelease(a.pre, b.pre)
}

/**
 * The version a merge publishes. `declared` is package.json's version on `main`;
 * `published` is every version already out (npm's list and the `v*` tags).
 *
 * The declared version wins when it is above the latest release: that is how a pull
 * request asks for a minor or a major. Otherwise the patch after the latest release.
 * Only stable versions are released this way. A prerelease on npm (published by hand)
 * is not a "latest release", and a declared prerelease is refused rather than made
 * `latest` by accident.
 */
export function nextVersion({ declared, published }) {
  const d = parseVersion(declared)
  if (d === null) throw new Error(`package.json version "${declared}" is not a version.`)
  if (d.pre !== null) {
    throw new Error(`package.json declares the prerelease ${d.raw}; publish-on-merge releases stable versions only.`)
  }
  let latest = null
  for (const raw of published) {
    const v = parseVersion(raw)
    if (v !== null && v.pre === null && (latest === null || compareVersions(v, latest) > 0)) latest = v
  }
  if (latest === null || compareVersions(d, latest) > 0) {
    return { version: d.raw, latest: latest?.raw ?? null, declared: true }
  }
  return { version: `${latest.major}.${latest.minor}.${latest.patch + 1}`, latest: latest.raw, declared: false }
}

// ── What a consumer installs ────────────────────────────────────────────────────

/**
 * Fields a CONSUMER receives. `version` is excluded on purpose: it is the release
 * itself, not a change to release.
 */
export const PUBLISHED_PKG_FIELDS = [
  'name', 'type', 'main', 'module', 'types', 'exports', 'files', 'bin',
  'dependencies', 'peerDependencies', 'optionalDependencies', 'engines', 'license',
]

/**
 * The lifecycle hooks npm runs on a CONSUMER's machine: `preinstall`/`install`/
 * `postinstall` when parseman is installed as a dependency, and `prepare` when it is
 * installed from a git URL. Every other script (`test`, `bench:*`) reaches nobody.
 */
export const CONSUMER_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

/**
 * package.json as a consumer sees it. A devDependency bump or a renamed bench script
 * changes the bytes of the packed package.json and nothing anyone installs or runs.
 */
export const consumerManifest = (pkg) =>
  JSON.stringify([
    ...PUBLISHED_PKG_FIELDS.map((k) => pkg?.[k] ?? null),
    ...CONSUMER_LIFECYCLE_SCRIPTS.map((k) => pkg?.scripts?.[k] ?? null),
  ])

/** Every file under `dir`, as `/`-separated paths relative to it. */
const walk = (dir, prefix = '') =>
  readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  )

/**
 * The files that differ between two unpacked npm tarballs: added, removed or changed,
 * with package.json compared through `consumerManifest`. Empty means a consumer would
 * install exactly what is already published.
 */
export function packageDifferences(a, b) {
  const left = new Set(walk(a))
  const right = new Set(walk(b))
  const differ = []
  for (const f of [...new Set([...left, ...right])].sort()) {
    if (!left.has(f) || !right.has(f)) differ.push(f)
    else if (f === 'package.json') {
      const read = (d) => JSON.parse(readFileSync(join(d, f), 'utf8'))
      if (consumerManifest(read(a)) !== consumerManifest(read(b))) differ.push(f)
    }
    else if (!readFileSync(join(a, f)).equals(readFileSync(join(b, f)))) differ.push(f)
  }
  return differ
}

/**
 * The subset of `paths` that `npm pack` would ship under `pkg`'s `files` field.
 *
 * Asked of npm itself rather than re-implemented: a scratch directory holds `pkg` and
 * an empty file at every path, and `npm pack --dry-run` lists what it would pack. A
 * deleted path gets a placeholder too, so a deletion under `src/` counts.
 */
export function shippedPaths(pkg, paths) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-pack-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
    for (const p of paths) {
      if (p === 'package.json') continue
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      writeFileSync(join(dir, p), '')
    }
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const packed = new Set(JSON.parse(out)[0].files.map((f) => f.path))
    return paths.filter((p) => p !== 'package.json' && packed.has(p))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── CHANGELOG ───────────────────────────────────────────────────────────────────

/** The heading pull requests add their entries under. */
export const UNRELEASED = 'Unreleased'

const isUnreleased = (heading) => heading.replace(/^##\s+/, '').trim() === UNRELEASED

/** The version a `##` heading line names (`## 0.58.0 — 2026-10-31`, `## [v0.36.0] - …`), or null. */
export const headingVersion = (heading) =>
  parseVersion(heading.replace(/^##\s+/, '').replace(/^\[/, '').split(/[\s\]]/)[0] ?? '')?.raw ?? null

/** The preamble, then each `## ` section with its lines up to the next one. */
function parse(text) {
  const preamble = []
  const sections = []
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) sections.push({ heading: line, lines: [] })
    else (sections.at(-1)?.lines ?? preamble).push(line)
  }
  return { preamble, sections }
}

const print = ({ preamble, sections }) =>
  [...preamble, ...sections.flatMap((s) => [s.heading, ...s.lines])].join('\n')

/** An entry is a top-level `- ` bullet with its continuation lines, or a paragraph. */
export function entries(lines) {
  const found = []
  let open = false
  for (const line of lines) {
    if (line.trim() === '') open = false
    else if (open && !line.startsWith('- ')) found[found.length - 1] += `\n${line}`
    else {
      found.push(line)
      open = true
    }
  }
  return found
}

const body = (list) => ['', ...list.flatMap((e) => [...e.split('\n'), ''])]

/**
 * The entries waiting to be released: those under `## Unreleased`, or, when a pull
 * request declares a version above `published`, those under that version's heading.
 */
export function pendingEntries(changelog, published) {
  const top = parse(changelog).sections[0]
  if (top === undefined) return []
  if (isUnreleased(top.heading)) return entries(top.lines)
  const v = headingVersion(top.heading)
  const p = parseVersion(published ?? '')
  return v !== null && p !== null && compareVersions(parseVersion(v), p) > 0 ? entries(top.lines) : []
}

/**
 * Stamp `version` into a CHANGELOG, or with no version only catch it up (`sync`).
 *
 *   - `## Unreleased` becomes `## <version> — <date>`. A section the pull request
 *     already declared for `version` takes the Unreleased entries and the date.
 *   - `released` is the CHANGELOG of the previous release's tag. Every release section
 *     it has and `changelog` lacks is copied in, in version order, and its entries are
 *     removed from the section being released: `main` never receives the auto-patch
 *     release commits, so an entry an earlier release shipped can still sit under
 *     Unreleased there. An entry edited on `main` after it shipped no longer matches
 *     and is released again.
 *
 * Every other line is kept byte for byte.
 */
export function stampChangelog(changelog, { version, date, released = '' }) {
  const doc = parse(changelog)
  const has = new Set(doc.sections.map((s) => headingVersion(s.heading)).filter((v) => v !== null))
  const missing = parse(released).sections.filter((s) => {
    const v = headingVersion(s.heading)
    return v !== null && v !== version && !has.has(v)
  })
  if (version === undefined && missing.length === 0) return changelog
  const shipped = new Set(missing.flatMap((s) => entries(s.lines)))
  const pending = (lines) => entries(lines).filter((e) => !shipped.has(e))

  const top = doc.sections[0]
  const unreleased = top !== undefined && isUnreleased(top.heading)
  const open = unreleased ? pending(top.lines) : []
  if (unreleased) doc.sections.shift()

  if (version === undefined) {
    if (open.length > 0) doc.sections.unshift({ heading: top.heading, lines: body(open) })
  }
  else {
    const heading = `## ${version} — ${date}`
    const declared = doc.sections.find((s) => headingVersion(s.heading) === version)
    if (declared === undefined) doc.sections.unshift({ heading, lines: body(open) })
    else {
      const kept = pending(declared.lines)
      declared.heading = heading
      if (open.length > 0 || kept.length !== entries(declared.lines).length) declared.lines = body([...open, ...kept])
    }
  }

  for (const s of missing) {
    const v = parseVersion(headingVersion(s.heading))
    const at = doc.sections.findIndex((x) => {
      const xv = headingVersion(x.heading)
      return xv !== null && compareVersions(parseVersion(xv), v) < 0
    })
    doc.sections.splice(at === -1 ? doc.sections.length : at, 0, s)
  }
  return print(doc)
}

// ── The working tree ────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const run = (cmd, args, opts = {}) =>
  (execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }) ?? '').trim()

/** package.json's `version` and `src/version.ts`'s `PARSEMAN_VERSION`, set to `version`. */
export function applyVersion(root, version) {
  for (const [file, pattern] of [
    ['package.json', /("version"\s*:\s*)"[^"]+"/],
    ['src/version.ts', /(PARSEMAN_VERSION\s*=\s*)'[^']+'/],
  ]) {
    const path = join(root, file)
    const source = readFileSync(path, 'utf8')
    if (!pattern.test(source)) throw new Error(`${file} names no version to stamp.`)
    writeFileSync(path, source.replace(pattern, (_, lead) => `${lead}${file === 'package.json' ? `"${version}"` : `'${version}'`}`))
  }
}

/** The `v*` release tags, newest first. */
const releaseTags = () =>
  run('git', ['tag', '--list', 'v*'])
    .split('\n')
    .map((tag) => ({ tag, v: parseVersion(tag) }))
    .filter((t) => t.v !== null && t.v.pre === null && /^v/.test(t.tag))
    .sort((a, b) => compareVersions(b.v, a.v))

/** The CHANGELOG at the newest release tag below `version` (any tag without one). */
const releasedChangelog = (version) => {
  const below = version === undefined ? null : parseVersion(version)
  const t = releaseTags().find((x) => below === null || compareVersions(x.v, below) < 0)
  return t === undefined ? '' : run('git', ['show', `${t.tag}:CHANGELOG.md`])
}

const readPkg = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Pack the working tree and the published `version`, unpack both, and diff them. */
function differencesFrom(version) {
  const tmp = mkdtempSync(join(tmpdir(), 'pm-release-'))
  try {
    const name = readPkg().name
    const unpack = (sub, cwd, args) => {
      const dir = join(tmp, sub)
      mkdirSync(dir)
      const file = JSON.parse(run('npm', [...args, '--json', '--pack-destination', dir], { cwd }))[0].filename
      run('tar', ['-xzf', join(dir, file), '-C', dir])
      return join(dir, 'package')
    }
    // Build output goes to stderr: stdout is the step's `key=value` result.
    run('node', ['scripts/build.mjs'], { stdio: ['ignore', process.stderr, 'inherit'] })
    const here = unpack('head', ROOT, ['pack', '--ignore-scripts'])
    const there = unpack('published', tmp, ['pack', `${name}@${version}`])
    return packageDifferences(here, there)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Decide whether this commit publishes, and as which version.
 *
 * Skipped when the package would be byte-identical to the latest release: the tree is
 * stamped with that release's version, built and packed exactly as `npm publish`
 * would, and compared file by file with the tarball npm serves for it. The build is
 * reproducible (a pack of the v0.57.0 tag rebuilt elsewhere has the published
 * tarball's sha1), so the comparison needs no list of paths that "count".
 */
function plan() {
  const pkg = readPkg()
  const npm = JSON.parse(run('npm', ['view', pkg.name, 'versions', '--json']))
  const tags = releaseTags().map((t) => t.v.raw)
  const next = nextVersion({ declared: pkg.version, published: [...[npm].flat(), ...tags] })
  const log = (msg) => console.error(msg)
  log(`declared (package.json): ${pkg.version}; latest release (npm and v* tags): ${next.latest ?? 'none'}`)

  if (next.declared) {
    log(`→ ${next.version}: package.json declares a version above the latest release.`)
    return { release: true, version: next.version }
  }
  // Stamped with the latest release's version so the version is not itself a difference;
  // restored afterwards so a local dry run leaves the checkout as it found it.
  applyVersion(ROOT, next.latest)
  let differ
  try {
    differ = differencesFrom(next.latest)
  } finally {
    applyVersion(ROOT, pkg.version)
  }
  if (differ.length === 0) {
    log(`→ skip: the packed tree is identical to parseman@${next.latest}; ${next.version} is not published.`)
    return { release: false, version: next.version }
  }
  log(`→ ${next.version}: ${differ.length} packed file(s) differ from parseman@${next.latest}:`)
  for (const f of differ.slice(0, 20)) log(`    ${f}`)
  if (differ.length > 20) log(`    … and ${differ.length - 20} more`)
  return { release: true, version: next.version }
}

/**
 * Stamp `version` into the tree and commit it on top of HEAD. A tree that already
 * says exactly this (nothing to stamp) is released from HEAD as it stands.
 *
 * Committed through plumbing, so no hook runs: the release preflight runs on this
 * exact tree immediately after.
 */
function stamp(version, date) {
  if (parseVersion(version) === null) throw new Error(`stamp: "${version}" is not a version.`)
  applyVersion(ROOT, version)
  const path = join(ROOT, 'CHANGELOG.md')
  writeFileSync(path, stampChangelog(readFileSync(path, 'utf8'), { version, date, released: releasedChangelog(version) }))
  const stamped = ['package.json', 'src/version.ts', 'CHANGELOG.md']
  if (run('git', ['status', '--porcelain', '--', ...stamped]) !== '') {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    }
    run('git', ['add', '--', ...stamped])
    const tree = run('git', ['write-tree'])
    const commit = run('git', ['commit-tree', tree, '-p', 'HEAD', '-m', `release: ${version}`], { env })
    run('git', ['update-ref', 'HEAD', commit])
  }
  return run('git', ['rev-parse', 'HEAD'])
}

/** File every release `main` has not recorded yet, from the newest tag. For a PR. */
function sync() {
  const t = releaseTags()[0]
  if (t === undefined) throw new Error('sync: no v* release tag.')
  const path = join(ROOT, 'CHANGELOG.md')
  writeFileSync(path, stampChangelog(readFileSync(path, 'utf8'), { released: releasedChangelog() }))
  applyVersion(ROOT, t.v.raw)
  return t.v.raw
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, arg] = process.argv.slice(2)
  const date = process.env.RELEASE_DATE ?? new Date().toISOString().slice(0, 10)
  try {
    if (command === 'plan') {
      const p = plan()
      console.log(`release=${p.release}\nversion=${p.version}`)
    }
    else if (command === 'stamp') console.log(stamp(arg, date))
    else if (command === 'sync') console.log(`main now records ${sync()}`)
    else throw new Error('usage: release.mjs plan | stamp <version> | sync')
  } catch (e) {
    console.error(`release: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
