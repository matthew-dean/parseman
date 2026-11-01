#!/usr/bin/env node
/**
 * Release on merge: what `.github/workflows/publish.yml` runs on every push to `main`.
 * Design: `docs/design/release-gates.md` § Publishing.
 *
 *   node scripts/release.mjs plan              # prints release=true|false and version=X.Y.Z
 *                                              # (reads npm; builds dist/; touches nothing tracked)
 *   node scripts/release.mjs stamp <version>   # stamps the release into the tree and commits it
 *   node scripts/release.mjs record <v> <remote> # pushes the release onto main (needs the deploy key)
 *   node scripts/release.mjs sync              # files released CHANGELOG sections onto main (a PR)
 *
 * `stamp` commits the version and the dated CHANGELOG heading inside the runner, the
 * workflow publishes that tree and tags that commit `vX.Y.Z`. With the
 * `RELEASE_DEPLOY_KEY` secret, `record` also puts the release on `main` (a fast-forward,
 * or the stamp rebuilt on a tip that moved), and the push it makes publishes nothing
 * (`releaseCommitOf`). Without it the tag is the only record: `main` keeps the last
 * version a pull request declared and its `## Unreleased` keeps entries an auto-patch
 * already shipped, until someone runs `sync` in a PR. Either way each stamp files those
 * entries under the release that shipped them, read from the previous tag, so every
 * tag's CHANGELOG is exact.
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

/** The highest stable version in `list`, parsed, or null. Prereleases and non-versions are skipped. */
const newestStable = (list) => {
  let latest = null
  for (const raw of list) {
    const v = parseVersion(raw)
    if (v !== null && v.pre === null && (latest === null || compareVersions(v, latest) > 0)) latest = v
  }
  return latest
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
  const latest = newestStable(published)
  if (latest === null || compareVersions(d, latest) > 0) {
    return { version: d.raw, latest: latest?.raw ?? null, declared: true }
  }
  return { version: `${latest.major}.${latest.minor}.${latest.patch + 1}`, latest: latest.raw, declared: false }
}

// ── What a consumer installs ────────────────────────────────────────────────────

/**
 * The package.json fields that reach nobody who installs parseman. Everything else
 * counts: a field this list does not name (`sideEffects`, `os`, `imports`, …) is
 * assumed to matter, so a new one is never silently ignored. `version` is the release
 * itself, not a change to release.
 */
export const NON_CONSUMER_FIELDS = ['version', 'devDependencies', 'packageManager', 'scripts']

/**
 * The lifecycle hooks npm runs on a CONSUMER's machine: `preinstall`/`install`/
 * `postinstall` when parseman is installed as a dependency, and `prepare` when it is
 * installed from a git URL. Every other script (`test`, `bench:*`) reaches nobody.
 */
export const CONSUMER_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

/**
 * The consumer-visible package.json fields that differ between `a` and `b`, with
 * `install-time scripts` for a lifecycle hook. A devDependency bump or a renamed
 * bench script changes the packed bytes and nothing anyone installs or runs.
 */
export function consumerFieldChanges(a, b) {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort()
  const changed = keys.filter((k) => !NON_CONSUMER_FIELDS.includes(k) && JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]))
  if (CONSUMER_LIFECYCLE_SCRIPTS.some((k) => a?.scripts?.[k] !== b?.scripts?.[k])) changed.push('install-time scripts')
  return changed
}

/** Every file under `dir`, as `/`-separated paths relative to it. */
const walk = (dir, prefix = '') =>
  readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  )

/**
 * The files that differ between two unpacked npm tarballs: added, removed or changed,
 * with package.json compared through `consumerFieldChanges`. Empty means a consumer would
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
      if (consumerFieldChanges(read(a), read(b)).length > 0) differ.push(f)
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

/** The entries under `version`'s `##` section, or null when there is none. */
export function sectionEntries(changelog, version) {
  const section = parse(changelog).sections.find((s) => headingVersion(s.heading) === version)
  return section === undefined ? null : entries(section.lines)
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
    // A version a later PR declared above every release: its section is still pending,
    // and may have been renamed from an Unreleased that held shipped entries.
    const newestReleased = missing.map((m) => parseVersion(headingVersion(m.heading))).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))
    const declared = unreleased ? null : top
    const dv = declared === null || declared === undefined ? null : headingVersion(declared.heading)
    if (dv !== null && compareVersions(parseVersion(dv), newestReleased) > 0) {
      const kept = pending(declared.lines)
      if (kept.length !== entries(declared.lines).length) declared.lines = body(kept)
    }
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

/** The identity release commits are made with. */
const BOT = {
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
}

const run = (cmd, args, opts = {}) =>
  (execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }) ?? '').trim()

/** The files that carry the version, and how each spells it. */
const VERSION_SITES = [
  ['package.json', /("version"\s*:\s*)"[^"]+"/, (v) => `"${v}"`],
  ['src/version.ts', /(PARSEMAN_VERSION\s*=\s*)'[^']+'/, (v) => `'${v}'`],
]

const withVersion = (file, source, version) => {
  const site = VERSION_SITES.find(([f]) => f === file)
  if (!site[1].test(source)) throw new Error(`${file} names no version to stamp.`)
  return source.replace(site[1], (_, lead) => `${lead}${site[2](version)}`)
}

/** package.json's `version` and `src/version.ts`'s `PARSEMAN_VERSION`, set to `version`. */
export function applyVersion(root, version) {
  for (const [file] of VERSION_SITES) {
    const path = join(root, file)
    writeFileSync(path, withVersion(file, readFileSync(path, 'utf8'), version))
  }
}

/** The `v*` release tags, newest first. */
const releaseTags = (root = ROOT) =>
  run('git', ['tag', '--list', 'v*'], { cwd: root })
    .split('\n')
    .map((tag) => ({ tag, v: parseVersion(tag) }))
    .filter((t) => t.v !== null && t.v.pre === null && /^v/.test(t.tag))
    .sort((a, b) => compareVersions(b.v, a.v))

/**
 * The release that already contains HEAD, if any. That is a re-run of a commit `main`
 * has moved past: publishing it would ship older code under a newer number, and the
 * version and tag guards cannot see it, because that number is new. A release commit
 * beside `main` has the merged commit as its parent, so "HEAD is an ancestor of the tag"
 * covers both kinds of tag.
 */
export function supersedingRelease(root = ROOT) {
  for (const t of releaseTags(root)) {
    try {
      run('git', ['merge-base', '--is-ancestor', 'HEAD', t.tag], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      return t.tag
    } catch {
      // Not in this release. Keep looking rather than assume history is linear.
    }
  }
  return null
}

/**
 * The tag HEAD is the release commit of, if any: its subject is `release: X.Y.Z` and its
 * tree is `vX.Y.Z`'s. That is the commit `record` pushed to `main`, and its push must
 * not publish again.
 */
export function releaseCommitOf(root = ROOT) {
  const git = (...args) => run('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  const v = /^release: (\d+\.\d+\.\d+)$/.exec(git('log', '-1', '--format=%s'))?.[1]
  if (v === undefined) return null
  try {
    return git('rev-parse', `v${v}^{tree}`) === git('rev-parse', 'HEAD^{tree}') ? `v${v}` : null
  } catch {
    return null
  }
}

/**
 * The commit that records release `version` on `main`, given `main`'s current tip.
 * HEAD is the release: the stamped commit, or the merged commit itself when there was
 * nothing to stamp.
 *
 *   - HEAD already on `main` (the tip contains it): nothing to record.
 *   - `main` has not moved (the tip is HEAD's parent): HEAD itself, a fast-forward.
 *   - `main` moved: the stamp rebuilt on the tip, as `sync` would. The version files say
 *     `version`, or the higher version a later PR declared on the tip. The release's
 *     CHANGELOG sections are copied in and their entries leave Unreleased (or the declared
 *     section), and whatever later PRs filed there stays.
 *
 * The rebuilt commit is written through a scratch index, so the checkout is untouched.
 */
export function recordCommit(root, version, tip) {
  const git = (args, opts = {}) => run('git', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], ...opts })
  const contains = (a, b) => {
    try {
      git(['merge-base', '--is-ancestor', a, b])
      return true
    } catch {
      return false
    }
  }
  const head = git(['rev-parse', 'HEAD'])
  if (contains(head, tip)) return { action: 'none', commit: tip }
  if (git(['rev-parse', 'HEAD^']) === git(['rev-parse', tip])) return { action: 'fast-forward', commit: head }

  const tmp = mkdtempSync(join(tmpdir(), 'pm-record-'))
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index'), ...BOT }
    git(['read-tree', tip], { env })
    // A later PR may have declared a version above this release on the tip: keep it.
    const tipVersion = parseVersion(JSON.parse(git(['show', `${tip}:package.json`])).version ?? '')
    const keep = tipVersion !== null && compareVersions(tipVersion, parseVersion(version)) > 0 ? tipVersion.raw : version
    const files = {
      'CHANGELOG.md': stampChangelog(git(['show', `${tip}:CHANGELOG.md`]), { released: git(['show', 'HEAD:CHANGELOG.md']) }),
      'package.json': withVersion('package.json', git(['show', `${tip}:package.json`]), keep),
      'src/version.ts': withVersion('src/version.ts', git(['show', `${tip}:src/version.ts`]), keep),
    }
    for (const [file, text] of Object.entries(files)) {
      // `git show` drops the final newline; every one of these files ends with one.
      const blob = git(['hash-object', '-w', '--stdin'], { input: text.endsWith('\n') ? text : `${text}\n` })
      git(['update-index', '--cacheinfo', `100644,${blob},${file}`], { env })
    }
    const tree = git(['write-tree'], { env })
    return { action: 'rebuilt', commit: git(['commit-tree', tree, '-p', tip, '-m', `release: ${version}`], { env }) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

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
 * The plan's decision, from what it read: package.json's `declared` version, the
 * versions on `npm`, the stable `v*` `tags`, the release HEAD is the record commit of
 * (`own`) or is already contained in (`superseded`), and `differences(latest)`, the
 * packed files that differ from that release's tarball. Kept apart from the reading so
 * each branch is tested.
 *
 * npm's newest stable version must have its tag. A publish whose tag push failed leaves
 * one without, and from then on every later release would read the CHANGELOG of the tag
 * before it, and file the untagged release's entries under the next version, and a
 * re-run of an old commit would not be recognised as one. So that state stops the run
 * until the tag is pushed (docs/design/release-gates.md § If a step fails).
 */
export function decide({ declared, npm, tags, own, superseded, differences, changelog, released }) {
  const next = nextVersion({ declared, published: [...npm, ...tags] })
  const skip = (reason) => ({ ...next, release: false, reason })
  if (own !== null) return skip(`this is ${own}'s release commit, recorded on main by the run that published it`)
  if (superseded !== null) return skip(`this commit is already contained in ${superseded}, so a run for it releases nothing`)

  const onNpm = newestStable(npm)
  if (onNpm !== null && !tags.some((t) => parseVersion(t)?.raw === onNpm.raw)) {
    throw new Error(
      `parseman@${onNpm.raw} is on npm but has no v${onNpm.raw} tag: the run that published it did not tag it.\n`
        + '  Push that tag first (docs/design/release-gates.md, "Publish succeeded, tag failed"),\n'
        + '  then re-run this. Releasing on top of it would file its CHANGELOG entries under the next version.',
    )
  }

  // package.json still names a release that has shipped. Normal while main trails its
  // tags, but every entry in its CHANGELOG section must then be one the tag records as
  // shipped (the stamp may have dated the section, folded Unreleased entries in, or moved
  // an entry an earlier auto-patch shipped to that release). An entry the tag lacks was
  // filed under a version another merge had already spent: a pull
  // request that declared X passed its gate before X shipped, and merged after. Releasing
  // would ship the next patch with an empty section and leave those entries under X.
  const d = parseVersion(declared)
  if (d !== null && tags.some((t) => parseVersion(t)?.raw === d.raw)) {
    // Any release section of the tag: the stamp moves an entry an earlier auto-patch
    // shipped out of the declared section and leaves it under that earlier release.
    const shipped = new Set(parse(released(`v${d.raw}`)).sections
      .filter((s) => headingVersion(s.heading) !== null).flatMap((s) => entries(s.lines)))
    const stale = (sectionEntries(changelog, d.raw) ?? []).filter((e) => !shipped.has(e))
    if (stale.length > 0) {
      throw new Error(
        `package.json declares ${d.raw}, which v${d.raw} already released, and CHANGELOG.md's ## ${d.raw}\n`
          + `  section has ${stale.length} entr${stale.length === 1 ? 'y' : 'ies'} that release did not ship, starting with:\n`
          + `    ${stale[0].split('\n')[0]}\n`
          + '  A pull request declared a version another merge shipped first. In a pull request, move those\n'
          + `  entries under "## Unreleased" and delete the ## ${d.raw} heading, then run \`node scripts/release.mjs sync\`:\n`
          + `  it files the ${d.raw} that shipped from its tag. Or rename the section to a version above the latest\n`
          + '  release and set package.json and src/version.ts to it. `sync` alone changes nothing while main\n'
          + `  has a ## ${d.raw} section. If a shipped entry was only reworded on main, restore its v${d.raw} wording.`,
      )
    }
  }

  if (next.declared) return { ...next, release: true }
  const differ = differences(next.latest)
  if (differ.length === 0) return skip(`nothing parseman@${next.latest} ships changed, so ${next.version} is not published`)
  return { ...next, release: true, differ }
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
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const npm = [JSON.parse(run('npm', ['view', pkg.name, 'versions', '--json']))].flat()
  const log = (msg) => console.error(msg)
  const d = decide({
    declared: pkg.version,
    npm,
    tags: releaseTags().map((t) => t.tag),
    own: releaseCommitOf(),
    superseded: supersedingRelease(),
    changelog,
    released: (tag) => run('git', ['show', `${tag}:CHANGELOG.md`]),
    differences: (latest) => {
      // Stamped with the latest release's version so the version is not itself a
      // difference; restored afterwards so a local dry run leaves the checkout as it found it.
      applyVersion(ROOT, latest)
      try {
        return differencesFrom(latest)
      } finally {
        applyVersion(ROOT, pkg.version)
      }
    },
  })
  log(`declared (package.json): ${pkg.version}; latest release (npm and v* tags): ${d.latest ?? 'none'}`)
  if (!d.release) log(`→ skip: ${d.reason}.`)
  else if (d.declared) log(`→ ${d.version}: package.json declares a version above the latest release.`)
  else {
    log(`→ ${d.version}: ${d.differ.length} packed file(s) differ from parseman@${d.latest}:`)
    for (const f of d.differ.slice(0, 20)) log(`    ${f}`)
    if (d.differ.length > 20) log(`    … and ${d.differ.length - 20} more`)
  }
  return d
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
    const env = { ...process.env, ...BOT }
    run('git', ['add', '--', ...stamped])
    const tree = run('git', ['write-tree'])
    const commit = run('git', ['commit-tree', tree, '-p', 'HEAD', '-m', `release: ${version}`], { env })
    run('git', ['update-ref', 'HEAD', commit])
  }
  return run('git', ['rev-parse', 'HEAD'])
}

/**
 * Push the commit that records `version` onto `main` at `remote`. Never forced: a push
 * rejected because `main` moved in the meantime is rebuilt on the new tip and retried.
 */
export function record(root, version, remote) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    run('git', ['fetch', '--quiet', remote, 'main'], { cwd: root })
    const r = recordCommit(root, version, run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: root }))
    console.error(`record ${version} on main: ${r.action} (${r.commit.slice(0, 8)})`)
    if (r.action === 'none') return r.commit
    try {
      run('git', ['push', '--quiet', remote, `${r.commit}:refs/heads/main`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      return r.commit
    } catch (e) {
      const why = String((e && typeof e === 'object' && 'stderr' in e && e.stderr) || (e instanceof Error ? e.message : e)).trim()
      console.error(`push rejected (attempt ${attempt}): ${why}\n  Rebuilding on the latest tip of main.`)
    }
  }
  throw new Error(
    `could not record ${version} on main after 3 attempts. The release is published and tagged;\n`
      + '  main only lacks the version. Catch it up in a pull request:\n'
      + '    node scripts/release.mjs sync',
  )
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
      console.log(`release=${p.release}\nversion=${p.version}${p.reason === undefined ? '' : `\nreason=${p.reason}`}`)
    }
    else if (command === 'stamp') console.log(stamp(arg, date))
    else if (command === 'sync') console.log(`main now records ${sync()}`)
    else if (command === 'record') console.log(record(ROOT, arg, process.argv[4]))
    else throw new Error('usage: release.mjs plan | stamp <version> | record <version> <remote> | sync')
  } catch (e) {
    console.error(`release: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
