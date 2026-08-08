# Differential gates — a comparison that has never failed is not evidence

`perf-gates.md` says what makes a TIMING claim trustworthy. `invariant-gate.md`
says what makes a SOURCE rule decidable. `release-gates.md` says what must be
true to ship. None of them says what makes a COMPARISON trustworthy, and that is
the gap every defect of the 0.47 cycle fell through — so it is a document of its
own rather than a section bolted onto one of those three. Its subject is not a
metric and not a rule: it is the instrument, and specifically the question of
whether the instrument is connected to anything.

## The rule

**Every sweep, oracle, identity check and A/B must have a recorded, reproducible
way to make it go red.** Not an argument that it would; a plant, in
`scripts/differential-defects.mjs`, that has been applied and observed to move it.

A differential that has never been shown to fail is not evidence, and a number it
produced is not a result. This is not a counsel of perfection. A vacuous harness
does not look broken — it prints a clean, plausible, internally consistent
number, on time, in the shape you expected. That is precisely why reading its
output cannot tell you anything about it. The only signal that separates a live
comparison from a dead one is a deliberate defect and a red line.

`pnpm check:differentials` enforces this mechanically. It is fast (~9s locally,
~4s in CI where the jess corpus is absent), it plants one defect at a time, and
it either reports every registered differential as having caught its plant or
names the one that did not.

## The vacuity modes

Each is stated with the instance that shipped. They are not hypotheticals and
they are not exotic; every one of them passed review. Several were repaired on
`release/0.47.0` itself, which is noted where it applies — a mode is listed here
because the repo has demonstrated it can produce it, not because it is open.

### V1 — both legs are the same engine

`bench/jess/fixture.ts` builds every leg at HEAD. A "table vs codegen"
comparison run through it was table-vs-table. It produced 1.09×, self-consistent
and plausible, and that number was reported to the owner as release quality.

*Counter-rule:* a leg must be able to state what makes it different from the
other leg, and the harness must assert it. `bench/jess/digest.ts` does this
correctly — the macro lowers a rule to a FUNCTION and the interpreted fuse leaves
an OBJECT, so `typeof entry === 'function'` is checked against the leg's declared
name and the run refuses rather than agreeing with itself.

### V2 — a leg that throws identically on every row

Three harnesses had this. A `cst` table refuses to run without a build host, so
every row of a hostless `cst` leg was the same `threw:` string — 87 of 87 for
css, 314 for less, 2408 for scss. Two legs that are both entirely dead agree
perfectly. `bench/jess/emit-identity-one.ts` was fixed by planting a defect and
observing that it moved zero rows; `bench/jess/digest.ts` was still open at
0.47.0 and is fixed by the same one line.

*Counter-rule:* a leg whose rows are all identical is a dead leg until proven
otherwise. Distinct-value counts are cheap; print them.

### V3 — a success predicate that means "did not throw"

`bench/jess/ab.ts` defined `parse ok` as `!row[0].startsWith('threw:')` — which
reports whether `run()` THREW, and a failing parse does not throw. It returns
`ok: false`. `gen-workload.scss` is 287,543 B, HEAD stopped at byte 218 of it,
and the row printed `parse ok: true`, `1780 MB/s` computed from the full file
size, and a `0.005x` ranking — a 200-fold SPEEDUP for a grammar the release had
stopped being able to parse. Every part of the row was consistent with a
triumph. Repaired at `90e115c` (`outcomeOf`, `ab.ts:468`).

*Counter-rule:* `ok` is a field on `RunResult`. Read it. And read it next to
`consumed` — see "Reading `consumed`" below.

### V4 — an option selects a different artifact, so the harness never realises
the thing under test

`run-tabled.ts` reads `options.tolerant === true` to decide WHICH TABLE is built:
the sync sentinel a list resyncs to is inferred from grammar structure, so it is
encoded before the table exists. `bench/jess/consumed-sweep.ts` calls
`run(entry, input)` with no options, so it never builds the tolerant assembly at
all. A before/after of a change confined to recovery was guaranteed to show zero
movement while proving nothing.

*Counter-rule:* enumerate the axes the artifact is built along — for this repo
`hostMode`, `trackLines`, `tolerant`, `coverage`, `probe` — and say which cell
the harness occupies. A sweep that only ever runs one cell says nothing about the
others. This mode has a permanent regression test: `check:differentials` asserts
that `tolerant-sweep` MOVES under the `tolerant-rec-off` plant and that
`consumed-sweep` does NOT. Both directions are enforced, so the day
`consumed-sweep` starts seeing tolerant changes, the gate says so.

### V5 — the result is dominated by an artifact of the harness

`bench/jess/ab.ts`'s self-check was 18% off because changing the number of legs
changed V8's inlining decisions. Every ratio it ever printed flattered HEAD.
`perf-harness-interleaving.md` is the full treatment for timing; the general
form is broader than timing. While writing `check-differentials.mjs` itself,
two false positives of exactly this shape appeared in one hour: every sweep
"detected" every plant, because a planted tree is a dirty tree and the sweeps
print `FLAGS: src-dirty`; and then again because each run writes to a
differently-named sink file and the sweeps echo the path.

*Counter-rule:* before believing a movement, ask what ELSE differed between the
two runs. Module-graph size, leg count, leg order, output paths, timestamps,
working-tree cleanliness — none of these are the thing under test.

### V6 — an import that reaches past the shipped export

`bench/table-lowering-identity.ts` imported `tableRules` from `src/table/exec.ts`
while `src/table/index.ts` re-exports `assembledRules` under that name. (The
reference export is now `execRules`, so that specific import can no longer be
written; INV-11 in `scripts/check-invariants.mjs` fails any re-aliasing of one
engine to the other. The same trap also cost `bench/jess/fixture.ts` a cycle of
mislabelled figures — see docs/design/canonical-fixture-benchmark.md.) A whole
sweep, and the CI subset in `test/unit/table-identity.test.ts`, validated a
reference driver that nothing ships while the assembler went unexecuted.
Repaired at `90e115c`: both drivers run, and the gate now carries one plant per
driver so the two cannot silently collapse back into one.

*Counter-rule:* a differential imports from the package's own entry points where
it can. Where it cannot — and a lowering comparison legitimately needs both
drivers — it must run BOTH and name each, which is what that file does now.

## The reporting rule

**A harness prints what engine each leg ran and the resolved `realpath` of its
source, before it prints a number.**

Three harnesses labelled a table as `codegen` this cycle. A label is a claim, and
it is the cheapest claim in the repo to get wrong: it is written once, when the
harness is new and correct, and it survives every later change to what the
harness actually imports.

Concretely, a run should be able to answer, from its own output:

- which engine each leg is (interpreted graph / macro codegen / reference table
  driver / assembled table / emitted assembly), and how the harness KNOWS
- the resolved path and version of the parseman that loaded —
  `bench/jess/grammars.ts`'s `assertParseman()` is the model: it resolves the
  bare specifier through the loader rather than deriving a path from
  `import.meta.url`, because comparing two paths both derived from the same
  source proves nothing
- for a table leg, whether it EMITTED or fell back to closures, and if it fell
  back, the refusal string (`Assembly.emitRefusal`)
- the corpus denominator, both taken and total, so a bounded run cannot read as a
  complete one

## Reading `consumed`

`consumed` is `unconsumedFrom ?? bytes`.

A parse that FAILED records the full byte count, because `unconsumedFrom` is
`null` and the fallback is the input length. So `consumed === bytes` means either
"read everything" or "failed", and the two are distinguished only by `ok`.

**Never read `consumed` without `ok`.** That misreading has already happened, and
it is the same shape as V3: a field that looks like a success signal, is not one,
and reads plausibly when wrong.

## The gate

`scripts/check-differentials.mjs` holds the registry;
`scripts/differential-defects.mjs` holds the plant catalogue.

```sh
pnpm check:differentials            # gate
pnpm check:differentials --list     # the registry and each entry's contract
pnpm check:differentials --strict   # UNPROVEN entries fail too (release)
```

For each registered differential it records a clean baseline, applies each
registered plant to `src/`, re-runs, and requires the normalised output to move —
or, for a plant the entry declares itself `blind` to, requires it NOT to move.
`src/` is restored on every path including a signal, and the gate refuses to
start if `src/` already has uncommitted changes.

Registered today:

| differential | legs | plants |
|---|---|---|
| `scan-shape-oracle` | emitted straight-line scan vs sticky `RegExp.exec`, per regex, per position | `scan-class-narrow` |
| `table-lowering-identity` | interpreted vs `compose()` codegen vs `tableRules` (shipped) vs `execRules` (reference) | `emit-node-span`, `exec-node-span` |
| `jess-oracle` | interpreted fuse vs the `PM_MACRO` artifact (the shipped assembler) vs `execRules` (reference), one process per leg | `exec-node-span` |
| `emit-identity-one` | `PM_TABLE_EMIT=1` emitted assembly vs `=0` closure walk | `emit-node-span` |
| `consumed-sweep` | bytes consumed per file, one build, appended as JSONL | `interp-many-cap`; BLIND to `tolerant-rec-off` |
| `tolerant-sweep` | the RECOVERY assembly, errors/spans/value digest per file | `tolerant-rec-off` |

Rules the registry enforces on itself:

- **A plant anchor that no longer matches is a hard failure**, never a skip. When
  a refactor moves the code out from under a plant, the gate stops with "anchor
  occurs 0 times, expected 1" and the plant has to be re-derived. A fuzzy match
  or a silent skip would convert this gate into the thing it detects.
- **A plant must be observable, not catastrophic.** A plant that makes every
  parse throw proves nothing — that is V2 with extra steps. The catalogue moves a
  span by one, narrows a character class by one code point, caps a repetition at
  three, or turns off recovery: each is the shape of a defect this repo has
  actually shipped, and each leaves the engine running.
- **A sweep is compared on its ARTIFACT, not its progress line.** The two
  JSONL sweeps print a record count and write the records to a file; comparing
  stdout would compare a count that no plant changes.
- **`blind` is a contract in both directions.** A documented limit that stops
  being true is as much a finding as a differential that stops working.

### What it deliberately does not do

It runs the css corpus (87 files), not less's 314 or scss's 2408. The claim under
test is that the comparison mechanism is live, not that today's corpus is clean —
that is what the sweeps themselves are for. It times nothing.

### UNPROVEN is not passing

Four of the six registered differentials drive jess's grammars over jess's
corpora, which live in an unpinned sibling checkout (`JESS_ROOT`) this repo does
not vendor. Where that checkout is absent they are reported UNPROVEN on their own
summary line — never as passing, and never silently omitted. CI runs the plain
mode and proves the two self-contained ones; `--strict` makes an UNPROVEN entry a
failure and is what a release runs, on a box where the jess checkout exists.

## Adding a differential

1. Register it in `REGISTRY` with its `legs` prose. The prose is required: it is
   where a label and an import get to disagree in public.
2. Add a plant to `differential-defects.mjs` — a real edit to `src/`, in the code
   path the differential claims to cover, of the shape of a defect that has
   actually shipped.
3. Run `pnpm check:differentials --only=<id>` and watch it say CAUGHT. If it says
   MISSED, the differential is not measuring what its name says, and that is the
   finding — fix the differential, not the plant.
4. If the differential is structurally blind to something adjacent, register that
   as a `blind` plant rather than leaving it as a comment.

## Known gaps, stated rather than fixed

- `bench/jess/divergence.ts` and `bench/table-lowering-sweep.ts` PRINT their
  disagreement counts and exit 0 regardless. They are reports, not gates. The
  teeth gate handles this by requiring their output to MOVE rather than to return
  non-zero, but a lane reading them by hand gets no exit code to trust, and
  `table-lowering-identity` is registered against the vitest test rather than the
  sweep for exactly that reason.
- `bench/jess/ab.ts` and `bench/jess/fixture.ts` are not registered. Both are
  timing harnesses whose defects (V1, V3, V5) are the ones this document opens
  with, and a timing differential needs `perf-harness-interleaving.md`'s
  machinery before a plant means anything.
