/**
 * NO STRING-TO-CODE OUTSIDE `compile()` (docs/design/runtime-and-size-contract.md,
 * rules 1–3), on every runtime path, decided two ways:
 *
 *   1. in-process, with `globalThis.Function` and `globalThis.eval` spied: every
 *      path but `compile()` makes ZERO calls;
 *   2. in a child process under `--disallow-code-generation-from-strings` (a CSP
 *      without `'unsafe-eval'`): every path, `compile()` included, parses exactly
 *      what it parses unrestricted. `compile()` gets there by falling back to the
 *      closure engine when specialisation throws `EvalError`.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compilePaths, noCodegenPaths } from '../fixtures/csp-runtime-paths.ts'

const FIXTURE = resolve(import.meta.dirname, '../fixtures/csp-runtime-paths.ts')

/** Run `body` with `Function` and `eval` proxied; return every call they received. */
function codegenCalls(body: () => void): string[] {
  const realFunction = globalThis.Function
  const realEval = globalThis.eval
  const seen: string[] = []
  globalThis.Function = new Proxy(realFunction, {
    construct(target, args, newTarget) { seen.push('Function'); return Reflect.construct(target, args, newTarget) as object },
    apply(target, thisArg, args) { seen.push('Function'); return Reflect.apply(target, thisArg, args) as unknown },
  })
  globalThis.eval = (src: string) => { seen.push('eval'); return realEval(src) }
  try { body() } finally {
    globalThis.Function = realFunction
    globalThis.eval = realEval
  }
  return seen
}

describe('no runtime string-to-code outside compile()', () => {
  const unrestricted: Record<string, string> = {}

  for (const [name, path] of Object.entries(noCodegenPaths)) {
    it(`${name}: constructs no code`, () => {
      let out = ''
      expect(codegenCalls(() => { out = path() })).toEqual([])
      expect(out).not.toContain('"ok":false')
      unrestricted[name] = out
    })
  }

  it('compile() is the one path that specialises (the spy sees it)', () => {
    for (const [name, path] of Object.entries(compilePaths)) {
      let out = ''
      expect(codegenCalls(() => { out = path() }).length, name).toBeGreaterThan(0)
      unrestricted[name] = out
    }
  })

  it('under --disallow-code-generation-from-strings every path parses identically', () => {
    const child = spawnSync(process.execPath, [
      '--disallow-code-generation-from-strings', '--import', 'tsx/esm', FIXTURE, '--child',
    ], { encoding: 'utf8', timeout: 120_000 })
    expect(child.status, child.stderr).toBe(0)
    const csp = JSON.parse(child.stdout) as Record<string, string>
    expect(Object.keys(csp).sort()).toEqual(Object.keys(unrestricted).sort())
    for (const name of Object.keys(unrestricted)) {
      expect(csp[name], `${name} under CSP`).toBe(unrestricted[name])
    }
  }, 120_000)
})
