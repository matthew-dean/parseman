# How pre-written pieces get wired together at run start — measured

Branch `exp/wiring`, base `origin/release/0.47.0` = `6bc265f5b854b256a2e8ea0df5522ca7cfd57770`.
Node `v24.11.1`, parseman `0.47.0`.
`src/` realpath: the `exp/wiring` worktree; `src` DIRTY throughout (the `setWiring`
hook below is the dirt, and it is recorded on every result row rather than hidden).

Raw records: `notes/results/wiring-sweep.jsonl`.

**Every number in this file is deterministic** — bytes, site counts, V8 trace
decisions, bytecode sizes. Not one wall-clock measurement was taken, and none is
needed for any conclusion drawn here. The timing floor stayed with `exp/cliff`.

---

## The instrument

`src/table/emit-assembly.ts` prints the assembly as text and `assemble.ts:2550`
compiles it with `new Function`. This branch adds `setWiring()` — read once per
ASSEMBLY, never on a parse path — which intercepts that text. `bench/wiring/rewire.ts`
mechanically respells *"piece A calls piece B"* seven ways and hands the result
back. Everything else is the shipped path: the real driver, the real reducers,
the real corpora from `bench/workloads`.

`new Function` is the measurement vehicle, not a proposal. The point of the sweep
is to decide which shape the MACRO should print into shipped source, where no
`Function` constructor exists.

Two guards, because a wiring leg that silently falls back to the baseline is this
repo's most-shipped defect:

- the splitter accounts for every byte of its input and **throws** if it cannot
  (it did throw, on `example/css`, which interleaves `const _r_Entry=_pf878`
  between piece declarations — that is why the css row exists at all);
- every leg's parse result is compared against the unrewritten one. All seven
  wirings parse **identically** on every workload measured.

---

## 1. WIRING SHAPE DOES NOT MATTER. Callee BYTECODE SIZE does.

`json/document`, 60 parses, `--trace-turbo-inlining`, counting DISTINCT emitted
pieces:

| wiring | considered | inlined | refusals |
|---|---:|---:|---|
| w0 direct hoisted name | 36 | 19 | reason5 × 11 |
| w1 array of refs, indexed at each site | 35 | 19 | reason5 × 14 |
| w2 object property → local const at link | 36 | 19 | reason5 × 11 |
| w3 closure capture of the callee | 36 | 19 | reason5 × 11 |
| w4 monomorphic wrapper over shared body | 60 | 38 | reason5 × 8 |
| **w5 switch dispatch on a small integer** | **33** | **9** | **reason5 × 53** |
| w7 partial sharing (snapshot prologue) | 52 | 22 | reason5 × 11 |

Strategies 1, 2, 3 and 5-as-"indirect call" collapse into one row, at real body
sizes. `design/balance` found this with 51-byte synthetic pieces; it **holds at
800-byte real ones**. Those four are closed.

### The trap this nearly shipped

The first run of that table read w1/w2/w3 at **1 inlined** against w0's 19 — a
19× collapse, a clean and plausible number, and entirely an artifact. Those three
rewrites turn `function _pf12(…){…}` into an *anonymous* function expression;
an anonymous function's `SharedFunctionInfo` has an empty name, so it vanishes
from the trace and reads as "V8 never considered it". Naming the expressions
(`P[0]=function _pf0(…)`) fixed it and the collapse disappeared. Recorded because
the fix is one character wide and the wrong answer was publication-shaped.

### What DOES control it

Every piece V8 refused with `Cannot consider … (reason: 5)` is exactly the set
over **460 bytecode bytes**:

| refused | bytecode | | considered/inlined | bytecode |
|---|---:|---|---|---:|
| `_pf12`, `_pf56`, `_pf83` | 801 | | `_pf33`, `_pf24` | 424 |
| `_pf92` | 746 | | `_pf51`, `_pf78` | 323 |
| `_pf43`, `_pf70` | 647 | | `_pf116` | 322 |

The cutoff is bracketed between 424 (inlines) and 647 (refused).
`--max-inlined-bytecode-size` defaults to **460** and sits in that gap.

**Proved by moving the flag.** Re-run with
`--max-inlined-bytecode-size=900 --max-inlined-bytecode-size-cumulative=5000`:
zero `Cannot consider` rows, and every previously-refused piece inlines —
`_pf12` into `_pf43` and `_pf70`, `_pf43` into `_pf56`, `_pf92` into `_pf56` and
`_pf70`. Same source, same wiring, one flag.

### There is no 460–4,600 dead zone

920 and 4,600 are `--max-inlined-bytecode-size-cumulative` and `-absolute` —
**caller-side budgets, not callee sizes**. 460 is the per-callee limit and it is a
hard cliff, not the bottom of a zone. Nothing above it inlines at any N. The
predicted dead zone was a misreading of three flags as one axis.

### The one wiring that costs something

**w5 switch dispatch: 9 inlined against 19, and 53 reason-5 refusals.** Routing
every call through one `_disp(id, …)` makes the dispatcher a second distinct
callee at every site — `design/balance`'s "the cliff is the second distinct
callee FunctionLiteral", reproduced on real pieces. Switch dispatch is the only
one of the seven that is actively worse, and it is worse for a reason that
generalises: *any* shared indirection layer in front of the pieces costs the
callers their inlining.

---

## 2. How much of a real grammar is already past the ceiling

Bytecode size per emitted piece, `--print-bytecode`, pieces reached in two parses:

| workload | pieces | min | p50 | p90 | max | **over 460** |
|---|---:|---:|---:|---:|---:|---:|
| json/document | 28 | 58 | 84 | 801 | 801 | **6 (21.4%)** |
| graphql/document | 74 | 58 | 323 | 801 | 3,974 | **21 (28.4%)** |
| css/stylesheet | 103 | 59 | 246 | 726 | 3,600 | **20 (19.4%)** |
| less/stylesheet | 319 | 59 | 202 | 568 | 2,813 | **53 (16.6%)** |

Source bytes, for comparison (`json`: min 93, p50 198, p90 2,277, max 2,520;
`less/stylesheet`: min 105, p50 567, p90 1,528, max 4,877) — roughly 3:1
source-to-bytecode, so ~1,400 source bytes is the practical inlining ceiling.

**The over-460 set is precisely the COMPOSITE pieces** — sequences and repeats,
i.e. the parents. That has a direct consequence for the child-kind axis
(`RELEASE-0.48-TARGET.md` §8b) and for D7: specialising a parent per child kind
spends bytecode budget on the one class of piece already at the ceiling. It
recovers inlining of the CHILD and can push the PARENT past 460, losing the
parent's own inlining into ITS parent. **There is a budget, and it is 460
bytecode bytes per piece.** No design that grows composite bodies is free.

---

## 3. OVERGENERATION — owner-named, and it costs about half of what it looks like

"trying with generating some functions that don't get used and some that do"

Axis: `trackLines`, aligned site-for-site between the two emitted variants.

| workload | sites | identical bodies | differing | **option-INVARIANT** |
|---|---:|---:|---:|---:|
| json/document | 28 | 12 | 16 | **42.9%** |
| graphql/document | 94 | 45 | 49 | **47.9%** |
| less/stylesheet | 349 | 136 | 213 | **39.0%** |

| workload | one variant | overgenerate ALL | overgenerate MOVERS |
|---|---:|---:|---:|
| json/document | 24,776 B | 46,374 B (+87.2%) | ~32,342 B (**+30.5%**) |
| graphql/document | 112,042 B | 219,979 B (+96.3%) | ~173,753 B (**+55.1%**) |
| less/stylesheet | 268,576 B | 529,786 B (+97.3%) | ~394,972 B (**+47.1%**) |

The overgenerated module was BUILT AND RUN, not modelled: it parses identically
to the baseline, and the live half is the untouched direct-name wiring, so the
un-picked variant's runtime cost is measured zero rather than asserted zero.

**Two corrections to the brief's standing figures.** The brief carries "~80% of
piece bodies are option-INVARIANT" and "`trackLines` changes 16–21% of them".
Measured on the emitted assembly, `trackLines` changes **57%** of bodies on json,
**52%** on graphql and **61%** on less. The invariant fraction is **39–48%**, not
~80%. Whatever the 80% described, it is not bodies of emitted pieces under
`trackLines`.

**The synthesis is the finding.** Overgenerating everything roughly doubles the
artifact. Overgenerating only the bodies that MOVE, and sharing the ~40% that do
not, costs **+30% to +55%** instead of +87% to +97% — for the same zero runtime
cost and the same parse. Overgeneration is viable; *naive* overgeneration is what
is expensive, and the two are not the same proposal.

---

## 4. PARTIAL SHARING — owner-named, and the largest single byte win found

"trying with sharing some parts of that and not others"

`emit-assembly.ts`'s own criterion is that **a shared emitted-scope helper is
sound exactly when it takes no piece as an argument**. That criterion is a
decomposition rule, not an all-or-nothing verdict on a piece, and nothing had
exercised it below the level of a whole piece.

The emitted sequence-term prologue snapshots six CST sink lengths so a zero-width
term can be roll back. It takes no piece. It is repeated at every sequence term.
Sharing it (`w7-shared-snapshot`) and leaving the dispatch and the child call per
site:

| workload | baseline | shared prologue | delta | inlining |
|---|---:|---:|---:|---|
| json/document | 24,776 B | **18,540 B** | **−25.2%** | 22 inlined vs 19 — *better* |

−25.2% of the emitted artifact, identical parse, and **more** inlining than the
baseline, because shrinking the composite bodies moves some of them back under
460. That is the mechanism in §1 and §2 working for us rather than against us:
partial sharing is not merely a byte trade, it *buys back inlining* on exactly
the composite pieces that are over the ceiling.

This is the one strategy of the seven that is unambiguously positive on every
axis measured, and it is the one the design work had not costed.

---

## 5. The monomorphic wrapper (D7)

| workload | sites | distinct bodies | wrapper cost |
|---|---:|---:|---:|
| json/document | 28 | 27 | +5.8% bytes |
| graphql/document | 94 | 81 | — |
| less/stylesheet | 349 | 296 | — |

**There is almost nothing to share.** 27 of 28 json bodies are distinct; 296 of
349 on less. A shared-body-plus-wrapper scheme has no deduplication to pay for
the wrapper with, so on today's emitted shapes the wrapper is close to pure byte
cost (+5.8%) — it neither loses inlining (38 inlined, wrappers and impls both) nor
gains bytes.

That is a statement about the CURRENT shapes. D7 proposes wrappers for cold sites
under a child-kind specialisation that does not exist yet, and that specialisation
would change the distinct-body count. The measurement to keep is the denominator:
**wrappers only pay when bodies actually repeat, and today they do not.**

---

## 6. What this says the macro should emit

1. **Print per-site named function declarations at macro time.** The wiring
   spelling is free — name, array slot, object property and closure capture are
   indistinguishable to V8 at every size measured — so choose the one that is
   simplest to emit and cheapest to link. That is direct hoisted names, which is
   what `emit-assembly.ts` already prints. The run-start step then LINKS and does
   nothing else.
2. **Never route calls through a shared dispatcher.** Switch dispatch halves
   inlining (19 → 9). Any shared indirection in front of the pieces does the same.
3. **Treat 460 bytecode bytes as a hard per-piece budget.** 17–28% of real pieces
   are already over it. Any change that grows composite bodies — child-kind
   specialisation above all — must be costed against it.
4. **Overgenerate only the bodies an option MOVES.** +30–55% instead of +87–97%,
   for the same zero runtime cost.
5. **Share the option-invariant, piece-free prologues.** −25.2% of the artifact on
   json, and it buys inlining back.

## 7. Still open

- The `new Function` at `assemble.ts:2550` is untouched by this work. This sweep
  says WHAT the macro should print; it does not print it.
- `src/combinators/grammar.ts:103` still reads `opts.trackLines ?? _ctx?.trackLines`
  on scope entry, mid-parse. Not fixed here.
- The emitted sequence-term prologue branches on `ctx.trivia === undefined` **per
  term**, inside the piece body — an option-shaped consult on the parse path that
  §10.5's `forCtx` write-up does not mention. Found while reading the emitted json
  text; not investigated.
- Every figure here is `trackLines: false` except the overgeneration alignment,
  and `w4`'s byte cost is measured on json only.
- No wall-clock number anywhere in this file. The ranking in §6 is an inlining and
  byte-count ranking; whether −25.2% bytes and +3 inlined pieces is worth
  milliseconds is unmeasured.
