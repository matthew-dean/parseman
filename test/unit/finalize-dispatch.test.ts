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
 */
import { describe, it, expect } from 'vitest'
import {
  rules, choice, literal, regex, sequence, parse, compile,
} from '../../src/index.ts'
import { linkable, fuseInterpreted } from '../../src/compiler/linker.ts'
import { compileRuleMap, compileLinkable } from '../../src/compiler/codegen.ts'
import type { Combinator } from '../../src/types.ts'

const unwrap = (c: unknown): unknown => {
  const d = (c as { _def: { tag: string; thunk?: () => unknown } })._def
  return d.tag === 'lazy' && d.thunk ? unwrap(d.thunk()) : c
}
const disjointOf = (c: unknown): boolean | undefined =>
  (unwrap(c) as { _def: { disjoint?: boolean } })._def.disjoint

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
    expect(disjointOf(g.Entry), 'g.X spelling — same three literals').toBe(true)
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

  it('REPRO 2 — a parse before linkable() must not change the linked artifact', () => {
    const run = (preParse: boolean) => {
      const base = makeBase()
      if (preParse) parse(base.Value as Combinator<unknown>, 'x')
      const pieces = linkable(base as unknown as Record<string, Combinator<unknown>>)
      const fused = fuseInterpreted([pieces as unknown as Record<string, unknown>,
        rules(() => ({ A: regex(/y/) })) as unknown as Record<string, unknown>])
      return parse(fused.Value as Combinator<unknown>, 'y')
    }
    expect(run(true)).toEqual(run(false))
  })

  // NOTE: this one does NOT currently reproduce in this simplified form — it passes on
  // the mutating implementation. The review's version reached the leak through the macro
  // (`src/plugin/index.ts:1707` -> compileRuleMap, then :1728 -> compileLinkable on the
  // SAME Map). Kept because the invariant is right and it must hold after the rebuild;
  // do not read its green as evidence that path is safe.
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
    // whether an unrelated monolithic compile happened first.
    expect(withFirst!.source).toBe(without!.source)
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
    expect(disjointOf(g.L0), 'outermost choice of a 5-deep chain').toBe(true)
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
    expect(disjointOf(g.Expr)).toBe(true)
    for (const [input, ok] of [['(a)', true], ['[a]', true], ['([a])', true], ['(a]', false]] as const)
      expect(parse(g.Expr as Combinator<unknown>, input).ok, input).toBe(ok)
  })
})
