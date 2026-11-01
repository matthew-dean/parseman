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
  withoutEach, nextVersion, packageDifferences, shippedPaths, stampChangelog, pendingEntries, compareVersions, parseVersion,
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
    const source = `${PRE}\n## Unreleased\n\n- first fix\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { version: '0.58.2', date, released: tag0581, source })).toBe(
      `${PRE}\n## 0.58.2 — 2026-11-02\n\n- second fix\n\n## 0.58.1 — 2026-11-01\n\n- first fix\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`,
    )
  })

  it('removes a shipped entry once, so a later entry with the same words is still released', () => {
    // 0.58.1 shipped "- Faster `compile()`." and main still lists it; a later PR filed an
    // entry worded the same way. Only the shipped one leaves.
    const tag0581 = `${PRE}\n## 0.58.1 — 2026-11-01\n\n- Faster \`compile()\`.\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    const main = `${PRE}\n## Unreleased\n\n- Faster \`compile()\`.\n\n- Faster \`compile()\`.\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    const source = `${PRE}\n## Unreleased\n\n- Faster \`compile()\`.\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { version: '0.58.2', date, released: tag0581, source })).toBe(
      `${PRE}\n## 0.58.2 — 2026-11-02\n\n- Faster \`compile()\`.\n\n## 0.58.1 — 2026-11-01\n\n- Faster \`compile()\`.\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`,
    )
    expect(withoutEach(['a', 'b', 'a', 'c'], ['a', 'c', 'x'])).toEqual(['b', 'a'])
  })

  it('releases an entry a later PR re-lands with the same words', () => {
    // 0.58.1 shipped "- Add foo."; PR B removed it and 0.58.2 shipped "- Revert foo.";
    // PR C re-lands foo, and its entry comes back word for word. Only what 0.58.2 took off
    // main (its source's Unreleased) is shipped: the re-landed line is new.
    const tag0582 = `${PRE}\n## 0.58.2 — 2026-11-02\n\n- Revert foo.\n\n## 0.58.1 — 2026-11-01\n\n- Add foo.\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    const source = `${PRE}\n## Unreleased\n\n- Revert foo.\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    const main = `${PRE}\n## Unreleased\n\n- Add foo.\n\n- Revert foo.\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { version: '0.58.3', date: '2026-11-03', released: tag0582, source })).toBe(
      `${PRE}\n## 0.58.3 — 2026-11-03\n\n- Add foo.\n\n## 0.58.2 — 2026-11-02\n\n- Revert foo.\n\n## 0.58.1 — 2026-11-01\n\n- Add foo.\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`,
    )
  })

  it('lists an entry folded into a declared release once, under that release', () => {
    // A docs-only merge filed U under Unreleased; a PR then declared 0.59.0 below it. The
    // 0.59.0 stamp folded U in. main still has its own 0.59.0 section without U, and U
    // still under Unreleased; a later PR adds Q.
    const source = `${PRE}\n## Unreleased\n\n- U\n\n## 0.59.0 — 2026-11-02\n\n- the minor\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    const tag0590 = `${PRE}\n## 0.59.0 — 2026-11-02\n\n- U\n\n- the minor\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    const main = `${PRE}\n## Unreleased\n\n- U\n\n- Q\n\n## 0.59.0 — 2026-11-02\n\n- the minor\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { version: '0.59.1', date: '2026-11-03', released: tag0590, source })).toBe(
      `${PRE}\n## 0.59.1 — 2026-11-03\n\n- Q\n\n## 0.59.0 — 2026-11-02\n\n- U\n\n- the minor\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`,
    )
  })

  it('refuses `released` without `source`', () => {
    expect(() => stampChangelog(`${PRE}\n## 0.58.0 — 2026-10-31\n\n- shipped\n`, { version: '0.58.1', date, released: PRE })).toThrow(/needs `source`/)
  })

  it('dates a section the pull request declared, and folds Unreleased into it', () => {
    const main = `${PRE}\n## Unreleased\n\n- late fix\n\n## 0.59.0 — 2026-11-01\n\n- **Breaking:** x\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { version: '0.59.0', date }))
      .toBe(`${PRE}\n## 0.59.0 — 2026-11-02\n\n- late fix\n\n- **Breaking:** x\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`)
  })

  it('removes shipped entries from a declared section too', () => {
    const tag = `${PRE}\n## 0.58.1 — 2026-11-01\n\n- first fix\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    const main = `${PRE}\n## 0.59.0 — 2026-11-01\n\n- first fix\n\n- new api\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    const source = `${PRE}\n## Unreleased\n\n- first fix\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { version: '0.59.0', date, released: tag, source })).toBe(
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
    // 0.58.2 was stamped from a main that still held 0.58.1's "a" beside its own "b".
    const source = `${PRE}\n## Unreleased\n\n- a\n\n- b\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(main, { released: tag, source })).toBe(tag)
    const pending = `${PRE}\n## Unreleased\n\n- a\n\n- c\n\n## 0.58.0 — 2026-10-31\n\n- shipped\n`
    expect(stampChangelog(pending, { released: tag, source }))
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
  // main as v0.2.0 left it: the section that release shipped.
  const shipped020 = '# Changelog\n\n## 0.2.0 — 2026-11-01\n\n- the minor\n\n## 0.1.0 — 2026-10-01\n\n- first\n'
  const read = {
    declared: '0.2.0', npm: ['0.1.0', '0.2.0'], tags: ['v0.1.0', 'v0.2.0'], own: null, superseded: null,
    changelog: shipped020, released: (tag: string): string => (tag === 'v0.2.0' ? shipped020 : ''),
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

  it('stops when package.json declares a version another merge already shipped, with entries it did not ship', () => {
    // A PR declared 0.2.0 and passed its gate; another merge shipped 0.2.0 first; then
    // this PR merged. Its entries sit under ## 0.2.0, which v0.2.0 never contained.
    const stale = '# Changelog\n\n## 0.2.0 — 2026-11-02\n\n- the new api\n\n## 0.1.0 — 2026-10-01\n\n- first\n'
    expect(() => decide({ ...read, changelog: stale, differences: changed }))
      .toThrow(/declares 0\.2\.0, which v0\.2\.0 already released[\s\S]*1 entry that release did not ship[\s\S]*- the new api[\s\S]*delete the ## 0\.2\.0 heading, then run `node scripts\/release\.mjs sync`/)
    // `sync` alone leaves the stale section where it is, so the stop stands.
    expect(stampChangelog(stale, { released: shipped020, source: shipped020 })).toBe(stale)
    // The fix the message names: the entries move under Unreleased, the heading goes, and
    // `sync` files the 0.2.0 that shipped from its tag. The plan then releases the entry.
    const moved = '# Changelog\n\n## Unreleased\n\n- the new api\n\n## 0.1.0 — 2026-10-01\n\n- first\n'
    const fixed = stampChangelog(moved, { released: shipped020, source: shipped020 })
    expect(fixed).toBe('# Changelog\n\n## Unreleased\n\n- the new api\n\n## 0.2.0 — 2026-11-01\n\n- the minor\n\n## 0.1.0 — 2026-10-01\n\n- first\n')
    expect(decide({ ...read, changelog: fixed, differences: changed })).toMatchObject({ release: true, version: '0.2.1' })
  })

  it('accepts main trailing its tags with the section the release shipped, re-dated or folded into', () => {
    // The tag's stamp dated the heading and folded an Unreleased entry in: main's
    // section is a subset of what shipped, which is the normal state without the deploy key.
    const tagged = '# Changelog\n\n## 0.2.0 — 2026-11-03\n\n- a late fix\n\n- the minor\n\n## 0.1.0 — 2026-10-01\n\n- first\n'
    expect(decide({ ...read, released: () => tagged, differences: changed })).toMatchObject({ release: true, version: '0.2.1' })
    // The declaring PR renamed an Unreleased that still held 0.1.1's entry; the 0.2.0 stamp
    // left that entry under 0.1.1. It is shipped, so it does not count as stale.
    const renamed = '# Changelog\n\n## 0.2.0 — 2026-11-01\n\n- from 0.1.1\n\n- the minor\n\n## 0.1.0 — 2026-10-01\n\n- first\n'
    const taggedWith011 = '# Changelog\n\n## 0.2.0 — 2026-11-01\n\n- the minor\n\n## 0.1.1 — 2026-10-15\n\n- from 0.1.1\n\n## 0.1.0 — 2026-10-01\n\n- first\n'
    expect(decide({ ...read, changelog: renamed, released: () => taggedWith011, differences: changed })).toMatchObject({ release: true })
    // No section for the version on main (a sync that only moved package.json): nothing to compare.
    expect(decide({ ...read, changelog: '# Changelog\n\n## Unreleased\n\n- x\n', differences: changed })).toMatchObject({ release: true })
  })
})

describe('publish.yml runs no dependency where a credential is held', () => {
  const yml = readFileSync(join(dirname(new URL(import.meta.url).pathname), '../../.github/workflows/publish.yml'), 'utf8')
  // Each job's text: the lines under `jobs:` from one two-space-indented key to the next.
  const jobs = yml.slice(yml.indexOf('\njobs:\n')).split(/\n(?= {2}[\w-]+:\n)/).slice(1)
    .map((text) => ({ name: /^ {2}([\w-]+):/.exec(text)![1]!, text }))

  it('gives the OIDC token, the write token and the deploy key to one job, which installs nothing but the pinned npm and runs no package code', () => {
    const privileged = jobs.filter((j) => /id-token: write|contents: write|secrets\./.test(j.text))
    expect(privileged.map((j) => j.name)).toEqual(['publish'])
    const body = privileged[0]!.text
      .split('\n').filter((line) => !/^\s*run: npm install -g npm@\d+\.\d+\.\d+$/.test(line)).join('\n')
    expect(body).not.toMatch(/\bpnpm\b|\bnpx\b|\byarn\b|\bnpm (ci|i|install|run|test|exec|pack)\b|cache:/)
    expect(body).toMatch(/npm publish "\$tgz" --provenance --ignore-scripts/)
  })

  it('pins the npm that packs and publishes', () => {
    const installs = [...yml.matchAll(/npm install -g (\S+)/g)].map((m) => m[1])
    expect(installs.length).toBeGreaterThan(0)
    for (const spec of installs) expect(spec).toMatch(/^npm@\d+\.\d+\.\d+$/)
  })
})

describe('publish.yml ships a tarball no test-time dependency touched', () => {
  const yml = readFileSync(join(dirname(new URL(import.meta.url).pathname), '../../.github/workflows/publish.yml'), 'utf8')
  const jobs = Object.fromEntries(yml.slice(yml.indexOf('\njobs:\n')).split(/\n(?= {2}[\w-]+:\n)/).slice(1)
    .map((text) => [/^ {2}([\w-]+):/.exec(text)![1]!, text]))

  it('packs what ships in a job that runs the build alone, and only the build job hands a tarball over', () => {
    const build = jobs.build!
    expect(build).toMatch(/pnpm install --frozen-lockfile --ignore-scripts/)
    expect(build).toMatch(/npm pack --ignore-scripts/)
    expect(build).not.toMatch(/cache:|pnpm (test|run|exec|build)\b|vitest/)
    expect(build).toMatch(/if \[ "\$sha" != "\$PREPARED" \]; then/)
    expect(jobs.prepare).not.toMatch(/upload-artifact/)
    expect(build).toMatch(/upload-artifact/)
  })

  it('publishes that tarball by the sha the build job output, and decides the version itself', () => {
    const publish = jobs.publish!
    expect(publish).toMatch(/needs: \[prepare, build\]/)
    expect(publish).toMatch(/SHA256: \$\{\{ needs\.build\.outputs\.sha256 \}\}/)
    const check = publish.indexOf('sha256sum -c --strict')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(publish.indexOf('npm publish "$tgz"'))
    expect(publish).toMatch(/nextVersion\(\{ declared, published: \[\.\.\.npm, \.\.\.tags\] \}\)/)
    expect(publish.indexOf('The version is the one main asks for')).toBeLessThan(publish.indexOf('npm publish "$tgz"'))
    expect(publish).toMatch(/if \[ "\$stamped" != "\$COMMIT" \]; then/)
  })
})

describe('publish.yml releases only a commit CI passed', () => {
  const yml = readFileSync(join(dirname(new URL(import.meta.url).pathname), '../../.github/workflows/publish.yml'), 'utf8')

  it('waits for the required `test` check on this exact commit before stamping', () => {
    const wait = yml.indexOf('- name: Wait for CI to pass on this commit')
    expect(wait).toBeGreaterThan(-1)
    expect(wait).toBeLessThan(yml.indexOf('- name: Stamp the release'))
    const step = yml.slice(wait, yml.indexOf('\n      - name:', wait + 1))
    expect(step).toMatch(/commits\/\$GITHUB_SHA\/check-runs\?check_name=test&/)
    expect(step).toMatch(/"completed success"\) .*break/)
    expect(step).toMatch(/completed\*\) .*exit 1/)
  })
})
