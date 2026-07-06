/**
 * The un-lowered-regex diagnostic is OPT-IN (`warnUnloweredRegex`). Most regexes
 * legitimately stay on `RegExp.exec` (a JIT-fast compiled path), so the plugin
 * must NOT nag by default — only when explicitly auditing lowering coverage.
 */
import { describe, it, expect } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'

// A grammar that macro-compiles (so emitRegex runs), whose `W` rule is
// `x{2,5}` — compiled but NOT lowered to a charCodeAt scan (bounded quantifier).
const SRC = `import { rules, regex, parser, trivia, many } from 'parseman' with { type: 'macro' }
const ws = trivia(regex(/[ ]+/))
export const g = rules(gr => ({ Doc: parser({ trivia: ws }, many(gr.W)), W: regex(/x{2,5}/) }))`

const loweringWarnings = (out: { warnings: string[] } | null) =>
  (out?.warnings ?? []).filter(w => /did not lower/.test(w))

describe('warnUnloweredRegex (opt-in)', () => {
  it('is SILENT by default', () => {
    expect(loweringWarnings(transformMacro(SRC, '/g.ts'))).toEqual([])
  })

  it('warns only when explicitly enabled', () => {
    const out = transformMacro(SRC, '/g.ts', undefined, true)
    expect(loweringWarnings(out).length).toBeGreaterThan(0)
    expect(loweringWarnings(out)[0]).toContain('/x{2,5}/')
  })
})
