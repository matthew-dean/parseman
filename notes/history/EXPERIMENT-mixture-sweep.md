# Mixture sweep — per-construct {shared-driver, specialised}

Status: **deterministic half complete and committed. NO TIMING TAKEN.** The
Pareto curve below has one real axis (bytes) and an empty one (ns/parse). Do not
quote a speed conclusion from this file; there isn't one in it yet.

Branch `exp/mixture`, based on `origin/release/0.47.0` =
`6bc265f5b854b256a2e8ea0df5522ca7cfd57770`. node v24.11.1, parseman 0.47.0.
Grammars from `JESS_ROOT=/Users/matthew/git/oss/jess`, four shipping dialects,
`ast` variant. Raw rows: `notes/results/mixture-sweep.jsonl` (208).

## What the axis is, and what it is NOT

The brief asked for `table` vs `inline codegen` via `src/compiler/codegen.ts`.
That file does not exist at this SHA and the axis as stated is not available.
What exists is TWO engines:

- **shared-driver** — `src/table/exec.ts`, one `switch` over the instruction
  stream, executed once per row.
- **specialised** — `src/table/assemble.ts` + `src/table/emit-assembly.ts`, one
  body per site.

`emit-assembly.ts` has exactly one importer in `src/` (`assemble.ts:101`) and
one consumer (`new Function`, `assemble.ts:2536`), so "linked closure" and
"emitted source" are the same engine either side of a codegen step — not two
lowerings, and not a design axis. Sweeping them would have measured the presence
of `new Function`.

**The specialised leg is reached via `new Function`. That is experimental
scaffolding.** The shipped form is build-time emitted source of the same shape,
which is why the emitted form was chosen over the closure form despite the
closure form being the one that avoids `new Function`: build-time emission
produces per-site function declarations, and per-literal IC feedback on those is
the entire premise of `emit-assembly.ts`. The closure form is procedurally
cleaner and models the destination worse. Every JSONL row carries
`specialisedVia` saying so.

## The instrument

`PM_MIX_DRIVER=NODE,LEAF` names the construct kinds given to the shared driver;
everything else stays specialised. `*` is all; a leading `-` removes, so
`*,-NODE` is the all-shared endpoint with NODE alone specialised. Read once at
module load — by parse time the choice is already expressed as which body each
site got, not as a branch.

Three pieces, each of which had to be right before a number meant anything:

**`src/table/cell.ts`** — one `FAIL` symbol and one end-position cell per
assembly. Both engines previously minted a private `Symbol('pm.fail')` and held
a private `let END = 0`. Sound while one engine runs a whole parse; fatal the
moment two are live, because a piece returning A's sentinel to a caller in B is
a VALUE to B (`!== FAIL` is true) and a failed match reads as a success carrying
a symbol. **This is NOT a live 0.47 defect** — see below.

**`exec.ts`'s `OVR`** — dense over code offsets, holding the specialised piece
for specialised sites and `undefined` for the driver's own. One load and one
`undefined` test at `exec`'s entry is the whole seam. A pure-driver
configuration passes an all-`undefined` array and pays the identical load: a
mechanism only the mixtures paid for would read as "mixtures are slower" and be
indistinguishable from a finding.

**`emit-assembly.ts`'s stub** — a flipped site emits
`return DRV(<ip>,input,pos,ctx)`. The specialised body is still produced and
DISCARDED, deliberately: `lower` is also how children get linked, so an early
return would leave a flipped site's SUBTREE unemitted and each of those children
would fall to the driver too. "Flip NODE" would then measure NODE and everything
beneath it, and the per-construct axis would be a fiction.

## Validity

**Identity.** 13 configurations on less/ast, including all-shared, digest
IDENTICALLY to the all-specialised endpoint. Across the full 208-row sweep:
0 errors, 0 rows with `ok !== true`, **0 rows where `consumed !== bytes`**. No
configuration bought anything by parsing less of its input.

**Refactor control.** `cell.ts` touched all three parsing files and must change
nothing. Digested the full corpus on unmodified `6bc265f` and on the branch,
both engines, four grammars (less 315 / css 88 / scss 2409 / jess 25 rows):
byte-identical in all eight cells.

**Positive control.** Identical digests prove correctness and say nothing about
whether the knob is CONNECTED — an inert knob produces the same clean sweep. So
every row also carries driver rows executed. The all-specialised endpoint runs
**0** driver rows (built, never called); every flip shows rows appearing with
the flipped construct on top.

That control caught a real defect in itself. The row counter fired at `exec`'s
entry, BEFORE the override check, so it charged the driver for every entry it
immediately handed back: `*,-NODE` reported NODE:104,891 driver rows for a
construct the driver never executed. The control meant to prove the mix routed
was reporting that it hadn't. Counter moved after the seam.

**Mechanism control.** A construct with zero sites in a dialect is a mix that
selects nothing and still pays the whole machinery. less has no XFORM site
(`SEQX`/`NODE` absorb them at encode time), so `PM_MIX_DRIVER=XFORM` on less is
an all-specialised parse carrying the mixture cost: 0 driver rows, **+28,764 B**
from `byIp` listing every site so `OVR` can be filled. Every mixed byte count
below is net of that per-dialect constant.

## Result 1 — the size question, answered

| dialect | all-specialised | all-shared | ratio |
|---|---:|---:|---:|
| css | 1,021 KB | 125 KB | **8.2x** |
| less | 1,986 KB | 218 KB | **9.1x** |
| scss | 1,369 KB | 138 KB | **9.9x** |
| jess | 1,443 KB | 160 KB | **9.0x** |

The 43.9 MB of generated grammar JS has a **9x** lever in it, at unknown speed
cost. That is the whole point of the sweep and the number the curve has to be
paid for against.

## Result 2 — bytes are perfectly separable

The forward sweep (flip one FROM all-specialised) and the reverse sweep (flip
one TO specialised FROM all-shared) return **the same number for every
construct, to the byte** — CHOICE 508 KB both ways on less, SEQV 440, NODE 240.

The brief predicted these two rankings would disagree, and that the disagreement
would locate the interaction effects. **On the byte axis they do not disagree at
all.** Bytes are additive across constructs, so the byte half of the Pareto
curve is fully determined by the single-flip rows and the greedy phase cannot
discover anything about it. Any interaction effect this sweep finds will be in
TIME, and time is what has not been measured.

## Result 3 — the byte ranking (KB saved by sharing, net of mechanism)

| construct | css | less | scss | B/driver-row (less) |
|---|---:|---:|---:|---:|
| CHOICE | 207 | **508** | 353 | 5.09 |
| SEQV | **231** | 440 | 347 | 2.83 |
| NODE | 121 | 240 | 141 | 2.29 |
| REPV | 42 | 137 | 106 | 4.58 |
| OPT | 55 | 106 | 62 | 2.52 |
| RX | 52 | 89 | 76 | 1.24 |
| SCOPE | 55 | 79 | 52 | 0.98 |
| NOT | 21 | 40 | 25 | 2.39 |
| REP | 33 | 39 | 7 | 2.26 |
| LIT | 27 | 37 | 28 | 0.83 |
| DISPATCH | 23 | 21 | 20 | **13.66** |
| GATE | 3 | 8 | 4 | 0.37 |
| FIELD | 1 | 3 | 0.4 | 0.24 |

Ranking is stable across dialects. Six constructs — CHOICE, SEQV, NODE, REPV,
OPT, RX — carry **77%** of the recoverable bytes on less.

`B/driver-row` is bytes-saved per row the driver then has to execute: a crude
density for "how much artifact does this construct cost per unit of interpretive
work it would add". DISPATCH is the outlier at 13.66 (much source, few rows);
GATE and FIELD are near zero, meaning sharing them costs interpretive work and
recovers almost nothing.

**jess's row counts are not usable.** Its fixture (`benchmark.jess`) is 124 B,
so row counts are 1-2 and `B/row` reads in the tens of thousands. jess's BYTE
column is sound; its density column is noise and is excluded above.

## What is NOT measured

**ns/parse — none of it.** The box was at loadavg 10.7 against a ceiling of 6
and `bench/jess/fixture.ts` was correctly refusing to measure. 0.47 lanes hold
the timing floor and this sweep is 0.48, so it yields. Every JSONL row has
`timing: null`.

Until that exists there is no Pareto curve, only its x-axis. **A 9x size lever
is not a recommendation.**

## Predictions this will test

`design/balance` and `exp/wiring` predict, and the curve will confirm or refute
each explicitly rather than leaving it to be read off:

1. Shared-driver WINS where a slot sees one callee kind; loses where a parent
   dispatches to several. NODE (718 sites, 10.9%, the reducer-invoking and
   child-kind-dispatching construct) is the sharpest test.
2. Wiring shape is free — direct name / array index / object property / closure
   capture are indistinguishable. So `OVR`'s array indirection should NOT be
   visible in the numbers. If it is, something else is going on.
3. Callee bytecode size is the binding constraint, threshold 460, and 17-28% of
   real pieces are already past it (less 53/319). This predicts sharing may win
   MORE than (1) implies, because specialisation spends body size on exactly the
   composites already at the ceiling.

## Caveats carried on every row

- `capoffLanded: false`. Not a bias — the cap label is provably inert here
  (`triviaScan` is null in every slot of every grammar, so `hasScan` is false,
  so `emit-assembly.ts:529`'s ternary is unreachable and forcing CAP_OFF emits
  byte-identical source). It is a DENOMINATOR change: at ~28% self-time in
  trivia, capoff's real fix moves the total every construct's marginal value is
  expressed against, so the ranking may reorder without anything being tilted.
  Re-take the ranked top configs when it lands.
- `specialisedVia` — `new Function`, scaffolding, see above.

## Adjacent findings (not this lane's to fix)

- **`cell.ts` is a 0.48 enabler, NOT a 0.47 fix.** A single parse cannot cross
  engines in production: the `TableRule` ABI converts `FAIL` to `-1` at every
  rule-map boundary (`exec.ts` and `assemble.ts:2782`, symmetric) and
  `stamp.ts:118` `entryFn` converts `-1` to `{ok:false}`, so only a
  `ParseResult` and a number cross. No un-adapted piece can be obtained —
  `grep '\.pieces\['` is zero outside `assemble.ts`, `d.exec` has no caller
  outside `exec.ts`'s own `runRule`. `stamp.ts:143-146` names the embedded-child
  case explicitly, so it is a known handled configuration rather than one nobody
  considered. `linker.ts:331` throws rather than falling back to a mixed form.
- **Two shipped paths bind the interpreter by import-name collision.**
  `linker.ts:24` and `fold.ts:1` bind `exec.ts`'s `tableRules`, while
  `index.ts:28` exports `assembledRules as tableRules` for everyone else, and
  `emit.ts:265` emits `import { tableVariants }` into generated modules. So
  `compose()`/`fuse()` and folded artifacts appear to run the slower engine.
  Handed to `lane/linker-engine`; deliberate-vs-defect not established here and
  no number claimed.
