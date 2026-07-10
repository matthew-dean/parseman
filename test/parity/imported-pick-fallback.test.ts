import { describe, it, expect } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'

// A `pick()` of an IMPORTED grammar can't have that grammar's ambient trivia resolved at
// build time (the trivia lives in the separately-compiled module). Inlining it would
// re-lower the picked rules WITHOUT that trivia and diverge from the runtime `pick()`,
// which reads `_meta.grammarTrivia`. So the macro must NOT inline an imported pick — it
// leaves the runtime `compose()`/`pick()` in place, which the interpreter also runs.
//
// (A `pick()` of a LOCAL grammar still inlines, with its own trivia frozen — covered by
// compose-parity.test.ts. This test guards only the imported-pick fallback.)
describe('macro: pick() of an imported grammar falls back to runtime (interpreter ≡ macro)', () => {
  it('does not inline; leaves the runtime compose()/pick() so trivia matches the interpreter', () => {
    const src = `import { base } from './base' with { type: 'macro' }
import { rules, compose, pick, trivia, oneOrMore, regex, sequence, literal } from 'parseman' with { type: 'macro' }
const rw = trivia(oneOrMore(regex(/[ \\t\\n]+/)))
export const g = compose([
  pick(base, ['Pair']),
  rules({ trivia: rw }, (r) => ({ Doc: sequence(literal('x'), r.Pair) })),
])`
    const out = transformMacro(src, 'consumer.ts', new Set(['parseman']))
    expect(out, 'transform should still run').not.toBeNull()
    const code = out!.code
    // Proves the fallback is the IMPORTED-PICK guard firing (not an unrelated
    // unresolvable-import bail): the guard runs before any module resolution and emits
    // this specific warning.
    expect(
      out!.warnings.some(w => w.includes('pick() of an imported grammar is not build-inlined')),
      'the imported-pick guard must fire',
    ).toBe(true)
    // The imported pick blocks build-fusion, so the runtime compose()/pick() survive —
    // they read the imported grammar's trivia at runtime, matching the interpreter.
    expect(/\bcompose\s*\(/.test(code), 'compose must stay runtime (imported pick not inlined)').toBe(true)
    expect(/\bpick\s*\(/.test(code), 'pick must stay runtime').toBe(true)
  })
})
