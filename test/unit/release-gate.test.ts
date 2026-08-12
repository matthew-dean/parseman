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

/**
 * TIMEOUTS — every test here spawns the real gate, and several build a throwaway git
 * repo with a handful of `git` invocations first. vitest's default budget is 5s,
 * which is a budget for an in-process unit test, not for a chain of child processes.
 *
 * That is an INVERTED budget: the child is allowed 60s and the parent 5s, so on a
 * loaded box vitest fires first and reports `Test timed out in 5000ms` — discarding
 * the child's stdout and stderr, which is the only diagnostic that says what actually
 * went wrong. The `gate()` helper below exists precisely to capture those streams.
 * CI is uncontended enough that this never fires there, so it reads as a local-only
 * flake rather than as the budget bug it is.
 *
 * The rule these encode: a test's vitest budget is strictly GREATER than the budget
 * of the children it spawns, so a genuine hang is reported by the child's own timeout
 * with its output attached. No test here spawns the gate more than twice, and the git
 * setup is bounded by its own budget.
 *
 * These are not noise absorption and are not sized against how long a run takes. A
 * test that exceeds one is a hang, not a slow machine.
 */
const SPAWN_BUDGET_MS = 60_000
/** Repo setup: a bounded number of short `git` invocations. */
const GIT_BUDGET_MS = 30_000
/** No test spawns the gate more than twice; add the git setup and a margin. */
const SUITE_BUDGET_MS = 2 * SPAWN_BUDGET_MS + GIT_BUDGET_MS + 30_000

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
      timeout: SPAWN_BUDGET_MS,
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
    // Unbudgeted, a wedged `git` (an index.lock another checkout holds) hangs the
    // suite until vitest kills it with no output. Bounded, it throws with its stderr.
    timeout: GIT_BUDGET_MS,
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

describe('merging is not publishing', { timeout: SUITE_BUDGET_MS }, () => {
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

describe('release integrity', { timeout: SUITE_BUDGET_MS }, () => {
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

describe('bump gate', { timeout: SUITE_BUDGET_MS }, () => {
  it('REJECTS a src/ change filed under an ALREADY PUBLISHED section', () => {
    // The top section equals package.json, so it is the version that shipped. Filing a
    // change there documents it into a release that does not contain it.
    const { dir, baseSha } = repo(
      { version: '0.36.0', changelog: released('0.36.0'), files: { 'src/a.ts': 'export const a = 1\n' } },
      { version: '0.36.0', changelog: released('0.36.0'), files: { 'src/a.ts': 'export const a = 2\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/already published as of the base/)
    // Both ways out are offered, because both are legal: defer the number to a later
    // publish, or make this PR the release. The message used to say "Do NOT bump
    // package.json" as an absolute, which is false for a release PR.
    expect(r.out).toMatch(/DEFER/)
    expect(r.out).toMatch(/RELEASE/)
    expect(r.out).toMatch(/release-exempt/)
  })

  it('ACCEPTS a RELEASE PR: heading, package.json and src/version.ts all bumped together', () => {
    // The release-PR shape. `package.json` moves ahead of npm in this very PR, so HEAD's
    // version is NOT the "last published" marker — the BASE's is. Reading HEAD here asked
    // "is the heading above the version this PR is publishing?", which is 0 by
    // construction, and rejected a correctly prepped release with the sentence
    // "0.45.0, which is already published" about a version that was not published at all.
    const { dir, baseSha } = repo(
      { version: '0.36.0', changelog: released('0.36.0'), files: { 'src/a.ts': 'export const a = 1\n' } },
      { version: '0.37.0', changelog: released('0.37.0'), files: { 'src/a.ts': 'export const a = 2\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/this is a RELEASE of 0\.37\.0/)
  })

  it('REJECTS a heading BELOW the base, even when package.json agrees with it', () => {
    // Guards the direction of the new base comparison: a downgrade must not read as
    // "not yet published" merely because heading and package.json are consistent.
    const { dir, baseSha } = repo(
      { version: '0.37.0', changelog: released('0.37.0'), files: { 'src/a.ts': 'export const a = 1\n' } },
      { version: '0.36.0', changelog: released('0.36.0'), files: { 'src/a.ts': 'export const a = 2\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
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

/*
 * C. BENCH ANCHOR GATE
 *
 * `bench/grammar-density/config.json` and `bench/workloads/config.json` each carry an
 * A/B `referenceSha` and each carry, in a JSON comment, "bump this to the released sha
 * at every release, in the release PR". Neither was bumped for TEN releases: when
 * 0.45.0 was prepped the density gate still measured against v0.33.0 and the workload
 * gate against v0.35.0.
 *
 * A stale anchor does not read red. It reads `ok` against a baseline that has already
 * absorbed every regression since, so the headroom becomes the error bar —
 * `rollback/dense` sat at -62%, meaning that path could have got 2.6x SLOWER and still
 * passed. The absolute-baseline rule held in letter while its resolution was gone.
 *
 * A policy that lives in a comment and depends on someone remembering it is not a
 * policy. These tests are the policy executed.
 */
describe('a missing input is a harder failure than a wrong one', { timeout: SUITE_BUDGET_MS }, () => {
  /*
   * The `PARSEMAN_VERSION`-vs-package.json convergence check sat behind
   * `existsSync(src/version.ts)`, including under `--publish`, where A' says all three
   * sites must be EQUAL. So deleting the file satisfied the rule by removing one of the
   * things it compares — a gate passing because it had one fewer thing to check.
   * package.json and CHANGELOG.md already `fail()` when absent; the version stamp is
   * the ARTIFACT VERSION LOCK and should be no softer.
   */
  it('FAILS when src/ exists but src/version.ts does not', () => {
    const dir = checkout({ version: '0.36.0', changelog: released('0.36.0'), stamp: null })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'parseman', version: '0.36.0' }))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1\n')
    const r = gate(dir)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/src\/version\.ts is missing/)
  })

  it('FAILS at publish too — that is the moment all three must agree', () => {
    const dir = checkout({ version: '0.36.0', changelog: released('0.36.0'), stamp: null })
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1\n')
    expect(gate(dir, '--publish').ok).toBe(false)
  })

  it('tolerates a checkout with no src/ at all — the fixture shape', () => {
    // Absence is only legitimate where there is no source tree to stamp. Every other
    // test in this file relies on that.
    const r = gate(checkout({ version: '0.36.0', changelog: released('0.36.0'), stamp: null }))
    expect(r.ok).toBe(true)
  })
})

describe('bench anchor gate', { timeout: SUITE_BUDGET_MS }, () => {
  const DENSITY = 'bench/grammar-density/config.json'
  const WORKLOADS = 'bench/workloads/config.json'

  const anchors = (sha: string): Record<string, string> => ({
    [DENSITY]: `${JSON.stringify({ referenceSha: sha }, null, 2)}\n`,
    [WORKLOADS]: `${JSON.stringify({ referenceSha: sha }, null, 2)}\n`,
  })

  /**
   * A repo whose base branch is the stable release line, followed by the release PR
   * head. Optional commits model a stable-main repair or release guard added after the
   * package was published without changing its runtime source.
   */
  function releaseRepo(opts: {
    previous: string
    published: string
    /** Commits merged onto the base AFTER the release, still at `published`. */
    after?: number
    head: Checkout
  }): { dir: string; baseSha: string; releaseSha: string } {
    const dir = checkout({ version: opts.previous, changelog: released(opts.previous) })
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', `release ${opts.previous}`)

    write(dir, { version: opts.published, changelog: released(opts.published) })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', `release ${opts.published}`)
    const releaseSha = git(dir, 'rev-parse', 'HEAD')

    for (let i = 0; i < (opts.after ?? 0); i++) {
      writeFileSync(join(dir, `docs-${i}.md`), `# ${i}\n`)
      git(dir, 'add', '-A')
      git(dir, 'commit', '-qm', `docs ${i}`)
    }
    const baseSha = git(dir, 'rev-parse', 'HEAD')

    write(dir, opts.head)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'head')
    return { dir, baseSha, releaseSha }
  }

  /** The 0.45.0 release PR, parameterised on what the anchors say. */
  const releasePr = (anchorSha: string, after = 0) =>
    releaseRepo({
      previous: '0.43.0',
      published: '0.44.0',
      after,
      head: {
        version: '0.45.0',
        changelog: released('0.45.0'),
        files: { 'src/a.ts': 'export const a = 1\n', ...anchors(anchorSha) },
      },
    })

  it('FAILS a release PR whose anchors still name an older release', () => {
    // The defect verbatim: the release is prepped, the changelog and both version
    // stamps agree, `--publish` would pass — and both perf gates are still measuring
    // against something ten releases back.
    const { dir, baseSha } = releasePr('0abc123')
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/RELEASE PR for 0\.45\.0/)
    expect(r.out).toContain(DENSITY)
    expect(r.out).toContain(WORKLOADS)
    // It must name the exact stable base sha to use, not merely complain.
    expect(r.out).toContain(baseSha.slice(0, 7))
  })

  it('PASSES once both anchors name the exact stable base', () => {
    const seed = releasePr('0abc123')
    const r0 = gate(seed.dir, `--base=${seed.baseSha}`)
    expect(r0.ok).toBe(false)

    // Re-anchor in place — the fix the failure message asks for.
    write(seed.dir, {
      version: '0.45.0',
      changelog: released('0.45.0'),
      files: { 'src/a.ts': 'export const a = 1\n', ...anchors(seed.baseSha.slice(0, 7)) },
    })
    git(seed.dir, 'add', '-A')
    git(seed.dir, 'commit', '-qm', 're-anchor')

    const r = gate(seed.dir, `--base=${seed.baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/perf-gate anchors name/)
  })

  it('names the exact base tip, not the first commit that introduced its version', () => {
    // 0.47.0 developed through multiple release candidates while package.json already
    // said 0.47.0. The old first-version heuristic selected an unpublished tree.
    // Stable main is now guarded, so the release PR compares against its exact tip.
    const { dir, baseSha, releaseSha } = releasePr('0abc123', 3)
    expect(baseSha).not.toBe(releaseSha)

    const wrong = gate(dir, `--base=${baseSha}`)
    expect(wrong.ok).toBe(false)
    expect(wrong.out).toContain(baseSha.slice(0, 7))

    write(dir, {
      version: '0.45.0',
      changelog: released('0.45.0'),
      files: { 'src/a.ts': 'export const a = 1\n', ...anchors(baseSha.slice(0, 7)) },
    })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'anchor at the tip')
    expect(gate(dir, `--base=${baseSha}`).ok).toBe(true)
  })

  it('accepts a FULL sha as well as the abbreviated one', () => {
    const { dir, baseSha } = releasePr('0abc123')
    write(dir, {
      version: '0.45.0',
      changelog: released('0.45.0'),
      files: { 'src/a.ts': 'export const a = 1\n', ...anchors(baseSha) },
    })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'full sha')
    expect(gate(dir, `--base=${baseSha}`).ok).toBe(true)
  })

  it('`release-exempt` does NOT waive it', () => {
    // The label exists for a revert or a chained PR — reasons a VERSION should not go
    // up. Neither is a reason to measure against a stale baseline, and the whole point
    // of moving this out of a comment was that it had a hatch called "forgetting".
    const { dir, baseSha } = releasePr('0abc123')
    const r = gate(dir, `--base=${baseSha}`, '--exempt')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/no hatch/)
  })

  it('does NOT fire on a mid-cycle PR — the bump is due at RELEASE', () => {
    // Every PR between two releases files into the open section without spending a
    // number. Asking each of them to re-anchor would be the per-merge cost the release
    // gate was rewritten to remove, and would put the anchor ahead of the release.
    const { dir, baseSha } = releaseRepo({
      previous: '0.43.0',
      published: '0.44.0',
      head: {
        version: '0.44.0',
        changelog: open_('0.45.0', '0.44.0'),
        files: { 'src/a.ts': 'export const a = 1\n', ...anchors('0abc123') },
      },
    })
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
  })

  it('FAILS a release PR whose anchor is absent or a stub', () => {
    for (const bad of ['', 'HEAD', '123']) {
      const { dir, baseSha } = releaseRepo({
        previous: '0.43.0',
        published: '0.44.0',
        head: {
          version: '0.45.0',
          changelog: released('0.45.0'),
          files: {
            'src/a.ts': 'export const a = 1\n',
            [DENSITY]: `${JSON.stringify({ referenceSha: bad }, null, 2)}\n`,
          },
        },
      })
      expect(gate(dir, `--base=${baseSha}`).ok).toBe(false)
    }
  })

  it('is silent in a checkout that carries neither gate', () => {
    // The list of anchored gates is allowed to lead or trail the repo. A checkout with
    // no bench configs has nothing to re-anchor, and must not be failed for it.
    const { dir, baseSha } = releaseRepo({
      previous: '0.43.0',
      published: '0.44.0',
      head: {
        version: '0.45.0',
        changelog: released('0.45.0'),
        files: { 'src/a.ts': 'export const a = 1\n' },
      },
    })
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).not.toMatch(/perf-gate anchors/)
  })
})

/*
 * §D governs MOVING the peak. §D' governs LANDING UNDER IT without moving it — the
 * `PERF-PEAK-WAIVER` line, which is the executable form of the closing rule in
 * docs/design/perf-gates.md: "either fix the regression, or land it with the number
 * visible and an explanation of why it is the price of something".
 *
 * Every test here is about the hatch being HARD, not about it working. A test that only
 * proves the flag lets a build through is half a test: an escape hatch that is easy or
 * quiet destroys the gate it hangs off, and then the gates that matter go with it. So
 * the cases below are, in order — the rule costs nothing to PRs that do not use it; the
 * flag without a number is still red; a number inside the allowance is still red; no
 * reason is still red; a STALE one is still red; one that also moves the bar is still
 * red; and only then the waived run, which must REPORT the breach rather than report
 * green.
 */
describe("peak-clause waiver (§D')", { timeout: SUITE_BUDGET_MS }, () => {
  const WORKLOADS = 'bench/workloads/config.json'
  const DENSITY = 'bench/grammar-density/config.json'

  const peakCfg = (sha: string, over: Record<string, unknown> = {}): string =>
    `${JSON.stringify(
      { referenceSha: '0abc123', peak: { sha, version: '0.45.0', allowancePct: 5, ...over } },
      null,
      2,
    )}\n`

  /** The declared waiver, in the sanctioned form. */
  const waiver = (
    body = 'median -164.9% min -158.2% — table lowering: 2.65x parse time buys a 40x smaller artifact',
  ): string => `PERF-PEAK-WAIVER ${WORKLOADS} ${body}`

  const section = (body: string): string =>
    `# Changelog\n\n## 0.47.0 — unreleased\n\n- the change under construction\n${body}\n\n`
    + '## 0.46.0 — 2026-07-24\n\n- shipped\n'

  /**
   * A mid-cycle PR filing into the open 0.47.0 section. `head` is spliced into that
   * section on the PR side; `base` on the base side (the staleness case).
   *
   * `peak.sha` has to resolve as a real commit or §D's STRUCTURAL check fails first and
   * these tests would be measuring that instead — so the repo is seeded once, its root
   * sha read back, and the configs written naming it.
   */
  function waiverRepo(opts: {
    head: string
    base?: string
    /** Overrides applied to the peak block on the HEAD side only. */
    headPeak?: Record<string, unknown>
  }): { dir: string; baseSha: string } {
    const dir = checkout({ version: '0.46.0', changelog: section('') })
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'seed')
    const sha = git(dir, 'rev-parse', 'HEAD').slice(0, 7)

    write(dir, {
      version: '0.46.0',
      changelog: section(opts.base ?? ''),
      files: { [WORKLOADS]: peakCfg(sha) },
    })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'base')
    const baseSha = git(dir, 'rev-parse', 'HEAD')

    write(dir, {
      version: '0.46.0',
      changelog: section(opts.head),
      files: {
        'src/a.ts': 'export const a = 1\n',
        [WORKLOADS]: peakCfg(sha, opts.headPeak ?? {}),
      },
    })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'head')
    return { dir, baseSha }
  }

  const run = (opts: Parameters<typeof waiverRepo>[0], ...args: string[]): Result => {
    const { dir, baseSha } = waiverRepo(opts)
    return gate(dir, `--base=${baseSha}`, ...args)
  }

  it('costs nothing to a PR that declares no waiver', () => {
    // The hatch must be invisible to everyone not using it. Same reasoning that exempts
    // docs and tests from the bump gate: a rule that fires on changes it has no business
    // judging is a rule that gets bypassed, and takes the others with it.
    const r = run({ head: '' })
    expect(r.ok).toBe(true)
    expect(r.out).not.toMatch(/WAIVED/)
  })

  it('REFUSES a waiver that states no number', () => {
    // The whole point: it must be impossible to use the flag without stating the
    // measurement. "We know it is slower, shipping anyway" is what this must not accept.
    const r = run({ head: waiver('— the table lowering buys a much smaller artifact') })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/states no `median <n>%`/)
    expect(r.out).toMatch(/states no `min <n>%`/)
  })

  it('REFUSES a waiver quoting median but not min', () => {
    // The peak clause breaches on median AND min both, so half the verdict is not the
    // verdict.
    const r = run({ head: waiver('median -164.9% — the lowering trades time for artifact size') })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/states no `min <n>%`/)
  })

  it('REFUSES a number that is INSIDE the allowance', () => {
    // Below the noise floor there is nothing to waive, and a tag that accepts it becomes
    // a ritual people paste in.
    const r = run({ head: waiver('median -2.1% min -1.4% — small cost here, large artifact win') })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/INSIDE/)
    expect(r.out).toMatch(/waives nothing/)
  })

  it('REFUSES a waiver with no reason', () => {
    // "land it with the number visible AND an explanation of why it is the price of
    // something" — the second half is not decoration.
    const r = run({ head: waiver('median -164.9% min -158.2%') })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/gives no reason/)
  })

  it('REFUSES a reason too short to be one', () => {
    const r = run({ head: waiver('median -164.9% min -158.2% — faster') })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/gives no reason/)
  })

  it('REFUSES a waiver naming a config that carries no peak block', () => {
    const r = run({
      head: `PERF-PEAK-WAIVER ${DENSITY} median -164.9% min -158.2% — deliberate cost bought artifact size`,
    })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/no `peak` block/)
  })

  it('REFUSES a STALE waiver — one already on the base', () => {
    // The non-stickiness rule, and the property that keeps the clause alive for the rest
    // of a release cycle. Without it the PR after the waiving one inherits the line and
    // the peak gate is silently off until the section ships.
    const line = waiver()
    const r = run({ head: line, base: line })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/ALREADY PRESENT on the base/)
    expect(r.out).toMatch(/per-PR and does not carry/)
  })

  it('REFUSES a waiver that ALSO moves the peak', () => {
    // Waiving and re-baselining are mutually exclusive by construction: a waiver exists
    // precisely so the bar does NOT move. Doing both is the laundering edit wearing the
    // honest one's clothes — and it would leave the record moved AND the breach excused.
    const r = run({ head: waiver(), headPeak: { allowancePct: 300 } })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/also EDITS/)
    expect(r.out).toMatch(/mutually exclusive/)
  })

  it('ACCEPTS a well-formed, fresh waiver — and REPORTS the breach rather than reporting green', () => {
    // The only passing case here, and it still has to be loud. A waived run that printed
    // a bare "ok" would be worse than no hatch: a silent green on a build sitting 33x
    // outside its allowance.
    const r = run({ head: waiver() })
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/PEAK CLAUSE WAIVED/)
    // The declared numbers, and how far outside the allowance they sit.
    expect(r.out).toContain('-164.9%')
    expect(r.out).toContain('-158.2%')
    expect(r.out).toMatch(/33\.0x/)
    expect(r.out).toMatch(/31\.6x/)
    // WHY, not just THAT.
    expect(r.out).toMatch(/40x smaller artifact/)
    // And the record explicitly did not move.
    expect(r.out).toMatch(/UNCHANGED/)
    expect(r.out).toMatch(/NOT raised/)
    expect(r.out).toMatch(/next PR is measured against it/)
  })

  it('accepts the harness spelling (+164.9%) as readily as the prose one', () => {
    // The harness prints a slowdown POSITIVE (head vs reference); prose about a drawdown
    // writes it negative. Both name the same breach, and rejecting one spelling would
    // make this a gate about punctuation.
    const r = run({ head: waiver('median +164.9% min +158.2% — deliberate: table lowering buys artifact size') })
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/PEAK CLAUSE WAIVED/)
  })

  it("§D's failure NAMES the waiver, so a red gate teaches the sanctioned route", () => {
    // A contributor who hits §D red and finds no documented way through invents one, and
    // the one they invent is widening `allowancePct`, because it is right there in the
    // file. The failure message has to point at the honest route by name.
    const r = run({ head: '', headPeak: { allowancePct: 900 } })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/allowance WIDENED/)
    expect(r.out).toMatch(/PERF-PEAK-WAIVER/)
  })

  it('`release-exempt` does NOT waive the peak clause', () => {
    // The label's documented scope is §B — a revert, or a chained PR. Widening it to
    // cover a perf hatch is the "bypassed gate" failure release-gates.md names, so the
    // two stay disjoint and a malformed waiver stays red under `--exempt`.
    const r = run({ head: waiver('median -164.9% min -158.2%') }, '--exempt')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/gives no reason/)
  })
})
