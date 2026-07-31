# Gates for a grammar refactor

Two questions have to be answered before a grammar cleanup can land, and they are
not the same question:

1. **Did the output move?** — an accept/reject. Answered by the identity oracle
   (`parseman/oracle`, `docs/guide/identity-oracle.md`).
2. **Did it cost anything?** — a measurement. Answered by the A/B harness
   (`bench/ab-harness.ts`, `docs/design/perf-gates.md`).

They fail in opposite directions and must not be conflated. A moved tree is a
hard reject regardless of how fast it made things. A neutral perf result is a
perfectly good result, and "prove it did not cost anything" is a much weaker
demand than "prove it changed nothing".

This note records why the first one is now a shipped entry point, and why the
second one is deliberately **not** being generalised in the same change.

## Why the oracle ships rather than living in a consumer

It was written three times in the downstream Less parser, from memory, because it
lived as a one-off script next to one of four grammars. The third rewrite shipped
with a silent defect: the `OK:`/`ERR:` prefix was dropped from the hashed payload,
which moved every aggregate on a grammar nobody had touched. It was caught only
because someone compared against a number quoted in an old commit message.

That is the whole argument. The utility is not hard; the utility is *paranoid*,
and paranoia does not survive being re-derived from memory. Every property below
was in one of those rewrites and absent from another:

| property | what it catches | what its absence looks like |
|---|---|---|
| `OK:`/`ERR:` discriminator | a rejection becoming a silent accept | green |
| key-sorted projection | nothing; it SUPPRESSES insertion-order churn | every refactor reads as a move |
| cycle-safe traversal | nothing; it prevents a hang | the gate never finishes |
| hashing the error payload | error-message and offset drift | green |
| relative entry ids | — | every cross-machine comparison reads as total regression |
| aggregate covering the ids | a corpus that silently shrank | a smaller, greener gate |

Four of those six fail **green**. A gate that fails green is worse than no gate,
because it is used as evidence.

## What parseman already had, and what was missing

Checked before writing anything:

- **`src/analysis/gating.ts`** — a *static* diagnostic: which choices first-char
  dispatch, and which arm poisons the ones that do not. Adjacent, and complementary
  — a collapse that costs dispatch is exactly what it catches — but it says nothing
  about output.
- **`src/coverage.ts`** — `GrammarCoverageSnapshot` and the trace sink. Answers
  "which rules did this corpus reach", not "what did they produce".
- **`src/spec/`** — EBNF and railroad from the same `_def` tree. Renders the
  grammar, does not run it.
- **`bench/ab-harness.ts` `assertSameParse()`** — the closest prior art, and the
  reason to read it carefully. It compares two sides of an A/B by
  `JSON.stringify`, which is right for its job: it is a *tripwire* guarding a
  timing claim ("the cheapest way for a side to look fast is to stop doing
  work"), over a handful of hand-authored workloads, in a context where the two
  sides are the same grammar. It is not a corpus differential, it does not hash
  errors, it does not survive a cycle or a shared subtree, and it is internal to
  a bench gate.

So: nothing covered it, and one thing was close enough to be worth not
duplicating. `assertSameParse` stays as it is. Reaching for the oracle there would
couple a perf gate to a digest format for no gain — its two sides are the same
grammar, so the strong projection has nothing to find.

## Shape

> **Superseded in 0.45.0, and worth reading anyway.** The line drawn below turned
> out to be in the wrong place. `loadCorpus`, `digestCorpus`, `compareReports` and
> `formatComparison` shipped from `parseman/oracle`; they no longer do. The test
> is *"would a grammar author who has never heard of this consumer want it?"* —
> and corpus walking, aggregate digests, three-way verdicts and report formatting
> only mean anything with one consumer's corpus roots and committed baseline in
> hand. What survives is `digestInto`: deterministic serialization of ONE parse
> result, which every grammar author needs and no consumer can write correctly,
> because it is parseman's node shapes that decide which distinctions are
> semantically meaningful.
>
> The reasoning below is kept because the *decisions* it records are the ones a
> consumer now has to make for itself, and each one is there because something
> went wrong without it. `docs/guide/identity-oracle.md` restates them as
> guidance; jess's implementation is
> `packages/syntax/less/less-parser/test/identity-oracle/`. Read the rest of this
> section as a specification for the harness you write, not for an API you import.

A parseman consumer's parse entry points are *its own*, so the general utility
cannot own them. It takes named **surfaces** and a named **corpus** and produces a
digest:

```
digestCorpus(surfaces, corpus, options?) -> IdentityReport
compareReports(before, after)            -> IdentityComparison
```

Decisions worth recording:

- **Surfaces are plural and named.** Declaring the surface you are *not* editing
  gives you a control for free: if it moves too, the harness or the corpus moved,
  not your rule. For parseman consumers specifically, "interpreted" and "compiled"
  are the natural pair, and a refactor neutral for one and not the other is the
  bug hardest to find by reading.
- **A comparison can be refused.** `incomparable` is a third verdict, not an
  exception and not a `moved`. Mismatched provenance must never come out as a
  statement about the grammar.
- **A shrunken corpus is reported, not refused.** The surviving entries still
  carry signal, and "one entry disappeared, the other 4,300 are unchanged" is more
  useful than a refusal. The verdict still reflects it.
- **Own enumerable keys only.** The question is whether the *output* moved.
  Hashing non-enumerable internals — parseman's carried CST pieces among them —
  would make a consumer's grammar digest move when parseman's internals change,
  which is the wrong sensitivity for a grammar gate.
- **Node-only, separate entry point.** It hashes with `node:crypto` and reads with
  `node:fs`. Keeping it out of the browser-capable `parseman` bundle is the
  established pattern here (`parseman/spec`, `parseman/run`).

### The self-check

The caution that motivated this — *a digest that changes because the harness
changed rather than the grammar is worse than no oracle* — is enforced rather than
documented:

1. `HARNESS_DIGEST` is a **behavioural** fingerprint: the harness run over a frozen
   canary corpus that exercises every payload-shaping decision it makes. It is
   behavioural rather than a hash of the source so that a comment edit does not
   move it — a fingerprint that moves for unrelated reasons is one people learn to
   update without reading. It is built from hand-written values rather than by
   parsing anything, for the same reason: every combinator change in this repo
   would otherwise re-baseline it.
2. It is stamped into every report, and `compareReports` returns `incomparable`
   when two reports disagree on it.
3. `test/unit/oracle-identity.test.ts` pins it to a literal. Changing the
   projection requires editing that constant in the same diff.

Together: there is no edit to the projection that changes a digest and stays quiet.

### Beyond the version it was ported from

Four strictness gaps in the original, fixed here rather than carried over:

- **Sharing was reported as a cycle.** A `WeakSet` added-to and never removed
  marks the *second* visit to a shared node, so a DAG's digest depended on
  traversal order. Now only a back-edge into the current path is abbreviated, and
  it records the distance to its ancestor.
- **`JSON.stringify` collapses.** `{a: undefined}` and `{}`; `NaN`, `±Infinity`
  and `null`; `-0` and `0`; every `Map` and `Set` to `{}`; two node classes with
  the same fields. All of those are tree moves a grammar refactor can make.
- **Nondeterminism was hashed.** A grammar whose output carries a counter or a
  timestamp produced a digest that moved every run, reading as a regression.
  `digestCorpus` now re-parses a sample and fails with a diagnosis.
- **A missing corpus root was skipped silently**, leaving the reported file count
  as the only clue. `loadCorpus` throws by default; opting out returns the missing
  roots.

## The bench and A/B harnesses: consolidation, not new code

`bench/ab-harness.ts` is strictly stronger than the downstream `ab-compare.mjs` /
`parse-bench.mjs` pair on every axis they share, and has three the pair lacks:
calibrated repetitions, a sign test, and majority-of-passes verdicts. There is
nothing to port *into* parseman. The migration runs the other way.

One genuine gap, and it is a direction rather than a missing property:

- `materialise()` pins **parseman** at a sha and copies the working tree's
  *grammar* onto both sides — "did the compiler get slower on a fixed grammar?"
- A consumer refactoring a grammar needs the mirror — pin the **grammar** at HEAD
  and hold parseman fixed: "did my cleanup get slower on a fixed compiler?"

Structurally that is the same harness with a different `materialise`, and the
interleaving, calibration and scoring are reusable as they stand.

**Deliberately not done here.** Not for a merge-ordering reason — #72 has landed, and
`bench/ab-harness.ts` has since been revised again by #82 — but because it is a
distinct capability rather than part of this gate. Parameterising which side is
pinned means a second calibration story (the pinned grammar has to be *built*, not
just checked out), an exported harness surface for consumers to drive, and its own
tests. Bolting that onto the branch that introduces the oracle would mean one PR
making two arguments, and the perf question is the weaker of the two gates.

The follow-up, unblocked and unclaimed: parameterise `materialise` on which side is
pinned, and export the harness so a consumer can drive it.

`bench/grammar-perf-guard.ts` still keeps its own copy of the machinery. #82 shared
the cache-verification logic between the two, but not `materialise` itself, so the
duplication is smaller than it was and has not gone away.

## What stays downstream

The corpus roots, the parse entry points, the build discipline. In particular the
"parse `lib/`, not `src/`" rule is a *consumer's* fact — that its `src/` is not
loadable standalone and that its macro-fallback build emits a different tree — even
though the underlying hazard (a fallback build is not the artifact that ships) is
general enough to belong in the guide, and is there.
