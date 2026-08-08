# TableProgram prototype: historical evidence and engine-name correction

> **Authority/status (2026-08-08): historical evidence, not current design.**
> This note records the prototype that established the table/assembly direction
> and the measurements taken while it was being built. The prototype is no
> longer “additive” or “unwired”: the shipping path is now the closure-based
> TableProgram assembler in `src/table/assemble.ts`. Current architecture and
> release status live in [`RELEASE-0.48-TARGET.md`](./RELEASE-0.48-TARGET.md),
> [`DESIGN-piece-library.md`](./DESIGN-piece-library.md), and
> [`docs/design/derived-tokenization.md`](../docs/design/derived-tokenization.md).

## Engine-name correction

Historical harnesses `bench/table-speed-ab.ts`, `table-vs-field.ts`,
`table-alloc-ablation.ts`, and `table-time-attribution.ts` called the
**reference bytecode interpreter** (`src/table/exec.ts`, now `execRules`)
“table” and the **shipped assembler** reached by `compose()`/`pm-macro:`
“codegen”. Source codegen was deleted in `37c57b5`; nothing after that commit
measured it. Thus “compiled → table +82%” means shipped assembler versus
reference bytecode. The figures remain evidence for those exact legs, but their
old labels were wrong. See `docs/design/canonical-fixture-benchmark.md` and
INV-11 in `scripts/check-invariants.mjs`.

The owner’s G5 ruling was:

> “basically, you should be reasoning about quickly building the grammar
> reference on run start, making some swaps on rules or sub-rules (leafs), and
> then the run actually runs with no logic branching for that option input”

## Artifact-size evidence

`bench/table-size.ts`, historical artifacts under `/tmp/pm-table-size/<unit>/`:

| rules | old source-codegen B | gzip | table B | gzip | words | ratio |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 8,354 | 2,250 | 340 | 252 | 38 | 24.57× |
| 32 | 161,242 | 20,516 | 3,838 | 1,341 | 813 | 42.01× |

The fitted marginal costs were **4,932 B per distinct node rule**, **186 B per
additional call site**, and **113 B/rule** for the ladder table: 43.7× smaller
on that ruler. JSON’s nine productions were **1,072 B table vs 16,203 B source
codegen** (15.1×). The old fixed driver was ~26 KB of unminified TS source and
broke even around five ladder-shaped rules; that was not a bundled package-cost
measurement. `example/css` was 247,553 B for 26 source-codegen productions.

Variant probe (`bench/table-variants.ts`):

| host mode | line tracking | table bytes | opcode mix |
|---|---|---:|---|
| ast | false | 2,078 | LIT 32, RX 16, NODE 17, tracking twins 0 |
| ast | true | 2,131 | tracking twins 32/16/17 |
| cst | false | 2,078 | same non-tracking rows |
| cst | true | 2,131 | tracking twins |

The four tables totalled **8,418 B** and the reference driver read **0 options**.
For scale, the 16-rule source-codegen ladder was 82,273 B for one variant.

## Reference-bytecode performance evidence

These numbers do **not** compare today’s assembler against deleted codegen. They
explain why the reference bytecode driver was not selected as the shipping
engine and which boundary removals helped it.

Scaling (`bench/table-scaling.ts`; loaded control ±3.3%, quiet control ±1.3%):

| records | bytes | loaded ratio | quiet ratio | after fuse/collapse |
|---:|---:|---:|---:|---:|
| 1 | 81 | 2.28× | 2.27× | 2.00× |
| 8 | 641 | 3.08× | 3.00× | 2.55× |
| 64 | 5,121 | 3.12× | 3.08× | 2.61× |
| 1,024 | 81,921 | 3.29× | 3.17× | 2.65× |

From 8 to 1,024 records, 128× more work changed the ratio only 4–7%; the old
driver asymptoted near 3.2× (also summarized as ~3.1× in the first contest)
before fusion and 2.65× after it.

Two proposed causes were refuted:

- mark allocation measured −20.7% once and +1.6% next, so it did not replicate;
- removing trivia from the input left gaps at +94/+281/+251 versus
  +99/+217/+245 with trivia, so trivia did not explain the gap.

Two boundary-elimination mechanisms worked:

- direct LIT/RX execution inside SEQ: **−3.7/−8.2/−6.7%** versus A/A
  **+2.3/+2.3/−0.2%**;
- fusing `transform(sequence(...))` into `SEQX` and collapsing pure `OP_RULE`
  indirections: **−17.9/−24.7/−25.8%** versus A/A
  **+1.6/+0.7/+0.3%**.

The latter reduced words JSON **116→108**, CSV **82→76**, language **301→277**,
and GraphQL **426→386**, removing RULE rows. Because it changed encoder and
driver together, its A/B froze both baselines.

Best loaded contest (`bench/table-speed-ab.ts`, load average 91 within the
machine's observed 90–120 range, 20 interleaved pairs; minima used because
medians moved ±20–50%):

| leg | small | medium | large |
|---|---:|---:|---:|
| assembler A/A control | −1.6% | −3.0% | −2.0% |
| shipped assembler → reference bytecode | +82.0% | +228.1% | +275.4% |
| shipped assembler → combinator interpreter | +181.9% | +831.1% | +755.6% |

Field contest after fusion (`bench/table-vs-field.ts`):

| leg | small | medium | large |
|---|---:|---:|---:|
| assembler A/A control | −3.5% | +1.4% | −2.2% |
| assembler → reference bytecode | +61.4% | +134% | +152% |
| bytecode → chevrotain | −4.6% | +46.7% | +43.4% |
| bytecode → peggy | +112% | +199% | +159% |
| bytecode → parsimmon | +438% | +677% | +633% |
| bytecode → nearley | +519% | +1,113% | +1,188% |
| bytecode → jison | +463% | +720% | +721% |

Earlier runs at load 43.7 and quiet 6.1 respectively measured assembler→bytecode
`+70.3/+165/+188` and `+78.0/+163/+184`; bytecode→chevrotain
`−10.3/+31.9/+23.5` and `−10.0/+30.4/+25.6`; bytecode→peggy
`+92.0/+159/+123` and `+92.0/+165/+124`; bytecode→parsimmon
`+388/+611/+549` and `+391/+595/+551`; bytecode→nearley
`+434/+1005/+1017` and `+454/+989/+1021`; bytecode→jison
`+397/+639/+627` and `+412/+614/+611`. Their controls were
`−1.4/+0.2/−1.7` and `−1.3/+1.7/−2.7`.
The after-fusion run was taken at load 6.6.

Those historical field bars held, but are not current release-margin evidence.

The prototype also proved that several then-current authoring-size rules were
source-codegen-specific and needed re-derivation: ~950 B per call site;
`node()` 3,425 B versus `transform()` 46 B; `keywords()` versus `word()` at
18.6×; `g.X` versus by-const at 13.69×; and promotion sweeps moving CSS
28.47×→17.71× and Less 16.22×→10.08×. These are preserved as old artifact
measurements, not current grammar advice. The semantic spread/child/arity and
trivia contracts for the then-counted 95 exports were expected to survive.

## Correctness evidence that must not be lost

The initial lowering sweep found **29/29** identical cases across JSON, the
node-scale ladder, the base grammar, and the 29-rule Less workload. The expanded
sweep encoded every in-repo grammar and found **42/42** fixture cases identical:

| grammar | encoded words |
|---|---:|
| CSV | 82 |
| JSON | 122 |
| language | 301 |
| GraphQL | 426 |
| Less workload, 29 rules | 1,277 |
| CSS | 606, including 5 CALL rows |

The gate caught tree-only defects that pass/fail checks missed:

- nullable rules cannot carry a first-set guard;
- trivia precedes the first repetition item too;
- O(1) dispatch requires encode-time **disjointness**, not stale shallow
  `def.disjoint` on unresolved rule refs;
- `optional()` yields `null`, not `undefined`;
- `token()` is not transparent: it clears trivia and capture sinks, then emits
  one leaf;
- `balanced()` overrides parsing to resolve ambient `scanSkip`, so structurally
  encoding only its eager `_def` changes behavior;
- `OP_LEAF` must be a capture boundary;
- `OP_REP` must apply leading trivia to a mandatory first item.

The `scanTo` gap was originally closed with an opaque CALL to the real
combinator. `keywords()` reused RX; `expect` added one row; longest-literal and
shared-prefix choices preserved their defined ordering. `greedyClassify` and
choices with `autoNot` were refused rather than approximated.

Historical Jess grammar call-site census:

| construct | sites |
|---|---:|
| `node` | 402 |
| `field` | 32 |
| `dispatch` | 29 |
| `scanTo` | 22 |
| `keywords` | 21 |
| `balanced` | 12 |
| `expect` | 11 |
| `guard`, `recover`, `withCtx` | 0 each |

The 113 B/rule figure was ladder-specific: JSON was 119 B/rule and Less was
1,277 words / 29 rules = **44.0 words/rule**. CSS and Less speed were not
measured in that early bytecode prototype.

## Three-way Jess corpus harness

`bench/jess/` ran interpreted | source-compiled | reference-bytecode in separate
processes and asserted each engine identity. Do not substitute `compose()` for
the macro leg. Identity covered every `RunResult` facet—value, span/failure
position, ordered expected set, recovery errors, and root trivia—not only the
tree. The SCSS corpus was the first 400 sorted sass-spec inputs; `JESS_ROOT`
selected the checkout.

After fixing OP_LEAF capture and mandatory-repeat trivia:

| dialect | files | identical | bytecode outlier | interpreter outlier | source-compiled outlier | three-way |
|---|---:|---:|---:|---:|---:|---:|
| css | 87 | 58 | **0** | 2 | 18 | 9 |
| scss | 400 | 315 | **0** | 83 | 0 | 2 |
| jess | 3 | 1 | **0** | 0 | 2 | 0 |
| less | 136 | 130 | **0** | 0 | 6 | 0 |

Across all 626 files, reference bytecode was never the sole outlier. The
remaining disagreements exposed drift between the two then-shipping engines;
compiled Less changed value/span on six fixtures where interpreter and bytecode
agreed.

Two public-diagnostic questions remained in the historical harness:

- `keywords()` inconsistently produced `['keyword']` versus its word list. A
  word-list fix grew GraphQL 149 B (**+0.21%**) beyond its 0.1% size slack and
  was not landed without an owner ruling.
- `routed()` could overwrite a better furthest failure with the opaque
  expectation `['routed()']` because failure state was last-write-wins.

Current differential and release ledgers, not this historical note, decide
whether either remains open.

## Separate interpreter-only finding

`bench/choice-disjoint-lazy-arms-repro.ts` compared identical direct and
rule-referenced arms. Shallow construction marked the latter non-disjoint:

| control/repro | 64 items | 512 items |
|---|---:|---:|
| direct → direct | +0.2% | −0.0% |
| direct → rule-referenced | +35.7% | +40.3% |

Only the combinator interpreter was affected. Source codegen recomputed deep
first sets, diagnostics correctly reported `recoverable`, and parse results were
identical. Do not cite this as evidence about the current assembler.

## What carries forward

The durable result is architectural: bind options and grammar facts while
building a compact TableProgram, then run closures with no option branch. The
durable performance clue is boundary elimination—direct terminal execution and
parent/child or transform/sequence fusion—not bytecode interpretation itself.
Current prototypes must use production dynamic coverage, current artifacts, an
A/A control, complete-result differentials, and the fixed piece/token interface.
