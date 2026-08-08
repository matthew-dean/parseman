# Token cursor groundwork: static evidence and shipping gaps

> **Authority/status (2026-08-08): evidence companion, not design authority.**
> This note records the static probe made on `lane/tokenstream` from
> `release/0.47.0` (`90e115c`) and the defects found in the unused token modules.
> The canonical architecture and token/piece integration rules are
> [`docs/design/derived-tokenization.md`](../docs/design/derived-tokenization.md),
> [`DESIGN-piece-library.md`](./DESIGN-piece-library.md), and the 0.48 experiment
> ledger. The shipping engine is the closure-based TableProgram assembler in
> `src/table/assemble.ts`; this note does not claim that token cursor plumbing is
> in production.

Every number below was produced on that branch with
`bench/jess/token-axis-one.ts`. These are counts and static analysis, **not timing
measurements**. They must not be combined with old `PM_TABLE_COUNT` numbers,
which instrumented reference bytecode `src/table/exec.ts`, not the shipping
assembler.

## Corrections to the original framing

1. `SiteLabel.tri` was never a boolean needing an enum extension. It is
   `TRI_UNKNOWN (-2)`, `TRI_NONE (-1)`, or a non-negative trivia slot index.
2. The current reusable unit is a bounded closure/piece family selected while
   assembling a TableProgram, not a per-rule source body or a new row in a
   retired bytecode driver.
3. `token()` is already an unrelated lexical-boundary combinator; do not reuse
   the name for derived classification.
4. The largest deleted scan optimization is already restored:
   `src/table/scan-shapes.ts` (1,578 lines) came from
   `scannable-run.ts` (1,627 lines) and supplies straight-line scans to the
   current lowering where it can.

## Unused modules: what survives and what must change

The three token modules totalled 880 lines and were still INV-3 `DEBT` with
`docs/design/derived-tokenization.md` as their owner. A bench-only import did
not make them production-reachable.

### `token-alphabet.ts` (209 lines)

The graph walk and integer id per distinct `literal`, `keywords`, or `regex`
remain applicable because both it and table encoding start from the combinator
graph. CSS moved only from the design document's 118 terminals
(31 literals / 30 keyword sets / 57 regexes) to **120**
(31 / 32 / 57).

Its hand-written `tokenChildren` duplicates `src/analysis/gating.ts`'s
`childrenOf`. Production wiring must share `childSlots`/the canonical graph walk
rather than add a third edge table.

### `token-scanner.ts` (318 lines)

Its emitted-source shape can be adapted to the assembler, but the implementation
is not production-correct:

- **Case-sensitive ASCII-letter hole.** `buildTrie` skips these literals while
  the fallback checks only regex terminals. A case-insensitive `@media` returned
  its token id at end 6; the same case-sensitive literal returned `TOK_UNKNOWN`
  at end 0. Population:

  | dialect | literals dropped | keyword sets dropped | examples |
  |---|---:|---:|---|
  | css | 0 | 0 | — |
  | less | 2 | 4 | `!important`, `extend`, `when`, `not`, `and`, `or` forms |
  | scss | 2 | 0 | `!default`, `!global` |
  | jess | 0 | 7 | `when`, `to`, `as`, `@-compose`, `@-export`, `@-import` forms |

- **Wrong trivia ownership.** The scanner hardcodes ASCII whitespace and
  `/*…*/`, but trivia is grammar- and scope-supplied. The current term boundary
  already skips trivia. Classification must consume the post-skip position or
  share `skipFor`; it must not scan trivia a second time.
- **Wrong memo lifetime.** Its single module-state memo spans parses. Current
  mutable parse state is reset by `_begin`; a derived result must be parse-local
  or explicitly passed as a pending classified result. The existing memo test is
  only a source assertion because production never calls the scanner.

### `token-dispatch.ts` (353 lines)

The `emitDispatchId` strategy family (`trie`, `lenswitch`, `firstchar`, `phash`,
and `PARSEMAN_DISPATCH`) belonged only to deleted source codegen. Its measured
whole-configuration spread was **2.4%**, so that bake-off is closed for the
current engine.

Roughly 230 of the original 353 lines belonged to that closed strategy family.
The shared integer/folding utilities are not dead:
`packInts`, `PACK_MAX`, `foldCode`, `foldExpr`, and
`sharedHelperDecl('unpack')`. They fixed a silent 12-bit overflow and the
incorrect `c | 32` mapping of `@` to a backtick. Re-home them if the dead
strategy family is removed.

## Where the cursor composes with TableProgram pieces

The current design is a position cursor: at a parser decision, recognize
`(input, currentPosition, lexicalContext)` once, use that result for ordered PEG
trial, and let the selected child consume it. A unique token-to-arm mapping can
integer-fork directly; same-token or prefix-compatible arms stay in source order
and reuse compact compatible views across rollback. Positions, spans, `_pfEnd`,
recovery, slicing, CST leaves, and diagnostics remain character offsets. A future
buffering layer would need its own context/invalidation proof; the seven-token
experiment did not test or reject one.

Lexical context is a grammar-site fact, not a caller option, so it does **not**
belong in `RunCfg` or `cfgKey`. It belongs beside encode-time site labels and
resolved dispatch data. A shared-leading tokenized choice recognizes once and
filters incompatible arms; compatible arms retain ordered PEG semantics. A
scannerless fallback is an explicit site decision, not the default conclusion of
the old distinct-lead walker.

The missing plumbing identified by the probe was:

- preserve each choice's lexical-context/candidate-set identity through encoding
  and resolution instead of discarding the combinator;
- hoist or bind the classifier through the fixed-piece library;
- leave trivia with the existing skip piece;
- pass the classified `(kind, end, value/span as needed)` result or compatible
  prefix view forward so every tried arm reuses it and the selected child consumes
  it without scanning the same bytes again;
- share terminal recognition semantics between standalone raw pieces and the
  classifier.

This complements composite/piece fusion. It neither requires nor justifies
undoing direct literal/regex pieces, scan shapes, non-choice early-rejection
guards, or parent/child boundary elimination. A disjoint character choice may keep
its cheaper fork and seed later recognition; a shared-leading choice discriminates
from the token result while compatible overlaps retain ordered trial. Consume each
position result once.

### Seeded recognition and the three cost shapes

A character gate that has already selected an arm passes its work into the same
recognition kernel: post-trivia cursor position, already-read lead/class, known
prefix length, lexical context, and trivia/adjacency state. The seeded kernel
continues at `position + prefixLength`; it never restarts full terminal recognition.
Its immutable parse-local result caches at least id/value/end for downstream pieces
or rollback-compatible arms. Recognition itself publishes no CST, field, error,
trivia, or commitment effect; consumption does.

Performance work must keep three shapes separate:

1. eager token recognition before a shared-leading choice;
2. disjoint character gate followed by seeded token completion;
3. character gate followed by the current raw terminal.

Measure calls, known-prefix rereads, pending-result hits, parse time, and artifact
bytes. A win in one shape does not establish either of the others.

### Parser semantics are a separate architecture decision

The 0.48 path is **tokenized PEG**: one current-position recognition filters
impossible arms; compatible arms remain in source order and use existing
attempt/commit/gate/probe/recovery semantics. Static LL(k)/LL(*) prediction and
ALL(*)-style adaptive prediction are separate future layers because they can change
PEG prefix commitment. The minimal discriminator is `a | ab` versus `ab | a`.

Adaptive prediction is not a free upgrade. The documented Chevrotain ALL(*) shape
uses strings containing alternative/state/call-stack data and concatenated string
keys for DFA identity; on large paths prediction construction can itself become the
workload. Any Parseman experiment therefore needs compact integer/table identities,
hard per-decision state and byte ceilings, fallback to tokenized PEG, and separate
cold-construction, warm-parse, live-configuration, cache, and artifact measurements.
Canonical detail and source links are in `docs/design/derived-tokenization.md` §2.1.

## Historical conservative static probe

One separate historical probe must be stated narrowly: mode-free maximal munch
against every terminal in the 118-member CSS alphabet produced **7 tokens for a
123 KB file**. It falsified that exact configuration. It did not test or rule out
global ids combined with parser/context modes, local candidate sets, near-complete
tokenization, or mode-aware buffering.

Command used:

```sh
node --experimental-strip-types --import ./bench/jess/register.mjs \
  bench/jess/token-axis-one.ts <css|less|scss|jess>
```

### Character-gate speculation (historical control)

`popcount(MASK[c])` estimates arms entered for an ASCII lead character. The
probe weighted eligible lead characters equally, not by production frequency:

| dialect | choice sites | arms | exclusive | ungated | mean arms entered | worst site |
|---|---:|---:|---:|---:|---:|---:|
| css | 75 | 248 | 19 (25.3%) | 0 | **1.705** | 8.00 of 8 |
| less | 166 | 540 | 41 (24.7%) | 0 | **1.582** | 11.00 of 11 |
| scss | 104 | 381 | 28 (26.9%) | 0 | **1.648** | 8.00 of 8 |
| jess | 98 | 355 | 36 (36.7%) | 0 | **1.522** | 8.00 of 8 |

All sites already had character dispatch: 0/75, 0/166, 0/104, and 0/98 were
ungated. CSS had 3 masked sites at 4+ arms and 25 at 2–4; Less had 8 and 36.
This explains why choosing already-distinct sites was a weak prototype target; it
does not bound tokenization of shared-leading wrapper/rule families.

### Distinct-lead walker reach (not token eligibility)

| dialect | terminals | literals | keyword sets (words) | regexes | choices | all arms lead with a terminal | leads distinct | walker stopped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| css | 120 | 31 | 32 (80) | 57 | 96 | 47 (49.0%) | **42 (43.8%)** | 49 (51.0%) |
| less | 188 | 43 | 51 (262) | 94 | 176 | 61 (34.7%) | **56 (31.8%)** | 115 (65.3%) |
| scss | 139 | 33 | 24 (87) | 82 | 111 | 52 (46.8%) | **44 (39.6%)** | 59 (53.2%) |
| jess | 150 | 37 | 35 (83) | 78 | 103 | 47 (45.6%) | **44 (42.7%)** | 56 (54.4%) |

The old note called **32–44%** “eligible”. That label is withdrawn: it is only the
reach of a walker that stops at nullable/many prefixes, wrappers, and unresolved
references and requires distinct leads the character gate often decides already.
It is not tokenizability. The table remains useful as exact alphabet/probe evidence.
Regexes dominate every alphabet (57/94/82/78), and the prototype's sticky regex
loop can be worse than current straight-line `charCodeAt` scan shapes.

## Experiment interpretation and next decisive test

The old static model predicted moving masked-site arm entries from 1.52–1.71
toward 1.0 on its 32–44% distinct-lead population—roughly 15–25% fewer arm
entries at gated choices, concentrated in 3–8 worst sites per dialect. That was
a bound on the conservative model, **not a token-coverage or speed prediction**.

A later conservative one-choice-per-dialect implementation measured **+3.77%**
on Less (a regression). It chose sites the character gate already decided and
falsified that implementation, not the cursor architecture.
Likewise, standalone terminal recognition is only a prerequisite/control: a
correct standalone JSON-number `charCodeAt` scanner was flat
(`-1.1%` to `+1.5%`). The performance hypothesis is elimination of duplicated
gate/child recognition and opaque boundaries, not recognition alone.

Later frequency-weighted nested-lead analysis on the shipping closure artifacts
found the production target the conservative probe missed. A singular global
longest-match rule had **303/1,552 Less winner mismatches**; the
semantics-correct compatible-view oracle instead preserved PEG order with **zero
winner mismatches**. Its overall eliminable failed entries were CSS
**140/4,167 (0.5%)**, benchmark Less **8,170/23,856 (9.4%)**, and generated Less
**27,137/65,059 (11.0%)**. The dominant Less `Value` site alone accounted for
**7,734/7,927** and **27,119/30,430** prior entries.

The first canonical closure prototype left TableProgram word count unchanged and
reduced remaining retries to **193/3,311**, but its native-RegExp compatible-set
scan regressed benchmark Less **+2.5% paired** (**+4.4% solo**) and generated Less
**+1.9% paired** (**+0.4% solo**). That rejects the scanner implementation, not
tokenized PEG. Its deliberate RED plant changed `a | ab` consumption from 1 to 2
and broke probe behavior, proving the semantic differential can catch accidental
longest-match prediction.

Before broad wiring:

1. Start with the proven Less `Value` site; do not select by distinct first leads.
2. Fix the case-sensitive literal hole and use grammar trivia ownership.
3. Bind its lexical context through the fixed-piece interface, use one recognition
   for every compatible ordered arm trial, and let the selected child consume the
   pending result.
4. Compare the complete `RunResult`, including `expected`, spans, recovery,
   trivia, and CST shape; an older digest omitted `expected` and hid six
   divergences.
5. Interleave performance against an A/A control and inspect artifact/package
   cost. Reject the prototype if classifier cost exceeds the boundaries and
   rescans it removes.

Do not infer a global answer from the old 2.2–2.6× bytecode gap: that comparison
used a non-shipping engine. Current CSS/Less priority must be based on production
profiles and dynamic coverage, while keeping the token cursor and fixed pieces
on one convergent interface.
