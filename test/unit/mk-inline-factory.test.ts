/**
 * Inline-`mk` recognition for FACTORY-authored nodes.
 *
 * `node(type, body, (c, f, s, r, tl) => mk(type, c, r, s, tl))` inside a helper is the
 * ordinary way to spell a family of nodes — parseman's own vendored Less workload uses
 * one such factory at 31 sites. The matcher demanded a string LITERAL in the `mk(...)`
 * type position, so every such site missed the inline path and paid a `_build[n](...)`
 * call per match, while `LOOKS_LIKE_MK_RE` matched and reported it as a near miss.
 *
 * The widening is sound rather than loose: it fires only when the SAME identifier stands
 * in the `node()` type position and in the `mk()` type position. The arrow's own
 * parameters are `(c, f, s, r, tl)`, so nothing between the two occurrences can rebind
 * the name, and the evaluator has already resolved that binding to `def.type` — the two
 * are two spellings of one value. Two DIFFERENT identifiers prove nothing and are still
 * refused.
 *
 * Scope, stated because it is easy to over-read: `typeSrc` is recorded by the MACRO
 * evaluator, which is the path that produces shipped artifacts. A runtime `compile()`
 * reads the reducer through `Function.prototype.toString` and has no call-site
 * identifier to compare against, so the interpreter path still reports the near miss.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { analyzeMkInlineBuild } from '../../src/compiler/inline-build.ts'
import { node, literal, parser } from '../../src/index.ts'
import type { ParserDef } from '../../src/index.ts'
import { compile } from '../../src/compiler/codegen.ts'
import { beginDegradationCapture, endDegradationCapture, resetDegradationMemo } from '../../src/compiler/degradation.ts'

type NodeDef = Extract<ParserDef, { tag: 'node' }>

/** A node def as the macro evaluator leaves it: resolved `type`, the reducer's source,
 *  and — new — the identifier the type argument was written as. */
const nodeDef = (type: string, buildSrc: string, typeSrc?: string): NodeDef => {
  const n = node(type, literal('a'), () => null)
  const def = n._def as NodeDef
  ;(def as { buildSrc?: string }).buildSrc = buildSrc
  if (typeSrc !== undefined) (def as { typeSrc?: string }).typeSrc = typeSrc
  return def
}

describe('inline-mk recognition through a node factory', () => {
  const savedLevel = process.env.PARSEMAN_DEGRADATION
  beforeEach(() => { process.env.PARSEMAN_DEGRADATION = 'warn'; resetDegradationMemo() })
  afterEach(() => {
    if (savedLevel === undefined) delete process.env.PARSEMAN_DEGRADATION
    else process.env.PARSEMAN_DEGRADATION = savedLevel
  })

  it('accepts the same identifier in both type positions', () => {
    expect(analyzeMkInlineBuild(nodeDef('Pair', '(c, f, s, r, tl) => mk(type, c, r, s, tl)', 'type'))).toBe('Pair')
  })

  it('accepts it with TypeScript annotations and a namespaced callee', () => {
    expect(analyzeMkInlineBuild(
      nodeDef('Pair', '(c: A, f: B, s: C, r: D, tl: E) => import_0.mk(t, c, r, s, tl)', 't'),
    )).toBe('Pair')
  })

  it('stops reporting the site as a near miss', () => {
    beginDegradationCapture()
    analyzeMkInlineBuild(nodeDef('Pair', '(c, f, s, r, tl) => mk(type, c, r, s, tl)', 'type'))
    expect(endDegradationCapture()).toEqual([])
  })

  it('refuses a DIFFERENT identifier — two names are not one value', () => {
    beginDegradationCapture()
    expect(analyzeMkInlineBuild(nodeDef('Pair', '(c, f, s, r, tl) => mk(other, c, r, s, tl)', 'type'))).toBeNull()
    expect(endDegradationCapture()).toHaveLength(1)
  })

  it('refuses a mismatched argument ORDER even when the identifier matches', () => {
    beginDegradationCapture()
    expect(analyzeMkInlineBuild(nodeDef('Pair', '(c, f, s, r, tl) => mk(type, c, s, r, tl)', 'type'))).toBeNull()
    expect(endDegradationCapture()).toHaveLength(1)
  })

  it('refuses the identifier form when no call-site identifier was recorded', () => {
    // Without `typeSrc` there is nothing to compare against, so the old answer stands.
    expect(analyzeMkInlineBuild(nodeDef('Pair', '(c, f, s, r, tl) => mk(type, c, r, s, tl)'))).toBeNull()
  })

  it('puts the inlined object in the ARTIFACT, with no build call', () => {
    const n = node('Pair', literal('a'), () => null)
    const def = n._def as NodeDef
    ;(def as { buildSrc?: string }).buildSrc = '(c, f, s, r, tl) => mk(type, c, r, s, tl)'
    ;(def as { typeSrc?: string }).typeSrc = 'type'
    // `gating: 'off'` used to be needed here to keep the diagnostic quiet.
    // Compiling no longer reports anything — see `diagnoseGrammar()`.
    const src = compile(parser({}, n)).source
    expect(src).toContain('_tag: \'node\', type: "Pair"')
    expect(src).not.toContain('_build[0](')
  })
})
