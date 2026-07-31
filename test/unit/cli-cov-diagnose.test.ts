/**
 * The `diagnose` command: the arm labels it prints, the two streams `--json` splits
 * output across, and the flags that change what gets expanded.
 *
 * `leadLabel` gets the most attention here because it is the part of the rendering a
 * reader navigates by. "arm 6" is not a thing anyone can look up; `word('solo')` is.
 * `test/fixtures/cli-cov/labels.mjs` is built so ONE run produces every label the switch
 * can make, including the two that are not obvious — an unnamed `ref()` described by what
 * it resolves to, and an unbound one that cannot be resolved at all and must say so
 * rather than throw.
 */
import { describe, it, expect } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../helpers/run-cli.ts'

const F = 'test/fixtures/cli-cov'
const G = `${F}/labels.mjs`
const LANG = ['examples/lang/parser.ts', '--export', 'exprParser'] as const
const LANG_CORPUS = 'examples/lang/corpus'

/** The `arm N   <label>   <first set>` table, as `label` strings in arm order. */
const armLabels = (out: string): string[] =>
  out.split('\n')
    .map(l => /^\s*arm \d+\s{2,}(\S.*?)\s+(?:starts with|can start with)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => m[1]!.trimEnd())

describe('leadLabel — every arm is described by what it LEADS with', () => {
  it('labels a literal, a regex, one word, several words, a named rule, a resolvable ref, an unbound ref, and anything else', async () => {
    const r = await runCli(['diagnose', G, '--width', '120'])
    expect(armLabels(r.stdout)).toEqual([
      "literal('lit')",
      'regex(/re[0-9]/)',
      "word('solo')",
      'keywords([2])',
      // A rules() reference carries its own name — that IS the useful label.
      'Named',
      // An anonymous ref() is resolved once and described by what it leads with.
      "→ literal('resolved')",
      // An anonymous ref() onto a NAMED rule reports the name, not the arrow form.
      'Named',
      // The thunk throws; the label must survive that rather than take the process down.
      'ref(unbound)',
      // Nothing more specific to say: the bare tag.
      'many',
    ])
    expect(r.code).toBe(1)
  })
})

describe('the diagnose exit contract', () => {
  it('exits 1 and says so when a choice fails the check', async () => {
    const r = await runCli(['diagnose', G])
    expect(r.stdout).toContain('1 problem, 1 failing the check, 1 cause')
    expect(r.stdout).toContain('exiting 1 (problems found)')
    expect(r.code).toBe(1)
  })

  it('exits 0 on a grammar with nothing to report', async () => {
    const r = await runCli(['diagnose', `${F}/named-one.mjs`])
    expect(r.stdout).toContain('nothing to fix')
    expect(r.stdout).toContain('1/1 choices gate on first char')
    expect(r.code).toBe(0)
  })

  it('`--accept` moves a choice to accepted and turns the same grammar green', async () => {
    const r = await runCli(['diagnose', G, '--accept', '<entry>'])
    expect(r.stdout).toContain('nothing to fix')
    expect(r.stdout).toContain('0/1 choices gate on first char · 1 accepted')
    expect(r.code).toBe(0)
  })

  it('`--accept` trims round each id and drops the empty ones', async () => {
    const r = await runCli(['diagnose', G, '--accept', ' , <entry> , '])
    // Same effect as the tight spelling above: the blanks are dropped, ` <entry> ` is
    // trimmed to an id that matches. Without the trim this would be an unmatched entry.
    expect(r.stdout).toContain('0/1 choices gate on first char · 1 accepted')
    expect(r.code).toBe(0)
  })

  it('an accept id that matches nothing is REPORTED as stale, not silently ignored', async () => {
    const r = await runCli(['diagnose', G, '--accept', 'some-other-id'])
    expect(r.stdout).toContain('1 accept-list entry that no longer matches anything')
    expect(r.stdout).toContain('2 problems, 1 failing the check')
    expect(r.code).toBe(1)
  })
})

describe('--limit', () => {
  it('expands exactly the number of sites it was given', async () => {
    const one = await runCli(['diagnose', ...LANG, '--width', '200', '--limit', '1'])
    const two = await runCli(['diagnose', ...LANG, '--width', '200', '--limit', '2'])
    expect(one.stdout).toContain('… 6 more site(s) — --limit 7 shows them, --json holds them all')
    expect(two.stdout).toContain('… 5 more site(s) — --limit 7 shows them, --json holds them all')
    expect(one.code).toBe(1)
  }, 30_000)

  it('refuses a limit it cannot honour instead of silently ignoring it', async () => {
    for (const bad of ['abc', '-1', '1.5']) {
      const r = await runCli(['diagnose', G, '--limit', bad])
      expect(r.stderr).toBe(`\`--limit\` needs a non-negative integer; got \`${bad}\`.\n`)
      expect(r.code).toBe(2)
    }
  })

  it('accepts 0 — "expand nothing" is a coherent request', async () => {
    const r = await runCli(['diagnose', ...LANG, '--width', '200', '--limit', '0'])
    expect(r.stdout).toContain('… 7 more site(s)')
    expect(r.code).toBe(1)
  }, 30_000)
})

describe('the corpus turns claims into measurements', () => {
  it('offers a `parseman fix` command ONLY when a rewrite has been proved against a corpus', async () => {
    const withCorpus = await runCli(['diagnose', ...LANG, '--width', '200', '--corpus', LANG_CORPUS])
    const without = await runCli(['diagnose', ...LANG, '--width', '200'])
    expect(withCorpus.stdout).toContain('3 of them can be fixed automatically. Run:')
    expect(withCorpus.stdout).toContain(
      'parseman fix examples/lang/parser.ts --export exprParser --corpus examples/lang/corpus',
    )
    // No corpus, no proof, no wrench — the guarantee `fix` has depends on this.
    expect(without.stdout).not.toContain('can be fixed automatically')
    expect(without.stdout).not.toContain('parseman fix')
  }, 60_000)

  it('the suggested command carries EVERY option that changed what was verified', async () => {
    // `--ext` picks the corpus files and `--accept` picks the candidate set, so a command
    // that drops them reproduces a different run than the one that earned the wrench.
    const r = await runCli([
      'diagnose', ...LANG, '--width', '200', '--corpus', LANG_CORPUS, '--ext', '.lang', '--accept', 'Expr,Term',
    ])
    expect(r.stdout).toContain(
      'parseman fix examples/lang/parser.ts --export exprParser --corpus examples/lang/corpus'
      + ' --ext .lang --accept Expr,Term',
    )
  }, 60_000)

  it('shell-quotes a value holding a space, so the command stays pasteable', async () => {
    // An unquoted path with a space silently becomes two arguments. Copy the corpus into
    // a directory whose name has one and check the suggestion survives a paste.
    const dir = mkdtempSync(join(tmpdir(), 'cli-cov-diag-'))
    const spaced = join(dir, 'corpus dir')
    cpSync(LANG_CORPUS, spaced, { recursive: true })
    try {
      const r = await runCli(['diagnose', ...LANG, '--width', '200', '--corpus', spaced])
      expect(r.stdout).toContain(`--corpus '${spaced}'`)
    }
    finally { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
  }, 60_000)

  it('keeps a grammar path that starts with `-` a PATH, not an option', async () => {
    // `relative()` turns `./--g.ts` into `--g.ts`, and the pasted command would then read
    // its own grammar path as a flag. Quoting cannot fix that — the shell strips the
    // quotes and `parseArgs` still sees the leading `-`.
    // The grammar has to sit beside its own relative imports and INSIDE the cwd, since
    // `relative()` is what strips the `./`. So: copy it next to `ast.ts`, and run from
    // there. `./--parser.ts` is also the only spelling that reaches the CLI at all —
    // `parseArgs` reads a bare `--parser.ts` as a flag, which is the whole point.
    const dashed = 'examples/lang/--parser.ts'
    cpSync('examples/lang/parser.ts', dashed)
    const cwd = process.cwd()
    try {
      process.chdir('examples/lang')
      const r = await runCli(['diagnose', './--parser.ts', '--export', 'exprParser', '--width', '200', '--corpus', 'corpus'])
      const line = r.stdout.split('\n').find(l => l.includes('parseman fix'))
      expect(line).toBeDefined()
      expect(line).toContain('parseman fix ./--parser.ts')
    }
    finally {
      process.chdir(cwd)
      rmSync(dashed, { force: true })
    }
  }, 60_000)

  it('reports the measured second world when a corpus is given', async () => {
    const r = await runCli(['diagnose', G, '--corpus', `${F}/corpus`])
    expect(r.stdout).toContain('reached at 13 places in your corpus')
    expect(r.stdout).toContain('one of the 13 places, in your own input')
    expect(r.code).toBe(1)
  })
})

describe('--json', () => {
  it('with no path, stdout is the DOCUMENT and the human rendering moves to stderr', async () => {
    const r = await runCli(['diagnose', G, '--json'])
    // The whole of stdout must parse. A stray human line anywhere in it breaks this.
    const doc = JSON.parse(r.stdout) as { schema: string; ok: boolean }
    expect(doc.schema).toBe('parseman.diagnosis/1')
    expect(doc.ok).toBe(false)
    expect(r.stdout.endsWith('\n')).toBe(true)
    expect(r.stderr).toContain('1 problem in 1 choice')
    expect(r.stdout).not.toContain('1 problem in 1 choice')
    // The document is a report, not a verdict: the exit code still carries the verdict.
    expect(r.code).toBe(1)
  })

  it('with a path, the file gets the document and stdout keeps the human rendering', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'cli-cov-json-')), 'report.json')
    const toFile = await runCli(['diagnose', G, `--json=${out}`])
    const toStdout = await runCli(['diagnose', G, '--json'])
    expect(readFileSync(out, 'utf8')).toBe(toStdout.stdout)
    expect(toFile.stdout).toContain('1 problem in 1 choice')
    expect(toFile.stderr).toBe('')
    expect(toFile.code).toBe(1)
  })

  it('a path it cannot write is an I/O failure with the path and the reason, and exits 2', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'cli-cov-json-')), 'no-such-dir', 'report.json')
    const r = await runCli(['diagnose', G, `--json=${out}`])
    expect(r.stderr).toContain(`could not write ${out}: `)
    expect(r.stderr).toContain('ENOENT')
    // The rendering was already produced — the failure is the WRITE, and it must not be
    // downgraded to the analysis verdict of 1.
    expect(r.stdout).toContain('1 problem in 1 choice')
    expect(r.code).toBe(2)
  })

  it('the document is written even when the grammar is clean', async () => {
    const r = await runCli(['diagnose', `${F}/named-one.mjs`, '--json'])
    const doc = JSON.parse(r.stdout) as { ok: boolean }
    expect(doc.ok).toBe(true)
    expect(r.code).toBe(0)
  })
})
