/** The public-root interpreter browser bundle must stay light and browser-native. */
import { describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const ENTRY = resolve(ROOT, 'scripts/chevrotain-bench-interpreter-entry.ts')
const BASELINE_RAW_BYTES = 57_680
const RATCHET_SLACK = 1.001

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
    expect(result.outputFiles[0]!.contents.length).toBeLessThanOrEqual(
      Math.floor(BASELINE_RAW_BYTES * RATCHET_SLACK),
    )
  })
})
