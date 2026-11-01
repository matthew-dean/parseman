/**
 * `scripts/check-changelog.mjs` is the pull-request half of publish-on-merge: every
 * merge to `main` publishes (`scripts/release.mjs`), so every PR that changes what the
 * package ships must arrive with its CHANGELOG entry, and `main` must always record one
 * version in three places.
 *
 * These run the real script against fixture checkouts — real git repos for the entry
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
    // The real package's `files`: the entry rule asks npm which changed paths it packs.
    `${JSON.stringify({ name: 'parseman', version, files: ['dist', 'src', 'README.md'], ...spec.pkg }, null, 2)}\n`,
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

/** `main` between releases: pending entries under Unreleased above the newest release. */
const pending = (published = '0.36.0', ...items: string[]): string =>
  `# Changelog\n\n## Unreleased\n\n${(items.length > 0 ? items : ['- the change under construction']).join('\n\n')}\n\n`
  + `## ${published} — 2026-07-24\n\n- shipped\n`

/** A pull request declaring `next` itself: the heading, package.json and src/version.ts together. */
const declared = (next: string, published = '0.36.0', item = '- the new api'): string =>
  `# Changelog\n\n## ${next} — 2026-07-25\n\n${item}\n\n## ${published} — 2026-07-24\n\n- shipped\n`

const src = (n: number): Record<string, string> => ({ 'src/a.ts': `export const a = ${n}\n` })

describe('release integrity', { timeout: SUITE_BUDGET_MS }, () => {
  it('ACCEPTS `## Unreleased` above the newest release, which matches package.json', () => {
    const r = gate(checkout({ version: '0.36.0', changelog: pending('0.36.0') }))
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/pending changes under Unreleased, above 0\.36\.0/)
  })

  it('ACCEPTS changelog, package.json and the artifact stamp in agreement', () => {
    const r = gate(checkout({ version: '0.36.0', changelog: released('0.36.0') }))
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/top section is 0\.36\.0/)
  })

  it('REJECTS Unreleased with no release heading under it', () => {
    const r = gate(checkout({ version: '0.36.0', changelog: '# Changelog\n\n## Unreleased\n\n- x\n' }))
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/names no version/)
  })

  it('REJECTS a top heading that is neither Unreleased nor a version', () => {
    // One spelling, so the publish can find it: "Next", "TBD" and "unreleased" are not it.
    for (const top of ['Next', 'TBD', 'unreleased']) {
      const r = gate(checkout({ version: '0.36.0', changelog: `# Changelog\n\n## ${top}\n\n- x\n\n## 0.36.0 — 2026-07-24\n\n- y\n` }))
      expect(r.ok).toBe(false)
      expect(r.out).toMatch(/names no version/)
    }
  })

  it('REJECTS a newest release heading that names a DIFFERENT version than package.json', () => {
    // Ahead was the old "open section" shape; publishing on merge has no use for it. Behind
    // means a declared version lost its heading.
    for (const changelog of [released('0.35.0'), released('0.37.0'), pending('0.35.0')]) {
      const r = gate(checkout({ version: '0.36.0', changelog }))
      expect(r.ok).toBe(false)
      expect(r.out).toMatch(/newest release heading is 0\.3[57]\.0 but package\.json says 0\.36\.0/)
    }
  })

  it('is not satisfied by a matching heading further DOWN the file', () => {
    const r = gate(
      checkout({
        version: '0.36.0',
        changelog: '# Changelog\n\n## Unreleased\n\n- x\n\n## 0.35.0 — 2026-07-20\n\n- a\n\n## 0.36.0 — 2026-07-24\n\n- b\n',
      }),
    )
    expect(r.ok).toBe(false)
  })

  it('REJECTS a src/version.ts stamp that drifted from package.json', () => {
    const r = gate(checkout({ version: '0.36.0', changelog: pending('0.36.0'), stamp: '0.35.0' }))
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/src\/version\.ts stamps 0\.35\.0 but package\.json says 0\.36\.0/)
  })

  it('REFUSES TO PUBLISH with Unreleased still on top', () => {
    // The publish workflow stamps the release first; a bare `npm publish` from main must not
    // ship a package whose CHANGELOG has no heading for it.
    const r = gate(checkout({ version: '0.36.0', changelog: pending('0.36.0') }), '--publish')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/cannot publish with "## Unreleased" on top/)
  })

  it('publishes once the release is stamped', () => {
    expect(gate(checkout({ version: '0.37.0', changelog: released('0.37.0') }), '--publish').ok).toBe(true)
  })

  it('tolerates the bracketed heading form', () => {
    const r = gate(
      checkout({ version: '0.36.0', changelog: '# Changelog\n\n## [v0.36.0] - 2026-07-24\n\n- x\n' }),
    )
    expect(r.ok).toBe(true)
  })
})

describe('entry gate', { timeout: SUITE_BUDGET_MS }, () => {
  it('REQUIRES an entry under Unreleased when src/ changes', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: src(1) },
      { changelog: released('0.36.0'), files: src(2) },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/adds no CHANGELOG entry/)
    expect(r.out).toMatch(/"## Unreleased"/)
    expect(r.out).toMatch(/release-exempt/)
  })

  it('ACCEPTS a src/ change with an entry under Unreleased and NO version bump', () => {
    // The whole point: merging publishes the next patch, and nobody has to pick it.
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: src(1) },
      { changelog: pending('0.36.0'), files: src(2) },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/adds 1 entry under Unreleased/)
  })

  it('a SECOND PR adds its own entry to the same Unreleased', () => {
    const { dir, baseSha } = repo(
      { changelog: pending('0.36.0', '- first'), files: src(1) },
      { changelog: pending('0.36.0', '- second', '- first'), files: src(2) },
    )
    expect(gate(dir, `--base=${baseSha}`).ok).toBe(true)
  })

  it('does NOT accept an entry that was already there', () => {
    // main's Unreleased keeps entries an auto-patch already shipped until a sync PR files
    // them, so "the section is non-empty" would pass a PR that wrote nothing.
    const { dir, baseSha } = repo(
      { changelog: pending('0.36.0', '- shipped in 0.36.1'), files: src(1) },
      { changelog: pending('0.36.0', '- shipped in 0.36.1'), files: src(2) },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/adds no CHANGELOG entry/)
  })

  it('ACCEPTS a declared minor: heading, package.json and src/version.ts set together', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: src(1) },
      { version: '0.37.0', changelog: declared('0.37.0'), files: src(2) },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/adds 1 entry under 0\.37\.0/)
  })

  it('REJECTS a version that goes DOWN — and the label is the only way through', () => {
    const { dir, baseSha } = repo(
      { version: '0.37.0', changelog: released('0.37.0'), files: src(2) },
      { version: '0.36.0', changelog: pending('0.36.0', '- revert 0.37.0'), files: src(1) },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/goes DOWN, from 0\.37\.0 to 0\.36\.0/)

    const waived = gate(dir, `--base=${baseSha}`, '--exempt')
    expect(waived.ok).toBe(true)
    expect(waived.out).toMatch(/VERSION GOES DOWN/)
  })

  it('orders prerelease identifiers numerically: rc.2 → rc.10 is not a downgrade, but is refused as a prerelease', () => {
    const { dir, baseSha } = repo(
      { version: '1.0.0-rc.2', changelog: released('1.0.0-rc.2'), files: src(1) },
      { version: '1.0.0-rc.10', changelog: declared('1.0.0-rc.10', '1.0.0-rc.2'), files: src(2) },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.out).not.toMatch(/goes DOWN/)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/declares the prerelease 1\.0\.0-rc\.10/)
  })

  it('REJECTS a declared prerelease above a stable base: merging would stop the publish', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: src(1) },
      { version: '0.37.0-beta.1', changelog: declared('0.37.0-beta.1'), files: src(2) },
    )
    const r = gate(dir, `--base=${baseSha}`, '--exempt')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/declares the prerelease 0\.37\.0-beta\.1/)
  })

  it('REJECTS a declared version below the latest release tag, which the publish would ignore', () => {
    // main still says 0.36.0; auto-patches shipped 0.36.1..0.36.3 on their tags.
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: src(1) },
      { version: '0.36.2', changelog: declared('0.36.2'), files: src(2) },
    )
    git(dir, 'tag', 'v0.36.3', baseSha)
    const r = gate(dir, `--base=${baseSha}`, '--exempt')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/declares 0\.36\.2, but 0\.36\.3 is already released/)
  })

  it.each(['0.38.0', '0.360.0', '2.0.0', '0.36.5'])('REJECTS a declared %s, which skips past the next release of 0.36.3', (skip) => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: src(1) },
      { version: skip, changelog: declared(skip), files: src(2) },
    )
    git(dir, 'tag', 'v0.36.3', baseSha)
    const r = gate(dir, `--base=${baseSha}`, '--exempt')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/skips past the next release of 0\.36\.3/)
  })

  it.each(['0.36.4', '0.37.0', '1.0.0'])('ACCEPTS a declared %s against the latest tag 0.36.3', (next) => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: src(1) },
      { version: next, changelog: declared(next), files: src(2) },
    )
    git(dir, 'tag', 'v0.36.3', baseSha)
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok, r.out).toBe(true)
    expect(r.out).toContain(`declares ${next} against the latest release 0.36.3`)
  })

  /** v0.36.3's release commit beside main, as the publish leaves it: its CHANGELOG has the dated section. */
  const tagRelease = (dir: string, baseSha: string, section: string): void => {
    git(dir, 'switch', '-q', '-c', 'release', baseSha)
    writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n${section}\n## 0.36.0 — 2026-07-24\n\n- something\n`)
    git(dir, 'commit', '-qam', 'release: 0.36.3')
    git(dir, 'tag', 'v0.36.3')
    git(dir, 'switch', '-q', 'main')
  }
  const shipped = '## 0.36.3 — 2026-07-26\n\n- fix three\n'

  it('ACCEPTS a sync: the version set to the latest tag, with that tag\'s section copied in', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: src(1) },
      { version: '0.36.3', changelog: `# Changelog\n\n## Unreleased\n\n- the new api\n\n${shipped}\n## 0.36.0 — 2026-07-24\n\n- something\n`, files: src(2) },
    )
    tagRelease(dir, baseSha, shipped)
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok, r.out).toBe(true)
    expect(r.out).toContain('declares 0.36.3 against the latest release 0.36.3')
  })

  it('REJECTS entries filed under the latest tag\'s version: the publish ships 0.36.4 and they replace 0.36.3\'s section', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: src(1) },
      { version: '0.36.3', changelog: declared('0.36.3'), files: src(2) },
    )
    tagRelease(dir, baseSha, shipped)
    const r = gate(dir, `--base=${baseSha}`, '--exempt')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/declares 0\.36\.3, the latest release, but CHANGELOG\.md's "## 0\.36\.3" section\s+is not v0\.36\.3's/)
  })

  it('REJECTS a skipped version against the base when there are no tags yet', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: src(1) },
      { version: '0.38.0', changelog: declared('0.38.0'), files: src(2) },
    )
    const r = gate(dir, `--base=${baseSha}`, '--exempt')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/skips past the next release of 0\.36\.0/)
  })

  it('does NOT require an entry for a change that cannot reach a consumer', () => {
    // The whole reason this gate can be a required check. Tests, docs, benches, scripts
    // and CI config change nothing about what `npm install` produces.
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: { 'test/x.test.ts': 'a\n', 'docs/g.md': 'a\n' } },
      { changelog: released('0.36.0'), files: { 'test/x.test.ts': 'b\n', 'docs/g.md': 'b\n', '.github/workflows/ci.yml': 'x\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/nothing the package ships changed/)
  })

  it('REQUIRES an entry for README.md, which `files` ships', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: { 'README.md': 'a\n' } },
      { changelog: released('0.36.0'), files: { 'README.md': 'b\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/packed file\(s\) \(README\.md\)/)
  })

  it('REQUIRES an entry when a shipped file is DELETED', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: { 'src/gone.ts': 'export {}\n' } },
      { changelog: released('0.36.0'), files: { 'docs/x.md': 'x\n' } },
    )
    rmSync(join(dir, 'src/gone.ts'))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'delete')
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/src\/gone\.ts/)
  })

  it('does NOT require an entry when src/version.ts only changes its stamp', () => {
    // The `sync` PR shape: main catches up to the latest release, which moves the version
    // and nothing a consumer has not already installed.
    const { dir, baseSha } = repo(
      { changelog: pending('0.36.0', '- a'), files: src(1) },
      { version: '0.36.1', changelog: declared('0.36.1', '0.36.0', '- a'), files: src(1) },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/nothing the package ships changed/)
  })

  it('REQUIRES an entry when a consumer-facing package.json field changes without src/', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), pkg: { exports: { '.': './dist/index.js' } } },
      { changelog: released('0.36.0'), pkg: { exports: { '.': './dist/index.js', './run': './dist/run/index.js' } } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/package\.json exports/)
  })

  it('REQUIRES an entry for a package.json field the gate does not name, such as sideEffects', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), pkg: { sideEffects: false } },
      { changelog: released('0.36.0'), pkg: { sideEffects: ['./dist/register.js'] } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/package\.json sideEffects/)
  })

  it('REQUIRES an entry when a build input changes', () => {
    // `scripts/build.mjs` decides what dist/ CONTAINS and is not itself packed.
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: { 'scripts/build.mjs': 'a\n' } },
      { changelog: released('0.36.0'), files: { 'scripts/build.mjs': 'b\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/build input scripts\/build\.mjs/)
  })

  it('REQUIRES an entry when the INHERITED tsconfig changes', () => {
    // `tsconfig.build.json` `extends` the root config, so its options reach dist/*.d.ts.
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: { 'tsconfig.json': '{"compilerOptions":{"strict":true}}\n' } },
      { changelog: released('0.36.0'), files: { 'tsconfig.json': '{"compilerOptions":{"strict":false}}\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/build input tsconfig\.json/)
  })

  it('does NOT treat the rest of scripts/ as a build input', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: { 'scripts/coverage-guard.mjs': 'a\n' } },
      { changelog: released('0.36.0'), files: { 'scripts/coverage-guard.mjs': 'b\n' } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/nothing the package ships changed/)
  })

  it('REQUIRES an entry when a consumer-executed lifecycle script changes', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), pkg: { scripts: { postinstall: 'node a.js', test: 'vitest' } } },
      { changelog: released('0.36.0'), pkg: { scripts: { postinstall: 'node b.js', test: 'vitest' } } },
    )
    const r = gate(dir, `--base=${baseSha}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/install-time scripts/)
  })

  it('does NOT require an entry for a script or a devDependency that reaches nobody', () => {
    const pairs: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ scripts: { postinstall: 'node a.js', 'bench:x': 'node x.ts' } }, { scripts: { postinstall: 'node a.js', 'bench:x': 'node y.ts' } }],
      [{ devDependencies: { vitest: '~4.1.9' } }, { devDependencies: { vitest: '~4.2.0' } }],
    ]
    for (const [before, after] of pairs) {
      const { dir, baseSha } = repo({ changelog: released('0.36.0'), pkg: before }, { changelog: released('0.36.0'), pkg: after })
      const r = gate(dir, `--base=${baseSha}`)
      expect(r.ok).toBe(true)
      expect(r.out).toMatch(/nothing the package ships changed/)
    }
  })

  it('the label waives the ENTRY rule only — never release integrity', () => {
    const { dir, baseSha } = repo(
      { changelog: released('0.36.0'), files: src(1) },
      { changelog: released('0.36.0'), files: src(2) },
    )
    const waived = gate(dir, `--base=${baseSha}`, '--exempt')
    expect(waived.ok).toBe(true)
    expect(waived.out).toMatch(/ENTRY GATE WAIVED/)

    const broken = repo(
      { changelog: released('0.36.0') },
      { changelog: '# Changelog\n\n## Next\n\n- x\n\n## 0.36.0 — 2026-07-24\n\n- y\n', files: src(1) },
    )
    const r = gate(broken.dir, `--base=${broken.baseSha}`, '--exempt')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/names no version/)
  })
})

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

/*
 * §D governs MOVING the peak: any edit is named in an entry the PR adds, and the record is
 * structurally sound. §D' is that there is no other way past a peak: the clauses are
 * absolute, so a `PERF-PEAK-WAIVER` entry is refused rather than honoured.
 */
describe("peak record (§D) and no peak waiver (§D')", { timeout: SUITE_BUDGET_MS }, () => {
  const WORKLOADS = 'bench/workloads/config.json'

  const peakCfg = (peak: Record<string, unknown>): string => `${JSON.stringify({ peak: { allowancePct: 5, ...peak } }, null, 2)}\n`

  const section = (body: string): string =>
    `# Changelog\n\n## Unreleased\n\n- the change under construction\n${body}\n\n`
    + '## 0.46.0 — 2026-07-24\n\n- shipped\n'

  /**
   * A PR filing into Unreleased. The peak names a seed commit whose package.json says
   * 0.45.0, so §D's structural check passes. `headPeak` overrides the HEAD side; the
   * string `BASE` in it names the base commit, which says 0.46.0.
   */
  function peakRepo(opts: { head: string; base?: string; headPeak?: Record<string, unknown> }): { dir: string; baseSha: string } {
    const dir = checkout({ version: '0.45.0', changelog: section('') })
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'seed')
    const seed = { sha: git(dir, 'rev-parse', 'HEAD').slice(0, 7), version: '0.45.0' }
    write(dir, { version: '0.46.0', changelog: section(opts.base ?? ''), files: { [WORKLOADS]: peakCfg(seed) } })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'base')
    const baseSha = git(dir, 'rev-parse', 'HEAD')
    const over = Object.fromEntries(Object.entries(opts.headPeak ?? {}).map(([k, v]) => [k, v === 'BASE' ? baseSha.slice(0, 7) : v]))
    write(dir, {
      version: '0.46.0',
      changelog: section(opts.head),
      files: { 'src/a.ts': 'export const a = 1\n', [WORKLOADS]: peakCfg({ ...seed, ...over }) },
    })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'head')
    return { dir, baseSha }
  }

  const run = (opts: Parameters<typeof peakRepo>[0], ...args: string[]): Result => {
    const { dir, baseSha } = peakRepo(opts)
    return gate(dir, `--base=${baseSha}`, ...args)
  }

  const waiver = `PERF-PEAK-WAIVER ${WORKLOADS} median -164.9% min -158.2% — table lowering: 2.65x parse time buys a 40x smaller artifact`

  it('costs nothing to a PR that leaves the peak alone', () => {
    const r = run({ head: '\n- an entry of its own' })
    expect(r.ok, r.out).toBe(true)
    expect(r.out).toMatch(/peak records unchanged/)
  })

  it.each([
    ['well-formed', waiver],
    ['overstated', `PERF-PEAK-WAIVER ${WORKLOADS} median -999% min -999% — anything at all`],
  ])('REFUSES a %s PERF-PEAK-WAIVER entry: the peak clauses have no waiver', (_kind, line) => {
    const r = run({ head: `\n- ${line}` })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/carries a PERF-PEAK-WAIVER/)
    expect(r.out).toMatch(/peak clauses have no waiver/)
  })

  it('`release-exempt` does not let a waiver through', () => {
    const r = run({ head: `\n- ${waiver}` }, '--exempt')
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/peak clauses have no waiver/)
  })

  it('an entry that only NAMES the tag in prose is not a waiver', () => {
    const r = run({ head: '\n- The peak clauses no longer honour `PERF-PEAK-WAIVER`.' })
    expect(r.ok, r.out).toBe(true)
  })

  it('a waiver line already on the base (history) is not this PR\'s', () => {
    const r = run({ head: `\n- ${waiver}\n\n- an entry of its own`, base: `\n- ${waiver}` })
    expect(r.ok, r.out).toBe(true)
  })

  it('REFUSES a widened allowance nobody named, and points at no waiver', () => {
    const r = run({ head: '', headPeak: { allowancePct: 900 } })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/allowance WIDENED/)
    expect(r.out).not.toMatch(/PERF-PEAK-WAIVER/)
  })

  it('ACCEPTS a peak move named in an entry the PR adds', () => {
    const r = run({ head: '- moves the workloads peak forward: median -6.1% min -5.8% vs 0.45.0', headPeak: { sha: 'BASE', version: '0.46.0' } })
    expect(r.ok, r.out).toBe(true)
    expect(r.out).toMatch(/peak record moved/)
  })

  it('a STALE entry mentioning the peak does not vouch for a new move', () => {
    // Unreleased keeps entries an auto-patch already shipped, so the section as a whole
    // can mention "peak" without this PR saying anything.
    const line = '- earlier note about the peak'
    const r = run({ head: line, base: line, headPeak: { sha: 'BASE', version: '0.46.0' } })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/no entry it adds under Unreleased mentions it/)
  })

  it('REFUSES a peak whose version is not the release at its sha', () => {
    // The seed commit says 0.45.0: naming it 0.46.0 reads as a bar it is not.
    const r = run({ head: '- the peak note', headPeak: { version: '0.46.0' } })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/`peak.version` is 0\.46\.0, but package.json at `peak.sha` [0-9a-f]+ says 0\.45\.0/)
  })
})
