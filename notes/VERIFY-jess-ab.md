# VERIFY: the `bench/jess/ab.ts` claim that 0.47 beats 0.46

Date 2026-08-06 · box `darwin/arm64`, node v24.11.1, 1-minute loadavg 4.1–6.0 throughout
(gate 6, `bench/jess/grammars.ts` `LOAD_CEILING`) · machine-readable results in
`notes/VERIFY-jess-ab-sweep.json`.

## Verdict

**The claim does not survive. It is inverted.**

The reported table said 0.47 was 0.759×/0.755×/0.786×/0.939× of 0.46 — a win on all four
shipping grammars. Running **that same harness at that same commit** (`b21777a`) produces the
opposite result, and so does an independent per-anchor runner that shares none of its code:

| grammar | fixture | claimed 0.46 | **measured 0.46** | measured 0.47 | real ratio |
|---|---|---:|---:|---:|---:|
| less | benchmark.less 107 KB | 46.95 ms | **17.19 ms** | 34.57 ms | **2.01× SLOWER** |
| less | gen-workload.less 275 KB | 208.82 ms | **48.45 ms** | 153.08 ms | **3.16× SLOWER** |
| scss | gen-workload.scss 288 KB | 140.84 ms | **33.30 ms** | 95.87 ms | **2.88× SLOWER** |
| css | benchmark.css 123 KB | 20.74 ms | **5.22 ms** | 19.71 ms | **3.78× SLOWER** |

The **0.47 column reproduces** (claimed 35.63 / 157.65 / 110.65 / 19.47 against measured
34.57 / 153.08 / 95.87 / 19.71). The **0.46 column does not**, by 2.7×–4.0×. As my brief
anticipated, the 0.46 leg was the number carrying the claim, and it is the one that is wrong.

Owner's recollection is correct: benchmark.less was not parsing at 47 ms. It parses at ~17 ms,
and has since at least 0.44.0.

**And it is not "0.47 recovers a regression 0.46 introduced" either.** The curve is flat across
0.44 → 0.46 and turns at 0.47. 0.46 is a perfectly good anchor. 0.47 is the regression.

## The curve

Absolute milliseconds, one parse, median of 7 round-medians, every anchor path-resolved into its
own worktree `src/` and self-checked. Full provenance per row in the JSON.

| version | sha | benchmark.less | gen-workload.less | benchmark.css | gen-workload.scss |
|---|---|---:|---:|---:|---:|
| 0.44.0 | `80d0e62` | 17.26 | 49.15 | 5.47 | 36.23 |
| 0.45.0 | `7d1817f` | 16.84 | 48.23 | 5.23 | 32.69 |
| 0.46.0 | `a5dc9bd` | 17.19 | 48.45 | 5.22 | 33.30 |
| **0.47.0** | `45eb01a` | **34.57** | **153.08** | **19.71** | **95.87** |

`bench/workloads/config.json`'s `peak` (0.45.0, `7d1817f`) is genuinely the peak — but 0.46 sits
within ~2% of it on every fixture, which is inside this sweep's own self-check spread. There is no
0.28→0.34-style accumulating bleed here. There is one step, and it is the current release.

**0.39.1 – 0.43.0 (`b792522`, `dac82db`, `a6fdac2`, `4ced600`, `dc65a5b`, `1222110`) are DROPPED**,
not skipped: none can lower jess's current grammars. All six fail identically and immediately, on
all three dialects —

```
packages/syntax/less/less-parser/src/grammar.ts:6524 — composeLeaf() must macro-fuse;
runtime composition is forbidden
```

The grammars are written against 0.46 and use a `composeLeaf()` contract those releases do not
have. This is a real limit on how far back the curve can reach, not a harness problem, and no
amount of contorting the runner would fix it. 0.44.0 is the oldest reachable anchor.

## What `ab.ts` gets wrong

The harness's *arithmetic* is fine. Run cleanly it prints the right answer — my own run of it
reports `2.044x`, `3.175x`, `3.559x`, `2.820x`, i.e. HEAD slower, matching the independent runner
to within 3%. Three defects sit around that arithmetic.

### 1. The reference side is whatever the PREVIOUS run left behind (the one that produced the claim)

`bench/jess/ab-hooks.mjs` `refSrcPath()` reads the pointer file `.cache/jess-ab-refsrc` and
memoises it. `load()` calls it for **every** module, including the untagged ones — `ab.ts` itself,
`ab-harness.ts`, `grammars.ts`, `digest.ts`. Those load *before* `main()` runs, and `main()` is
what writes the pointer. So the value memoised is the **previous invocation's** reference, and the
run then measures against it while printing the sha you asked for.

The guard that is there anticipates the wrong failure:

```js
// An EMPTY answer is never cached. ...
if (refSrc === '') { refSrc = process.env.PM_REF_SRC ?? (existsSync(POINTER) ? readFileSync(POINTER, 'utf8').trim() : '') }
```

Empty is handled. **Stale is not.** Demonstrated, back to back, same command, same commit:

- `ab.ts less --self` immediately after a `--ref=a5dc9bd` run → **2.199× / 3.426×**, and
  `three-way agreement: *** NO ***`. It was measuring HEAD against 0.46 and calling it a
  self-check.
- `ab.ts less --self` again, pointer now holding its own sha → **0.998× / 0.992×**,
  `three-way agreement: YES`. Flat, as documented.

Nothing errors, nothing warns, and the protocol block prints the sha that was *requested*. This is
the most likely origin of the claimed table: a run whose reference side was silently some earlier
worktree. It is also the answer to "run `--self` and report it" — `--self` reads flat only when it
is not the first run after a different `--ref`.

**Fix:** read the pointer once, eagerly, in `register()`/`ab-register.mjs`, or refuse a pointer
file whose mtime predates process start.

### 2. `codegen vs codegen` is false at HEAD — it is table vs codegen

`ab.ts` refuses a mixed pair by name, and its protocol block prints
`engines HEAD codegen vs a5dc9bd codegen`. But `buildLeg`'s `codegen` branch means "whatever the
macro emits", and at HEAD the macro emits the **table**:

```
$ head -4 <HEAD-lowered less grammar>
// Generated by parseman v0.47.0 — DO NOT EDIT.
import { tableRules } from "parseman/table"
```

0.46's macro emits inlined codegen and imports no parseman runtime at all (its only `parseman`
import is `import type`). The sizes are not subtle — less: **11,676,050 B at 0.46 vs 1,074,385 B
at 0.47**, and the same ~11× gap on all four grammars. So the harness executes by default exactly
the pairing it refuses when spelled as flags, and `--head-engine=codegen` cannot be honoured at
HEAD at all.

This is defensible as *shipping vs shipping* — it is what jess gets from each release — but it must
be labelled that way. It is not codegen vs codegen.

### 3. The "5.35 ms artefact" is not an artefact — it is the real number

`ab.ts`'s `solo()` header, and the `--allow-mixed-engines` refusal message, both rest on this:

> a mixed-engine pair (HEAD table vs 0.46 codegen) read 5.35 ms for a leg that five other
> measurements read at 19.2–19.8 ms

**0.46 codegen genuinely parses benchmark.css in ~5.2 ms.** Measured three independent ways:
5.42 ms (ab.ts's own ref leg), 5.30 ms (single leg, own process, 60 warmups), 5.22 ms (the sweep,
two self-checked graphs). The "19.2–19.8 ms" cluster is **0.47's table** — 19.71 ms in this sweep,
19.29 ms from ab.ts's HEAD leg. Five measurements of one engine were used to convict a correct
measurement of the other.

The conclusion drawn from it — that mixed pairs are unstable and must be refused — is what kept
the 3.8× css regression from being visible, and the refusal message should be rewritten before it
does so again.

## Fixture parity — 0.47 parses 68.5% of benchmark.less and reports success

Spot-checking that both sides parse the same bytes turned up the opposite of the concern in my
brief. The 0.46 leg is not failing early; **the 0.47 leg is.**

| | 0.44 / 0.45 / 0.46 | 0.47.0 |
|---|---|---|
| `span.end` | 106802 | **73117** |
| `unconsumedFrom` | `null` | **73117** |
| `JSON.stringify(value).length` | 1098639 | **755598** |
| `errors` | `[]` | **`[]`** |
| `ok` | `true` | **`true`** |

0.47's table lowering of the Less grammar stops at byte 73117 of 106802 — 31.5% of the file
unconsumed — and reports `ok: true` with an empty `errors` array. The other three fixtures consume
100% at every anchor, so this is specific to benchmark.less.

`ab.ts` **does** catch this and prints
`three-way agreement: *** NO *** — the a5dc9bd codegen leg is the outlier`, differing on `value`
and `span`. Two things about that line: the outlier is named backwards — the leg that stops at 68%
is HEAD's, not the reference's — and the run then proceeds to `TIMED ANYWAY, CAVEATED`. Since it is
HEAD that truncates, **0.47 is 2.01× slower on benchmark.less while doing 68% of the work.** The
like-for-like figure is gen-workload.less, where all anchors consume 100% and 0.47 is **3.16×**
slower.

The correctness defect outranks the timing one and is not a benchmark question.

`RunResultRecord` vs plain `Object` is the only other cross-release difference and is a container
change, not a parse change — `ab.ts`'s `identity()` already handles it correctly.

## Provenance — every anchor proven to be itself

Required before any number above is quotable. All four measured anchors pass all of it; the JSON
carries it per anchor.

- **`realpath`** of each leg's `src/` terminates in `parser-thing/.cache/anchor-<sha>/src`. Every
  cross-worktree import is **path-resolved**, never bare: `ab-hooks.mjs` rewrites `parseman` and
  `parseman/*` to `<anchor src>/…` before node sees a specifier, so neither pnpm's virtual store
  nor jess's installed `parseman@0.46.0` is reachable. `NODE_PATH` is unset in every run.
- **`package.json` version === `src/version.ts`'s `PARSEMAN_VERSION`**, read at runtime from inside
  each leg's own graph: 0.44.0/0.45.0/0.46.0/0.47.0. `versionAgrees: true` everywhere.
- **Worktree sha === requested sha**, `git status --porcelain -- src` clean at all four.
- **Structural discriminator holds exactly.** `src/table/` exists at 0.47.0 and at **no** earlier
  anchor — checked at all ten, including the six dropped ones. No pre-0.47 leg can see a table.
- **No `link:`/`file:`/`workspace:`/`portal:`** entry for parseman in either lockfile. Nothing is
  a symlink into a live checkout. No leg is a `dist/` build; all four load `src/`.
- **Artifact digests are all distinct** — `fd6a23fd` / `8de64545` / `8e583bbe` / `d5afe445` for
  less, and distinct per grammar per anchor throughout. No two anchors are secretly one build.
- **Zero runtime fallbacks anywhere.** My leading hypothesis was that 0.46 could not fully lower
  grammars and was silently emitting interpreted subtrees. It is false, and cleanly so: `_rp[N].parse(`
  occurs **0** times in every artifact at every anchor, `transformMacro` returns **0** warnings, no
  `PARSEMAN_DEGRADATION` record is emitted, and no inline-expansion cap site is reported. 0.46
  lowers all four grammars completely. The result is not "0.47 beats a capped 0.46" — there is no
  cap, and 0.47 does not beat it.

### One trap worth recording

`ab-hooks.mjs`'s `srcOf()` maps **every** `h<n>` side to `HEAD_SRC` unconditionally. A leg built as
`h1` from an anchor path loads the anchor's modules by absolute path while every bare `parseman`
under it — *and the macro that lowers it* — comes from HEAD. The first pass of this sweep did
exactly that and read **44.65 ms** for 0.46 against the same anchor's **17.34 ms**, with a 2.5×
"self-check" that looked like a real finding. Both legs of an anchor must be `r<n>`. This is
recorded in the JSON's `_method.warning` because it is precisely the shape of the two silent
mis-resolutions this project has already been bitten by.

## Method (the independent leg)

Deliberately shares no code with `ab.ts` beyond the ESM loader:

- **One process per (anchor, dialect).** No interleave, no control leg, no opponent, so a pairing
  artefact cannot survive into it.
- **Two independent module graphs of the same anchor** (`r1`, `r2`), each timed alone — a per-anchor
  self-check. All four measured anchors read 1.001–1.158 (css at 0.44/0.46 is the loosest at
  1.10–1.16; every less/scss row is ≤1.04). No anchor was voided.
- 40 warmup parses, 7 rounds × median of 5 timed repetitions, report the median of the 7.
- Load re-checked before **every** anchor, not once, and recorded per fixture.

Cross-checks that agree with it: `ab.ts` itself when run cleanly (within 3%); a single-leg run with
warmups swept 0/3/10/30/100 (0.46 reads 24.0 → 16.6 ms and 0.47 reads 36.9 → 34.2 ms — **0.46 is
ahead at every warmup level**, so `ab-config.json`'s `warmup: 3` is low for a 12 MB codegen artifact
but is not what produced the claim); and a four-leg replication of `ab.ts`'s exact leg set
(h1 33.14, r1 34.71, r2 34.28, interpreter 80.08 — flat, so the leg *count* is not an artefact
either).

## What should happen next, in order

1. **Investigate the 0.47 truncation of benchmark.less at byte 73117.** `ok: true` with 31.5%
   unconsumed and an empty `errors` array is a silent wrong answer, and it is in the release
   candidate. This is not a perf item.
2. **Treat 0.47 as a 2–3.8× parse regression on all four shipping grammars** against a flat
   0.44–0.46 baseline. `bench/workloads/config.json`'s `peak` gate is the mechanism that was
   supposed to catch this; it did not, because it runs parseman's own synthetic workloads and the
   jess grammars are where the table's cost shows up.
3. **Fix the stale pointer** in `ab-hooks.mjs` before anyone quotes this harness again.
4. **Relabel the engines** on the row, and **retract the 5.35 ms "artefact"** note in `solo()` and
   in the `--allow-mixed-engines` refusal message.
5. Do **not** bump `ab-config.json`'s `referenceSha` to `45eb01a` at this release.
   `_referenceNote` already says why: moving the reference forward onto a slower build launders the
   regression into the baseline. That is exactly what would happen here.
