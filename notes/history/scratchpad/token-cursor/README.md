# token-cursor scratch: the absorbable-share instrument

Answers `derived-tokenization.md` §10.3 / §17 — *what does on-demand scanning
actually cost, and how much char-level work does a token cursor absorb?* — which
both stood as **UNKNOWN**.

Nothing here is a build input. Copies of the shipping artifacts and the recorded
traces are gitignored; the instruments are not.

## Layout

| file | what |
| --- | --- |
| `instrument.mjs` | rewrites a built jess grammar artifact so every char-level op is counted |
| `rig/counters.mjs` | the counters and the replayable trace |
| `rig/census-run.mjs` | INSTRUMENT 1 — exact dynamic census + trace dump |
| `rig/absorb.mjs` | INSTRUMENT 2 — the absorbable share, interleaved in one process |
| `rig/`, `rig-less/` | one rig per dialect; `node_modules` is a symlink to the built jess package |

## Reproduce

The rigs measure the **shipping** jess grammars, not `examples/css`, and the
**AST** path, not CST (G10).

```sh
# css
cd rig
cp <jess>/packages/syntax/css/css-parser/lib/grammar.js grammar.orig.js
node ../instrument.mjs grammar.orig.js grammar.instr.js
node --max-old-space-size=8192 census-run.mjs <jess>/packages/jess/benchmark/benchmark.css \
  ./grammar.instr.js ./grammar.orig.js Stylesheet css
node --max-old-space-size=8192 absorb.mjs css ./grammar.orig.js 61

# less — grammar2.js is the artifact, and the Less entry needs `state.source`
cd ../rig-less
cp <jess>/packages/syntax/less/less-parser/lib/grammar2.js grammar.orig.js
node ../instrument.mjs grammar.orig.js grammar.instr.js
TC_STATE_SOURCE=1 node --max-old-space-size=8192 census-run.mjs \
  <jess>/packages/jess/benchmark/benchmark.less ./grammar.instr.js ./grammar.orig.js Stylesheet less
TC_STATE_SOURCE=1 node --max-old-space-size=8192 absorb.mjs less ./grammar.orig.js 61
```

## Why it is trustworthy

- **The instrumented artifact is gated on tree identity with the shipped one.**
  `census-run.mjs` parses with both and diffs to the first differing byte before
  it reports a single count, so the census describes the shipped parse and not a
  variant of it (§16.3).
- **Every timed case runs in ONE process, interleaved round-robin**, medians and
  min-of-mins over 61 rounds, with the case order rotated each round (§16.4).
- **The noise floor is carried live**, not quoted: `parse-control` is a second
  registration of the same parse, so its spread against `parse` is this run's
  instrument reading (§16.5).
- **Every case is batched** to ~20 ms per sample. An unbatched harness read two
  byte-identical artifacts 7.8% apart.
- **The rewrite is total, and says so.** `instrument.mjs` re-scans its own output
  and prints any residual `.charCodeAt(` / `.exec(` it failed to wrap, because a
  census that silently misses sites reads as a small number rather than as an
  error.

## Known limits, stated rather than buried

- `replay-all` re-executes the reads but **not** the comparisons, branches and
  loop bookkeeping around them, nor the dispatch-key walks. It is a **lower
  bound** on absorbable time.
- `scan-emit` is a scanner written for this measurement. It is a **floor** on
  what a real derived scanner costs, not a proposal.
- The `parse` case's own control spread ran **+2.9%/+2.8%** here, above the
  documented ~1% floor — the 13 MB artifact and a batch of 1–4 leave this case
  noisier than the gate harness. Every effect reported is several times that.
