# Choice-dispatch measurement scaffolding — NOT FOR MERGE

This branch exists to make `choice` dispatch measurable. **Do not merge it.** It
changes emitted code and exports internals that are not API.

Findings that came out of it live in PR #62 (docs).

## What it adds

| Hook | Where | Purpose |
| --- | --- | --- |
| `__setChoiceProbe(fn)` | `src/compiler/codegen.ts` | observe every rule map compiled through `compileRuleMap`/`compileLinkable` — including the fused/linkable maps, which no public API exposes |
| `PARSEMAN_MEASURE_DISPATCH` | build-time env | compile instrumentation into the `firstMatch` guard chain |
| `PARSEMAN_MEASURE_OUT` | build-time env | dump the per-arm registry (`arms` mode) to JSON |
| `classifyBroadArm` | `src/analysis/gating.ts` | exported (was module-private) so the triage can reuse the diagnostic's own cause attribution |

### `PARSEMAN_MEASURE_DISPATCH` modes

- **`counters`** — count `firstMatch` visits, guard TERMS evaluated, and arms ENTERED
  into `globalThis.__cv` / `__gt` / `__ae`. Answers *what does the guard chain do?*
- **`sink`** — one global store per guarded arm, no counting. The **control** for `double`.
- **`double`** — `sink` plus the whole guard chain evaluated a second time and discarded.
  `double − sink` is an **upper bound** on what any smarter dispatch (switch, prefix trie)
  could give back, since a perfect dispatcher can at best remove one chain evaluation.
- **`arms`** — one registry row per emitted arm, classified **at emit time** (the only
  place that knows which guard the arm actually got), plus `globalThis.__ah[id]` entry
  counts. This is what the `any`-first-set triage needs.

## Running it

```sh
PM=$PWD DEST=~/git/worktrees/jess-dispatch-measure bash .measure/setup-jess.sh
PM=$PWD DEST=~/git/worktrees/jess-dispatch-measure bash .measure/build-jess.sh arms
(cd ~/git/worktrees/jess-dispatch-measure && pnpm --filter @jesscss/awaitable-pipe build && pnpm --filter @jesscss/core build)
node .measure/triage.mjs
```

`setup-jess.sh` documents the two traps: jess pins parseman `^0.32.0` and the carried-IR
artifacts are **version-locked** (a 0.34.0 macro rejects 0.32.0 pieces, so
`@jesscss/internal-css-recognition` must be rebuilt too, not just the parsers); and pnpm
writes `link:` overrides as broken node_modules-relative symlinks.

## Measurement protocol (learned the hard way)

**Never compare separate builds.** Build-to-build variance on this machine swamped the
signal — the same mode measured 9.4 ms and 26 ms in consecutive runs. Snapshot each
mode's built artifacts (`build-jess.sh` does this into `packages/*/snap/<mode>/`), import
all modes into **one** process, and interleave them round-robin so drift hits every mode
equally. 30 warmup iterations, then 150 rounds; report median, p10, p25, min **and** win
rate — a lone median is not a result.

## Known limits

- Arm **ids are per build process**, so registries cannot be concatenated across
  packages — `build-jess.sh` writes one file per package.
- Within a package, tsdown emits ESM and CJS from one process, so the same arm gets two
  ids; only the ESM one is ever hit. **Dedupe static counts; dynamic counts are exact.**
- The enclosing-rule name in a registry row is **unreliable** — an unnamed `choice`
  inherits whatever name was last set. Trust `cause`/`detail` (derived from the arm
  itself); treat `rule` as a hint only. The reported triage does not depend on it.
