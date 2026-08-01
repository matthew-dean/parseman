# `lane/disjoint-fix`: what it delivers, and what it does NOT

Read this before quoting any number from this branch.

## Status: BLOCKED BY REVIEW. Do not merge.

An adversarial review of the `deferFirstSetRefs` exclusion reproduced three cases of
the exact staleness the exclusion exists to prevent. The mechanism is wrong, not the
diagnosis. See PR #107's review comment for the reproductions; summary:

  - `finalizeDispatch` MUTATES shared combinator objects, so "we do not call it in
    `compileLinkable`" does not stop `compileLinkable` from being handed an object an
    earlier compile or parse already refreshed. The boundary is stated as an
    object-graph property and enforced as a call-site convention; object identity
    defeats it.
  - `src/plugin/index.ts:1707` -> `compileRuleMap` (which refreshes) hands the SAME Map
    to `compileLinkable` at :1728, on every exported grammar. Green only because the
    full-pieces fallback that would ship it has never fired.
  - `fuseInterpreted` (publicly exported) reuses live base combinators: one `.parse()`
    before the fuse produces a wrong REJECT, and the one-shot `refreshed` memo means it
    never self-corrects.
  - `emitChoice`'s disjoint branch has no `deferFirstSetRefs` handling at all, so there
    is no second line of defence now that `def.disjoint` is reachable under
    `compileLinkable`.
  - `finalize-dispatch.ts` ships 108 lines with zero tests; `MAX_PASSES` exhaustion is
    silent; analysis reads are now order-dependent.

A landable version needs the refresh to be NON-MUTATING — a compile-scoped map of
verdicts — or `compileLinkable` to assert/reset. Everything below still describes what
the change does and does not measure, and remains accurate.

## Original status

Two commits — `5906aed` (interpreter) and `520b27c` (codegen). They deliver
**correctness**: both engines now decide dispatch from the same resolved arms, so they
can no longer disagree on strategy. Suite 189 files / 3,619 passed; 15,546 rejected
inputs with zero added interpreter-vs-compiled divergence.

They deliver **nil measured benefit on the four shipping grammars.**

## Why nil

All four grammars build through `composeLeaf(...)` — the linkable path, where
`deferFirstSetRefs` is set. The refresh is deliberately NOT applied there, because a
named rule can be overridden at fuse time and a dispatch table baked over today's arms
would fail to route composed input. That boundary is correct and must stay. It is also
exactly the path every shipping grammar takes.

Proven, not inferred. Four-dialect oracle, `A` = clean `f2b0e44`, `B` = same + this
branch, both packed and installed with distinct md5s:

    css   111 files    333 pairs   278 real trees   0 MISMATCHED
    less   41 files    123 pairs   121 real trees   0 MISMATCHED
    scss 2405 files   7215 pairs  6450 real trees   0 MISMATCHED
    jess   24 files     72 pairs    69 real trees   0 MISMATCHED

The 0-mismatch is VACUOUS. Artifact delta was +0 bytes on all eight built files while
md5 reported "differ" — same length, different content, eight for eight. The 2,245
differing lines are all the path-derived namespace token:

    A  const _495baed4__re0 = /-?(?:[_a-zA-Z…
    B  const _3fcfd22e__re0 = /-?(?:[_a-zA-Z…

i.e. the two builds differ only by a directory name.

**`example/css` moved -0.60% (224,789 -> 222,756 B). That is NOT a shipping number** —
`examples/css` is a monolithic `compile()`, which is the path the refresh does apply to.
Do not quote it as a dialect result.

## The follow-on work is smaller than it looks — measured

The obvious next step is to extend the fuse-time `/*@FS:rule:codevar@*​/true`
substitution (linker.ts) from per-arm guards to the disjoint-dispatch decision. Before
building it, the question "how much is left on the table?" was measured directly, by
counting placeholder resolutions at fuse time on a composeLeaf grammar shaped like the
shipping ones (recursive, `g.X`-saturated):

    @FS placeholders seen at fuse time: 8
      resolved to a real first-char condition : 8
      left as `true` (arm always attempted)   : 0

**Every rule-ref choice arm on the composed path already gets a resolved first-char
guard at fuse time.** Composed grammars are not attempting arms blindly; each is
skipped by a cheap integer comparison. The remaining gap is O(n) integer tests versus
one O(1) table lookup per choice — real, but incremental.

This matters because the interpreter measurement that motivated the work (36-40%
slower on a recursively-spelled but perfectly gated choice) does NOT transfer to the
compiled path. There, `disjoint=false` means arms are genuinely PARSED. Codegen never
had that problem for composed grammars: `deferFirstSetRefs` plus fuse-time `@FS`
substitution already solved it, and that machinery exists precisely because someone
hit this before.

So "the largest un-taken speed item" is not supported by measurement on the compiled
path. The interpreter win is real (-8.3% / -3.4% on `examples/css` at load 3.7); the
compiled win is bounded by the difference between a guarded scan and a table lookup.

## Still outstanding

  - compiled-path perf numbers on a quiet box, to size the guarded-scan-vs-dispatch gap
    directly rather than bounding it by argument;
  - a decision on whether that gap justifies extending the `@FS` substitution from a
    boolean CONDITION to a structural dispatch form — note a placeholder cannot do it,
    since you cannot turn a firstMatch loop into an O(1) dispatch by replacing `true`.
