# Probes for `notes/DESIGN-piece-library.md`

Every `M-n` measurement in that document is reproducible from here. **No timing** — these are V8
shape/trace observations and byte counts, both deterministic, so they may be run while the box is
contended. Measured on Node **v24.11.1** at `6bc265f`.

The `*.mjs` files under here are **illustrative probes, not shipping code**. They are deliberately
crude (hand-unrolled ladders, duplicated function bodies) because the thing being varied is
FunctionLiteral identity, which cannot be varied by a loop.

| probe | claim | run |
|---|---|---|
| `cliff.mjs` + `sweep.sh` | **M-1** closure count is irrelevant; 64 closures of one FunctionLiteral still inline | `zsh sweep.sh cliff.mjs` |
| `kinds2.mjs` + `sweep-kinds3.sh` | **M-2** the cliff is the *second distinct callee FunctionLiteral*; no polymorphic call tier | `zsh sweep-kinds3.sh` |
| `wiring.mjs` + `sweep-wiring.sh` | **M-3a** closure capture / constant index / property / variable index all inline alike | `zsh sweep-wiring.sh` |
| `matrix.mjs` + `sweep-matrix.sh` | **M-3b** the 2×2 isolating wiring from kind count | `zsh sweep-matrix.sh` |
| `specialise.mjs` + `sweep-spec.sh` | **M-4** shared / specialised / wrapper / pasted — the design test | `zsh sweep-spec.sh` |
| `budget.mjs` + `sweep-budget.sh` | **M-5** monomorphic callees inline at 29/116/390 bytecode bytes | `zsh sweep-budget.sh` |
| — | **M-5** the budget itself | `node --v8-options \| grep inlined-bytecode-size` |
| `emitsize.mjs` | **§5.2** `emitAssemblySource` bytes per grammar per cfgKey | `node --experimental-strip-types emitsize.mjs` |
| `bodyshare.mjs` | **§5.3** per-body identity across option sets | `node --experimental-strip-types bodyshare.mjs` |

## Reading the inlining traces

`--trace-turbo-inlining` prints `Inlining <callee SFI> into <caller SFI>`. The probes name their
functions distinctly (`leafA`…`leafH`, `seqS0`…`seqS7`, `pieceWrapper`, `tail`) so a grep on those
names says exactly which *slot* inlined. Where a probe has two child slots, one is deliberately
held monomorphic (`tail`) as a within-run control: if the control inlines and the variable slot does
not, the difference is the slot, not the run.

## Known limits, so nobody over-reads these

- The pieces are synthetic and small (`seq2` is 51 bytecode bytes). Real `OP_SEQ` pieces carry
  mark/rollback and trivia and are much larger, and **M-5 says size interacts with inlining** — so
  M-4's full recovery may be smaller on real bodies. `exp/cliff` re-runs this sweep on actual
  sequence/dispatch/repetition bodies; that result supersedes these. See §9.2.
- `budget.mjs` tops out at 390 bytecode bytes and does **not** demonstrate the 460 wall or the
  460–4,600 dead zone. §9.3 says so; extending the ladder past 460 is the missing run.
- `emitsize.mjs`/`bodyshare.mjs` encode `{ [rule]: root }` — a single-rule table with default
  options (no recovery, no coverage, no fusion, no dispatch), mirroring
  `bench/table-opcode-gaps.ts:72`. A real host going through `rules({...})` produces more `OP_RULE`
  rows and different shapes.
- Both byte probes run on `examples/`, the toy grammars. jess's four shipping grammars emit 6–13×
  larger and jess's real Less grammar is **not in this repo** (`bench/workloads/less.ts` is a
  vendored re-creation — see its header). §5.3's `trackLines` divergence is flagged as **H-3** for
  exactly this reason.
