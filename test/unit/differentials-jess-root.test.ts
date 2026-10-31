/**
 * `check:differentials` runs the jess differentials only against a jess worktree
 * it was pointed at and that has been built. There is no default checkout: a
 * mirror whose packages' `lib/` lag its source made four differentials red before
 * any plant, which reads as four broken instruments.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-differentials.mjs')

function gate(env: Record<string, string | undefined>): { code: number; out: string } {
  const { JESS_ROOT: _unset, ...rest } = process.env
  const r = spawnSync(process.execPath, [SCRIPT, '--only=jess-oracle'], {
    encoding: 'utf8', env: { ...rest, ...env } as NodeJS.ProcessEnv,
  })
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` }
}

describe('check:differentials and JESS_ROOT', () => {
  it('reports the jess differentials unproven when JESS_ROOT is not set, naming why', () => {
    const r = gate({})
    expect(r.code).toBe(0)
    expect(r.out).toContain('UNPROVEN')
    expect(r.out).toContain('JESS_ROOT is not set')
  })

  it('refuses a jess checkout whose packages were built before their last source commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-stale-jess-'))
    try {
      for (const pkg of ['packages/core', 'packages/parser-shared']) {
        mkdirSync(join(root, pkg, 'src'), { recursive: true })
        mkdirSync(join(root, pkg, 'lib'), { recursive: true })
        writeFileSync(join(root, pkg, 'src/index.ts'), 'export {}\n')
        // Built a day before the source commit below.
        const old = Date.now() / 1000 - 86_400
        utimesSync(join(root, pkg, 'lib'), old, old)
      }
      const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' })
      git('init', '-q')
      git('add', '.')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'src')
      const r = gate({ JESS_ROOT: root })
      expect(r.code).toBe(2)
      expect(r.out).toContain('older than its last source commit')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
