/**
 * Linkable form (RULE_ABI_PLAN §3): a rules() map compiles so every rule is a
 * canonical `_r_<Name>` function addressable/overridable by name, with a
 * dependency manifest for the linker's dep-closure + name-closure checks.
 */
import { describe, it, expect } from 'vitest'
import { rules, regex, literal, sequence, choice, optional, sepBy } from '../../src/index.ts'
import { ruleDependencies } from '../../src/compiler/codegen.ts'
import { transformMacro } from '../../src/plugin/index.ts'

const mkGrammar = () => rules((g: any) => ({
  Value: choice(g.Num, g.List),
  Num: regex(/[0-9]+/),
  List: sequence(literal('['), optional(sepBy(g.Value, literal(','))), literal(']')),
}))

describe('linkable form — dependency manifest', () => {
  it('records each rule’s referenced rule names (boundary = another rule)', () => {
    const deps = ruleDependencies([...Object.entries(mkGrammar())])
    expect(deps.get('Num')).toEqual([])
    expect(new Set(deps.get('Value'))).toEqual(new Set(['Num', 'List']))
    expect(deps.get('List')).toEqual(['Value'])
  })

  it('includes a self-reference for a directly recursive rule', () => {
    const g = rules((gg: any) => ({
      // R = '(' R? ')'  — references itself
      R: sequence(literal('('), optional(gg.R), literal(')')),
    }))
    expect(ruleDependencies([...Object.entries(g)]).get('R')).toEqual(['R'])
  })
})

describe('linkable form — canonical rule functions', () => {
  it('compiles every map rule to a canonical `_r_<Name>` fn called by name', () => {
    const src = `import { regex, literal, sequence, choice, optional, sepBy, rules } from 'parseman' with { type: 'macro' }
export const { Value, Num, List } = rules(g => ({
  Value: choice(g.Num, g.List),
  Num: regex(/[0-9]+/),
  List: sequence(literal('['), optional(sepBy(g.Value, literal(','))), literal(']')),
}))`
    const out = transformMacro(src, 'x.ts', new Set(['parseman']))!.code
    // Each rule is a canonical named function...
    for (const name of ['_r_Value', '_r_Num', '_r_List']) {
      expect(out, name).toContain(`function ${name}(input`)
    }
    // ...and siblings call them by that name (fusable, direct local calls).
    expect(out).toContain('_r_Num(input')
    expect(out).toContain('_r_Value(input')
    // No leftover per-reference `_pfN` duplication for these map rules.
    expect(out).not.toContain('_pf0')
  })
})
