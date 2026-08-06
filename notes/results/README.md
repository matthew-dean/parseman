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
| `engine` | `interpreted`, `compiled` (codegen) or `table` |
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

Three builds, 19859 records:

| build | engine(s) | note |
|---|---|---|
| `a5dc9bd` 0.46.0 | `compiled` | inlined codegen — the engine that shipped at 0.46, and the only one that parsed `benchmark.less` whole |
| `45eb01a` 0.47.0 | `interpreted`, `table` | the release candidate, BEFORE the trivia-scope fix |
| `45eb01a` + fix | `interpreted`, `table` | after; carries `src-dirty` because it is an uncommitted working tree |

Against the 0.46 codegen baseline the fix repairs nine files and leaves two
known SCSS regressions — see the lane report and
`test/parity/rules-trivia.test.ts` for what is pinned.
