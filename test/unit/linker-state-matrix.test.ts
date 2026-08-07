import { describe, expect, it } from 'vitest'
import { literal, rules, sequence, type Combinator } from '../../src/index.ts'
import { run } from '../../src/functional/run.ts'
import {
  COMPOSED_PIECES,
  carriedRuleMaps,
  carriedRuleMapsDetailed,
  compose,
  cstBuildHost,
  fuseInterpreted,
  isInterpretedFuse,
  once,
  recoverComposedRules,
  type IRPiece,
} from '../../src/compiler/linker.ts'
import { compileLinkableTable, type LinkableTable } from '../../src/compiler/compile-linkable-table.ts'
import { serializeRuleMap } from '../../src/compiler/ir-serialize.ts'
import { PARSEMAN_VERSION } from '../../src/version.ts'

const entries = (map: Record<string, Combinator<unknown>>) => Object.entries(map)

function irPiece(ns: string, map: Record<string, Combinator<unknown>>): IRPiece {
  const ir = serializeRuleMap(entries(map))
  expect(ir).not.toBeNull()
  return { ns, ir: ir! }
}

function opaque(ns: string, keys: string[]): LinkableTable {
  return {
    v: PARSEMAN_VERSION,
    ns,
    keys,
    external: [],
    prog: null,
    rules: null,
    replacement: null,
    ir: null,
    ruleMap: [],
    hostMode: 'ast',
    hostBranchElided: false,
    hasDirectBuilders: false,
    isRecognitionOnly: true,
    reflection: { nodes: [] },
  }
}

describe('linker state and recovery matrix', () => {
  it('memoizes a lazy hydration exactly once, including an undefined result', () => {
    let calls = 0
    const hydrate = once(() => {
      calls++
      return undefined
    })
    expect(hydrate()).toBeUndefined()
    expect(hydrate()).toBeUndefined()
    expect(calls).toBe(1)
  })

  it('recovers carried table/IR maps and reports opaque artifact names', () => {
    const table = compileLinkableTable([['A', literal('a')]], 'table')!
    const ir = irPiece('ir', { B: literal('b') })
    const hidden = opaque('hidden', ['C', 'D'])
    const detailed = carriedRuleMapsDetailed([table, ir, hidden])

    expect(detailed.maps.map(map => map.map(([name]) => name))).toEqual([['A'], ['B']])
    expect(detailed.opaque).toEqual([{ ns: 'hidden', ruleNames: ['C', 'D'] }])
    expect(carriedRuleMaps([table, ir, hidden])).toHaveLength(2)
  })

  it('recovers later-wins definitions from a composed stamp and skips unresolved refs', () => {
    const base = rules(() => ({ Value: literal('a') })) as Record<string, Combinator<unknown>>
    const delta = rules(g => ({ Entry: g.Value, Value: literal('b') })) as Record<string, Combinator<unknown>>
    const stamped: Record<string, unknown> = {}
    Object.defineProperty(stamped, COMPOSED_PIECES, {
      value: [irPiece('base', base), irPiece('delta', delta)],
    })

    const recovered = recoverComposedRules(stamped)!
    expect(recovered.opaque).toEqual([])
    expect(run(recovered.rules.get('Value')!, 'b').ok).toBe(true)
    expect(run(recovered.rules.get('Value')!, 'a').ok).toBe(false)
    expect(recoverComposedRules({})).toBeUndefined()
  })

  it('binds open recursion, stamps host mode, and carries interpreted provenance', () => {
    const base = rules(g => ({ Entry: sequence(literal('('), g.Value, literal(')')), Value: literal('a') }))
    const override = rules(() => ({ Value: literal('b') }))
    const fused = fuseInterpreted([base, override], { hostMode: 'cst' })

    expect(run(fused.Entry!, '(b)', { build: cstBuildHost }).ok).toBe(true)
    expect(run(fused.Entry!, '(a)', { build: cstBuildHost }).ok).toBe(false)
    expect(fused.Entry!._meta.grammarHostMode).toBe('cst')
    expect(isInterpretedFuse(fused)).toBe(true)
  })

  it('attributes a missing name to the rule that references it', () => {
    const incomplete = rules(g => ({ Entry: sequence(literal('('), g.Missing, literal(')')) }))
    expect(() => fuseInterpreted([incomplete]))
      .toThrow('fuseInterpreted: rule "Entry" references missing rule "Missing"')
  })

  it('refuses to silently rebind one shared placeholder to a different fusion', () => {
    const base = rules(g => ({ Entry: g.Value }))
    const first = rules(() => ({ Value: literal('a') }))
    const second = rules(() => ({ Value: literal('b') }))
    expect(run(fuseInterpreted([base, first]).Entry!, 'a').ok).toBe(true)
    expect(() => fuseInterpreted([base, second])).toThrow(/already bound by a DIFFERENT interpreted fusion/)
  })

  it('fails closed when an interpreted diagnostic meets opaque composed state', () => {
    const composed: Record<string, unknown> = {}
    Object.defineProperty(composed, COMPOSED_PIECES, { value: [opaque('binary', ['Entry'])] })
    expect(() => fuseInterpreted([composed]))
      .toThrow('cannot interpret a composed grammar containing precompiled artifact(s) "binary" (1 rules)')
  })

  it('refuses an opaque artifact directly in both composition engines', () => {
    const binary = opaque('binary', ['Entry'])
    expect(() => fuseInterpreted([binary]))
      .toThrow('a precompiled linkable artifact with no carried IR has no combinator graph')
    expect(() => compose([binary]))
      .toThrow('compose: carried piece "binary" has no re-lowerable IR and cannot be fused')
  })

  it('explicit ast mode clears a rule-map cst stamp', () => {
    const grammar = rules({ hostMode: 'cst' }, () => ({ Entry: literal('x') }))
    expect(grammar.Entry._meta.grammarHostMode).toBe('cst')
    const fused = fuseInterpreted([grammar], { hostMode: 'ast' })
    expect(fused.Entry!._meta.grammarHostMode).toBeUndefined()
    expect(run(fused.Entry!, 'x').ok).toBe(true)
  })
})
