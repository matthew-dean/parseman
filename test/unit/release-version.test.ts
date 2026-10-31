/**
 * `scripts/release.mjs` decides, on every push to `main`, whether parseman publishes and
 * as which version, and writes the CHANGELOG the release carries. These are its pure
 * parts; `release-gate.test.ts` covers the pull-request gate that feeds it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  nextVersion, packageDifferences, shippedPaths, stampChangelog, pendingEntries, compareVersions, parseVersion,
  consumerFieldChanges, supersedingRelease,
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
