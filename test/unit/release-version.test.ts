/**
 * `scripts/release.mjs` decides, on every push to `main`, whether parseman publishes and
 * as which version, and writes the CHANGELOG the release carries. These are its pure
 * parts; `release-gate.test.ts` covers the pull-request gate that feeds it.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  nextVersion, packageDifferences, shippedPaths, stampChangelog, pendingEntries, compareVersions, parseVersion,
  consumerFieldChanges, supersedingRelease, recordCommit, record, releaseCommitOf, decide,
} from '../../scripts/release.mjs'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('the version a merge publishes', () => {
  it('publishes the declared version when it is above the latest release (a minor or a major)', () => {
    expect(nextVersion({ declared: '0.59.0', published: ['0.57.0', '0.58.0', '0.58.3'] }))
      .toEqual({ version: '0.59.0', latest: '0.58.3', declared: true })
    expect(nextVersion({ declared: '1.0.0', published: ['0.58.3'] }).version).toBe('1.0.0')
    // A declared patch above the latest counts too.
    expect(nextVersion({ declared: '0.58.5', published: ['0.58.3'] }).version).toBe('0.58.5')
  })

  it('takes the next patch when the declared version IS the latest release', () => {
    expect(nextVersion({ declared: '0.58.0', published: ['0.57.0', '0.58.0'] }))
      .toEqual({ version: '0.58.1', latest: '0.58.0', declared: false })
  })

  it('takes the next patch after the LATEST release when main still declares an older one', () => {
    // Auto-patch releases are recorded on their tags, not on main, so main's package.json
    // trails npm between declared versions. The number comes from the registry.
    expect(nextVersion({ declared: '0.58.0', published: ['0.58.0', '0.58.1', '0.58.2'] }).version).toBe('0.58.3')
  })

  it('orders versions numerically, never lexically', () => {
    expect(nextVersion({ declared: '0.9.0', published: ['0.10.0'] }).version).toBe('0.10.1')
    expect(nextVersion({ declared: '0.58.0', published: ['0.58.9', '0.58.10'] }).version).toBe('0.58.11')
  })

  it('ignores prereleases on npm: they are never the latest release', () => {
    expect(nextVersion({ declared: '0.58.0', published: ['0.58.0', '0.59.0-rc.1'] }).version).toBe('0.58.1')
    expect(nextVersion({ declared: '0.59.0', published: ['0.58.0', '0.59.0-rc.1'] }).version).toBe('0.59.0')
  })

  it('refuses a declared prerelease rather than publishing it as latest', () => {
    expect(() => nextVersion({ declared: '0.59.0-rc.1', published: ['0.58.0'] })).toThrow(/stable versions only/)
  })

  it('publishes the declared version for the very first release', () => {
    expect(nextVersion({ declared: '0.1.0', published: [] })).toEqual({ version: '0.1.0', latest: null, declared: true })
  })

  it('orders prerelease identifiers numerically and below their release', () => {
    const cmp = (a: string, b: string) => compareVersions(parseVersion(a)!, parseVersion(b)!)
    expect(cmp('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1)
    expect(cmp('1.0.0-rc.1', '1.0.0')).toBe(-1)
  })
})

describe('the skip decision: what a consumer would install', () => {
  function unpacked(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'pm-unpacked-'))
    dirs.push(dir)
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), body)
    }
    return dir
  }
  const pkg = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ name: 'parseman', version: '0.58.0', files: ['dist'], devDependencies: { vitest: '4' }, ...over })

  const published = { 'package.json': pkg(), 'dist/index.js': 'export {}\n', 'README.md': '# p\n' }

  it('finds nothing when every packed file is identical', () => {
    expect(packageDifferences(unpacked(published), unpacked(published))).toEqual([])
  })

  it('names a changed, an added and a removed file', () => {
    const head = unpacked({ ...published, 'dist/index.js': 'export const a = 1\n', 'dist/new.js': '' })
    const old = unpacked({ ...published, 'dist/gone.js': '' })
    expect(packageDifferences(head, old)).toEqual(['dist/gone.js', 'dist/index.js', 'dist/new.js'])
  })

  it('reads package.json as a consumer does: a devDependency or a bench script is not a change', () => {
    const head = unpacked({ ...published, 'package.json': pkg({ devDependencies: { vitest: '5' }, scripts: { 'bench:x': 'y' } }) })
    expect(packageDifferences(head, unpacked(published))).toEqual([])
  })

  it('counts a dependency, an export, sideEffects, os or an install-time script', () => {
    // Every field but the few that reach nobody: a field the list does not name is assumed to matter.
    for (const over of [
      { dependencies: { x: '1' } }, { exports: './dist/index.js' }, { sideEffects: true }, { os: ['linux'] },
      { peerDependenciesMeta: { x: { optional: true } } }, { scripts: { postinstall: 'x' } },
    ]) {
      expect(packageDifferences(unpacked({ ...published, 'package.json': pkg(over) }), unpacked(published))).toEqual(['package.json'])
    }
  })

  it('asks npm which changed paths ship under `files`', () => {
    const paths = ['src/a.ts', 'src/gone.ts', 'README.md', 'test/a.test.ts', 'docs/x.md', 'bench/b.ts', 'package.json']
    expect(shippedPaths({ name: 'parseman', version: '0.58.0', files: ['dist', 'src', 'README.md'] }, paths))
      .toEqual(['src/a.ts', 'src/gone.ts', 'README.md'])
  })
})

describe('a run for a commit a release already contains publishes nothing', () => {
  it('finds the release that contains HEAD, through a release commit beside main', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-superseded-'))
    dirs.push(dir)
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8' }).trim()
    const commit = (message: string): string => {
      writeFileSync(join(dir, 'f'), message)
      git('add', '-A')
      git('commit', '-qm', message)
      return git('rev-parse', 'HEAD')
    }
    git('init', '-q', '-b', 'main')
    const a = commit('A')
    const b = commit('B')
    // B's release: stamped beside main, as publish.yml does.
    commit('release: 0.1.1')
    git('tag', 'v0.1.1')
    git('checkout', '-q', '--detach', b)
    expect(supersedingRelease(dir)).toBe('v0.1.1')      // a re-run of B
    git('checkout', '-q', '--detach', a)
    expect(supersedingRelease(dir)).toBe('v0.1.1')      // an older commit, re-run after B shipped
    git('checkout', '-q', 'main')
    git('reset', '-q', '--soft', b)
    commit('C')
    expect(supersedingRelease(dir)).toBeNull()          // new work after the release
  })
})

describe('the CHANGELOG a release carries', () => {
  const PRE = '# Changelog\n\nPreamble.\n'
  const date = '2026-11-02'

  it('names `## Unreleased` after the release and keeps everything else byte for byte', () => {
    const main = `${PRE}\n## Unreleased\n\n- a fix\n  continued\n\n- another\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { version: '0.58.1', date }))
      .toBe(`${PRE}\n## 0.58.1 — 2026-11-02\n\n- a fix\n  continued\n\n- another\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`)
  })

  it('files entries an earlier auto-patch shipped under that release, read from its tag', () => {
    // main never receives the release commits, so after 0.58.1 its Unreleased still holds
    // that release's entry. The 0.58.2 release must not claim it.
    const tag0581 = `${PRE}\n## 0.58.1 — 2026-11-01\n\n- first fix\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    const main = `${PRE}\n## Unreleased\n\n- first fix\n\n- second fix\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { version: '0.58.2', date, released: tag0581 })).toBe(
      `${PRE}\n## 0.58.2 — 2026-11-02\n\n- second fix\n\n## 0.58.1 — 2026-11-01\n\n- first fix\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`,
    )
  })

  it('dates a section the pull request declared, and folds Unreleased into it', () => {
    const main = `${PRE}\n## Unreleased\n\n- late fix\n\n## 0.59.0 — 2026-11-01\n\n- **Breaking:** x\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { version: '0.59.0', date }))
      .toBe(`${PRE}\n## 0.59.0 — 2026-11-02\n\n- late fix\n\n- **Breaking:** x\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`)
  })

  it('removes shipped entries from a declared section too', () => {
    const tag = `${PRE}\n## 0.58.1 — 2026-11-01\n\n- first fix\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    const main = `${PRE}\n## 0.59.0 — 2026-11-01\n\n- first fix\n\n- new api\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { version: '0.59.0', date, released: tag })).toBe(
      `${PRE}\n## 0.59.0 — 2026-11-02\n\n- new api\n\n## 0.58.1 — 2026-11-01\n\n- first fix\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`,
    )
  })

  it('opens a dated section even when nothing was filed', () => {
    const main = `${PRE}\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { version: '0.58.1', date })).toBe(`${PRE}\n## 0.58.1 — 2026-11-02\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`)
  })

  it('sync catches main up and drops an emptied Unreleased', () => {
    const tag = `${PRE}\n## 0.58.2 — 2026-11-02\n\n- b\n\n## 0.58.1 — 2026-11-01\n\n- a\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    const main = `${PRE}\n## Unreleased\n\n- a\n\n- b\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { released: tag })).toBe(tag)
    const pending = `${PRE}\n## Unreleased\n\n- a\n\n- c\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(pending, { released: tag }))
      .toBe(`${PRE}\n## Unreleased\n\n- c\n\n## 0.58.2 — 2026-11-02\n\n- b\n\n## 0.58.1 — 2026-11-01\n\n- a\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`)
    expect(stampChangelog(main, { released: '' })).toBe(main)
  })

  it('reads the entries waiting to be released', () => {
    const unreleased = `${PRE}\n## Unreleased\n\n- a\n  b\n\n- c\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(pendingEntries(unreleased, '0.58.0')).toEqual(['- a\n  b', '- c'])
    const declared = `${PRE}\n## 0.59.0 — 2026-11-01\n\n- x\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(pendingEntries(declared, '0.58.0')).toEqual(['- x'])
    expect(pendingEntries(declared, '0.59.0')).toEqual([])
  })
})

/*
 * Recording a release on main (the RELEASE_DEPLOY_KEY path). A fixture repo stands in
 * for the runner: `main` at M, the stamped release commit R on top of it, and a bare
 * repo as the remote.
 */
describe('recording a release on main', () => {
  const CHANGELOG = (top: string) => `# Changelog\n\n${top}## 0.1.0 — 2026-10-01\n\n- first\n`
  function runner(): { dir: string; remote: string; git: (...a: string[]) => string; m: string; r: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pm-record-'))
    const remote = mkdtempSync(join(tmpdir(), 'pm-record-remote-'))
    dirs.push(dir, remote)
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
    git('init', '-q', '-b', 'main')
    mkdirSync(join(dir, 'src'))
    const write = (version: string, top: string): void => {
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'parseman', version }, null, 2)}\n`)
      writeFileSync(join(dir, 'src/version.ts'), `export const PARSEMAN_VERSION = '${version}'\n`)
      writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG(top))
    }
    write('0.1.0', '## Unreleased\n\n- a fix\n\n')
    git('add', '-A')
    git('commit', '-qm', 'M')
    const m = git('rev-parse', 'HEAD')
    git('push', '-q', remote, 'main')
    // What `stamp 0.1.1` commits in the runner.
    write('0.1.1', '## 0.1.1 — 2026-11-01\n\n- a fix\n\n')
    git('add', '-A')
    git('commit', '-qm', 'release: 0.1.1')
    return { dir, remote, git, m, r: git('rev-parse', 'HEAD') }
  }
  const remoteGit = (remote: string, ...args: string[]): string => execFileSync('git', args, { cwd: remote, encoding: 'utf8' }).trim()

  it('fast-forwards main to the release commit when main has not moved', () => {
    const { dir, remote, m, r } = runner()
    expect(recordCommit(dir, '0.1.1', m)).toEqual({ action: 'fast-forward', commit: r })
    expect(record(dir, '0.1.1', remote)).toBe(r)
    expect(remoteGit(remote, 'rev-parse', 'main')).toBe(r)
  })

  it('rebuilds the stamp on a tip that moved, keeping the later PR\'s entry under Unreleased', () => {
    const { dir, remote, git, m, r } = runner()
    // Another PR merged while the release was being published.
    const other = mkdtempSync(join(tmpdir(), 'pm-record-other-'))
    dirs.push(other)
    execFileSync('git', ['clone', '-q', remote, other])
    writeFileSync(join(other, 'CHANGELOG.md'), CHANGELOG('## Unreleased\n\n- a fix\n\n- a later change\n\n'))
    writeFileSync(join(other, 'later.txt'), 'x\n')
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'N'], { cwd: other })
    execFileSync('git', ['add', '-A'], { cwd: other })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'N2'], { cwd: other })
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other })
    const n = remoteGit(remote, 'rev-parse', 'main')

    const pushed = record(dir, '0.1.1', remote)
    expect(pushed).not.toBe(r)
    // Never forced: the new main sits on top of the tip that moved.
    expect(remoteGit(remote, 'rev-parse', 'main')).toBe(pushed)
    expect(remoteGit(remote, 'rev-parse', `${pushed}^`)).toBe(n)
    expect(remoteGit(remote, 'log', '-1', '--format=%s', pushed)).toBe('release: 0.1.1')
    expect(remoteGit(remote, 'show', `${pushed}:CHANGELOG.md`)).toBe(
      '# Changelog\n\n## Unreleased\n\n- a later change\n\n## 0.1.1 — 2026-11-01\n\n- a fix\n\n## 0.1.0 — 2026-10-01\n\n- first',
    )
    expect(JSON.parse(remoteGit(remote, 'show', `${pushed}:package.json`)).version).toBe('0.1.1')
    expect(remoteGit(remote, 'show', `${pushed}:src/version.ts`)).toBe("export const PARSEMAN_VERSION = '0.1.1'")
    expect(remoteGit(remote, 'show', `${pushed}:later.txt`)).toBe('x')
    // The runner's checkout is untouched.
    expect(git('rev-parse', 'HEAD')).toBe(r)
    expect(git('status', '--porcelain')).toBe('')
    expect(m).not.toBe(n)
  })

  it('keeps a higher version a later PR declared on the moved tip', () => {
    const { dir, remote } = runner()
    const other = mkdtempSync(join(tmpdir(), 'pm-record-declared-'))
    dirs.push(other)
    execFileSync('git', ['clone', '-q', remote, other])
    // That PR renamed Unreleased (still holding the shipped "a fix") to its 0.2.0.
    writeFileSync(join(other, 'package.json'), `${JSON.stringify({ name: 'parseman', version: '0.2.0' }, null, 2)}\n`)
    writeFileSync(join(other, 'src/version.ts'), "export const PARSEMAN_VERSION = '0.2.0'\n")
    writeFileSync(join(other, 'CHANGELOG.md'), CHANGELOG('## 0.2.0 — 2026-11-01\n\n- a fix\n\n- new api\n\n'))
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'declare 0.2.0'], { cwd: other })
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other })

    const pushed = record(dir, '0.1.1', remote)
    expect(JSON.parse(remoteGit(remote, 'show', `${pushed}:package.json`)).version).toBe('0.2.0')
    expect(remoteGit(remote, 'show', `${pushed}:src/version.ts`)).toBe("export const PARSEMAN_VERSION = '0.2.0'")
    expect(remoteGit(remote, 'show', `${pushed}:CHANGELOG.md`)).toBe(
      '# Changelog\n\n## 0.2.0 — 2026-11-01\n\n- new api\n\n## 0.1.1 — 2026-11-01\n\n- a fix\n\n## 0.1.0 — 2026-10-01\n\n- first',
    )
    // And main still passes its own release gates at that commit.
    const after = mkdtempSync(join(tmpdir(), 'pm-record-after-'))
    dirs.push(after)
    execFileSync('git', ['clone', '-q', remote, after])
    for (const gate of ['scripts/check-changelog.mjs', 'scripts/check-main-release-state.mjs']) {
      const args = gate.includes('main-release') ? [`--root=${after}`, '--base-ref=main', '--head-ref=main'] : [`--root=${after}`]
      execFileSync(process.execPath, [join(dirname(new URL(import.meta.url).pathname), '../..', gate), ...args], { stdio: 'pipe' })
    }
  })

  it('never forces past a rejection: it logs why, retries, then fails with the recovery step', () => {
    const { dir, remote } = runner()
    // A remote that refuses every push, e.g. a ruleset without the deploy-key bypass.
    writeFileSync(join(remote, 'hooks/pre-receive'), '#!/bin/sh\necho "protected branch: deploy key not allowed" >&2\nexit 1\n', { mode: 0o755 })
    const before = remoteGit(remote, 'rev-parse', 'main')
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)) })
    try {
      expect(() => record(dir, '0.1.1', remote)).toThrow(/after 3 attempts[\s\S]*node scripts\/release\.mjs sync/)
    } finally {
      spy.mockRestore()
    }
    expect(errors.filter(e => e.includes('push rejected'))).toHaveLength(3)
    expect(errors.join('\n')).toMatch(/deploy key not allowed/)
    expect(remoteGit(remote, 'rev-parse', 'main')).toBe(before)
  })

  it('records nothing when main already contains the release', () => {
    const { dir, remote, r } = runner()
    record(dir, '0.1.1', remote)
    expect(recordCommit(dir, '0.1.1', r)).toEqual({ action: 'none', commit: r })
    expect(record(dir, '0.1.1', remote)).toBe(r)
  })

  it("the recorded commit's own push publishes nothing", () => {
    const { dir, git, m } = runner()
    git('tag', 'v0.1.1')
    expect(releaseCommitOf(dir)).toBe('v0.1.1')
    // Same subject, different tree: a rebuilt record on a moved tip, judged by the tarball instead.
    git('checkout', '-q', '--detach', m)
    writeFileSync(join(dir, 'later.txt'), 'x\n')
    git('add', '-A')
    git('commit', '-qm', 'release: 0.1.1')
    expect(releaseCommitOf(dir)).toBeNull()
    git('commit', '-q', '--allow-empty', '-m', 'an ordinary merge')
    expect(releaseCommitOf(dir)).toBeNull()
  })
})

describe('publish.yml records on main only with the deploy key', () => {
  const yml = readFileSync(join(dirname(new URL(import.meta.url).pathname), '../../.github/workflows/publish.yml'), 'utf8')
  const step = (name: string): string => {
    const at = yml.indexOf(`- name: ${name}`)
    expect(at).toBeGreaterThan(-1)
    const next = yml.indexOf('\n      - name:', at + 1)
    return yml.slice(at, next === -1 ? undefined : next)
  }

  it('gates the record step on the secret and still tags without it', () => {
    expect(yml).toMatch(/HAS_DEPLOY_KEY: \$\{\{ secrets\.RELEASE_DEPLOY_KEY != '' \}\}/)
    const rec = step('Record the release on main')
    expect(rec).toMatch(/env\.HAS_DEPLOY_KEY == 'true'/)
    expect(rec).toMatch(/continue-on-error: true/)
    expect(rec).not.toMatch(/--force|\+refs|push -f/)
    const tag = step('Tag the published commit')
    expect(tag).not.toMatch(/HAS_DEPLOY_KEY|steps\.record/)
    expect(yml.indexOf('- name: Record the release on main')).toBeLessThan(yml.indexOf('- name: Tag the published commit'))
    expect(step('Fail if main does not record the release')).toMatch(/steps\.record\.outcome == 'failure'/)
  })
})

describe('the plan decides from what it read', () => {
  const read = {
    declared: '0.2.0', npm: ['0.1.0', '0.2.0'], tags: ['v0.1.0', 'v0.2.0'], own: null, superseded: null,
  }
  const unchanged = (): string[] => []
  const changed = (): string[] => ['dist/index.js']

  it('skips the record commit and a commit a release already contains, before comparing anything', () => {
    const differences = vi.fn(changed)
    expect(decide({ ...read, own: 'v0.2.0', differences })).toMatchObject({ release: false, reason: expect.stringMatching(/v0\.2\.0's release commit/) })
    expect(decide({ ...read, superseded: 'v0.2.0', differences })).toMatchObject({ release: false, reason: expect.stringMatching(/already contained in v0\.2\.0/) })
    expect(differences).not.toHaveBeenCalled()
  })

  it('publishes a declared version without comparing, and the next patch only when the package changed', () => {
    const differences = vi.fn(unchanged)
    expect(decide({ ...read, declared: '0.3.0', differences })).toMatchObject({ release: true, version: '0.3.0', declared: true })
    expect(differences).not.toHaveBeenCalled()
    expect(decide({ ...read, differences })).toMatchObject({ release: false, version: '0.2.1', reason: expect.stringMatching(/nothing parseman@0\.2\.0 ships changed/) })
    expect(differences).toHaveBeenCalledWith('0.2.0')
    expect(decide({ ...read, differences: changed })).toMatchObject({ release: true, version: '0.2.1', differ: ['dist/index.js'] })
  })

  it('stops when npm\'s newest release has no tag, rather than releasing on top of it', () => {
    // 0.2.1 published, its tag push failed: the next release would read v0.2.0's CHANGELOG.
    expect(() => decide({ ...read, npm: [...read.npm, '0.2.1'], differences: changed })).toThrow(/parseman@0\.2\.1 is on npm but has no v0\.2\.1 tag/)
    // A declared release on top of it would misfile 0.2.1's entries the same way.
    expect(() => decide({ ...read, declared: '0.3.0', npm: [...read.npm, '0.2.1'], differences: changed })).toThrow(/parseman@0\.2\.1 is on npm but has no v0\.2\.1 tag/)
    // An older untagged version, or a prerelease published by hand, is not that state.
    expect(decide({ ...read, npm: ['0.0.9', ...read.npm, '0.3.0-rc.1'], differences: changed })).toMatchObject({ release: true, version: '0.2.1' })
  })
})
