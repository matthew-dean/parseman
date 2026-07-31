/**
 * CHOICE COST — the ANALYSIS layer (src/analysis/choice-cost.ts), the paths the
 * existing suite does not reach.
 *
 * Each case here is a documented refusal or a documented bound. They are worth a
 * test for the same reason the module states them: every one of them is a place
 * where "I could not see this" would otherwise be indistinguishable from "there is
 * nothing here" — an unresolvable reference walked as a leaf, a wrapper chain the
 * label walker gives up on, a stale cached first set read as "always try".
 */
import { describe, it, expect } from 'vitest'
import { choice, sequence, literal, regex, many, optional, node, rules, ref } from '../../src/index.ts'
import { analyzeChoiceInventory, armLabel, modelledFirstCharGate } from '../../src/analysis/choice-cost.ts'
import type { Combinator } from '../../src/types.ts'

const entries = (g: Record<string, Combinator<unknown>>): [string, Combinator<unknown>][] => Object.entries(g)

describe('a leading term that is not a bare terminal blocks factoring, by name', () => {
  it('names the referenced RULE, so the blocking arm can be found without reading the tree', () => {
    const g = rules((g2: { Other: Combinator<unknown> }) => ({
      Other: literal('x'),
      A: choice(
        sequence(g2.Other, literal('y')),
        sequence(g2.Other, literal('z')),
      ),
    }))
    const e = analyzeChoiceInventory(entries(g)).entries.find(x => x.arity === 2)!
    expect(e.declineReason).toBe('arms-not-factorable')
    expect(e.armDeclines.map(a => a.arm)).toEqual([0, 1])
    expect(e.armDeclines[0]!.reason).toBe('lead-not-concrete-terminal')
    expect(e.armDeclines[0]!.detail).toBe(
      'leading term is `lazy` (ref to Other); factoring through it would change the arm\'s value or capture shape',
    )
    // Both arms DO begin with the same rule — and it is still not a group, because
    // a group means a shareable concrete terminal.
    expect(e.groups).toEqual([])
    expect(e.unfactoredArms).toBe(0)
  })

  it('reports a non-ref leading term without inventing a rule name for it', () => {
    const g = rules(() => ({
      A: choice(
        sequence(node('N', literal('x')), literal('y')),
        sequence(literal('x'), literal('z')),
      ),
    }))
    const e = analyzeChoiceInventory(entries(g)).entries.find(x => x.arity === 2)!
    expect(e.armDeclines[0]).toEqual({
      arm: 0, reason: 'lead-not-concrete-terminal',
      detail: 'leading term is `node`; factoring through it would change the arm\'s value or capture shape',
    })
  })

  it('a CASE-INSENSITIVE leading literal is excluded even though the arms do share it', () => {
    const g = rules(() => ({
      A: choice(
        sequence(literal('@', { caseInsensitive: true }), literal('media')),
        sequence(literal('@', { caseInsensitive: true }), literal('layer')),
      ),
    }))
    const e = analyzeChoiceInventory(entries(g)).entries.find(x => x.arity === 2)!
    expect(e.groups).toEqual([])
    expect(e.declineReason).toBe('arms-not-factorable')
    expect(e.armDeclines.map(a => a.reason)).toEqual([
      'lead-case-insensitive-literal', 'lead-case-insensitive-literal',
    ])
    expect(e.armDeclines[0]!.detail).toBe(
      'literal "@" is case-insensitive; the matched text can differ from the literal\'s own value',
    )
  })

  it('a single-arm choice declines for arity, not for anything about its arm', () => {
    const g = rules(() => ({ A: choice(sequence(literal('@'), literal('m'))) }))
    const e = analyzeChoiceInventory(entries(g)).entries[0]!
    expect(e.arity).toBe(1)
    expect(e.factored).toBe(false)
    expect(e.declineReason).toBe('fewer-than-two-arms')
    expect(e.armDeclines).toEqual([])
  })
})

describe('a root reference is followed once — and a chain too deep is REPORTED, not walked', () => {
  const chain = (n: number): Combinator<unknown> => {
    const links = Array.from({ length: n }, () => ref())
    for (let i = 0; i < n - 1; i++) links[i]!.define(links[i + 1]!)
    links[n - 1]!.define(choice(literal('a'), sequence(literal('a'), literal('b'))) as Combinator<unknown>)
    return links[0]! as Combinator<unknown>
  }

  it('resolves a short chain and walks the choice it names', () => {
    const r = analyzeChoiceInventory([['Chain', chain(4)]])
    expect(r.unresolvedRoots).toEqual([])
    expect(r.choiceSites).toBe(1)
    expect(r.entries[0]!.siteKey).toBe('Chain')
  })

  it('gives up past the hop budget and counts the root as unresolved rather than empty', () => {
    const r = analyzeChoiceInventory([
      ['Deep', chain(12)],
      ['Shallow', choice(literal('a'), sequence(literal('a'), literal('b'))) as Combinator<unknown>],
    ])
    // The site inside `Deep` is NOT reported as absent-and-fine; the root is named.
    expect(r.unresolvedRoots).toEqual(['Deep'])
    expect(r.rules).toBe(2)
    expect(r.choiceSites).toBe(1)
    expect(r.entries[0]!.site.rule).toBe('Shallow')
  })

  it('an undefined ref is unresolved too — the compose hole only compose() can bind', () => {
    const r = analyzeChoiceInventory([
      ['Hole', ref() as Combinator<unknown>],
      ['Real', choice(literal('a'), sequence(literal('a'), literal('b'))) as Combinator<unknown>],
    ])
    expect(r.unresolvedRoots).toEqual(['Hole'])
  })
})

describe('armLabel stops descending rather than looping on a wrapper chain', () => {
  it('returns the outermost tag once the hop budget is spent', () => {
    let deep: Combinator<unknown> = literal('q')
    for (let i = 0; i < 10; i++) deep = optional(deep) as Combinator<unknown>
    // Shallow enough and it reaches the literal; ten deep and it does not, which is
    // the bound, not a bug: an unbounded descent through a cyclic grammar would hang.
    expect(armLabel(optional(optional(literal('q'))) as Combinator<unknown>)).toBe('"q"')
    expect(armLabel(deep)).toBe('optional')
  })

  it('prefers the rule name, then the node type, over anything structural', () => {
    const g = rules(() => ({ Named: sequence(literal('a'), literal('b')) }))
    expect(armLabel(g.Named)).toBe('Named')
    expect(armLabel(node('AtRule', sequence(literal('@'), literal('x'))) as Combinator<unknown>)).toBe('node(AtRule)')
    expect(armLabel(regex(/[a-z]+/) as Combinator<unknown>)).toBe('/[a-z]+/')
    expect(armLabel(many(literal('z')) as Combinator<unknown>)).toBe('"z"')
  })
})

describe('modelling the compiled guard: a STALE cached `any` still yields a guard', () => {
  /**
   * `sequence()` computes its first set at construction. A `ref()` filled in
   * afterwards leaves that cached set as `any` forever — the interpreter does not
   * care, but codegen recovers a real guard from the deep, ref-resolving first set
   * at emit (or at fuse time, from the `@FS:name@` placeholder). Modelling only the
   * cached set would report these arms ungated and inflate their attempt counts.
   */
  it('recovers the guard from the deep first set when the cached one is a stale `any`', () => {
    const r = ref()
    const s = sequence(r as Combinator<unknown>, literal('a')) as Combinator<unknown>
    expect(s._meta.firstSet.kind).toBe('any')
    r.define(literal('%'))
    // Still `any` after the fact — this is exactly the stale cache codegen works around.
    expect(s._meta.firstSet.kind).toBe('any')
    expect(modelledFirstCharGate(s)).toEqual({ kind: 'ranges', ranges: [{ lo: 37, hi: 37 }] })
  })

  it('reports NO guard when the deep set cannot be resolved either', () => {
    const s = sequence(ref() as Combinator<unknown>, literal('a')) as Combinator<unknown>
    // An unbound ref throws on resolution; an always-try arm is the safe model, and
    // the safe model is the one codegen emits.
    expect(modelledFirstCharGate(s)).toBeNull()
  })

  it('reports NO guard for an arm that can match empty at its start', () => {
    expect(modelledFirstCharGate(regex(/[a-z]*/) as Combinator<unknown>)).toBeNull()
    expect(modelledFirstCharGate(optional(literal('%')) as Combinator<unknown>)).toBeNull()
    expect(modelledFirstCharGate(literal('') as Combinator<unknown>)).toBeNull()
  })
})
