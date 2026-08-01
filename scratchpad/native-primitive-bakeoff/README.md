# native-primitive bakeoff: which V8 primitive to emit at a hot site

Two questions, measured rather than argued:

1. **char-level primitives** — for the scan and class-membership shapes the
   codegen emits, which native spelling is actually fastest? One answer shipped
   (`PARSEMAN_SCANTO=indexof`, see CHANGELOG); the rest lost and are kept as the
   record of what was tried.
2. **`_ctx` object shape** — is the emitted context object costing polymorphic
   loads? **Answered NO.** See *Findings* below.

Nothing here is a build input. The rigs read built artifacts; they never
contribute to one.

## Layout

| file | what it measures | outcome |
| --- | --- | --- |
| `micro-charclass.mjs` | MICRO 1 — char-class membership in the ident scan loop, 7-range css ident-continuation set | chain wins; bitmask and sticky lose |
| `micro-all-charclass.mjs` | MICRO 1 consolidated — every candidate in ONE run, so all share a JIT baseline | supersedes the split runs |
| `micro-tweaks.mjs` | MICRO 1b — the two losers retried with the tweak their failure mode implies, plus a class-WIDTH sweep | still lose |
| `micro-scanto.mjs` | MICRO 2 — `String.prototype.indexOf` (SIMD in V8) vs the manual char loop at the `scanTo` site | **4.3x in regime (a)** — cited from `src/compiler/scannable-run.ts` |
| `micro-keyed.mjs` | MICRO 3 — keyed-lookup family against the emitted rules map | map is NOT on the hot path; question moot |
| `elements-kind.mjs` | reports the ACTUAL V8 elements kind per candidate shape (`--allow-natives-syntax`) | supporting instrument |
| `insitu-scanto.ts` | in-situ A/B of `PARSEMAN_SCANTO=indexof` on the repo's workload grammars, correctness-gated on tree identity | at/below noise floor; NOT claimed as a win |
| `size-ab.ts` | artifact size A/B (raw + gzip) for a toggled codegen change | produced the CHANGELOG size numbers |
| `ctx-hidden-class.mjs` | hidden-class state of `_ctx` on a real fused artifact (`--allow-natives-syntax`) | 5 distinct maps across 6 construction sites |
| `ctx-realized-maps.mjs` | REALIZED maps under a real workload | **1** — see *Findings* |
| `micro-ctx-access.mjs` | what the measured `_ctx` state costs at a read site | +13.6% at 2 maps, +26.9% at 4; hoisting 2.1–2.4x |
| `hoist-population.mjs` | is hoisting even AVAILABLE, given writes and cross-rule calls? | 956/1680 reads (56.9%) are hoistable |
| `insitu-ctx.ts` | in-situ A/B of pre-declaring the written `_ctx` fields, with an A-vs-A control | effect not attributable — see *Findings* |

## Findings that live nowhere else

**`_ctx` hidden-class unification is CLOSED on evidence, not deferred.** Exactly
one context object exists per parse; across 8 independent full parses it ends on
the **same** map (realized maps = 1), settling after 792 B on css and 1 B on
less, so >95% of the 1,580 read sites already execute monomorphic. The in-situ
A/B of pre-declaring the 7 written fields moved less/stylesheet 0.9797 and css
0.9876 — but the **A-vs-A control** reached 0.9925, and the ordering contradicts
the mechanism (less settles at 1 byte yet moves most; css settles latest and does
not move). This reproduces a prior build-measure-revert of the same idea.

**The live lead is hoisting, and it is independent of hidden classes.** Splitting
each emitted body at every call site, **956 of 1,680 `_ctx` reads (56.9%)** are
repeat reads of the same field inside a call-free region — `_cstRawChildren` 331,
`_cstTriviaLog` 207, `_cstLeaves` 193. That is an upper bound: it does not yet
exclude regions that WRITE the field.

## Known rough edges

- `size-ab.ts`'s header refers to a `size-ab.sh` comparison wrapper that was
  never committed; compare the two runs by hand.
- The `ctx-*` and `*-ctx*` rigs have no `RESULTS.md`; their numbers are the
  *Findings* section above and the commit messages that added them.
