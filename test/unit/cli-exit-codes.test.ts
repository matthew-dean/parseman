/**
 * The exit-code contract, asserted by RUNNING the CLI.
 *
 * This test exists because the contract was reported broken by a user — `13 blocking
 * findings` printed, exit 0 — and the cause turned out to be a stale build rather than
 * the source. That distinction is invisible from the outside and irrelevant to the
 * person whose CI passed anyway. A gate is only worth what its exit code is worth, so
 * the code is asserted end to end, through the real argv parsing, the real renderers and
 * the real process exit, rather than by unit-testing the branch that computes it.
 *
 *   0  analysed, no blocking finding
 *   1  analysed, blocking findings
 *   2  COULD NOT ANALYSE — bad usage, unloadable grammar, unusable corpus
 *
 * 2 is the one with teeth: a tool that cannot measure must not report success. This repo
 * has already shipped a coverage report claiming 100% over zero analysable input.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = resolve(ROOT, 'src/cli/index.ts')

function run(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx/esm', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

describe('parseman CLI exit codes', () => {
  // Every case boots a real `tsx` subprocess, which the default 5s budget is not for.
  const T = 60_000

  it('exits 0 on a clean grammar', () => {
    const r = run('diagnose', 'examples/json/parser.ts', '--export', 'jsonDoc')
    expect(r.out).toContain('nothing to fix')
    expect(r.code).toBe(0)
  }, T)

  it('exits NON-ZERO when it reports blocking findings', () => {
    const r = run('diagnose', 'examples/css/parser.ts', '--export', 'cssRules')
    // The exact failure that was reported: problems printed on stdout and a zero exit.
    expect(r.out).toMatch(/problems in \d+ choices/)
    expect(r.code).not.toBe(0)
    expect(r.code).toBe(1)
  }, T)

  it('exits 1 through the rule-map entry as well as a single root', () => {
    const viaRoot = run('diagnose', 'examples/css/parser.ts', '--export', 'Stylesheet')
    const viaMap = run('diagnose', 'examples/css/parser.ts', '--export', 'cssRules')
    expect(viaRoot.code).toBe(1)
    expect(viaMap.code).toBe(1)
  }, T)

  it('exits 2 when it cannot analyse — no such grammar', () => {
    const r = run('diagnose', 'examples/nope/parser.ts')
    expect(r.out).toContain('no such grammar module')
    expect(r.code).toBe(2)
  }, T)

  it('exits 2 when the export is ambiguous, and NAMES the exports', () => {
    const r = run('diagnose', 'examples/json/parser.ts')
    expect(r.out).toContain('--export')
    expect(r.out).toContain('jsonDoc')
    expect(r.code).toBe(2)
  }, T)

  it('exits 2 when `fix` has no corpus — an unverified rewrite is not offered', () => {
    const r = run('fix', 'examples/lang/parser.ts', '--export', 'exprParser')
    expect(r.out).toContain('no files were given to check against')
    expect(r.code).toBe(2)
  }, T)

  it('exits 0 when `fix` verifies rewrites, and writes nothing without --apply', () => {
    const r = run('fix', 'examples/lang/parser.ts', '--export', 'exprParser',
      '--corpus', 'examples/lang/corpus')
    expect(r.out).toContain('Nothing has been written')
    expect(r.out).toContain('safe to make')
    expect(r.code).toBe(0)
  }, T)

  it('exits 2 on a `--limit` that is not a non-negative integer', () => {
    // `Number('abc')` is NaN, and the renderer's `shown >= limit` is then always false —
    // the flag would be silently ignored and every site expanded. A tool that cannot honour
    // the flag it was given must say so, not pretend it did.
    const r = run('diagnose', 'examples/css/parser.ts', '--export', 'cssRules', '--limit', 'abc')
    expect(r.out).toContain('--limit')
    expect(r.code).toBe(2)
  }, T)

  it('honours a valid `--limit`', () => {
    const r = run('diagnose', 'examples/css/parser.ts', '--export', 'cssRules', '--limit', '1')
    expect(r.code).toBe(1)
  }, T)

  it('prints usage and exits 2 with no command at all', () => {
    const r = run()
    expect(r.out).toContain('parseman diagnose')
    expect(r.code).toBe(2)
  }, T)

  it('emits no ANSI when NO_COLOR is set, even for the code frames', () => {
    const r = run('diagnose', 'examples/css/parser.ts', '--export', 'cssRules',
      '--corpus', 'fixtures/css')
    expect(r.out.includes(String.fromCharCode(27))).toBe(false)
  }, T)
})
