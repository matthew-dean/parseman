/**
 * A fused (composed) grammar must be as first-set-efficient as the same grammar
 * compiled monolithically. A choice arm / node body whose leading term is a rule
 * REFERENCE (`sequence(g.Rule, …)`) must be first-char dispatched on that rule's
 * first set — otherwise the arm is ENTERED at every position and rejected only
 * inside (the Less `@{…}` interpolation case: ~56k invocations, 97% at a non-`@`
 * char). Monolithic `compile()` resolves the ref's first set (`firstSetOf`);
 * `fusedBody()` fixpoint-resolves the per-rule leading recipe over the WINNING
 * rules, so it must gate the arm identically — AND stay sound under override.
 */
import { describe, it, expect } from 'vitest'
import { sequence, choice, literal, regex, node, rules, optional } from '../../src/index.ts'
import { compileLinkable, leadingFirstSetRecipe } from '../../src/compiler/codegen.ts'
import { fusedBody } from '../../src/compiler/linker.ts'

const cst = (type: string) => (ch: readonly unknown[], _f: unknown, span: { start: number; end: number }) =>
  ({ _tag: 'node' as const, type, span, children: [...ch] })

describe('fused grammar first-set parity with monolithic', () => {
  it('recipe separates concrete leading chars from leading ref names (through the nullable prefix)', () => {
    const interp = node('Interp', sequence(literal('@{'), regex(/[a-z]+/), literal('}')), cst('Interp'))
    const g = rules((g: Record<string, ReturnType<typeof regex>>) => ({
      Interp: interp,
      // `.`/`#`(46/35) from the optional, then the `Interp` ref (its `@`).
      Sel: node('Sel', sequence(optional(regex(/[.#]/)), g.Interp!, literal('x')), cst('Sel')),
    }))
    const r = leadingFirstSetRecipe((g as Record<string, ReturnType<typeof regex>>).Sel!)
    expect(r.refs).toContain('Interp')                         // leading ref deferred by NAME
    expect(r.concrete).toMatchObject({ kind: 'ranges' })       // and the `.`/`#` kept concrete
  })

  it('fused Doc first-char-gates the sequence(ref,…)-led arm on the ref first set', () => {
    const g = rules((g: Record<string, ReturnType<typeof regex>>) => ({
      Interp: node('Interp', sequence(literal('@{'), regex(/[a-z]+/), literal('}')), cst('Interp')),
      Sel: node('Sel', sequence(g.Interp!, literal('x')), cst('Sel')),
      Doc: choice(g.Sel!, node('Other', literal('.'), cst('Other'))),
    }))
    const pieces = compileLinkable([...Object.entries(g)], '_lk0_')!
    const { body } = fusedBody([pieces])
    // The fused Doc must gate the Sel arm on `@`(64) — not degrade to `true`.
    expect(body).toMatch(/=== 64/)
    expect(body).not.toMatch(/@FS:Sel/)                        // placeholder resolved, not left raw
  })

  it('stays SOUND under compose override — a wider winning rule widens the arm gate', () => {
    // Artifact A: Interp starts with `@`(64); Doc gates the Sel(->Interp) arm.
    const A = compileLinkable([...Object.entries(rules((g: Record<string, ReturnType<typeof regex>>) => ({
      Interp: node('Interp', sequence(literal('@{'), regex(/[a-z]+/), literal('}')), cst('Interp')),
      Sel: node('Sel', sequence(g.Interp!, literal('x')), cst('Sel')),
      Doc: choice(g.Sel!, node('Other', literal('.'), cst('Other'))),
    })))], '_a_')!
    // Artifact B OVERRIDES Interp with a WIDER first set (`@` OR `$`(36)).
    const B = compileLinkable([...Object.entries(rules(() => ({
      Interp: node('Interp', choice(sequence(literal('@{'), regex(/[a-z]+/), literal('}')), sequence(literal('${'), regex(/[a-z]+/), literal('}'))), cst('Interp')),
    })))], '_b_')!
    // Fuse with B winning Interp — Sel's gate must now include `$`(36) too, else it
    // would DROP a valid `${x}x` parse. (Under-approximation = silent parse loss.)
    const { body } = fusedBody([A, B])
    expect(body).toMatch(/=== 64/)   // still `@`
    expect(body).toMatch(/=== 36/)   // AND `$` — widened by the winning Interp
  })
})
