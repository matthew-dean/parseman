import { describe, it, expect } from 'vitest'
import * as P from '../../src/index.ts'
// `pick` is internal (not in the public API — see test/unit/pick-not-public.test.ts), so
// import it directly for the harness that still exercises pick()'s composition behavior.
import { pick } from '../../src/compiler/linker.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { cases } from './helpers/compose-cases.ts'

/**
 * The guardrail: for each grammar, fuse it BOTH ways —
 *   - RUNTIME `compose()` (interpreter/`new Function` path), and
 *   - the MACRO (`transformMacro`, then EXECUTE the emitted module)
 * — and assert IDENTICAL parse results (ok + end position) on a battery of inputs.
 *
 * Both are produced from ONE source string, so they can't silently drift. `evalModule`
 * strips the import line and injects the real library as parameters: for the runtime
 * path this runs the untouched `compose()/pick()` calls; for the macro path the compose
 * is already inlined to a self-contained fused IIFE (and any interpreter fallback still
 * has the library available). This proves interpreter ≡ macro at every composition depth,
 * including through `pick()`.
 */
function evalModule(code: string, ...want: string[]): Record<string, any> {
  const body = code.replace(/^\s*import[^\n]*\n/gm, '').replace(/\bexport\s+/g, '')
  const lib: Record<string, unknown> = { ...P, pick }  // pick is internal; inject it for the harness
  const names = Object.keys(lib)
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${body}\nreturn { ${want.join(', ')} }`)(...names.map(n => lib[n]))
}
const end = (r: any): string | number => (r.ok ? r.span.end : 'FAIL')

describe('compose/pick parity — interpreter ≡ macro at every depth', () => {
  for (const c of cases) {
    it(c.name, () => {
      const out = transformMacro(c.src, 'parity.ts', new Set(['parseman']))
      expect(out, 'macro must transform the module').not.toBeNull()
      const macroCode = out!.code

      // The macro must FULLY compile — no interpreter fallback: import stripped, and no
      // residual runtime `compose(` / `pick(` calls. (Fallback would still be correct but
      // would make "macro" secretly the runtime path, defeating the parity guarantee.)
      expect(macroCode.includes("from 'parseman'"), `${c.name}: import must be stripped`).toBe(false)
      expect(/\bcompose\s*\(/.test(macroCode), `${c.name}: compose must inline`).toBe(false)
      if (c.pick) expect(/\bpick\s*\(/.test(macroCode), `${c.name}: pick must inline`).toBe(false)

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
