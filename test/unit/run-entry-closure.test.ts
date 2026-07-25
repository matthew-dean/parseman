/**
 * `parseman/run` exists to be SMALL. That is its entire reason to exist, and it is
 * a property nothing else enforces: adding one import to `functional/run.ts` — a
 * type-only import that isn't type-only, a helper reached for convenience — would
 * quietly pull the combinator set or the compiler back in, and every consumer
 * shipping a compiled parser would carry it without anything failing.
 *
 * So the closure is asserted directly, by module list rather than by byte size.
 * A size threshold drifts and invites ratcheting; the module list says exactly
 * what the driver is allowed to depend on, and a new entry in the diff is a
 * decision someone has to make on purpose.
 */
import { describe, it, expect } from 'vitest'
import { build } from 'esbuild'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../src/run/index.ts'
import { compile, literal, sequence, regex, parser, trivia } from '../../src/index.ts'
import type { ParseContext } from '../../src/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Every source module the entry pulls in, repo-relative and sorted. */
async function closureOf(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [resolve(ROOT, entry)],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  })
  return Object.keys(result.metafile.inputs)
    .map(f => relative(ROOT, resolve(ROOT, f)))
    .sort()
}

describe('parseman/run — the minimal execution entry', () => {
  it('pulls in exactly the driver, and nothing that builds grammars', async () => {
    expect(await closureOf('src/run/index.ts')).toEqual([
      'src/cst/capture-buffer.ts',
      // A DELIBERATE addition, which is what this test exists to force. The driver has
      // to refuse an artifact/host mismatch once per parse — `run()` was the one entry
      // that did not, so an 'ast' artifact driven with a positioned-CST host silently
      // returned AST objects that the CST child filter then dropped. Enforcing that
      // needs the contract, and a second copy of it in the driver is exactly how the
      // two engines drift. `src/cst/host-mode.ts` is therefore import-free by design:
      // it adds one leaf module and pulls in nothing, so the closure grows by one and
      // the entry still builds no grammars.
      'src/cst/host-mode.ts',
      'src/functional/run.ts',
      'src/recovery/scan.ts',
      'src/run/index.ts',
    ])
  })

  it('is a small fraction of the main entry', async () => {
    const main = await closureOf('src/index.ts')
    const driver = await closureOf('src/run/index.ts')
    // Not a byte budget — a structural statement: the driver must stay an order of
    // magnitude simpler than the library, or it has stopped being a driver.
    expect(driver.length * 10).toBeLessThan(main.length)
    // And it must not reach the compiler or the combinators at all.
    expect(driver.some(f => f.startsWith('src/compiler/'))).toBe(false)
    expect(driver.some(f => f.startsWith('src/combinators/'))).toBe(false)
  })

  it('actually runs a compiled grammar', () => {
    // The point of the entry: execute macro/`compile()` output without importing
    // the library that produced it.
    const ws = trivia(regex(/[ \t]+/))
    const g = parser({ trivia: ws }, sequence(literal('a'), literal('b')))
    const compiled = compile(g)

    // `Runnable` is `(input, pos, ctx)`; `parseWithContext` is `(input, ctx, pos)` —
    // the macro emits the former, so adapt the compile() surface to match it.
    const entry = (input: string, pos: number, ctx: ParseContext) =>
      compiled.parseWithContext(input, ctx, pos)

    const result = run(entry, 'a b', {})
    expect(result.ok).toBe(true)
    expect(result.span.end).toBe(3)
    expect(result.unconsumedFrom).toBe(null)
  })
})
