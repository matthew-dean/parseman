/**
 * A dispatch arm must lower under the macro exactly as the interpreter builds it.
 *
 * Two divergences lived in the arm path:
 *   - `makeWhen(opts)` is `(key, parser) => when(key, parser, opts)`, so it accepts every
 *     key `when` accepts. The macro's factory branch accepted only string keys, so an
 *     arm keyed by a startsWith/endsWith/matches MATCHER was a hard macro failure
 *     ("rules(...) factory isn't statically evaluable") for a grammar the interpreter
 *     builds — while the identical un-aliased `when(matcher, …)` compiled.
 *   - `routed(fallback)` was entered in the macro's generic table as a ZERO-ARG
 *     constructor, so the fallback was dropped SILENTLY: the compiled production lost
 *     its out-of-dispatch behaviour while the interpreted one kept it.
 */
import { describe, it, expect } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'
import { evaluateExpr } from '../../src/plugin/evaluator.ts'
import { parseSync } from 'oxc-parser'
import { routed, literal } from '../../src/index.ts'

const IMPORT =
  `import { rules, dispatch, when, otherwise, routed, makeWhen, literal, regex, startsWith, endsWith, matches } from 'parseman' with { type: 'macro' }`

/** The macro's warnings for a source, or [] when it lowered cleanly. */
function warnings(body: string): string[] {
  const result = transformMacro(`${IMPORT}\n${body}`.trim(), 'test.ts', new Set(['parseman']))
  expect(result, 'macro did not run').not.toBeNull()
  return result!.warnings ?? []
}

/** Macro-evaluate a single expression to its combinator def. */
function macroDef(src: string): unknown {
  const code = `const x = ${src}`
  const ast = parseSync('t.ts', code)
  const init = (ast.program.body[0] as unknown as { declarations: { init: unknown }[] }).declarations[0]!.init
  const out = evaluateExpr(init as never, new Map() as never, code)
  return (out as { _def?: unknown } | null)?._def
}

describe('macro dispatch arms match the interpreter', () => {
  for (const [label, matcher] of [
    ['startsWith', `startsWith('url(')`],
    ['endsWith', `endsWith('(')`],
    ['matches', `matches(/^url\\(/)`],
  ] as const) {
    it(`a makeWhen() alias accepts a ${label} matcher key, as when() does`, () => {
      const grammar = (arm: string) => `
export const g = rules((g) => ({
  Value: dispatch(regex(/[a-z(]+/), ${arm}, otherwise(g.Word)),
  Url: literal('url('),
  Word: regex(/[a-z]+/),
}))`
      // Control: the un-aliased constructor lowers.
      expect(warnings(grammar(`when(${matcher}, routed(g.Url))`)), 'control: bare when()').toEqual([])
      // The alias must lower identically, not fall back to the interpreter.
      const aliased = warnings(
        `const ciCase = makeWhen({ caseInsensitive: true })\n${grammar(`ciCase(${matcher}, routed(g.Url))`)}`,
      )
      expect(aliased, 'makeWhen() alias with a matcher key').toEqual([])
    })
  }

  it('a makeWhen() alias still lowers string and string[] keys', () => {
    const w = warnings(`
const ciCase = makeWhen({ caseInsensitive: true })
export const g = rules((g) => ({
  Value: dispatch(regex(/[a-z(]+/), ciCase('url(', g.Url), ciCase(['calc(', 'min('], g.Word), otherwise(g.Word)),
  Url: literal('url('),
  Word: regex(/[a-z]+/),
}))`)
    expect(w).toEqual([])
  })

  it('routed(fallback) keeps its fallback through the macro', () => {
    const def = macroDef(`routed(literal('url('))`) as { tag?: string; fallback?: unknown }
    expect(def?.tag).toBe('routed')
    expect(def?.fallback, 'fallback dropped by the macro').toBeDefined()
    // Same shape the interpreter builds.
    const live = routed(literal('url(')) as unknown as { _def: { fallback?: unknown } }
    expect(Object.keys(def!).sort()).toEqual(Object.keys(live._def).sort())
  })

  it('bare routed() is unchanged (no fallback key)', () => {
    const def = macroDef(`routed()`) as Record<string, unknown>
    expect(def).toEqual({ tag: 'routed' })
    expect('fallback' in def).toBe(false)
  })
})
