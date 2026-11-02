/**
 * Shared legs for differential tests over the table engines: every reader of a
 * `TableProgram`, and a seeded source of generated inputs.
 */
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource, EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import type { Runnable } from '../../src/functional/run.ts'

/** The reference driver, the closure engine and the precompiled emitted engine. */
export function readers(prog: TableProgram): ReadonlyArray<readonly [string, Record<string, Runnable>]> {
  const resolved = resolveTable(prog)
  const precompiled: PrecompiledAssembly[] = defaultAssemblyCfgs(prog).map(cfg => {
    const out = emitAssemblySource(resolved, prog, cfg, [])
    return {
      key: cfgKey(cfg),
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      factory: new Function(...EMITTED_PARAMS, out.source) as PrecompiledAssembly['factory'],
      plan: out.plan, reached: [...out.reached],
    }
  })
  return [
    ['reference', execRules(prog)],
    ['closure', tableRules({ ...prog, asm: [] })],
    ['emitted', tableRules({ ...prog, asm: precompiled })],
  ]
}

/**
 * `rnd(n)`: a uniform integer in `[0, n)` from a seeded mulberry32.
 *
 * Every step is exact 32-bit arithmetic. The LCG these tests used before,
 * `(seed * 1103515245 + 12345) & 0x7fffffff`, multiplies past 2^53 and loses the
 * low bits, so `rnd(n)` for an even `n` returned 0 after its first call and 600
 * "generated" inputs held 26 distinct ones.
 */
export function seeded(seed: number): (n: number) => number {
  let a = seed >>> 0
  return (n: number): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) % n
  }
}
