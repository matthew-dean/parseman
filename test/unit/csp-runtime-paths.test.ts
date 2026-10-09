/**
 * NO STRING-TO-CODE OUTSIDE `compile()` (docs/design/runtime-and-size-contract.md,
 * rules 1–3), on every runtime path, decided three ways:
 *
 *   1. in-process, with `globalThis.Function` and `globalThis.eval` spied: every
 *      path but `compile()` makes ZERO calls — including importing and parsing with
 *      macro-built grammar packages, one of which composes the other;
 *   2. in a child process under `--disallow-code-generation-from-strings` (a CSP
 *      without `'unsafe-eval'`): every path, `compile()` included, parses exactly
 *      what it parses unrestricted. `compile()` gets there by falling back to the
 *      closure engine when specialisation throws `EvalError`. The child also catches
 *      what a spy cannot see (`Function.prototype.constructor`, `vm`, `import()` of a
 *      `data:` URL): V8 refuses every one of them;
 *   3. statically: the runtime modules contain one string-to-code site, `compile()`'s
 *      specialisation, and never import the build-time IR evaluator.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildCompiledPackages, compilePaths, loadCompiledPaths, noCodegenPaths } from '../fixtures/csp-runtime-paths.ts'

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/csp-runtime-paths.ts')
const SRC = path.resolve(import.meta.dirname, '../../src')

/** Run `body` with `Function` and `eval` proxied; return every call they received. */
async function codegenCalls(body: () => unknown): Promise<string[]> {
  const realFunction = globalThis.Function
  const realEval = globalThis.eval
  const seen: string[] = []
  globalThis.Function = new Proxy(realFunction, {
    construct(target, args, newTarget) { seen.push('Function'); return Reflect.construct(target, args, newTarget) as object },
    apply(target, thisArg, args) { seen.push('Function'); return Reflect.apply(target, thisArg, args) as unknown },
  })
  globalThis.eval = (src: string) => { seen.push('eval'); return realEval(src) }
  try { await body() } finally {
    globalThis.Function = realFunction
    globalThis.eval = realEval
  }
  return seen
}

describe('no runtime string-to-code outside compile()', () => {
  const unrestricted: Record<string, string> = {}
  let dir = ''

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-csp-packages-'))
    await buildCompiledPackages(dir)
  })
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  for (const [name, path] of Object.entries(noCodegenPaths)) {
    it(`${name}: constructs no code`, async () => {
      let out = ''
      expect(await codegenCalls(() => { out = path() })).toEqual([])
      expect(out).toContain('"ok":true,"full":true')
      unrestricted[name] = out
    })
  }

  it('compiled grammar packages: loading and parsing construct no code', async () => {
    let paths: Record<string, () => string> = {}
    // The import is inside the spy: evaluating a built module is part of loading it.
    expect(await codegenCalls(async () => { paths = await loadCompiledPaths(dir) }), 'loading').toEqual([])
    for (const [name, path] of Object.entries(paths)) {
      let out = ''
      expect(await codegenCalls(() => { out = path() }), name).toEqual([])
      unrestricted[name] = out
    }
    expect(unrestricted['compiled base package']).toContain('"ok":true,"full":true')
    expect(unrestricted['compiled downstream package composing the base']).toContain('"ok":true,"full":true')
    expect(unrestricted['compiled package composing an esbuild-bundled compiled package']).toContain('"ok":true,"full":true')
    expect(unrestricted['runtime compose() over a compiled base']).toMatch(/^refused: compose: /)
  })

  it('compile() is the one path that specialises (the spy sees it)', async () => {
    for (const [name, path] of Object.entries(compilePaths)) {
      let out = ''
      expect((await codegenCalls(() => { out = path() })).length, name).toBeGreaterThan(0)
      unrestricted[name] = out
    }
  })

  it('under --disallow-code-generation-from-strings every path parses identically', () => {
    const child = spawnSync(process.execPath, [
      '--disallow-code-generation-from-strings', '--import', 'tsx/esm', FIXTURE, '--child', dir,
    ], { encoding: 'utf8', timeout: 120_000 })
    expect(child.status, child.stderr).toBe(0)
    const csp = JSON.parse(child.stdout) as Record<string, string>
    expect(Object.keys(csp).sort()).toEqual(Object.keys(unrestricted).sort())
    for (const name of Object.keys(unrestricted)) {
      expect(csp[name], `${name} under CSP`).toBe(unrestricted[name])
    }
  }, 120_000)
})

describe('runtime modules: one string-to-code site, and it is compile()', () => {
  // Build-time only: the macro plugin (runs in the bundler) and the CLI (a build tool).
  const BUILD_TIME = [path.join(SRC, 'plugin'), path.join(SRC, 'cli')]
  const files = (fs.readdirSync(SRC, { recursive: true }) as string[])
    .filter(f => f.endsWith('.ts'))
    .map(f => path.join(SRC, f))
    .filter(f => !BUILD_TIME.some(d => f.startsWith(d + path.sep)))
  /** Source with comments blanked, so a doc comment that names `new Function` is not a site. */
  const code = (f: string): string => fs.readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  const CODEGEN = /\bnew\s+Function\b|\beval\b\s*\)?\s*\(|(^|[^\w.$])Function\s*\(|\bimport\s*\(\s*[`'"]data:/

  it('finds the sites it is looking for (the scan is not vacuous)', () => {
    expect(CODEGEN.test('const f = new Function("a", src)')).toBe(true)
    expect(CODEGEN.test('fn = (0, eval)(`(${src})`)')).toBe(true)
    expect(CODEGEN.test('const g = Function("return 1")')).toBe(true)
    expect(files.length).toBeGreaterThan(50)
  })

  it('only src/table/assemble.ts constructs code, and the macro IR evaluator is unreachable', () => {
    const sites: string[] = []
    const reachesPlugin: string[] = []
    for (const f of files) {
      const text = code(f)
      for (const line of text.split('\n')) {
        if (CODEGEN.test(line)) sites.push(`${path.relative(SRC, f)}:${line.trim()}`)
      }
      if (/from\s+['"][./]*(?:\.\.\/)*plugin\//.test(text)) reachesPlugin.push(path.relative(SRC, f))
    }
    // `compile()`'s live specialisation, which falls back to closures on `EvalError`.
    expect(sites).toEqual([expect.stringMatching(/^table\/assemble\.ts:factory = new Function\(\.\.\.EMITTED_PARAMS, em\.source\)/)])
    expect(reachesPlugin).toEqual([])
  })
})
