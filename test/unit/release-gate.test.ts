/**
 * `scripts/check-changelog.mjs` is the gate that keeps `main` shippable at all times.
 *
 * It exists in this form because the previous form did not work. It ran only as
 * `prepublishOnly` and asked whether package.json's version appeared ANYWHERE in
 * CHANGELOG.md — which a `## Unreleased` section sitting on top of the real content
 * satisfies trivially. So `fix(expect)` merged, `main` read 0.35.0, the changelog's
 * top section read `## Unreleased`, and nothing complained until someone tried to
 * publish. The first two tests below are that exact state.
 *
 * These run the real script against fixture checkouts — real git repos for the bump
 * rule — which is also the only way to cover a script that executes at module scope
 * and cannot be imported. Same approach as `doc-verifier.test.ts`.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = join(ROOT, 'scripts/check-changelog.mjs')

interface Result {
  out: string
  ok: boolean
}

/** Run the gate against `dir`, capturing both streams and the pass/fail verdict. */
function gate(dir: string, ...args: string[]): Result {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, `--root=${dir}`, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    return { out, ok: true }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}` || (err.message ?? ''), ok: false }
  }
}

interface Checkout {
  /** package.json contents; `version` is spread in from `version`. */
  pkg?: Record<string, unknown>
  version?: string
  /** Everything below the first `##` heading is irrelevant to the gate. */
  changelog: string
  /** Omit to leave src/version.ts absent. */
  stamp?: string | null
  files?: Record<string, string>
}

const dirs: string[] = []

function checkout(spec: Checkout): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-relgate-'))
  dirs.push(dir)
  write(dir, spec)
  return dir
}

function write(dir: string, spec: Checkout): void {
  const version = spec.version ?? '0.36.0'
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'parseman', version, ...spec.pkg }, null, 2)}\n`,
  )
  writeFileSync(join(dir, 'CHANGELOG.md'), spec.changelog)
  if (spec.stamp !== null) {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/version.ts'), `export const PARSEMAN_VERSION = '${spec.stamp ?? version}'\n`)
  }
  for (const [rel, body] of Object.entries(spec.files ?? {})) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
}

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'gate', GIT_AUTHOR_EMAIL: 'gate@example.invalid',
      GIT_COMMITTER_NAME: 'gate', GIT_COMMITTER_EMAIL: 'gate@example.invalid',
    },
  }).trim()

/** A two-commit repo: `base` then `head`. Returns the dir and the base sha. */
function repo(base: Checkout, head: Checkout): { dir: string; baseSha: string } {
  const dir = checkout(base)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  const baseSha = git(dir, 'rev-parse', 'HEAD')
  write(dir, head)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'head')
  return { dir, baseSha }
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const released = (v: string): string => `# Changelog\n\n## ${v} — 2026-07-24\n\n- something\n`

/** A changelog with `next` OPEN for construction above published `published`. */
const open_ = (next: string, published = '0.36.0'): string =>
  `# Changelog\n\n## ${next} — unreleased\n\n- the change under construction\n\n## ${published} — 2026-07-24\n\n- shipped\n`

describe('merging is not publishing', () => {
  /*
   * The gate used to require a `package.json` bump on any PR touching `src/**`. That
   * makes a version number the price of MERGING, while this project spends numbers at
   * PUBLISH — so between two releases every PR burned a number and all but the last
   * collapsed (0.37 through 0.41 shipped as one 0.37.0). It also forced a PR that could
   * not bump to file its entry under an ALREADY PUBLISHED heading, documenting changes
   * into a release that does not contain them, with the `release-exempt` label — meant
   * for reverts and chained PRs — as the only way out.
   *
   * The invariant is now changelog-relative: `main` carries an open section naming the
   * next unpublished version, every PR files into it, and the numbers converge at
   * publish.
   */
  it('accepts an OPEN section above package.json outside publish mode', () => {
    const r = gate(checkout({ version: '0.36.0', changelog: open_('0.37.0') }))
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/0\.37\.0 open for construction over published 0\.36\.0/)
  })

  it('REFUSES TO PUBLISH while a section is still open', () => {
    // The bump is not optional, only deferred. `--publish` is where it comes due.
    const r = gate(checkout({ version: '0.36.0', changelog: open_('0.37.0') }), '--publish')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/cannot publish/)
    expect(r.out).toMatch(/package\.json AND src\/version\.ts to 0\.37\.0/)
  })

  it('publishes once the numbers converge', () => {
    const r = gate(checkout({ version: '0.37.0', changelog: released('0.37.0') }), '--publish')
    expect(r.ok).toBe(true)
  })

  it('REJECTS a top section BELOW package.json in every mode', () => {
    // Ahead is a release under construction; behind is history being rewritten.
    for (const args of [[], ['--publish']]) {
      const r = gate(checkout({ version: '0.37.0', changelog: released('0.36.0') }), ...args)
      expect(r.ok).toBe(false)
    }
  })

  it('still refuses `Unreleased` as the open section — it names no version', () => {
    // Deferring the BUMP is not the same as deferring the DECISION. An open section
    // still has to say which version is being built, or `main` is back in the state
    // that let 0.36.0's content sit under a heading naming nothing.
    const r = gate(
      checkout({
        version: '0.36.0',
        changelog: `# Changelog\n\n## Unreleased\n\n- x\n\n## 0.36.0 — 2026-07-24\n\n- shipped\n`,
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/names no version/)
  })

  it('still requires src/version.ts to track package.json, not the open section', () => {
    // The stamp goes into every generated-artifact banner and is read by the fuse-time
    // version lock, so it moves WITH package.json at publish — never ahead of it.
    const r = gate(checkout({ version: '0.36.0', changelog: open_('0.37.0'), stamp: '0.37.0' }))
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/src\/version\.ts stamps 0\.37\.0 but package\.json says 0\.36\.0/)
  })
})

describe('release integrity', () => {
  it('REJECTS an `Unreleased` top section — the state main was actually in', () => {
    const r = gate(
      checkout({
        version: '0.35.0',
        changelog: `# Changelog\n\n## Unreleased\n\n- the fix that was never versioned\n\n## 0.35.0 — 2026-07-24\n\n- shipped\n`,
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/top section is "## Unreleased", which names no version/)
  })

  it('is not satisfied by a matching heading further DOWN the file', () => {
    // The old check tested `^##\s+0\.35\.0\b` anywhere in the document, so the
    // release history alone passed it while the top section named nothing.
    const r = gate(
      checkout({
        version: '0.35.0',
        changelog: `# Changelog\n\n## Unreleased\n\n- x\n\n## 0.35.0 — 2026-07-24\n\n- shipped\n`,
      }),
    )
    expect(r.ok).toBe(false)
  })

  it('REJECTS a top section that names a DIFFERENT version than package.json', () => {
    const r = gate(checkout({ version: '0.36.0', changelog: released('0.35.0') }))
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/top section is 0\.35\.0 but package\.json says 0\.36\.0/)
  })

  it('REJECTS a src/version.ts stamp that drifted from package.json', () => {
    const r = gate(checkout({ version: '0.36.0', changelog: released('0.36.0'), stamp: '0.35.0' }))
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/src\/version\.ts stamps 0\.35\.0 but package\.json says 0\.36\.0/)
  })

  it('ACCEPTS changelog, package.json and the artifact stamp in agreement', () => {
    const r = gate(checkout({ version: '0.36.0', changelog: released('0.36.0') }))
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/top section is 0\.36\.0/)
  })

  it('tolerates the bracketed heading form', () => {
    const r = gate(
      checkout({ version: '0.36.0', changelog: '# Changelog\n\n## [v0.36.0] - 2026-07-24\n\n- x\n' }),
    )
    expect(r.ok).toBe(true)
  })
})

describe('bump gate', () => {
  it('REJECTS a src/ change filed under an ALREADY PUBLISHED section', () => {
    // The top section equals package.json, so it is the version that shipped. Filing a
    // change there documents it into a release that does not contain it.
    const { dir, baseSha } = repo(
      { version: '0.36.0', changelog: released('0.36.0'), files: { 'src/a.ts': 'export const a = 1\n' } },
      { version: '0.36.0', changelog: released('0.36.0'), files: { 'src/a.ts': 'export const a = 2\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/which is already published/)
    expect(r.out).toMatch(/Do NOT bump package\.json/)
    expect(r.out).toMatch(/release-exempt/)
  })

  it('ACCEPTS a src/ change filed under an OPEN section, with NO version bump', () => {
    // This is the whole point. `package.json` does not move; the changelog opens the
    // next version and the change is filed there.
    const { dir, baseSha } = repo(
      { version: '0.36.0', changelog: released('0.36.0'), files: { 'src/a.ts': 'export const a = 1\n' } },
      { version: '0.36.0', changelog: open_('0.37.0'), files: { 'src/a.ts': 'export const a = 2\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/0\.37\.0 is open for construction/)
    expect(r.out).toMatch(/the bump lands at publish, not at merge/)
  })

  it('lets a SECOND PR land into the same open section — the collapse this fixes', () => {
    // A branch-relative rule ("head version > base version") would demand another bump
    // here, and that number would collapse into whatever finally ships: 0.37 through
    // 0.41 all went out as one 0.37.0 exactly this way. The section is already open, so
    // this PR costs nothing.
    const { dir, baseSha } = repo(
      { version: '0.36.0', changelog: open_('0.37.0'), files: { 'src/a.ts': 'export const a = 1\n' } },
      { version: '0.36.0', changelog: open_('0.37.0'), files: { 'src/a.ts': 'export const a = 2\n' } },
    )
    expect(gate(dir, `--base=${baseSha}`).ok).toBe(true)
  })

  it('does NOT require a bump for a change that cannot reach a consumer', () => {
    // The whole reason this gate can be a required check. Tests, docs, benches,
    // scripts and CI config change nothing about what `npm install` produces, and a
    // gate that fires on them gets bypassed — taking the real gates with it.
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: { 'test/x.test.ts': 'a\n', 'docs/g.md': 'a\n' } },
      { changelog: released('0.36.0'), files: { 'test/x.test.ts': 'b\n', 'docs/g.md': 'b\n', '.github/workflows/ci.yml': 'x\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/no published surface changed/)
  })

  it('REQUIRES a bump when a consumer-facing package.json field changes without src/', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), pkg: { exports: { '.': './dist/index.js' } } },
      { changelog: released('0.36.0'), pkg: { exports: { '.': './dist/index.js', './run': './dist/run/index.js' } } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/package\.json exports/)
  })

  it('REQUIRES a bump when a build input changes', () => {
    // `scripts/build.mjs` and the bundler config decide what dist/ CONTAINS. They can
    // change every shipped byte — different externals, a dropped entry — with src/
    // and package.json sitting still.
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: { 'scripts/build.mjs': 'a\n' } },
      { changelog: released('0.36.0'), files: { 'scripts/build.mjs': 'b\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/build input scripts\/build\.mjs/)
  })

  it('REQUIRES a bump when the INHERITED tsconfig changes', () => {
    // `tsconfig.build.json` is four lines that `extends` the root config, and the
    // shipped declarations come from `tsc -p tsconfig.build.json`. A declaration-
    // affecting option edited in `tsconfig.json` therefore reaches dist/*.d.ts
    // without `tsconfig.build.json` being touched at all.
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: { 'tsconfig.json': '{"compilerOptions":{"strict":true}}\n' } },
      { changelog: released('0.36.0'), files: { 'tsconfig.json': '{"compilerOptions":{"strict":false}}\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/build input tsconfig\.json/)
  })

  it('does NOT treat the rest of scripts/ as a build input', () => {
    // The other half: CI machinery in the same directory reaches no consumer.
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: { 'scripts/coverage-guard.mjs': 'a\n' } },
      { changelog: released('0.36.0'), files: { 'scripts/coverage-guard.mjs': 'b\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/no published surface changed/)
  })

  it('REQUIRES a bump when a consumer-executed lifecycle script changes', () => {
    // `postinstall` runs on the machine of whoever installs parseman. Changing what
    // executes at install time is a consumer-visible change with nothing in src/.
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), pkg: { scripts: { postinstall: 'node a.js', test: 'vitest' } } },
      { changelog: released('0.36.0'), pkg: { scripts: { postinstall: 'node b.js', test: 'vitest' } } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/install-time scripts/)
  })

  it('does NOT require a bump for a script that reaches nobody', () => {
    // The other half of the same rule. `scripts` is not compared wholesale: `test`,
    // `lint` and the bench entries churn constantly and never execute for a consumer.
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), pkg: { scripts: { postinstall: 'node a.js', 'bench:x': 'node x.ts' } } },
      { changelog: released('0.36.0'), pkg: { scripts: { postinstall: 'node a.js', 'bench:x': 'node y.ts' } } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/no published surface changed/)
  })

  it('orders prerelease identifiers numerically, not lexically', () => {
    // `rc.10` follows `rc.2`. Comparing the tag as one string puts it BELOW, which
    // would read a legitimate open section as a downgrade and block it.
    const { dir, baseSha } = repo(
      { version: '1.0.0-rc.2', changelog: released('1.0.0-rc.2'), files: { 'src/a.ts': 'export const a = 1\n' } },
      {
        version: '1.0.0-rc.2',
        changelog: open_('1.0.0-rc.10', '1.0.0-rc.2'),
        files: { 'src/a.ts': 'export const a = 2\n' },
      },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/1\.0\.0-rc\.10 is open for construction/)
  })

  it('rejects a top section that goes BACKWARDS from package.json', () => {
    const { dir, baseSha } = repo(
      { version: '1.0.0-rc.10', changelog: released('1.0.0-rc.10'), files: { 'src/a.ts': 'export const a = 1\n' } },
      {
        version: '1.0.0-rc.10',
        changelog: open_('1.0.0-rc.9', '1.0.0-rc.10'),
        files: { 'src/a.ts': 'export const a = 2\n' },
      },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/never behind it|can be AHEAD/)
  })

  it('sorts a prerelease BELOW its release, per semver', () => {
    // `1.0.0` is above `1.0.0-rc.1`, so opening `1.0.0` over a published rc is valid.
    const { dir, baseSha } = repo(
      { version: '1.0.0-rc.1', changelog: released('1.0.0-rc.1'), files: { 'src/a.ts': 'export const a = 1\n' } },
      {
        version: '1.0.0-rc.1',
        changelog: open_('1.0.0', '1.0.0-rc.1'),
        files: { 'src/a.ts': 'export const a = 2\n' },
      },
    )
    expect(gate(dir, `--base=${baseSha}`).ok).toBe(true)
  })

  it('does NOT require a bump for a devDependency-only package.json change', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), pkg: { devDependencies: { vitest: '~4.1.9' } } },
      { changelog: released('0.36.0'), pkg: { devDependencies: { vitest: '~4.2.0' } } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/no published surface changed/)
  })

  it('REJECTS a version that goes DOWN — and the label is the only way through', () => {
    const revert = {
      base: { version: '0.37.0', changelog: released('0.37.0'), files: { 'src/a.ts': 'export const a = 2\n' } },
      head: { version: '0.36.0', changelog: released('0.36.0'), files: { 'src/a.ts': 'export const a = 1\n' } },
    }
    const { dir, baseSha } = repo(revert.base, revert.head)
    expect(gate(dir, `--base=${baseSha}`).ok).toBe(false)

    const waived = gate(dir, `--base=${baseSha}`, '--exempt')
    expect(waived.ok).toBe(true)
    expect(waived.out).toMatch(/RELEASE GATE WAIVED/)
  })

  it('the label waives the BUMP rule only — never release integrity', () => {
    const { dir, baseSha } = repo(
      { version: '0.36.0', changelog: released('0.36.0') },
      {
        version: '0.36.0',
        changelog: '# Changelog\n\n## Unreleased\n\n- x\n\n## 0.36.0 — 2026-07-24\n\n- y\n',
        files: { 'src/a.ts': 'export const a = 1\n' },
      },
    )
    const r = gate(dir, `--base=${baseSha}`, '--exempt')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/names no version/)
  })
})
