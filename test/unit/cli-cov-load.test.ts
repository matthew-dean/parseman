/**
 * `loadGrammar` and `readCorpus` — the two places the CLI reads the world.
 *
 * Both exist to turn a failure that would otherwise surface as a stack trace into a
 * sentence and an exit code of 2. So what is asserted here is mostly the sentence: which
 * path it names, which exports it lists, which reason it gives. A message that says
 * "cannot read corpus path" without the path is the same failure the exit code exists to
 * prevent — you cannot act on it.
 *
 * The count assertions are the other half. `readCorpus` walks recursively, sorts, and
 * filters by extension, and none of that is visible from an exit code; it IS visible in
 * "reached at N places in your corpus", which is a function of exactly which bytes were
 * read. The fixture corpus is deliberately three files of three different sizes so the
 * number distinguishes "walked into `sub/`" from "did not".
 */
import { afterAll, describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../helpers/run-cli.ts'

const F = 'test/fixtures/cli-cov'
const G = `${F}/labels.mjs`
const CORPUS = `${F}/corpus`

// Scratch corpus directories, removed together at the end rather than left in the OS
// temp directory on every run. `maxRetries` because Node documents ENOTEMPTY as transient
// for recursive removal — tidying up must not be what fails a suite that otherwise passed.
const scratchDirs: string[] = []
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
})

/** `corpus/a.txt` is 4 bytes, `corpus/b.css` is 6, `corpus/sub/c.txt` is 3. */
const placesReached = (out: string): number => {
  const m = /reached at ([\d,]+) places in your corpus/.exec(out)
  if (m === null) throw new Error(`no corpus reach line in:\n${out}`)
  return Number(m[1]!.replace(/,/g, ''))
}

describe('loadGrammar', () => {
  it('names the path when the module is not there', async () => {
    const r = await runCli(['diagnose', `${F}/nope.mjs`])
    expect(r.stderr).toBe(`no such grammar module: ${F}/nope.mjs\n`)
    expect(r.stdout).toBe('')
    expect(r.code).toBe(2)
  })

  it('reports a module that throws while EVALUATING, with its error name and message', async () => {
    const r = await runCli(['diagnose', `${F}/throws.mjs`])
    expect(r.stderr).toBe(
      `could not load ${F}/throws.mjs\n  TypeError: fixture exploded on import\n`,
    )
    expect(r.code).toBe(2)
  })

  it('uses the default export when there is one', async () => {
    const r = await runCli(['diagnose', G])
    expect(r.stdout).toContain(`${G} — 1 problem in 1 choice`)
    expect(r.code).toBe(1)
  })

  it('uses the ONE named export when there is no default and no ambiguity', async () => {
    const r = await runCli(['diagnose', `${F}/named-one.mjs`])
    expect(r.stdout).toContain(`${F}/named-one.mjs — nothing to fix`)
    expect(r.code).toBe(0)
  })

  it('refuses to guess between several named exports, and LISTS them', async () => {
    const r = await runCli(['diagnose', `${F}/named-many.mjs`])
    expect(r.stderr).toBe(
      `${F}/named-many.mjs has no default export, and 2 named exports to choose between.\n`
      + '  Pick one with --export: alphaRule, betaRule\n',
    )
    expect(r.code).toBe(2)
  })

  it('`--export` picks one of them', async () => {
    const r = await runCli(['diagnose', `${F}/named-many.mjs`, '--export', 'betaRule'])
    expect(r.stdout).toContain(`${F}/named-many.mjs — nothing to fix`)
    expect(r.code).toBe(0)
  })

  it('`--export` naming something absent lists what IS there', async () => {
    const r = await runCli(['diagnose', `${F}/named-many.mjs`, '--export', 'nope'])
    expect(r.stderr).toBe(
      `${F}/named-many.mjs has no export \`nope\`. It exports: alphaRule, betaRule\n`,
    )
    expect(r.code).toBe(2)
  })

  it('`--export` beats a default export rather than being ignored beside it', async () => {
    // labels.mjs has a default (9 arms, 1 problem). Asking for a named export must not
    // silently fall back to it.
    const r = await runCli(['diagnose', G, '--export', 'notAnExport'])
    expect(r.stderr).toContain('has no export `notAnExport`')
    expect(r.code).toBe(2)
  })

  it('loads a TypeScript grammar through the tsx loader', async () => {
    const r = await runCli(['diagnose', `${F}/clean.ts`])
    expect(r.stdout).toContain(`${F}/clean.ts — nothing to fix`)
    expect(r.stdout).toContain('1/1 choices gate on first char')
    expect(r.code).toBe(0)
  })
})

describe('readCorpus', () => {
  it('reads a single FILE', async () => {
    const r = await runCli(['diagnose', G, '--corpus', `${CORPUS}/a.txt`])
    expect(placesReached(r.stdout)).toBe(4)
    expect(r.code).toBe(1)
  })

  it('walks a DIRECTORY recursively — the nested file is read too', async () => {
    // 4 (a.txt) + 6 (b.css) + 3 (sub/c.txt). Miss the recursion and this is 10.
    const r = await runCli(['diagnose', G, '--corpus', CORPUS])
    expect(placesReached(r.stdout)).toBe(13)
  })

  it('reads directory entries in SORTED order, so the sample shown is stable', async () => {
    const r = await runCli(['diagnose', G, '--corpus', CORPUS])
    // `a.txt` < `b.css` < `sub/c.txt`; the frame is drawn for the first place found.
    expect(r.stdout).toContain(`╭─[${CORPUS}/a.txt:1:1]`)
    expect(r.stdout).not.toContain(`${CORPUS}/b.css:`)
  })

  it('`--ext` filters, and filters INSIDE the walk rather than after it', async () => {
    const css = await runCli(['diagnose', G, '--corpus', CORPUS, '--ext', '.css'])
    const txt = await runCli(['diagnose', G, '--corpus', CORPUS, '--ext', '.txt'])
    expect(placesReached(css.stdout)).toBe(6)
    expect(css.stdout).toContain(`╭─[${CORPUS}/b.css:1:1]`)
    // 4 + 3: the nested .txt survives the filter.
    expect(placesReached(txt.stdout)).toBe(7)
  })

  it('`--ext` accepts a comma-separated list, and tolerates spaces and empties', async () => {
    const r = await runCli(['diagnose', G, '--corpus', CORPUS, '--ext', '.css, .txt,'])
    expect(placesReached(r.stdout)).toBe(13)
  })

  it('a corpus path that is not there names the path and the reason', async () => {
    const r = await runCli(['diagnose', G, '--corpus', `${F}/nope`])
    expect(r.stderr).toMatch(/^cannot read corpus path .*\/test\/fixtures\/cli-cov\/nope: ENOENT/)
    expect(r.code).toBe(2)
  })

  it('an EMPTY corpus directory is an error, not a silent zero-input pass', async () => {
    const empty = scratch('cli-cov-empty-')
    const r = await runCli(['diagnose', G, '--corpus', empty])
    expect(r.stderr).toBe(`corpus ${empty} contains no files\n`)
    expect(r.code).toBe(2)
  })

  it('a corpus that the extension filter empties says WHAT it was filtering for', async () => {
    const r = await runCli(['diagnose', G, '--corpus', CORPUS, '--ext', '.zzz'])
    expect(r.stderr).toBe(`corpus ${CORPUS} contains no files matching .zzz\n`)
    expect(r.code).toBe(2)
  })

  it('a directory holding only subdirectories is empty too', async () => {
    const root = scratch('cli-cov-dirs-')
    mkdirSync(join(root, 'nested'))
    const r = await runCli(['diagnose', G, '--corpus', root])
    expect(r.stderr).toBe(`corpus ${root} contains no files\n`)
    expect(r.code).toBe(2)
  })

  it('no `--corpus` at all is NOT an error — the corpus is the optional second world', async () => {
    const r = await runCli(['diagnose', G])
    expect(r.stdout).not.toContain('in your corpus')
    expect(r.stderr).toBe('')
    expect(r.code).toBe(1)
  })
})
