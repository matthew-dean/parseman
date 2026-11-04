/**
 * The engine-refactor gates run as CI runs them, as processes: a planted violation must
 * exit non-zero. The tests beside this one call the gates' functions, which stay green
 * if a command stops acting on what they return.
 *
 * The call-count gate runs on a worktree of HEAD with this tree's benches over it, so
 * a planted edit never touches this checkout. Its reference is HEAD, and `--only` keeps
 * each run to one family of rows.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { measureSide, type Rows } from '../../bench/call-count-guard.ts'
import { collectArtifacts, measure } from '../../bench/dup-function-guard.ts'
import type { WorkerArgs } from '../../bench/engine-guards/count-worker.ts'
import { withBuiltSnapshot } from '../../bench/jess/real-grammars.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-engine-guards-cli-')))
const TREE = path.join(TMP, 'tree')
const LINK = path.join(TMP, 'link')
const CALL_COUNT = 'bench/call-count-guard.ts'
const DUP = 'bench/dup-function-guard.ts'
const CALL_BASELINE = path.join(TREE, 'bench/call-count-baseline.json')
const DUP_BASELINE = path.join(TREE, 'bench/dup-function-baseline.json')
const REASONS = path.join(TREE, 'bench/call-count-reasons.json')
const ENTRY = path.join(TREE, 'src/table/compile.ts')
const ANCHOR = '      return runOnce(input, pos, parseCtx)'

const git = (args: string[], env?: NodeJS.ProcessEnv): string =>
  execFileSync('git', args, { cwd: TREE, encoding: 'utf8', env: { ...process.env, ...env } }).trim()

function gate(script: string, args: string[], root = TREE): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx/esm', path.join(root, script), ...args], { cwd: TREE, encoding: 'utf8', timeout: 170_000 })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const callCount = (args: string[] = [], root = TREE): { code: number | null; out: string } =>
  gate(CALL_COUNT, ['--ref=HEAD', '--only=emitted/', ...args], root)

/** A commit holding this duplicate baseline, made with plumbing so no hook runs. */
function commitDupBaseline(text: string): string {
  writeFileSync(DUP_BASELINE, text)
  const index = { GIT_INDEX_FILE: path.join(TMP, 'index') }
  git(['read-tree', 'HEAD'], index)
  git(['add', '-f', 'bench/dup-function-baseline.json'], index)
  const identity = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' }
  return git(['commit-tree', git(['write-tree'], index), '-p', 'HEAD', '-m', 'a baseline'], identity)
}

describe('the gates as commands', () => {
  let cleanCalls: string
  let cleanDups: string
  let cleanEntry: string
  let cleanBase: string
  const dup = (root = TREE): { code: number | null; out: string } =>
    gate(DUP, [`--base=${cleanBase}`, '--only=emitted/'], root)
  beforeAll(async () => {
    execFileSync('git', ['worktree', 'add', '--detach', TREE, 'HEAD'], { cwd: ROOT, stdio: 'ignore' })
    for (const rel of ['bench', 'scripts', 'fixtures/jess-grammars']) cpSync(path.join(ROOT, rel), path.join(TREE, rel), { recursive: true, force: true })
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(TREE, 'node_modules'), 'dir')
    symlinkSync(TREE, LINK, 'dir')
    writeFileSync(REASONS, '{ "against": "", "rows": {} }\n')
    // The baselines are this tree's counts, so an uncommitted engine edit in the checkout
    // running these tests does not fail them for the wrong reason.
    const rows: Rows = await measureSide(TREE, path.join(TMP, 'clean-out'), row => row.startsWith('emitted/') || row === 'emitted/')
    cleanCalls = `${JSON.stringify(rows, null, 2)}\n`
    writeFileSync(CALL_BASELINE, cleanCalls)
    const { rows: dupRows } = measure(await collectArtifacts(TREE, 'emitted/'))
    cleanDups = `${JSON.stringify(Object.fromEntries(Object.entries(dupRows).map(([id, r]) => [id, r.duplicates])), null, 2)}\n`
    cleanBase = commitDupBaseline(cleanDups)
    cleanEntry = readFileSync(ENTRY, 'utf8')
  }, 300_000)
  beforeEach(() => {
    writeFileSync(CALL_BASELINE, cleanCalls)
    writeFileSync(DUP_BASELINE, cleanDups)
    writeFileSync(REASONS, '{ "against": "", "rows": {} }\n')
    writeFileSync(ENTRY, cleanEntry)
  })
  afterAll(() => {
    // The gate made a reference worktree inside this one. Remove it first, or its registration outlives it.
    execFileSync('git', ['worktree', 'remove', '--force', path.join(TREE, '.cache/call-count-HEAD')], { cwd: ROOT, stdio: 'ignore' })
    execFileSync('git', ['worktree', 'remove', '--force', TREE], { cwd: ROOT, stdio: 'ignore' })
    rmSync(TMP, { recursive: true, force: true })
  })

  const plantCall = (): void => writeFileSync(ENTRY, cleanEntry.replace(ANCHOR, `      ;(() => 0)()\n${ANCHOR}`))
  const raiseBaseline = (): void => {
    const rows = JSON.parse(cleanCalls) as Rows
    rows['emitted/json/document']!.calls += 1
    writeFileSync(CALL_BASELINE, JSON.stringify(rows))
  }

  describe('callcount:guard', () => {
    it('passes a clean tree', () => {
      const r = callCount()
      expect(r.out).toContain('call-count: ok — 5 rows')
      expect(r.code).toBe(0)
    }, 180_000)

    it('exits non-zero on one extra call per parse', () => {
      plantCall()
      const r = callCount()
      expect(r.out).toContain('(+1 per parse)')
      expect(r.code).toBe(1)
    }, 180_000)

    it('exits non-zero when the baseline differs from what HEAD counts', () => {
      raiseBaseline()
      const r = callCount()
      expect(r.out).toContain('bank the win')
      expect(r.code).toBe(1)
    }, 180_000)

    it('exits non-zero on a reason with empty text', () => {
      plantCall()
      const rows = Object.fromEntries(Object.keys(JSON.parse(cleanCalls) as Rows).map(row => [`${row} calls`, { why: '', limit: 1 }]))
      writeFileSync(REASONS, JSON.stringify({ against: 'HEAD', rows }))
      const r = callCount()
      expect(r.out).toContain('"why" must say why')
      expect(r.code).toBe(1)
    }, 180_000)

    it('exits non-zero when run through a symlinked path', () => {
      raiseBaseline()
      const r = callCount([], LINK)
      expect(r.out).toContain('bank the win')
      expect(r.code).toBe(1)
    }, 180_000)

    it('refuses two legs that share a tree', () => {
      const r = callCount(['--head-ref=HEAD'])
      expect(r.out).toContain('both resolve parseman from')
      expect(r.code).toBe(1)
    }, 180_000)

    it('refuses a run that counts no rows', () => {
      const r = gate(CALL_COUNT, ['--ref=HEAD', '--only=nothing/'])
      expect(r.out).toContain('nothing/: no rows were counted')
      expect(r.code).toBe(1)
    }, 180_000)
  })

  describe('dupfn:guard', () => {
    it('passes a clean tree', () => {
      const r = dup()
      expect(r.out).toContain('dup-function: ok')
      expect(r.code).toBe(0)
    }, 180_000)

    it('exits non-zero when the output has more duplicates than the baseline', () => {
      const rows = JSON.parse(cleanDups) as Record<string, number>
      rows['emitted/less']! -= 1
      writeFileSync(DUP_BASELINE, JSON.stringify(rows))
      const r = dup()
      expect(r.out).toContain('duplicated functions, baseline')
      expect(r.code).toBe(1)
    }, 180_000)

    it('exits non-zero when the baseline rose from the merge base', () => {
      const rows = JSON.parse(cleanDups) as Record<string, number>
      rows['emitted/less']! -= 1
      const base = commitDupBaseline(JSON.stringify(rows))
      writeFileSync(DUP_BASELINE, cleanDups)
      const r = gate(DUP, [`--base=${base}`, '--only=emitted/'])
      expect(r.out).toContain('it only moves down')
      expect(r.code).toBe(1)
    }, 180_000)

    it('exits non-zero when run through a symlinked path', () => {
      const rows = JSON.parse(cleanDups) as Record<string, number>
      rows['emitted/less']! -= 1
      writeFileSync(DUP_BASELINE, JSON.stringify(rows))
      const r = dup(LINK)
      expect(r.out).toContain('duplicated functions, baseline')
      expect(r.code).toBe(1)
    }, 180_000)

    it('refuses a run that reads no artifacts', () => {
      const r = gate(DUP, [`--base=${cleanBase}`, '--only=nothing/'])
      expect(r.out).toContain('nothing/: no artifacts were read')
      expect(r.code).toBe(1)
    }, 180_000)
  })
})

describe('the count worker refuses a parse it should not count', () => {
  const WORKER_DIR = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-engine-guards-worker-')))
  afterAll(() => rmSync(WORKER_DIR, { recursive: true, force: true }))
  const input = path.join(WORKER_DIR, 'input.css')
  const empty = path.join(WORKER_DIR, 'empty.css')
  writeFileSync(input, 'a { b: c }')
  writeFileSync(empty, '')
  const length = 'a { b: c }'.length

  function worker(args: WorkerArgs): { code: number | null; out: string } {
    const r = spawnSync(process.execPath, ['--import', 'tsx/esm', path.join(ROOT, 'bench/engine-guards/count-worker.ts'), JSON.stringify(args)], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const moduleFile = (name: string, code: string): string => {
    const file = path.join(WORKER_DIR, `${name}.mjs`)
    writeFileSync(file, code)
    return file
  }
  /** A grammar module whose `run` returns `result`; `onRun` sees the options it was given. */
  const jess = (name: string, result: string, onRun = ''): { code: number | null; out: string } => worker({
    kind: 'jess',
    module: moduleFile(name, `export const grammar = { Stylesheet: {}, whitespace: {} }\nexport const cstBuildHost = {}\nexport const run = (_e, _i, opts) => { ${onRun}; return ${result} }\n`),
    cases: [{ id: 'macro/less/ast/probe', dialect: 'less', input, cst: false }],
  })
  const good = `{ ok: true, span: { start: 0, end: ${length} }, unconsumedFrom: null, errors: [], value: { type: 'Stylesheet' } }`

  it('counts a parse that passes every check', () => {
    expect(jess('good', good)).toMatchObject({ code: 0 })
  }, 60_000)

  it.each([
    ['a failed parse', 'failed', `{ ok: false, span: { start: 0, end: 1 } }`, 'parse FAILED'],
    ['unconsumed input', 'unconsumed', `{ ok: true, span: { start: 0, end: 2 }, unconsumedFrom: 2, errors: [], value: { type: 'Stylesheet' } }`, 'left input unconsumed'],
    ['a recovered error', 'errors', `{ ok: true, span: { start: 0, end: ${length} }, unconsumedFrom: null, errors: [{}], value: { type: 'Stylesheet' } }`, 'recovered from 1 errors'],
    ['no Stylesheet', 'value', `{ ok: true, span: { start: 0, end: ${length} }, unconsumedFrom: null, errors: [], value: {} }`, 'did not build a Stylesheet'],
  ])('refuses %s', (_label, name, result, message) => {
    const r = jess(name, result)
    expect(r.out).toContain(message)
    expect(r.code).not.toBe(0)
  }, 60_000)

  it('refuses a parse whose grammar reported a diagnostic', () => {
    const r = jess('diagnostics', good, "opts.state.document.diagnostics.push({})")
    expect(r.out).toContain('reported 1 diagnostics')
    expect(r.code).not.toBe(0)
  }, 60_000)

  it('refuses an empty input', () => {
    const r = worker({
      kind: 'jess',
      module: moduleFile('empty-input', `export const grammar = { Stylesheet: {} }\nexport const run = () => ({ ok: true, span: { start: 0, end: 0 }, value: { type: 'Stylesheet' } })\n`),
      cases: [{ id: 'macro/less/ast/probe', dialect: 'less', input: empty, cst: false }],
    })
    expect(r.out).toContain('the input is empty')
    expect(r.code).not.toBe(0)
  }, 60_000)

  it('refuses a workload that stops early, and an empty list of workloads', () => {
    const partial = worker({
      kind: 'workloads',
      engine: 'emitted',
      module: moduleFile('partial', `export const buildWorkloads = () => [{ id: 'css/stylesheet', input: 'a b', make: () => ({ parse: () => ({ ok: true, span: { start: 0, end: 1 } }) }) }]\n`),
    })
    expect(partial.out).toContain('parse stopped at byte 1')
    expect(partial.code).not.toBe(0)
    const none = worker({ kind: 'workloads', engine: 'emitted', module: moduleFile('none', 'export const buildWorkloads = () => []\n') })
    expect(none.out).toContain('nothing to count')
    expect(none.code).not.toBe(0)
  }, 60_000)

  it('refuses Less positions on `!important`, until #253 is fixed', async () => {
    const important = path.join(WORKER_DIR, 'important.css')
    writeFileSync(important, '.a { b: c !important; }')
    await withBuiltSnapshot(async snap => {
      await snap.shipped('less', 'ast/positions')
      const r = worker({
        kind: 'jess',
        module: await snap.runnable('less', 'ast/positions'),
        cases: [{ id: 'macro/less/ast/positions/probe', dialect: 'less', input: important, cst: false }],
      })
      expect(r.out).toContain('left input unconsumed from byte 0')
      expect(r.code).not.toBe(0)
    })
  }, 300_000)
})

describe('the pre-commit perf filter', () => {
  it('matches every file bench/perf-guard.ts builds from', async () => {
    const hook = readFileSync(path.join(ROOT, 'scripts/git-hooks/pre-commit'), 'utf8')
    const pattern = /grep -qE '([^']+)'/.exec(hook)?.[1]
    if (pattern === undefined) throw new Error('the hook no longer filters with grep -qE')
    const filter = new RegExp(pattern)
    expect(filter.test('src/table/assemble.ts')).toBe(true)
    const { metafile } = await build({ entryPoints: [path.join(ROOT, 'bench/perf-guard.ts')], absWorkingDir: ROOT, bundle: true, write: false, metafile: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent' })
    const inputs = Object.keys(metafile.inputs)
    expect(inputs.length).toBeGreaterThan(50)
    expect(inputs.filter(f => !filter.test(f))).toEqual([])
  }, 60_000)
})
