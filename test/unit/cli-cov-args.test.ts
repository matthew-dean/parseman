/**
 * Argument parsing and process wiring — everything `src/cli/index.ts` decides BEFORE it
 * has looked at a grammar.
 *
 * `cli-exit-codes.test.ts` owns the end-to-end contract through a real subprocess. This
 * file owns the shape of the surface: which spellings of a flag mean the same thing,
 * which stream each kind of output goes to, and the two DIFFERENT zero-and-two exits that
 * both print the same usage text. Those are the parts a user hits by typing something
 * slightly wrong, and the parts that a rewrite of `parseArgs` would break silently.
 */
import { describe, it, expect } from 'vitest'
import { runCli, stripSgr } from '../helpers/run-cli.ts'

const G = 'test/fixtures/cli-cov/labels.mjs'
const CLEAN = 'test/fixtures/cli-cov/named-one.mjs'
const CORPUS = 'test/fixtures/cli-cov/corpus'
const ESC = String.fromCharCode(27)

/** The rule separator is a full-width run of `─`, so it measures the resolved width. */
const separatorWidths = (out: string): number[] =>
  stripSgr(out).split('\n').filter(l => l.startsWith('─')).map(l => l.length)

describe('usage and the two ways of asking for it', () => {
  it('`--help` prints usage on STDOUT and exits 0', async () => {
    const r = await runCli(['--help'])
    expect(r.stdout).toContain('parseman — grammar diagnostics')
    expect(r.stdout).toContain('parseman diagnose <grammar> [options]')
    expect(r.stdout).toContain('0 clean · 1 blocking findings · 2 could not analyse')
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
  })

  it('`-h` is the same thing as `--help`', async () => {
    const short = await runCli(['-h'])
    const long = await runCli(['--help'])
    expect(short.stdout).toBe(long.stdout)
    expect(short.code).toBe(0)
  })

  it('the `help` COMMAND exits 0', async () => {
    const r = await runCli(['help'])
    expect(r.stdout).toContain('parseman — grammar diagnostics')
    expect(r.code).toBe(0)
  })

  it('no command at all prints the same usage but exits 2 — asked-for vs. no-input', async () => {
    const none = await runCli([])
    const asked = await runCli(['--help'])
    expect(none.stdout).toBe(asked.stdout)
    // Same bytes, different verdict: an empty invocation ANALYSED NOTHING.
    expect(none.code).toBe(2)
    expect(asked.code).toBe(0)
  })

  it('`--help` wins over a command, so `diagnose --help` does not try to analyse', async () => {
    const r = await runCli(['diagnose', '--help'])
    expect(r.stdout).toContain('parseman — grammar diagnostics')
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
  })

  it('a command with no grammar path exits 2, says which command, and repeats usage', async () => {
    const r = await runCli(['diagnose'])
    expect(r.stderr).toContain('`parseman diagnose` needs a grammar module path.')
    expect(r.stderr).toContain('parseman — grammar diagnostics')
    expect(r.stdout).toBe('')
    expect(r.code).toBe(2)
  })

  it('an unknown command is named back, once it gets that far', async () => {
    const r = await runCli(['frobnicate', CLEAN])
    expect(r.stderr).toContain('unknown command `frobnicate`')
    expect(r.stderr).toContain('parseman — grammar diagnostics')
    expect(r.code).toBe(2)
  })
})

describe('parseArgs', () => {
  it('`--flag=value` and `--flag value` reach the same place', async () => {
    const eq = await runCli(['diagnose', G, '--limit=abc'])
    const sep = await runCli(['diagnose', G, '--limit', 'abc'])
    expect(eq.stderr).toContain('`--limit` needs a non-negative integer; got `abc`.')
    expect(sep.stderr).toBe(eq.stderr)
    expect(eq.code).toBe(2)
    expect(sep.code).toBe(2)
  })

  it('a value-taking flag at the END of argv has no value to take, so it is a boolean', async () => {
    // `--limit` with a value it cannot honour is a hard error (see above). Bare, there is
    // no value at all, so there is nothing to dishonour and the run must proceed.
    const r = await runCli(['diagnose', G, '--limit'])
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('1 problem in 1 choice')
    expect(r.code).toBe(1)
  })

  it('a value-taking flag does NOT swallow the following `--flag`', async () => {
    // On a TTY colour is on by default, so `--no-color` has a visible job to do. If
    // `--limit` had eaten it, the error would be "got `--no-color`" and colour would stay.
    const r = await runCli(['diagnose', G, '--limit', '--no-color'], { isTTY: true, env: { NO_COLOR: undefined } })
    expect(r.stderr).toBe('')
    expect(r.stdout.includes(ESC)).toBe(false)
    expect(r.code).toBe(1)
  })

  it('a value-taking flag DOES take a value that merely looks like one', async () => {
    // `-1` does not start with `--`, so it is consumed — and then rejected on its merits.
    const r = await runCli(['diagnose', G, '--limit', '-1'])
    expect(r.stderr).toContain('got `-1`')
    expect(r.code).toBe(2)
  })

  it('a bare boolean flag does not consume the positional after it', async () => {
    // `--json` is not value-taking, so the grammar path behind it is still a positional.
    const r = await runCli(['diagnose', '--json', CLEAN])
    expect(JSON.parse(r.stdout).schema).toBe('parseman.diagnosis/1')
    expect(r.code).toBe(0)
  })

  it('the FIRST positional is the command and the second is the grammar', async () => {
    const r = await runCli(['diagnose', CLEAN, 'an-extra-positional'])
    expect(r.stdout).toContain('test/fixtures/cli-cov/named-one.mjs — nothing to fix')
    expect(r.code).toBe(0)
  })
})

describe('colour resolution', () => {
  it('`--color` forces colour ON even though stdout is not a TTY', async () => {
    const r = await runCli(['diagnose', G, '--color'])
    expect(r.stdout.includes(ESC)).toBe(true)
  })

  it('`--color=false` forces colour OFF even on a TTY with no NO_COLOR', async () => {
    const r = await runCli(['diagnose', G, '--color=false'], { isTTY: true, env: { NO_COLOR: undefined } })
    expect(r.stdout.includes(ESC)).toBe(false)
  })

  it('`--no-color` forces colour OFF on a TTY', async () => {
    const r = await runCli(['diagnose', G, '--no-color'], { isTTY: true, env: { NO_COLOR: undefined } })
    expect(r.stdout.includes(ESC)).toBe(false)
  })

  it('NO_COLOR in the environment turns colour off on a TTY', async () => {
    const r = await runCli(['diagnose', G], { isTTY: true, columns: 100, env: { NO_COLOR: '1' } })
    expect(r.stdout.includes(ESC)).toBe(false)
  })

  it('a TTY with no NO_COLOR gets colour by default; a pipe does not', async () => {
    const tty = await runCli(['diagnose', G], { isTTY: true, columns: 100, env: { NO_COLOR: undefined } })
    const pipe = await runCli(['diagnose', G], { isTTY: false, env: { NO_COLOR: undefined } })
    expect(tty.stdout.includes(ESC)).toBe(true)
    expect(pipe.stdout.includes(ESC)).toBe(false)
  })
})

describe('width resolution', () => {
  it('`--width <n>` is obeyed exactly', async () => {
    const r = await runCli(['diagnose', G, '--width', '60'])
    expect([...new Set(separatorWidths(r.stdout))]).toEqual([60])
  })

  it('a width that is not a positive number falls back to 80, it does not become NaN', async () => {
    const bad = await runCli(['diagnose', G, '--width', 'abc'])
    const zero = await runCli(['diagnose', G, '--width', '0'])
    expect([...new Set(separatorWidths(bad.stdout))]).toEqual([80])
    expect([...new Set(separatorWidths(zero.stdout))]).toEqual([80])
  })

  it('with colour on, an unspecified width follows the terminal', async () => {
    const r = await runCli(['diagnose', G, '--color'], { isTTY: true, columns: 55 })
    expect([...new Set(separatorWidths(r.stdout))]).toEqual([55])
  })

  it('OFF-TTY the width is PINNED at 80 whatever the terminal claims — a piped rendering must be diffable', async () => {
    const r = await runCli(['diagnose', G], { isTTY: false, columns: 55, env: { NO_COLOR: undefined } })
    expect([...new Set(separatorWidths(r.stdout))]).toEqual([80])
  })

  it('an explicit `--width` beats the terminal', async () => {
    const r = await runCli(['diagnose', G, '--color', '--width', '48'], { isTTY: true, columns: 120 })
    expect([...new Set(separatorWidths(r.stdout))]).toEqual([48])
  })
})

describe('--no-links', () => {
  const abs = `file://${process.cwd()}/test/fixtures/cli-cov/corpus/a.txt`

  it('a coloured rendering links code frames at their absolute path', async () => {
    const r = await runCli(['diagnose', G, '--corpus', CORPUS, '--color'])
    expect(r.stdout).toContain(`${ESC}]8;;${abs}${ESC}\\`)
  })

  it('`--no-links` keeps the absolute path out of the rendering entirely', async () => {
    const r = await runCli(['diagnose', G, '--corpus', CORPUS, '--color', '--no-links'])
    expect(r.stdout).not.toContain(process.cwd())
    // The frame is still there and still says where it is — only the link target is gone.
    expect(stripSgr(r.stdout)).toContain('test/fixtures/cli-cov/corpus/a.txt')
  })
})
