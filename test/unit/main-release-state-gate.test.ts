import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = join(ROOT, 'scripts/check-main-release-state.mjs')
const dirs: string[] = []

function fixture(version: string, heading: string, stamp = version): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-main-release-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ version })}\n`)
  writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## ${heading}\n\n- entry\n`)
  writeFileSync(join(dir, 'src/version.ts'), `export const PARSEMAN_VERSION = '${stamp}'\n`)
  return dir
}

function gate(dir: string, base: string, head: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, `--root=${dir}`, `--base-ref=${base}`, `--head-ref=${head}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, out }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('main release-state gate', () => {
  it('rejects the exact premature-integration shape: a 0.48 release branch carrying 0.47', () => {
    const result = gate(fixture('0.47.0', '0.48.0 — unreleased'), 'main', 'release/0.48.0')
    expect(result.ok).toBe(false)
    expect(result.out).toMatch(/release\/0\.48\.0 names 0\.48\.0, but package\.json says 0\.47\.0/)
  })

  it('rejects an otherwise converged release while its changelog remains unreleased', () => {
    const result = gate(fixture('0.48.0', '0.48.0 — unreleased'), 'main', 'release/0.48.0')
    expect(result.ok).toBe(false)
    expect(result.out).toMatch(/unreleased development line cannot merge to main/)
  })

  it('accepts a dated release whose branch, package, changelog, and artifact stamp agree', () => {
    const result = gate(fixture('0.47.1', '0.47.1 — 2026-08-12'), 'main', 'release/0.47.1')
    expect(result.ok).toBe(true)
    expect(result.out).toMatch(/0\.47\.1 is converged and dated/)
  })

  it('rejects stamp drift even when the branch and package agree', () => {
    const result = gate(fixture('0.47.1', '0.47.1 — 2026-08-12', '0.47.0'), 'main', 'release/0.47.1')
    expect(result.ok).toBe(false)
    expect(result.out).toMatch(/src\/version\.ts: 0\.47\.0/)
  })

  it('does not constrain PRs whose base is a development release branch', () => {
    const result = gate(fixture('0.47.0', '0.48.0 — unreleased'), 'release/0.48.0', 'feature/token-body')
    expect(result.ok).toBe(true)
    expect(result.out).toMatch(/skipped/)
  })
})
