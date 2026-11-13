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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
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

/** A commit holding this duplicate baseline and the call baseline on disk, made with plumbing so no hook runs. */
function commitBaselines(text: string): string {
  writeFileSync(DUP_BASELINE, text)
  const index = { GIT_INDEX_FILE: path.join(TMP, 'index') }
  git(['read-tree', 'HEAD'], index)
  git(['add', '-f', 'bench/dup-function-baseline.json', 'bench/call-count-baseline.json'], index)
  const identity = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' }
  return git(['commit-tree', git(['write-tree'], index), '-p', 'HEAD', '-m', 'a baseline'], identity)
}

describe('the gates as commands', () => {
  let cleanCalls: string
  let cleanDups: string
  let cleanEntry: string
  let cleanBase: string
  const callCount = (args: string[] = [], root = TREE): { code: number | null; out: string } =>
    gate(CALL_COUNT, ['--ref=HEAD', `--base=${cleanBase}`, '--only=emitted/', ...args], root)
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
    cleanBase = commitBaselines(cleanDups)
    cleanEntry = readFileSync(ENTRY, 'utf8')
  }, 300_000)
  beforeEach(() => {
    writeFileSync(CALL_BASELINE, cleanCalls)
    writeFileSync(DUP_BASELINE, cleanDups)
    writeFileSync(REASONS, '{ "against": "", "rows": {} }\n')
    writeFileSync(ENTRY, cleanEntry)
  })
  afterAll(() => {
    // A call-count run makes a reference worktree inside this one, and a filtered run may
    // not. Remove it first, or its registration outlives it; neither failure stops the next.
    for (const dir of [path.join(TREE, '.cache/call-count-HEAD'), TREE]) spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT, stdio: 'ignore' })
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
      expect(r.out).toContain('call-count: ok — 11 rows')
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

    it('exits non-zero when a row at the merge base leaves the baseline', () => {
      const rows = JSON.parse(cleanCalls) as Rows
      delete rows['emitted/json/document']
      writeFileSync(CALL_BASELINE, JSON.stringify(rows))
      const r = callCount()
      expect(r.out).toContain('emitted/json/document: in the baseline at the merge base')
      expect(r.code).toBe(1)
    }, 180_000)

    it('refuses a run that counts no rows', () => {
      const r = gate(CALL_COUNT, ['--ref=HEAD', `--base=${cleanBase}`, '--only=nothing/'])
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
      const base = commitBaselines(JSON.stringify(rows))
      writeFileSync(DUP_BASELINE, cleanDups)
      const r = gate(DUP, [`--base=${base}`, '--only=emitted/'])
      expect(r.out).toContain('it only moves down')
      expect(r.code).toBe(1)
    }, 180_000)

    it('exits non-zero when a row is renamed in the baseline, whatever its count', () => {
      const { 'emitted/less': less, ...rest } = JSON.parse(cleanDups) as Record<string, number>
      writeFileSync(DUP_BASELINE, JSON.stringify({ ...rest, 'emitted/less-renamed': (less ?? 0) + 1 }))
      const r = dup()
      expect(r.out).toContain('emitted/less: in the baseline at the merge base')
      expect(r.code).toBe(1)
    }, 180_000)

    it.each([['a string', 'x'], ['an object', {}], ['a fraction', 1.5]])('exits non-zero when a baseline value is %s', (_label, value) => {
      writeFileSync(DUP_BASELINE, JSON.stringify({ ...JSON.parse(cleanDups) as Record<string, number>, 'emitted/json': value }))
      const r = dup()
      expect(r.out).toContain('emitted/json: the baseline holds')
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

describe('the gates with no --base use the merge base with origin/main', () => {
  // Its own repository: CI's test jobs have no `origin/main`, and a hook's GIT_* must not
  // point these commands at the real one. HEAD and origin/main split after the first
  // commit, and the tip of origin/main would pass both checks, so only the merge base fails.
  const REPO = path.join(TMP, 'base-repo')
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  const inRepo = (args: string[]): string => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: REPO, encoding: 'utf8', env }).trim()
  const commit = (dups: Record<string, number>, calls: string[]): string => {
    writeFileSync(path.join(REPO, 'bench/dup-function-baseline.json'), JSON.stringify(dups))
    writeFileSync(path.join(REPO, 'bench/call-count-baseline.json'), JSON.stringify(Object.fromEntries(calls.map(row => [row, { calls: 1, branches: 1 }]))))
    inRepo(['add', '-f', 'bench/dup-function-baseline.json', 'bench/call-count-baseline.json'])
    inRepo(['commit', '-qm', 'baselines'])
    return inRepo(['rev-parse', 'HEAD'])
  }
  const run = (script: string): { code: number | null; out: string } => {
    const r = spawnSync(process.execPath, ['--import', 'tsx/esm', path.join(REPO, script)], { cwd: REPO, encoding: 'utf8', env, timeout: 60_000 })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }
  beforeAll(() => {
    mkdirSync(REPO)
    for (const rel of ['bench', 'scripts', 'package.json']) cpSync(path.join(ROOT, rel), path.join(REPO, rel), { recursive: true })
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(REPO, 'node_modules'), 'dir')
    inRepo(['init', '-q'])
    const first = commit({ a: 1 }, ['kept', 'cut'])
    commit({ a: 5 }, ['kept'])
    inRepo(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    inRepo(['reset', '-q', '--soft', first])
    commit({ a: 2 }, ['kept'])
  }, 60_000)

  it('dupfn:guard fails a rise from the merge base that the tip would allow', () => {
    const r = run(DUP)
    expect(r.out).toContain('a: the baseline rose from 1 to 2')
    expect(r.code).toBe(1)
  }, 60_000)

  it('callcount:guard fails a row gone since the merge base that the tip also lacks', () => {
    const r = run(CALL_COUNT)
    expect(r.out).toContain('cut: in the baseline at the merge base')
    expect(r.code).toBe(1)
  }, 60_000)

  it('both exit non-zero when origin/main cannot be found', () => {
    inRepo(['update-ref', '-d', 'refs/remotes/origin/main'])
    for (const script of [DUP, CALL_COUNT]) {
      const r = run(script)
      expect(r.out).toContain('could not find the commit to compare')
      expect(r.code).toBe(1)
    }
  }, 120_000)
})

describe('the count worker refuses a parse it should not count', () => {
  const WORKER_DIR = path.join(TMP, 'worker')
  mkdirSync(WORKER_DIR)
  const input = path.join(WORKER_DIR, 'input.css')
  const empty = path.join(WORKER_DIR, 'empty.css')
  writeFileSync(input, 'a { b: c }')
  writeFileSync(empty, '')
  const blank = path.join(WORKER_DIR, 'blank.css')
  writeFileSync(blank, ' \n\t\n')
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

  it.each([['an empty input', empty], ['a whitespace-only input', blank]])('refuses %s', (_label, file) => {
    const r = worker({
      kind: 'jess',
      module: moduleFile('empty-input', `export const grammar = { Stylesheet: {} }\nexport const run = () => ({ ok: true, span: { start: 0, end: 0 }, value: { type: 'Stylesheet' } })\n`),
      cases: [{ id: 'macro/less/ast/probe', dialect: 'less', input: file, cst: false }],
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

  it('counts Less positions on `!important`', async () => {
    const important = path.join(WORKER_DIR, 'important.css')
    writeFileSync(important, '.a { b: c !important; }')
    await withBuiltSnapshot(async snap => {
      await snap.shipped('less', 'ast/positions')
      const r = worker({
        kind: 'jess',
        module: await snap.runnable('less', 'ast/positions'),
        cases: [{ id: 'macro/less/ast/positions/probe', dialect: 'less', input: important, cst: false }],
      })
      expect(r.out).toContain('"macro/less/ast/positions/probe"')
      expect(r.code).toBe(0)
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
    // Read at run time, so the import graph below cannot see them.
    expect(filter.test('fixtures/css/decls.css')).toBe(true)
    expect(filter.test('bench/parseman-baseline.json')).toBe(true)
    const { metafile } = await build({ entryPoints: [path.join(ROOT, 'bench/perf-guard.ts')], absWorkingDir: ROOT, bundle: true, write: false, metafile: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent' })
    const inputs = Object.keys(metafile.inputs)
    expect(inputs.length).toBeGreaterThan(50)
    expect(inputs.filter(f => !filter.test(f))).toEqual([])
  }, 60_000)
})
