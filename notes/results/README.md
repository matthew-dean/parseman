# Parse results, per parseman build — append-only

## `parse-consumed.jsonl`

**Bytes consumed**, one JSON record per line, per
`(build × engine × dialect × fixture)` over jess's four shipping grammars and
their real corpora.

### Why this file exists

A parse that stops early and still reports `ok: true` is this project's worst
failure mode: no error, no exception, every test green. It is exactly what
happened at 0.47 — jess's Less grammar consumed 73117 of `benchmark.less`'s
106802 bytes, 68.5%, silently — and **nothing in the repo recorded bytes consumed
against a previous build**, so a 31.5% regression in what the parser accepts was
invisible to every gate while the timing harness reported the same release as a
speed-up.

`notes/VERIFY-jess-ab-sweep.json` is keyed by sha and rewritten per run, so a
curve across releases cannot be recovered from it. This file is **append-only**
so results accumulate and a later reader can plot the curve without re-running
anything.

### How to append

One process per `(build, engine, dialect)` — the grammars' `composeLeaf()` fuse
mutates shared recognition pieces in place, so only one dialect can be realised
per process, and `compiled` needs a whole-process `PM_MACRO=1`:

```sh
node --experimental-strip-types --import ./bench/jess/register.mjs \
  bench/jess/consumed-sweep.ts <dialect> <interpreted|table> notes/results/parse-consumed.jsonl

PM_MACRO=1 node --experimental-strip-types --import ./bench/jess/register.mjs \
  bench/jess/consumed-sweep.ts <dialect> compiled notes/results/parse-consumed.jsonl
```

To add a build, check that build out into its **own worktree** and run the same
command there. Never rewrite the file in place.

### Fields

Provenance is read at RUNTIME from inside the graph that actually loaded — never
assumed from the checkout, because a stale pointer resolves silently:

| field | meaning |
|---|---|
| `parsemanSha`, `parsemanVersion`, `packageVersion` | build identity; a mismatch is flagged |
| `srcRealpath` | the `src/` actually loaded, resolved through symlinks |
| `srcDirty` | `git status --porcelain -- src` was non-empty |
| `jessRoot`, `jessSha` | the grammar corpus is an UNPINNED sibling checkout and moves on its own |
| `engine` | one of **four** tokens. The spelling is a WIRE CONTRACT — records already committed use it — so read it against this legend rather than at face value: `interpreted` = the combinator graph; `table` = `execRules` (`src/table/exec.ts`), the **reference bytecode INTERPRETER**, which nothing ships on; `assembled` = `tableRules` (`src/table/assemble.ts`; it was called `assembledRules` when these records were written), **the shipped engine**; `compiled` = the `PM_MACRO` artifact, which imports `tableRules` from `parseman/table` and is therefore **also the shipped assembler** — `src/compiler/codegen.ts` was deleted in `37c57b5` and this token has not named a source lowering since. An earlier version of this legend listed three tokens, omitted `assembled`, and glossed `compiled` as "(codegen)". |
| `dialect`, `variant`, `file`, `bytes` | what was parsed |
| **`consumed`** | `unconsumedFrom ?? bytes` — the field this file exists for |
| `ok`, `unconsumedFrom`, `errors`, `threw` | the rest of the answer |
| `ms`, `loadStart`, `loadEnd` | null on a correctness sweep; a timed appender fills them |
| `flags` | contamination markers — see below |

`ms` is deliberately null here. Timing needs a controlled box and a load gate,
and mixing an untimed correctness sweep into the same records as timed ones
invites reading noise as a curve.

### Contaminated runs are RECORDED, not dropped

`flags` carries `src-dirty`, `version-mismatch`, `NODE_PATH-set`. A discarded run
that leaves no trace is how a curve quietly becomes a lie. Filter on `flags`
when reading; do not delete lines.

### What is in the file today

**Five builds, 31207 records** (2837 per build × engine). The earlier "three
builds, 19859 records" note is stale.

| build | engine(s) | note |
|---|---|---|
| `a5dc9bd` 0.46.0 | `compiled` | inlined codegen — the engine that shipped at 0.46, and the only one that parsed `benchmark.less` whole |
| `45eb01a` 0.47.0 | `interpreted`, `table` | the release candidate, BEFORE the trivia-scope fix |
| `1f5d3ea` | `interpreted`, `table` | the trivia-scope fix; also present as a `src-dirty` pair taken from the working tree before commit |
| `e9443dc` | `interpreted`, `table` | after the regex lowering |
| `d7bf366` | `interpreted`, `table` | after the scss `hasOwnTriviaBoundary` fix — **`src/` here is byte-identical to release `90aa867`**, so this is the release's state |

Divergence from the 0.46 codegen baseline, per build, counting a change of
`threw` / `ok` / `consumed` (table leg; the interpreted leg agrees at every
build measured):

| build | files differing from 0.46 |
|---|---:|
| `45eb01a` | 16 |
| `1f5d3ea` | 10 |
| `e9443dc` | 9 |
| `d7bf366` (= release) | **7** |

The trivia-scope fix repaired **9** files and introduced 3 regressions, of which
`4cfc0bd` fixed one (`selectors.less`) and `d7bf366` fixed the other two. **All 7
residual divergences are THROWS**, the same 7 present at `45eb01a`: they are
0.47 regressions that are still open, not pre-0.47 state. See
`test/parity/rules-trivia.test.ts` for what is pinned.

### Two traps in reading this file

- **`consumed` is meaningless when `ok` is false.** The field is
  `unconsumedFrom ?? bytes`, and a failed parse reports `unconsumedFrom: null`,
  so `consumed` falls back to the FULL byte count. `gen-workload.scss` at
  `1f5d3ea` records `consumed: 287543` with `ok: false` — that is a total
  failure, not a complete parse. Always read `ok` and `threw` first.
- **Everything here is `variant: 'ast'`.** The `*-lines` variants stack-overflow
  on every file of every corpus (a pre-existing self-referential `OP_RULE ip→ip`
  encoder defect), so `trackLines` has no baseline at all — it is unmeasured, not
  clean.
