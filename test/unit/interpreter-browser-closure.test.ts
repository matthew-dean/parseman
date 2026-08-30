/** The public-root interpreter browser bundle must stay light and browser-native. */
import { describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import type { Metafile } from 'esbuild'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const ENTRY = resolve(ROOT, 'scripts/chevrotain-bench-interpreter-entry.ts')
const BASELINE_RAW_BYTES = 57_957
const RATCHET_SLACK = 1.001
const SHARED_RUNTIME_COMPILER_BYTE_CEILING = 1_300
const SHARED_RUNTIME_COMPILER_MODULES = new Set([
  'src/compiler/build-arity.ts',
  'src/compiler/direct-projection.ts',
  'src/compiler/token-alphabet.ts',
  'src/compiler/token-capability.ts',
  'src/compiler/value-usage.ts',
])

function emittedBytes(metafile: Metafile, input: string): number {
  return Object.values(metafile.outputs)
    .reduce((total, output) => total + (output.inputs[input]?.bytesInOutput ?? 0), 0)
}

describe('interpreter browser closure', () => {
  it('stays browser-native and does not grow materially', async () => {
    const result = await build({
      entryPoints: [ENTRY],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      write: false,
      metafile: true,
      logLevel: 'silent',
    })
    const inputs = Object.keys(result.metafile.inputs)
    const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])

    expect(inputs.filter(input => builtins.has(input))).toEqual([])
    expect(inputs.filter(input => /(?:^|\/)(?:oxc-parser|oxc-resolver|magic-string|unplugin)(?:\/|$)/.test(input)))
      .toEqual([])
    expect(inputs.filter(input => /src\/(?:cli|plugin|language-service|oracle)\//.test(input))).toEqual([])
    expect(inputs.filter(input => {
      const bytes = emittedBytes(result.metafile, input)
      if (bytes === 0) return false
      if (/src\/table\//.test(input)) return true
      return /src\/compiler\//.test(input) && !SHARED_RUNTIME_COMPILER_MODULES.has(input)
    })).toEqual([])
    expect(inputs
      .filter(input => SHARED_RUNTIME_COMPILER_MODULES.has(input))
      .reduce((total, input) => total + emittedBytes(result.metafile, input), 0))
      .toBeLessThanOrEqual(SHARED_RUNTIME_COMPILER_BYTE_CEILING)
    expect(result.outputFiles[0]!.contents.length).toBeLessThanOrEqual(
      Math.floor(BASELINE_RAW_BYTES * RATCHET_SLACK),
    )
  })
})
