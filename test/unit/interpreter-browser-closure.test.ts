/** The public-root interpreter browser bundle must stay light and browser-native. */
import { describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import type { Metafile } from 'esbuild'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const ENTRY = resolve(ROOT, 'scripts/chevrotain-bench-interpreter-entry.ts')
// Bumped +76B for scanTo paired-sentinel recovery. The public interpreter owns
// the cursor checkpoint/parity loop; the compiler and table plumbing tree-shake
// out of this browser entry. Measured from 58,198B at parent 8ff324c to 58,274B.
// Bumped +105B for the labeled-trivia spec `trivia()` now carries on its meta
// (58,288B at parent 5740595 to 58,393B): every labeled trivia scan reads it,
// and re-deriving it cost 1.8% of a jess Less parse.
// Bumped +271B for `rules()` giving a grammar its own copy of a rule value another
// grammar already holds (58,393B at parent 4ddd49b to 58,664B), so one grammar's
// trivia/scanSkip no longer leaks into another that shares a terminal.
// Moved to 58,734B: the labeled-trivia spec carrying its own scanners dropped the
// two four-slot memos (58,485B at a246ecf, -179B), and `field(…, { leadingTrivia,
// trailingTrivia })` added the option and the boundary hand-off in `sequence()`
// and `sepBy()` (+249B).
// Bumped +332B for `lines()` and `columns()` (58,742B at parent 247505b to 59,074B):
// the first-set, nullability, expected-set and routed walks every combinator shares
// name both tags; `lines.ts` itself tree-shakes out of a grammar that never calls it.
// Bumped +110B to 59,184B: lookahead, a rejected `choice()` arm and `attempt()`
// restore `columns()`'s tab-split mark, a nullable `lines()` opening widens its
// first-set, and the context factory initializes `lineView` and `_columnsSplit`.
// Bumped +563B to 59,747B: the trivia scanner lowers a literal shared by every
// alternative (`\/(?:\*…\*\/|\/…)`, jess's one comment arm), which gave jess's
// document trivia an unlabelled scanner.
// Bumped +46B to 59,793B: a labelled trivia spec carries the slots the table
// engines' root-selection fast path primes (`table/trivia-gap.ts`).
// Bumped +645B to 60,438B: the regex first-set analyzer and the class and literal
// readers decode `\u{…}`, `\cX`, `\p{…}`, `\k<…>` and legacy octal escapes instead
// of reading them as letters, and `/i` widens a set that reaches 128.
const BASELINE_RAW_BYTES = 60_438
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
