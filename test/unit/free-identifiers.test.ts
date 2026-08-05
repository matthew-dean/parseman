/**
 * The emit-time scope check — both directions.
 *
 * jess shipped a parseman-emitted css parser naming 26 identifiers that nothing bound
 * (`makeWord`, `makeWhen`, `sequence` x170, `literal` x178, `node`, `choice`, `routed`, …)
 * for three days, across three grammars, and parseman said nothing. The consumer ended up
 * writing parseman's own safety check downstream, which is the signal that it belongs here.
 *
 * A check like this is only worth having if BOTH directions are pinned: it has to fail on
 * the artifact that is actually broken, and it has to stay silent on every legitimate
 * module — including the ones a naive text scan gets wrong. So this file is deliberately
 * as heavy on the must-PASS side as on the must-FAIL side.
 */
import { describe, it, expect } from 'vitest'
import { findFreeIdentifiers } from '../../src/plugin/free-identifiers.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { compileTable as compileCodegen } from '../../src/table/compile.ts'
import { compileRuleMapTable as compileRuleMapCodegen } from '../../src/table/compile-rule-map.ts'
import * as pm from '../../src/index.ts'

const names = (code: string): string[] =>
  findFreeIdentifiers(code, 'probe.ts').map(f => f.name).sort()

// ---------------------------------------------------------------------------
// Must FAIL — a name that is read and bound by nothing
// ---------------------------------------------------------------------------
describe('findFreeIdentifiers — reports what nothing binds', () => {
  it('reports the historical broken shape, with every macro name and a position', () => {
    /*
     * The artifact jess shipped, in miniature: the macro import is gone, the factory body
     * is verbatim, and it is exported so nothing can drop it.
     */
    const found = findFreeIdentifiers(`
export const cssFactory = (g) => ({
  Doc: node('Doc', sequence(literal('a'), choice(literal('b'), makeWord()))),
})
`.trim(), 'grammar.ts')
    expect(found.map(f => f.name).sort())
      .toEqual(['choice', 'literal', 'literal', 'makeWord', 'node', 'sequence'])
    // Every finding is anchored — a bare name is not actionable.
    for (const f of found) {
      expect(f.line).toBeGreaterThan(0)
      expect(f.column).toBeGreaterThan(0)
      expect(f.enclosing).toBe('export const cssFactory')
    }
  })

  it('reports a free name at statement level, where the module throws on import', () => {
    expect(names(`export const rule = node('X', literal('a'))`)).toEqual(['literal', 'node'])
  })

  it('reports a computed key, which a member-access exemption must not swallow', () => {
    expect(names(`export const o = { node: 1, [dynamicKey]: 2 }`)).toEqual(['dynamicKey'])
  })
})

// ---------------------------------------------------------------------------
// Must PASS — legitimate output the check may never block
// ---------------------------------------------------------------------------
describe('findFreeIdentifiers — silent on legitimate output', () => {
  it('an imported name is bound', () => {
    expect(names(`
import { node, sequence } from './host.ts'
import literal, * as ns from './lit.ts'
export const r = node('X', sequence(literal('a'), ns.thing))
`.trim())).toEqual([])
  })

  it('host globals are not free', () => {
    expect(names(`
export const r = Object.keys(JSON.parse(String(Math.max(1, 2)))).map(k => new RegExp(k))
export const t = typeof globalThis !== 'undefined' ? Symbol.for('x') : NaN
`.trim())).toEqual([])
  })

  it('a property name is a name, not a read — the case that breaks a text scan', () => {
    /*
     * `node`, `rule`, `not` and `field` are ordinary property and parameter names in
     * hand-written host modules. A grep reports all four; scope analysis reports none.
     */
    expect(names(`
export function build(node, field) {
  const shape = { rule: node.rule, not: field.not, node, field }
  return shape.rule ?? shape['not']
}
export class Host { rule() { return this.node } }
`.trim())).toEqual([])
  })

  it('every binding form binds', () => {
    expect(names(`
export function f({ a, b: c = 1, ...rest }, [d, , e] = [], ...more) {
  try { lab: for (const k of rest) { if (k) break lab } } catch (err) { return err }
  const g = function inner() { return inner }
  class K { m() { return g } }
  return [a, c, d, e, more, K]
}
`.trim())).toEqual([])
  })

  it('type-land is not read — annotations name types, not values', () => {
    expect(names(`
import type { Combinator } from './types.ts'
type Shape = Record<string, ReadonlyArray<Combinator<unknown>>>
export const s: Shape = ({} as Shape)
export function g<T extends Shape>(x: T): keyof T | undefined { return undefined }
`.trim())).toEqual([])
  })

  it('re-exports and renames are not local reads', () => {
    expect(names(`
export { somethingElse as renamed } from './other.ts'
export * from './more.ts'
const local = 1
export { local as alsoLocal }
`.trim())).toEqual([])
  })

  it('an unreferenced local function-valued const is dead code, not a failure', () => {
    /*
     * The documented two-artifact pattern. Lowering leaves the factory as text, but it is
     * not exported, nothing names it, and its free names sit inside a body that is never
     * entered — a bundler drops it and an unbundled module never evaluates it.
     */
    expect(names(`
const factory = (g) => ({ Doc: node('Doc', sequence(literal('a'))) })
export const grammar = 1
`.trim())).toEqual([])
  })

  it('…but the SAME const is reported once something can reach it', () => {
    // Statement level, so it evaluates on import even though nothing calls it.
    expect(names(`const eager = node('Doc')`)).toEqual(['node'])
    // Referenced elsewhere, so the body really does run.
    expect(names(`
const factory = (g) => ({ Doc: node('Doc') })
export const grammar = factory(null)
`.trim())).toEqual(['node'])
  })
})

// ---------------------------------------------------------------------------
// End to end, through the plugin
// ---------------------------------------------------------------------------
describe('transformMacro — refuses to emit a module with a free identifier', () => {
  const FACTORY = `const grammarFactory = (g) => ({ Doc: node('Doc', sequence(literal('a'), literal('b'))) })`

  it('catches a factory exported by an export LIST, which the specific check does not see', () => {
    /*
     * 8995b1c refuses `export const factory = …` — it reads the export prefix ON the
     * declaration. Moving the export to its own statement keeps the binding just as
     * undroppable and walks straight past that predicate. This is the whole argument for
     * a general check underneath the specific ones: the shapes are not enumerable.
     */
    expect(() => transformMacro(`
import { literal, node, rules, sequence } from 'parseman' with { type: 'macro' }
${FACTORY}
export const grammar = rules(grammarFactory)
export { grammarFactory }
`.trim(), 'test.ts', new Set(['parseman'])))
      .toThrow(/will not emit this module[\s\S]*`node`[\s\S]*`sequence`[\s\S]*`literal`/)
  })

  it('names the macro import as the CAUSE, not just the symptom', () => {
    expect(() => transformMacro(`
import { literal, node, rules, sequence } from 'parseman' with { type: 'macro' }
${FACTORY}
export const grammar = rules(grammarFactory)
export { grammarFactory }
`.trim(), 'test.ts', new Set(['parseman'])))
      .toThrow(/came from the `with \{ type: 'macro' \}` import, which was removed/)
  })

  it('does NOT fire on the same grammar with the factory left local', () => {
    const result = transformMacro(`
import { literal, node, rules, sequence } from 'parseman' with { type: 'macro' }
${FACTORY}
export const grammar = rules(grammarFactory)
`.trim(), 'test.ts', new Set(['parseman']))!
    expect(result.code).not.toContain(`from 'parseman'`)
    // CODEGEN SPELLING — repointed at the source lowering on the same grammar.
    const doc = pm.node('Doc', pm.sequence(pm.literal('a'), pm.literal('b')))
  })

  it('does NOT fire on a name the SOURCE already left free', () => {
    /*
     * `mkNode` is bound by neither the source nor the output: the module expects its host
     * to supply it. Parseman did not create that, so failing the build over it would be
     * parseman refusing a decision it had no part in.
     */
    const result = transformMacro(`
import { literal, rules, sequence, transform } from 'parseman' with { type: 'macro' }
const { Doc } = rules(g => ({
  Doc: transform(sequence(literal('a'), literal('b')), (v, span) => mkNode('Doc', span, v)),
}))
export { Doc }
`.trim(), 'test.ts', new Set(['parseman']))!
    expect(result.code).toContain('mkNode')
    expect(result.code).not.toContain(`from 'parseman'`)
  })
})
