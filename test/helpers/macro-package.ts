/**
 * COMPOSE OVER A BUILT BASE, THE WAY A PACKAGE DOES: at build time.
 *
 * A downstream module that `compose()`s an imported, macro-built grammar is
 * lowered by the macro plugin, which re-lowers the base's carried IR in the
 * bundler. Runtime `compose()` never does that — it links live `rules()` maps and
 * evaluates no carried source (docs/design/runtime-and-size-contract.md, rule 1).
 *
 * `macroComposed` writes the base into a throwaway package, macro-compiles a
 * downstream module that imports it from `./base.js`, and returns the downstream
 * module's exports.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect } from 'vitest'
import * as parseman from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroExports } from './eval-macro-module.ts'

export function macroComposed(baseSource: string, downstreamSource: string): Record<string, unknown> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-macro-package-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    const base = transformMacro(baseSource, path.join(dir, 'base.ts'), new Set(['parseman']))
    if (!base) throw new Error('transformMacro returned null for the base')
    fs.writeFileSync(path.join(dir, 'base.js'), base.code)
    const out = transformMacro(downstreamSource, path.join(dir, 'down.ts'), new Set(['parseman']))
    if (!out) throw new Error('transformMacro returned null for the downstream module')
    expect(out.warnings).toEqual([])
    expect(out.code, 'the downstream compose() must lower at build time').not.toMatch(/\bcompose\s*\(\s*\[/)
    // The emitted downstream module may still name its imports; bind them to the
    // base module's own evaluated exports, as a bundler would.
    return evalMacroExports(out.code, { ...parseman, ...evalMacroExports(base.code, { ...parseman }) })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
