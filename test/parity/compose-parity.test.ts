import { describe, it, expect } from 'vitest'
import * as P from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { cases } from './helpers/compose-cases.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

/**
 * The guardrail: for each grammar, fuse it BOTH ways —
 *   - RUNTIME `compose()` (interpreter/`new Function` path), and
 *   - the MACRO (`transformMacro`, then EXECUTE the emitted module)
 * — and assert IDENTICAL parse results (ok + end position) on a battery of inputs.
 *
 * Both are produced from ONE source string, so they can't silently drift. `evalModule`
 * strips the import line and injects the real library as parameters: for the runtime
 * path this runs the untouched `compose()` calls; for the macro path the compose is
 * already inlined to a self-contained fused IIFE (and any interpreter fallback still has
 * the library available). This proves interpreter ≡ macro at every composition depth.
 */
function evalModule(code: string, ...want: string[]): Record<string, any> {
  return evalMacroModule(code, `{ ${want.join(', ')} }`, { ...P })
}
const end = (r: any): string | number => (r.ok ? r.span.end : 'FAIL')

describe('compose parity — interpreter ≡ macro at every depth', () => {
  for (const c of cases) {
    it(c.name, () => {
      const out = transformMacro(c.src, 'parity.ts', new Set(['parseman']))
      expect(out, 'macro must transform the module').not.toBeNull()
      const macroCode = out!.code

      // The macro must FULLY compile — no interpreter fallback: import stripped, and no
      // residual runtime `compose(` calls. (Fallback would still be correct but would
      // make "macro" secretly the runtime path, defeating the parity guarantee.)
      expect(macroCode.includes("from 'parseman'"), `${c.name}: import must be stripped`).toBe(false)
      expect(/\bcompose\s*\(/.test(macroCode), `${c.name}: compose must inline`).toBe(false)

      const runtimeG = evalModule(c.src, 'g').g
      const macroG = evalModule(macroCode, 'g').g

      for (const input of c.inputs) {
        const r = end(P.run(runtimeG[c.entry], input))
        const m = end(P.run(macroG[c.entry], input))
        expect(m, `${c.name}: macro vs runtime on ${JSON.stringify(input)}`).toEqual(r)
        // Guard against BOTH paths being wrong the same way, where we have a known value.
        if (c.expect && input in c.expect) {
          expect(r, `${c.name}: runtime value on ${JSON.stringify(input)}`).toEqual(c.expect[input])
        }
      }
    })
  }
})
