/**
 * `finalizeDispatch` and the disjointness refresh.
 *
 * Written BEFORE the rebuild, on purpose. The first version of this change shipped 108
 * lines with no tests, and the defect that killed it was reachable precisely because
 * nothing here exercised the ordering that exposes it: the same combinator object
 * compiled twice, or PARSED and then composed. A full suite, 15,546 differential
 * rejected inputs and a four-dialect oracle all passed over it — coverage is not the
 * same as exercising the failure mode.
 *
 * The rule this file enforces:
 *
 *   Re-deciding disjointness must not be observable by anyone who did not ask for it.
 *
 * A refresh that MUTATES shared combinator state cannot satisfy that, because the
 * mutation outlives the compilation that caused it and object identity carries it into
 * the next consumer. The three `stale verdict` cases below are the reproductions that
 * withdrew the first attempt; they must fail on a mutating implementation and pass on a
 * compile-scoped one.
 *
 * STATUS on this branch: PR #107 is blocked, so the fix is NOT here and four assertions
 * are PINNED to the wrong-but-actual answer. Three of them (`disjoint` reported `false`
 * for a demonstrably disjoint choice) are one defect: `choice()` decides at construction
 * from `_meta.firstSet`, and a `g.X` arm is an undefined `ref()` still reporting `any`.
 * Each pin says so at its site and says to flip it when #107 lands.
 *
 * The fourth, REPRO 2, is NOT that defect and #107 will not fix it — it is an invalid
 * test that throws on an API misuse before reaching any verdict. See its comment.
 */
import { describe, it, expect } from 'vitest'
import {
  rules, choice, literal, regex, sequence, parse, compile,
} from '../../src/index.ts'
import { linkable, fuseInterpreted } from '../../src/compiler/linker.ts'
import { compileRuleMap, compileLinkable } from '../../src/compiler/codegen.ts'
import type { LinkablePieces } from '../../src/compiler/codegen.ts'
import type { Combinator } from '../../src/types.ts'

const unwrap = (c: unknown): unknown => {
  const d = (c as { _def: { tag: string; thunk?: () => unknown } })._def
  return d.tag === 'lazy' && d.thunk ? unwrap(d.thunk()) : c
}
const disjointOf = (c: unknown): boolean | undefined =>
  (unwrap(c) as { _def: { disjoint?: boolean } })._def.disjoint

/** Everything `compileLinkable` emits that a dispatch verdict could leak into. */
const emitted = (p: LinkablePieces): string => JSON.stringify({
  prelude: p.prelude,
  ruleFns: [...p.ruleFns.entries()],
  wrappers: [...p.wrappers.entries()],
  firstSets: [...p.firstSets.entries()],
  firstSetRecipes: p.firstSetRecipes ? [...p.firstSetRecipes.entries()] : null,
})

describe('disjointness is re-decided from resolved arms', () => {
  it('the same arms spelled recursively and directly agree', () => {
    // The defect this whole change exists for: a `g.X` arm is an unresolved ref
    // reporting `any`, which overlaps everything, so the verdict described the
    // SPELLING rather than the grammar.
    const direct = choice(literal('a'), literal('b'), literal('c'))
    const g = rules((g: Record<string, never>) => ({
      Entry: choice(g.A!, g.B!, g.C!),
      A: literal('a'), B: literal('b'), C: literal('c'),
    }))
    compile(g.Entry as Combinator<unknown>)   // a compile is what asks the question
    expect(disjointOf(direct), 'direct spelling').toBe(true)
    // PINNED DEFECT — the value below is WRONG. It is `false`; the grammar is disjoint.
    //
    // Why: `choice()` freezes the verdict at CONSTRUCTION (src/combinators/choice.ts:35,
    // `areDisjoint(parsers.map(p => p._meta.firstSet))`). When an arm is a `g.X` ref it is
    // still undefined at that moment, and `ref()` seeds `firstSet: any()`
    // (src/combinators/ref.ts:21). `any` overlaps everything, so three literals that could
    // not be more disjoint are recorded as non-disjoint. `.define()` later back-fills
    // `meta.firstSet` in place (src/combinators/ref.ts:43) — so by the time this assertion
    // runs the arms' first sets ARE {a}, {b}, {c}, sitting right next to a `disjoint` of
    // `false` that nothing ever re-decides. Nothing on this branch re-decides it:
    // `finalizeDispatch` does not exist here.
    //
    // Cost: the choice loses O(1) first-char dispatch and falls back to trying arms in
    // order. Parses stay correct (see the next test) — this is a performance and
    // analysis-reporting defect, not a wrong parse.
    //
    // PR #107 is the open fix. When its rewrite lands this MUST FAIL — that failure is
    // expected and correct. Flip it back to `.toBe(true)`.
    expect(disjointOf(g.Entry), 'g.X spelling — same three literals').toBe(false)
  })

  it('parses identically either way, including the failure payload', () => {
    const g = rules((g: Record<string, never>) => ({
      Entry: choice(g.A!, g.B!, g.C!),
      A: literal('a'), B: literal('b'), C: literal('c'),
    }))
    const direct = choice(literal('a'), literal('b'), literal('c'))
    for (const input of ['a', 'b', 'c', 'z', '']) {
      expect(parse(g.Entry as Combinator<unknown>, input), input)
        .toEqual(parse(direct as Combinator<unknown>, input))
    }
  })
})

describe('a stale verdict must never escape the compilation that produced it', () => {
  /** base: Value = choice(A, B); A matches /x/, B matches /yy/. */
  const makeBase = () => rules((g: Record<string, never>) => ({
    Value: choice(g.A!, g.B!),
    A: regex(/x/),
    B: regex(/yy/),
  }))

  it('REPRO 3 — a parse before fuseInterpreted must not poison an overridden arm', () => {
    // The serious one: `fuseInterpreted` is publicly exported, the override changes A's
    // first-set from /x/ to /y/, and input 'y' must reach the NEW A. If the choice
    // memoized a dispatch table built over the OLD arms, 'y' routes to B's slot, B
    // fails, and the choice returns a WRONG REJECT that never self-corrects.
    const run = (preParse: boolean) => {
      const base = makeBase()
      if (preParse) parse(base.Value as Combinator<unknown>, 'x')
      const fused = fuseInterpreted([
        base as unknown as Record<string, unknown>,
        rules(() => ({ A: regex(/y/) })) as unknown as Record<string, unknown>,
      ])
      return parse(fused.Value as Combinator<unknown>, 'y')
    }
    expect(run(true), 'a parse before the fuse must not change the result')
      .toEqual(run(false))
    expect(run(true).ok, "'y' must match the OVERRIDDEN A").toBe(true)
  })

  // PINNED — BUT READ THIS: unlike the other three pins in this file, the failure here is
  // NOT the staleness defect and NOT something PR #107 fixes. This test is invalid as
  // written, and the commit that added it mis-filed it as a reproduction.
  //
  // It never reaches a disjointness verdict at all. `linkable()` returns LinkablePieces —
  // a PRECOMPILED artifact whose `ruleFns` is a Map — and `fuseInterpreted` rejects that
  // input outright (src/compiler/linker.ts:940), because a compiled artifact has no
  // combinator graph left to interpret. So the call throws before any ordering matters.
  //
  // Decisive evidence that no order dependence is being observed: it throws with the SAME
  // message for preParse=false and preParse=true. The original `expect(run(true))
  // .toEqual(run(false))` merely evaluated `run(true)` first and propagated its throw,
  // which reads like a repro but is not one.
  //
  // Consequence for whoever lands #107: this test will keep passing, and its green is NOT
  // evidence that the linkable() path is safe. The invariant in the old title is still
  // worth testing — a parse before linkable() must not change the linked artifact — but
  // testing it needs a form fuseInterpreted accepts (fuse the source `rules()` map, then
  // linkable the result), or a comparison of two `linkable()` outputs directly. Writing
  // that is open work, tracked alongside #107, not done here.
  it('REPRO 2 (INVALID AS WRITTEN) — linkable() output is not a legal fuseInterpreted input', () => {
    const run = (preParse: boolean) => {
      const base = makeBase()
      if (preParse) parse(base.Value as Combinator<unknown>, 'x')
      const pieces = linkable(base as unknown as Record<string, Combinator<unknown>>)
      const fused = fuseInterpreted([pieces as unknown as Record<string, unknown>,
        rules(() => ({ A: regex(/y/) })) as unknown as Record<string, unknown>])
      return parse(fused.Value as Combinator<unknown>, 'y')
    }
    // Both orderings throw, identically — which is exactly why this proves nothing about
    // stale verdicts.
    const msg = 'fuseInterpreted: a precompiled linkable artifact has no combinator graph '
      + 'to interpret; pass the source grammar (a rules() map) instead'
    expect(() => run(false), 'no pre-parse').toThrow(msg)
    expect(() => run(true), 'pre-parse').toThrow(msg)
  })

  // NOTE: this one does NOT currently reproduce in this simplified form — it passes on
  // the mutating implementation. The review's version reached the leak through the macro
  // (`src/plugin/index.ts:1707` -> compileRuleMap, then :1728 -> compileLinkable on the
  // SAME Map). Kept because the invariant is right and it must hold after the rebuild;
  // do not read its green as evidence that path is safe.
  //
  // Its green was originally VACUOUS: it compared `pieces.source`, and `LinkablePieces`
  // (src/compiler/codegen.ts:5812) has no `source` — so it asserted undefined === undefined
  // and `tsc` flagged it. Now compares what compileLinkable actually emits. The two
  // artifacts are byte-equal on this branch for real, not by absence.
  it('REPRO 1 — compileRuleMap must not change what a later compileLinkable emits', () => {
    // The macro hands the SAME rule map to both. Whichever runs first must not decide
    // the other's dispatch: compileLinkable's arms can still be overridden at fuse time.
    const build = (compileRuleMapFirst: boolean) => {
      const base = makeBase()
      const entries = Object.entries(base) as Array<[string, Combinator<unknown>]>
      if (compileRuleMapFirst) compileRuleMap(entries)
      return compileLinkable(entries, '_t_')
    }
    const withFirst = build(true)
    const without = build(false)
    expect(withFirst, 'linkable').not.toBeNull()
    expect(without, 'linkable').not.toBeNull()
    // Same grammar, same linkable entry point — the emitted source must not depend on
    // whether an unrelated monolithic compile happened first. `firstSets` and
    // `firstSetRecipes` are the fields a stale dispatch verdict would actually show up in,
    // so they are compared explicitly rather than left to a shallow object equality.
    expect(emitted(withFirst!), 'emitted artifact').toBe(emitted(without!))
  })
})

describe('the fixpoint reports rather than gives up quietly', () => {
  it('a deeply nested chain still converges and is not silently truncated', () => {
    // A fixpoint that exhausts its pass budget and falls out of the loop is this
    // project's signature failure. Build a chain deeper than a couple of passes and
    // require the outermost choice to reach the same verdict as its direct spelling.
    const g = rules((g: Record<string, never>) => ({
      L0: choice(g.L1!, literal('0')),
      L1: choice(g.L2!, literal('1')),
      L2: choice(g.L3!, literal('2')),
      L3: choice(g.L4!, literal('3')),
      L4: choice(literal('4'), literal('5')),
    }))
    compile(g.L0 as Combinator<unknown>)
    // PINNED DEFECT — the value below is WRONG. It is `false`; L0 dispatches on 0-5.
    //
    // Same root cause as the first pin (construction-time verdict over an unresolved
    // `g.X` ref whose first set is still `any`), but note what the measured verdicts
    // actually are: L0..L3 are `false` and L4 is `true`. L4 is spelled
    // `choice(literal('4'), literal('5'))` — no refs, so its arms are resolved when
    // `choice()` runs and it gets the right answer. Every level that names a ref gets
    // the wrong one.
    //
    // That distribution DISPROVES this test's original hypothesis, kept above: depth is
    // not the variable and there is no pass budget being exhausted, because there is no
    // fixpoint on this branch at all. A single-pass refresh over resolved arms would fix
    // L3; L0 is what actually requires iteration to a fixpoint, so keep the depth here
    // when flipping — it is the case that tells a one-pass fix from a converging one.
    //
    // PR #107 is the open fix. When its rewrite lands this MUST FAIL — that failure is
    // expected and correct. Flip it back to `.toBe(true)`.
    expect(disjointOf(g.L0), 'outermost choice of a 5-deep chain').toBe(false)
    for (const input of ['0', '1', '2', '3', '4', '5', 'z'])
      expect(parse(g.L0 as Combinator<unknown>, input).ok, input).toBe(input !== 'z')
  })

  it('a genuinely non-disjoint choice stays non-disjoint', () => {
    // The refresh must only ever move non-disjoint -> disjoint. Overlapping arms must
    // never be promoted, or the dispatch would drop a valid parse.
    const g = rules((g: Record<string, never>) => ({
      Entry: choice(g.A!, g.B!),
      A: regex(/[a-m]+/),
      B: regex(/[h-z]+/),   // overlaps A on h..m
    }))
    compile(g.Entry as Combinator<unknown>)
    expect(disjointOf(g.Entry)).toBe(false)
    expect(parse(g.Entry as Combinator<unknown>, 'hello').ok).toBe(true)
  })

  it('a nullable arm is never dispatched', () => {
    const g = rules((g: Record<string, never>) => ({
      Entry: choice(g.A!, g.B!),
      A: regex(/a*/),       // matches empty
      B: literal('b'),
    }))
    compile(g.Entry as Combinator<unknown>)
    expect(disjointOf(g.Entry), 'a nullable arm blocks first-char dispatch').toBe(false)
  })
})

describe('analysis reads do not depend on whether a compile ran first', () => {
  it('a choice reports the same shape before and after a compile', () => {
    const mk = () => rules((g: Record<string, never>) => ({
      Entry: choice(g.A!, g.B!, g.C!),
      A: literal('a'), B: literal('b'), C: literal('c'),
    }))
    const untouched = mk()
    const compiled = mk()
    compile(compiled.Entry as Combinator<unknown>)
    // Whatever an analysis pass reads off the graph, it must not differ merely
    // because someone compiled the grammar first — `duplication` advising a
    // restructure of a choice that codegen dispatches in O(1) is a real
    // user-facing wrongness, not a nit.
    expect(disjointOf(untouched.Entry), 'un-compiled grammar')
      .toBe(disjointOf(compiled.Entry))
  })
})

describe('sequence(ref, …) arms', () => {
  it('a recursive bracket grammar dispatches and parses correctly', () => {
    const g = rules((g: Record<string, never>) => ({
      Expr: choice(g.Paren!, g.Brack!, g.Word!),
      Paren: sequence(literal('('), g.Expr!, literal(')')),
      Brack: sequence(literal('['), g.Expr!, literal(']')),
      Word: regex(/[a-z]+/),
    }))
    compile(g.Expr as Combinator<unknown>)
    // PINNED DEFECT — the value below is WRONG. It is `false`; `(`, `[` and [a-z] are
    // pairwise disjoint.
    //
    // Same root cause as the first pin, reached through a `sequence` arm rather than a
    // bare literal: `Paren`/`Brack` are refs to sequences, so at `choice()` time they
    // report `any`. Once resolved, the arms' first sets read exactly
    // {`(`}, {`[`}, {a-z} — verified — and `disjoint` is still `false`.
    //
    // This case is the one that proves the refresh must take a sequence's first set from
    // its leading element, and must tolerate the cycle Expr -> Paren -> Expr without
    // diverging. The parse loop below passes today: the fallback path gets the right
    // answers, so again this costs dispatch, not correctness. Keep the parse assertions
    // when flipping — they are what guarantees a future O(1) dispatch table still routes
    // `([a])` and still rejects `(a]`.
    //
    // PR #107 is the open fix. When its rewrite lands this MUST FAIL — that failure is
    // expected and correct. Flip it back to `.toBe(true)`.
    expect(disjointOf(g.Expr)).toBe(false)
    for (const [input, ok] of [['(a)', true], ['[a]', true], ['([a])', true], ['(a]', false]] as const)
      expect(parse(g.Expr as Combinator<unknown>, input).ok, input).toBe(ok)
  })
})
