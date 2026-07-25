/**
 * The longest-literal contract, pinned across BOTH engines.
 *
 * `docs/guide/natural-grammars.md` documents this as Parséman's one deliberate
 * divergence from pure PEG ordered choice, and documents the two mechanisms that
 * implement it — `literalsLongestFirst` (reordering, all-literal choices) and
 * `autoNot` (rejection, mixed `firstMatch` choices). Both are user-visible: they
 * decide which arm wins.
 *
 * The doc's worked examples are machine-checked by `docs:verify`, but that runs the
 * INTERPRETER only. `autoNot` is computed once in `choice.ts` and emitted separately
 * by `emitFirstMatch`, so a compiled-path regression would leave every doc example
 * and every existing auto-not unit test (all of which call `parse`) green. This file
 * is the differential half: same cases, whole-result equality between engines.
 */
import { describe, it, expect } from 'vitest'
import { choice, literal, regex, sequence } from '../../src/index.ts'
import { assertEnginesAgree, assertEnginesAgreeAll } from './helpers/engine-parity.ts'

const ident = regex(/[a-z]+/)

describe('longest-literal wins — parity across engines', () => {
  it('literalsLongestFirst: the LATER, longer literal arm wins', () => {
    const ops = choice(literal('<'), literal('<='))
    expect((ops._def as { strategy: { tag: string } }).strategy.tag).toBe('literalsLongestFirst')
    const r = assertEnginesAgree(ops, '<=')
    expect(r.ok && r.value).toBe('<=')
  })

  it('autoNot startsWith: a mixed choice reaches the same answer by a different route', () => {
    // A regex arm rules out `literalsLongestFirst`, so this is plain `firstMatch`
    // and the longer literal wins via auto-not rejection instead of reordering.
    const ops = choice(literal('<'), literal('<='), ident)
    expect((ops._def as { strategy: { tag: string } }).strategy.tag).toBe('firstMatch')
    const r = assertEnginesAgree(ops, '<=')
    expect(r.ok && r.value).toBe('<=')
  })

  it('autoNot firstSet: a literal arm gets a word boundary from a later regex arm', () => {
    // `@x` is not something `ident` can match, so `greedyClassify` is ruled out too.
    const kw = choice(literal('if'), ident, literal('@x'))
    expect((kw._def as { strategy: { tag: string } }).strategy.tag).toBe('firstMatch')

    // Bare keyword: the literal arm stands.
    expect(assertEnginesAgree(kw, 'if').ok).toBe(true)
    const bare = assertEnginesAgree(kw, 'if')
    expect(bare.ok && bare.value).toBe('if')

    // `ident` can continue past `if` → the literal arm is REJECTED.
    const cont = assertEnginesAgree(kw, 'ifdef')
    expect(cont.ok && cont.value).toBe('ifdef')

    // `9` is outside [a-z]; nothing can continue, so the literal arm stands.
    const stops = assertEnginesAgree(kw, 'if9')
    expect(stops.ok && stops.value).toBe('if')
  })

  it('literals ONLY: a non-literal longer alternative restores strict ordering', () => {
    // The longer alternative is a sequence, so it is not a core literal: no
    // auto-not check is generated and the EARLIER arm wins, as pure PEG says.
    const p = choice(literal('<'), sequence(literal('<='), literal('x')))
    const r = assertEnginesAgree(p, '<=x')
    expect(r.ok && r.value).toBe('<')
  })

  it('holds on the failure paths too, not just the winners', () => {
    // Whole-result equality: a divergence in `expected` or `span` on a failing
    // parse is exactly the class of parity bug a value-only check misses.
    assertEnginesAgreeAll(choice(literal('if'), ident, literal('@x')), [
      '', 'I', '9', '@', '@x', 'if', 'if9', 'ifdef', '<=',
    ])
    assertEnginesAgreeAll(choice(literal('<'), literal('<='), ident), [
      '', '<', '<=', '<==', 'x', '>',
    ])
  })
})
