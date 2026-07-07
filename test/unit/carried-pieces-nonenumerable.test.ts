/**
 * The macro attaches a compiled grammar's carried pieces under
 * `Symbol.for('parseman.composedPieces')` as a NON-ENUMERABLE property — matching
 * the runtime attach in `linker.ts` (`{ value, enumerable: false }`).
 *
 * This matters: the carried IR can be hundreds of KB. An enumerable symbol prop
 * (what a plain `Object.assign(grammar, { [sym]: … })` produces) would be copied
 * by `Object.assign(target, grammar)` and `{ ...grammar }`, silently dragging that
 * blob into unrelated objects. The emitter must use `Object.defineProperty` so the
 * pieces travel WITH the grammar but stay invisible to enumeration/copy.
 */
import { describe, it, expect } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'

const SRC = `import { rules, regex, choice } from 'parseman' with { type: 'macro' }
export const base = rules(g => ({ Value: choice(g.Num, g.Word), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/) }))`

describe('carried composedPieces are non-enumerable', () => {
  it('emits Object.defineProperty with enumerable:false, not an enumerable Object.assign', () => {
    const out = transformMacro(SRC, 'base.ts', new Set(['parseman']))
    expect(out).not.toBeNull()
    const code = out!.code

    // The pieces are still carried (re-composable downstream)…
    expect(code).toMatch(/Symbol\.for\('parseman\.composedPieces'\)/)
    // …via a non-enumerable defineProperty, mirroring the runtime attach.
    expect(code).toMatch(/Object\.defineProperty\([\s\S]*parseman\.composedPieces[\s\S]*enumerable:\s*false/)
    // The old enumerable form (Object.assign of the symbol) must not be emitted —
    // it would leak the carried IR through Object.assign / object spread.
    expect(code).not.toMatch(/Object\.assign\([^;]*parseman\.composedPieces/)
  })
})
