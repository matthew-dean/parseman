/**
 * The `fix` command's wiring: what it refuses, where it looks for the source, and what it
 * writes.
 *
 * `fix` is the command with a promise attached — every rewrite it offers was applied, the
 * parser rebuilt and the corpus re-parsed to an identical result. The wiring here is what
 * makes that promise checkable, so the refusals are the important cases: no root to parse
 * with, no corpus to prove anything against, no readable source to locate an edit in.
 * Each of those exits 2, because `fix` fails CLOSED — a loop that could not run is not a
 * pass, and 0 would tell CI it was.
 */
import { describe, it, expect } from 'vitest'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../helpers/run-cli.ts'

const F = 'test/fixtures/cli-cov'
const LANG = 'examples/lang/parser.ts'
const LANG_ARGS = [LANG, '--export', 'exprParser', '--corpus', 'examples/lang/corpus'] as const
const T = 60_000

const tmp = (name: string): string => join(mkdtempSync(join(tmpdir(), 'cli-cov-fix-')), name)

describe('fix refuses, and says why', () => {
  it('a rule MAP has no single root to re-parse with', async () => {
    const r = await runCli(['fix', `${F}/rule-map.mjs`, '--corpus', `${F}/corpus`])
    expect(r.stderr).toBe(
      `${F}/rule-map.mjs exported a rule map or a composed grammar, which has no single root to parse with.\n`
      + '  `fix` verifies by re-parsing, so it needs the rule you parse with: --export <RuleName>.\n',
    )
    expect(r.stdout).toBe('')
    expect(r.code).toBe(2)
  })

  it('the same module IS fixable once `--export` names a root', async () => {
    const r = await runCli(['fix', `${F}/rule-map.mjs`, '--export', 'Item', '--corpus', `${F}/corpus`])
    expect(r.stdout).toContain(`${F}/rule-map.mjs — nothing here can be rewritten`)
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
  })

  it('exits 2 with NO corpus — an unverified rewrite is never offered', async () => {
    const r = await runCli(['fix', LANG, '--export', 'exprParser'])
    expect(r.stdout).toContain('no files were given to check against')
    expect(r.code).toBe(2)
  }, T)

  it('a `--source` it cannot read names the path and the reason', async () => {
    const missing = tmp('not-here.ts')
    const r = await runCli(['fix', ...LANG_ARGS, '--source', missing])
    expect(r.stderr).toContain(`could not read grammar source ${missing}: `)
    expect(r.stderr).toContain('ENOENT')
    expect(r.stdout).toBe('')
    expect(r.code).toBe(2)
  }, T)
})

describe('fix previews by default', () => {
  it('reports the verified rewrites, writes nothing, and exits 0', async () => {
    const before = readFileSync(LANG, 'utf8')
    const r = await runCli(['fix', ...LANG_ARGS, '--width', '200'])
    expect(r.stdout).toContain('3 changes that are safe to make')
    expect(r.stdout).toContain('Nothing has been written. Add --apply to make these edits.')
    expect(r.stdout).not.toContain('edit(s) written to')
    expect(readFileSync(LANG, 'utf8')).toBe(before)
    expect(r.code).toBe(0)
  }, T)

  it('says how much of your input it checked against', async () => {
    const r = await runCli(['fix', `${F}/labels.mjs`, '--corpus', `${F}/corpus`, '--width', '200'])
    // 3 files, 4 + 6 + 3 bytes — the recursive walk, restated by the thing that used it.
    expect(r.stdout).toContain('Checked against 3 of your files (13 bytes).')
    expect(r.stdout).toContain('nothing here can be rewritten')
    expect(r.code).toBe(0)
  }, T)
})

describe('fix --apply', () => {
  it('writes the verified edits to `--source`, and leaves the grammar module alone', async () => {
    const copy = tmp('parser-copy.ts')
    copyFileSync(LANG, copy)
    const grammarBefore = readFileSync(LANG, 'utf8')

    const r = await runCli(['fix', ...LANG_ARGS, '--source', copy, '--apply', '--width', '200'])

    const after = readFileSync(copy, 'utf8')
    // The three verified rewrites, each replacing a keyword regex with word().
    expect(after).toContain("word('if', '\\w')")
    expect(after).toContain("word('true', '\\w')")
    expect(after).toContain("word('false', '\\w')")
    expect(after).not.toContain('regex(/true(?!\\w)/)')
    expect(r.stdout).toContain('3 edit(s) written to')
    expect(r.stdout).not.toContain('Nothing has been written')
    // `--source` is where edits are LOCATED and written; the grammar module is untouched.
    expect(readFileSync(LANG, 'utf8')).toBe(grammarBefore)
    expect(r.code).toBe(0)
  }, T)

  it('a source it can READ but not WRITE is an I/O failure, not a silent no-op success', async () => {
    // The hazard this covers: `fix --apply` printing "3 edit(s) written" over a write that
    // never landed. A tool that could not do the thing must not exit 0.
    const copy = tmp('read-only.ts')
    copyFileSync(LANG, copy)
    const before = readFileSync(copy, 'utf8')
    chmodSync(copy, 0o444)
    try {
      const r = await runCli(['fix', ...LANG_ARGS, '--source', copy, '--apply'])
      expect(r.stderr).toContain(`could not write ${copy}: `)
      expect(r.stderr).toContain('EACCES')
      expect(readFileSync(copy, 'utf8')).toBe(before)
      expect(r.code).toBe(2)
    }
    finally { chmodSync(copy, 0o644) }
  }, T)

  it('with nothing verified, writes no file and still reports the count it wrote', async () => {
    const copy = tmp('labels-copy.mjs')
    copyFileSync(`${F}/labels.mjs`, copy)
    const before = readFileSync(copy, 'utf8')

    const r = await runCli(['fix', `${F}/labels.mjs`, '--corpus', `${F}/corpus`, '--source', copy, '--apply'])

    expect(readFileSync(copy, 'utf8')).toBe(before)
    expect(r.stdout).toContain('0 edit(s) written to')
    expect(r.code).toBe(0)
  }, T)
})

describe('fix --json', () => {
  it('puts the report on stdout and the human rendering on stderr', async () => {
    const r = await runCli(['fix', ...LANG_ARGS, '--json'])
    const doc = JSON.parse(r.stdout) as { schema: string; ok: boolean }
    expect(doc.schema).toBe('parseman.fix/1')
    expect(doc.ok).toBe(true)
    expect(r.stderr).toContain('3 changes that are safe to make')
    expect(r.stdout).not.toContain('3 changes that are safe to make')
    expect(r.code).toBe(0)
  }, T)

  it('writes the report to a path, and a bad path is an I/O failure that exits 2', async () => {
    const good = tmp('fix.json')
    const ok = await runCli(['fix', ...LANG_ARGS, `--json=${good}`])
    expect((JSON.parse(readFileSync(good, 'utf8')) as { schema: string }).schema).toBe('parseman.fix/1')
    expect(ok.code).toBe(0)

    const bad = join(tmp('x'), 'nested', 'fix.json')
    const r = await runCli(['fix', ...LANG_ARGS, `--json=${bad}`])
    expect(r.stderr).toContain(`could not write ${bad}: `)
    expect(r.code).toBe(2)
  }, T)
})
