/**
 * The macro attaches a compiled grammar's carried pieces under
 * `Symbol.for('parseman.composedPieces')` through the grammar's metadata
 * prototype. It remains readable but is not an own property.
 *
 * This matters: the carried IR can be hundreds of KB. An enumerable symbol prop
 * (what a plain `Object.assign(grammar, { [sym]: … })` produces) would be copied
 * by `Object.assign(target, grammar)` and `{ ...grammar }`, silently dragging that
 * blob into unrelated objects. The metadata prototype keeps the pieces travelling
 * WITH the grammar while ordinary key/copy operations see only rule entries.
 */
import { describe, it, expect } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

const SRC = `import { rules, regex, choice } from 'parseman' with { type: 'macro' }
export const base = rules(g => ({ Value: choice(g.Num, g.Word), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/) }))`

describe('carried composedPieces are non-enumerable', () => {
  it('carries pieces through a metadata prototype without descriptors or spread leakage', () => {
    const out = transformMacro(SRC, 'base.ts', new Set(['parseman']))
    expect(out).not.toBeNull()
    const code = out!.code

    // The pieces are still carried (re-composable downstream)…
    expect(code).toMatch(/Symbol\.for\('parseman\.composedPieces'\)/)
    expect(code).not.toContain('Object.defineProperty')
    expect(code).not.toMatch(/Object\.assign\([^;]*parseman\.composedPieces/)

    const grammar = evalMacroModule<Record<string | symbol, unknown>>(code, 'base')
    const pieces = Symbol.for('parseman.composedPieces')
    const reflection = Symbol.for('parseman.grammarReflection')
    expect(Array.isArray(grammar[pieces])).toBe(true)
    expect(grammar[reflection]).toEqual({ nodes: [] })
    expect(Object.keys(grammar)).toEqual(['Value', 'Num', 'Word'])
    expect(Object.prototype.hasOwnProperty.call(grammar, pieces)).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(grammar, reflection)).toBe(false)
    expect(({ ...grammar } as Record<symbol, unknown>)[pieces]).toBeUndefined()
    expect(({ ...grammar } as Record<symbol, unknown>)[reflection]).toBeUndefined()
    expect((Object.assign({}, grammar) as Record<symbol, unknown>)[pieces]).toBeUndefined()

    const covered = transformMacro(SRC, 'base.ts', new Set(['parseman']), false, false, true)!
    expect(covered.code).not.toContain('Object.defineProperty')
    const coveredGrammar = evalMacroModule<Record<string | symbol, unknown>>(covered.code, 'base')
    const coverage = Symbol.for('parseman.grammarCoverageDefinitions')
    expect(coveredGrammar[coverage]).toEqual([
      { id: 'choice:Value/arm:0', kind: 'choice-arm' },
      { id: 'choice:Value/arm:1', kind: 'choice-arm' },
      { id: 'rule:Num', kind: 'rule' },
      { id: 'rule:Value', kind: 'rule' },
      { id: 'rule:Word', kind: 'rule' },
    ])
    expect(Object.prototype.hasOwnProperty.call(coveredGrammar, coverage)).toBe(false)
    expect(({ ...coveredGrammar } as Record<symbol, unknown>)[coverage]).toBeUndefined()
  })
})
