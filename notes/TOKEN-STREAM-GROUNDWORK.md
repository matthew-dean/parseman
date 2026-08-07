# Token streaming — the groundwork, and where the runway ends

Branch `lane/tokenstream`, cut from `release/0.47.0` (`90e115c`). No `src/` change.
The deliverables are this note and `bench/jess/token-axis-one.ts`, a static probe.

Everything numeric here was produced on this branch, in this worktree, by the
command printed beside it. **No figure is inherited.** §2 of
`notes/RELEASE-0.48-TARGET.md` and the *Standing hazard* section at its foot say
why: the published token-scanning bound was measured against the bytecode
interpreter, and every `PM_TABLE_COUNT` row describes `src/table/exec.ts`, which
is not the engine that ships.

**Nothing here is a timing measurement.** Three lanes were measuring while this
was written. Counting and static analysis only.

---

## 0. Four things in the framing that are wrong when checked

Stated first, because two of them would have been built.

1. **"The 0.48 notes record the cheap prep: make the per-site trivia label an
   enum with room for a third value rather than a boolean."**
   `notes/RELEASE-0.48-TARGET.md` contains no such entry — the words *enum*,
   *third value* and *room for* do not occur in it, nor anywhere under `notes/`
   or `docs/`. And the label is not a boolean: `SiteLabel.tri`
   (`src/table/site-labels.ts:83`) is `TRI_UNKNOWN (-2)`, `TRI_NONE (-1)`, or a
   non-negative **trivia slot index**. That is a lattice with an unbounded third
   arm, already stronger than the proposed prep. See §4 — the prep is
   deliberately not done, because it is already done.

2. **"A char-consuming literal piece and a token-consuming one are two members of
   one piece library."**
   There is no piece library in the shipping engine. `emit-assembly.ts`'s
   `lower(ip, fname)` *writes a body per site* — a `switch` over `code[ip]` that
   emits text. The arity-unrolled *library* the owner quote describes is
   `src/table/assemble.ts`, the **closure** engine, which is the fallback.
   "A new row in the library" is the wrong unit for the engine that runs; the
   right unit is a new branch in `lower`, pooled the way `skipFor` already pools.

3. **"`token()` is where token streaming goes."**
   It is not. `OP_TOKEN` is an existing, unrelated combinator — a lexical
   boundary that clears every capture sink and `ctx.trivia`
   (`site-labels.ts:235-238`). Any lane brief that reaches for the name will
   collide with it.

4. **"§9's deleted fast paths are for 0.48 to recover when token streaming
   lands."**
   The largest of them is already back. `src/table/scan-shapes.ts` is 1,578
   lines and its own header says *"Restored from
   `archive/codegen-fastpaths:src/compiler/scannable-run.ts` and re-aimed at
   `emit-assembly.ts`"* — against `scannable-run.ts`'s 1,627. It is live on the
   shipping path: `emit-assembly.ts:565`'s `emitScan` consults it for every
   `OP_RX` row and only falls back to `RegExp.test` when the shape refuses. §9's
   instruction is partly discharged, and the part that is discharged is the part
   token streaming would otherwise have been asked to justify.

---

## 1. What is in-tree, and what of it is stale

Three modules, 880 lines, `DEBT` in `scripts/invariant-allowlist.mjs` with `ref:
docs/design/derived-tokenization.md`. The gate still reports all three as
outstanding on this branch (`pnpm check:invariants`, 110 modules, **0
findings**) — a `bench/` import does not discharge INV-3, so the probe added
here leaves the debt exactly where it was.

### `token-alphabet.ts` (209 lines) — APPLIES, and is the most valuable of the three

Walks the **combinator graph** and assigns one integer id per distinct
`literal` / `keywords` / `regex`. It depends on `Combinator` / `ParserDef` from
`src/types.ts` — the authoring API, which `encodeTable` also consumes — and on
nothing from any retired engine. It runs unmodified against all four shipping
grammars today.

Its numbers have barely moved in the architecture changes. `derived-tokenization.md`
§1 records css as 118 members (31 literals / 30 keyword sets / 57 regexes),
walked from the live combinator graph. Re-walked on this branch: **120**
(31 / 32 / 57). The alphabet is stable; the doc's §1 is not stale.

The three unmeasured dialects in §1 are now measured — see §3.

**One stale internal:** the `tokenChildren` edge list is hand-written and
duplicates `src/analysis/gating.ts`'s `childrenOf`, which is the deduplicated
one (two INV-4 allowlist entries left when that dedup happened). Wiring must not
add a third edge table; `site-labels.ts:113`'s own header names this drift as
its reason for sharing `childSlots`.

### `token-scanner.ts` (318 lines) — APPLIES STRUCTURALLY, and has a correctness hole

It **emits source strings**, which is exactly the shape the shipping engine
wants — it was written for codegen and survives the move to `emit-assembly.ts`
unchanged in kind. It compiles and runs: driven through `new Function` on this
branch it correctly returns the regex terminal for `@supports`, the numeric
terminal for `123`, the literal terminal for `{`, and sets `tight` to 0 after
leading whitespace.

Three findings:

- **HOLE — a case-SENSITIVE literal containing an ASCII letter is silently
  unrecognisable.** `buildTrie` skips it (`token-scanner.ts:108`, `:115`) and
  the header says it is "left to the regex path" — but the regex path only
  consults terminals of kind `regex`. Verified directly: `literal('@media', {
  caseInsensitive: true })` scans to its own id, end 6; the same literal
  case-sensitive scans to `TOK_UNKNOWN`, end 0. Population, counted on the four
  grammars:

  | dialect | literals dropped | keyword sets dropped | examples |
  |---|---:|---:|---|
  | css | 0 | 0 | — |
  | less | 2 | 4 | `!important`, `extend`, `{when…}`, `{not…}`, `{and…}`, `{or…}` |
  | scss | 2 | 0 | `!default`, `!global` |
  | jess | 0 | 7 | `{when…}`, `{to…}`, `{as…}`, `{@-compose,@-export,@-import…}` |

  These are the discriminating tokens the design exists to serve. It is an
  unfinished implementation, not a design defect — a second, unfolded trie fixes
  it — but a wiring lane that does not fix it first will produce a scanner that
  is *wrong* on less and jess rather than slow.

- **STALE — the scanner skips its own trivia, hardcoded.** `token-scanner.ts:245`
  skips ASCII whitespace and `/* … */`. In this architecture trivia is
  grammar-supplied: `ctx.trivia`, swapped mid-parse by `OP_SCOPE`, lowered per
  slot through `TRIVIASCAN[ki]`, and labelled per kind. Worse, it is *redundant*:
  `emitTerm` (`emit-assembly.ts:309`) already skips trivia at the sequence term
  **before** calling the child, so a scan invoked at a choice would be scanning
  an already-skipped position. Both the skip loop and the `tight` bit it computes
  have to be re-sited onto `skipFor`, not ported.

- **STALE — the memo is single-slot module state** keyed on
  `(input identity, pos, mode, set)`. The emitted assembly's own mutable module
  state is `_pfEnd` / `_pfScan` / `_pfHost`, all reset per parse by `_begin`. A
  memo that survives across parses is a fourth kind of state with a different
  lifetime, and `test/unit/token-scanner-memo.test.ts` exists only because a
  wrong-token-from-a-warm-cache defect already shipped into it once. It is also
  a *source* assertion — the test says so in its header — because nothing parses
  through the scanner.

### `token-dispatch.ts` (353 lines) — SPLIT: the utilities apply, the thread is closed

Two halves with different fates:

- **The `emitDispatchId` strategy family** (`trie` / `lenswitch` / `firstchar` /
  `phash`, the `PARSEMAN_DISPATCH` env switch, the measured table in its header)
  is **dead**. Its only consumer was `codegen.ts`, deleted at 0.47
  (CHANGELOG:1423 — *"codegen imports `token-dispatch.ts` and nothing else from
  that group"*). `derived-tokenization.md` §9.2 had already closed the thread as
  LEGACY on its own evidence: the whole spread across every dispatch
  configuration was 2.4%. The emitted engine's `OP_DISPATCH`
  (`emit-assembly.ts:1262`) does not use any of it. Re-measuring these four
  strategies against the emitted engine is the kind of borrowed-question work
  this note exists to prevent.

- **`packInts` / `PACK_MAX` / `foldCode` / `foldExpr` / `sharedHelperDecl('unpack')`
  apply and are load-bearing.** `token-scanner.ts` imports exactly these. Two
  defects were fixed by making them single-sourced — a 12-bit encoding that
  wrapped silently, and a `c | 32` fold that maps `@`→`` ` `` — and both fixes
  live here. `scripts/check-invariants.mjs:494` cites the first by name. If the
  dead half is deleted, these five exports move; they are not deleted with it.

---

## 2. Do the selection axes accommodate an input-representation axis?

**Yes — but not as an axis on the thing the framing names, and the reason
matters.**

### It does not belong in `RunCfg`

`RunCfg` (`assemble.ts:205-278`) admits a fact only when it is *fixed for the
lifetime of a parse and supplied by the caller* — `hostCst`, `trackLines`,
`tolerant`, `coverage`, `probe`. `cfgKey` is five bits, one per option, at most
32 assemblies. Whether a given site can be decided by a derived token is a
property of the **grammar**, not of the parse, and it differs *between sites in
one assembly*. Putting it in `cfgKey` would double the assembly cache to select
between two bodies that differ at 40% of their sites and are identical at the
rest. The 0.47 notes already record the shape of that mistake twice:
`cstCaptureActive` and `_cstBuf` were proposed for `RunCfg` and would have been
*incorrect*, not merely redundant.

### It belongs where the site labels already are

`site-labels.ts` is the precedent, exactly: a fact computed at **encode time
from program structure, before any option set exists**, that selects a body.
`skipFor(l)` (`emit-assembly.ts:500`) is the mechanism — it keys a pool on
`` `${ki}|${hasScan}|${buf}|${cap}` ``, mints the arm that survives once per
distinct key, and every site with that key calls it by name. A token axis is one
more component of that key.

`emitScan` (`emit-assembly.ts:565`) is the precedent for *refusal*: it tries
`scanShapeFromRegex`, and where the shape does not lower it returns `undefined`
and the caller emits the general `RegExp.test` body. Per-site, no parse-path
branch either way, and the fallback is the current code. **That is the same
contract a token-consuming piece needs**, and it already exists twice.

### And the calling convention does not have to change

This is the load-bearing structural finding, and it is what makes the answer
"yes" instead of "yes, after a redesign".

`derived-tokenization.md` §2 is emphatic that the design is a token **cursor**,
not a token **stream**: *"At a choice, scan just far enough to pick the arm."*
There is no buffered token array. So the position handed between pieces stays a
**character offset**, and every piece keeps the signature
`(input: string, pos: number, ctx) => unknown` with its end in `_pfEnd`. A
token-consuming piece and a char-consuming piece are interchangeable at every
call site with no adapter.

Had the design been a real *stream* — pieces indexed by token number — the
answer would be the opposite: `_pfEnd`, `ctx._fe`, every span, every
`input.slice(pos, e)`, `spanLines`, `recoverScan` and the whole CST leaf
protocol are stated over character offsets, and the axis would be a rewrite. The
brief's word *streaming* and the design's word *cursor* are not the same
proposal, and only one of them fits.

### The one joint that actually moves

`emit-assembly.ts:1155`'s `OP_CHOICE` opens with

```js
const c = lead(input, pos)
```

and then indexes `MASK[c]`, one bit per arm. That is the entire char-keyed gate,
in one expression, at one site, over a table built at emit time. §2 of the design
doc calls the intended relationship *"upgrade in place: the gate stays where it
is and its key gets wider"* — and it is literally one expression wide. The
`exclusive` form above it (`DISP[di].ascii[c]`, arm-per-`case`) is the same joint
with a denser table.

**So: the axes accommodate it, with no redesign, provided the cursor form is
kept.** What must change that is not currently there:

- an encode-time record of each choice's **candidate set index**, alongside
  `armCls` in `ResolvedDispatch` — `token-alphabet.ts`'s `candidateSet` computes
  it from combinators, but `resolveDispatch` (`program.ts:410`) is where it has
  to be *stored*, and today `encode.ts` discards the combinator;
- the scanner's decls hoisted into `emit-assembly.ts`'s `prelude`, which is a
  flat `const` list inside the `new Function` body — `emitScanner(alphabet, ns)`
  already takes the namespace parameter for precisely this;
- the trivia skip taken *out* of the scanner and left to `skipFor`.

None of those is an axis change. All three are plumbing.

---

## 3. What the token gate would have to beat — measured, this branch

`bench/jess/token-axis-one.ts`, one dialect per process. Two independent
populations, deliberately not joined: the encoded table's `OP_CHOICE` sites, and
the combinator graph's `choice()` nodes. The encoder rewrites choices, and a
one-to-one map between the two is not available without inventing one.

```
node --experimental-strip-types --import ./bench/jess/register.mjs \
  bench/jess/token-axis-one.ts <css|less|scss|jess>
```

### (a) The speculation the char gate leaves

Arms *entered* at a position is `popcount(MASK[c])`. Averaged over the ASCII
lead chars a site can see, then over sites:

| dialect | choice sites | arms | exclusive (1 arm) | ungated | mean arms entered per lead char | worst site |
|---|---:|---:|---:|---:|---:|---|
| css | 75 | 248 | 19 (25.3%) | 0 | **1.705** | 8.00 of 8 |
| less | 166 | 540 | 41 (24.7%) | 0 | **1.582** | 11.00 of 11 |
| scss | 104 | 381 | 28 (26.9%) | 0 | **1.648** | 8.00 of 8 |
| jess | 98 | 355 | 36 (36.7%) | 0 | **1.522** | 8.00 of 8 |

Read three things off it:

- **Zero ungated sites in any dialect.** `bench/jess/table-gating-one.ts`'s
  question — how many choices fall to the linear arm loop — answers 0/75, 0/166,
  0/104, 0/98 on this branch. Every choice is dispatched. Whatever the 2.2×–2.6×
  regression of §8 is, it is not ungated choices.
- **The headroom is real but small: ~1.5×–1.7× arm entries, and the ideal is
  1.0.** A quarter to a third of sites are already `exclusive` and have
  literally nothing to gain.
- **The tail is where it lives.** css has 3 masked sites at 4+ arms entered and
  25 in 2–4; less has 8 and 36. A handful of sites at 8–11 arms is a much better
  target than a global mechanism.

**This is a static bound, and it is an upper bound only.** It weights every lead
char equally rather than by how often a parse lands on it. A site whose mean is
4.0 but which is entered twice per document is worth nothing. Converting it to a
frequency-weighted count needs an execution counter on the **emitted** engine,
which does not exist — `PM_TABLE_COUNT` instruments `exec.ts` and would answer a
different question. Building that counter is the honest next measurement and it
is not built here.

### (b) Whether a derived token could decide the site at all

`collectAlphabet` + `candidateSet`, run on the combinator graph for the first
time:

| dialect | terminals | literals | keyword sets (words) | regexes | `choice()` nodes | every arm has a lead terminal | …and leads DISTINCT | must stay scannerless |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| css | 120 | 31 | 32 (80) | 57 | 96 | 47 (49.0%) | 42 (43.8%) | 49 (51.0%) |
| less | 188 | 43 | 51 (262) | 94 | 176 | 61 (34.7%) | 56 (31.8%) | 115 (65.3%) |
| scss | 139 | 33 | 24 (87) | 82 | 111 | 52 (46.8%) | 44 (39.6%) | 59 (53.2%) |
| jess | 150 | 37 | 35 (83) | 78 | 103 | 47 (45.6%) | 44 (42.7%) | 56 (54.4%) |

The alphabets are scanner-sized, as §1 claimed. But **the decidable fraction is
32%–44%, not the 43%–93% §1 left open** — and less, the dialect the shipping
regression is measured on, is the worst of the four.

Two caveats that cut opposite ways and are stated rather than resolved:

- `leadTerminal` **bails** at a nullable or `many` prefix (`token-alphabet.ts:163`)
  and at any unresolved `lazy`. Some of the 51%–65% is walker limitation, which
  is §1's own "the 46 are places the static walker stopped". Resolving them is
  analysis work.
- Regexes outnumber literals in every dialect (57, 94, 82, 78). A regex terminal
  in the scanner is a **sticky `exec` behind a first-char bitset gate**, while
  the same row through `emitScan`/`scan-shapes.ts` today is *straight-line
  `charCodeAt` with the ranges folded into the source and no match array*.
  For those, the derived scanner as written is a **downgrade**.

---

## 4. The prep — deliberately not done

The named prep (§0.1) does not exist in the notes and the label it names is
already three-valued and open-ended. Doing it would mean *narrowing* `tri` to an
enum to then widen it. Not done, and the reason is that it is already done.

The prep that would actually be cheap and is **also not done**, because it needs
an owner ruling first:

- **Store the candidate-set index on `ResolvedDispatch`.** `armCls` is already
  there; a parallel `armLead: readonly (number | null)[]` costs one array per
  dispatch and nothing at parse time, and it is the one fact the encoder throws
  away that the wiring step cannot recompute (the combinator is gone by then).
  It is not free, though — it means `encode.ts` calling into
  `token-alphabet.ts`, which turns three DEBT-listed modules into live compiler
  dependencies. That is a directional commitment, not a prep, and it belongs to
  whoever owns the 0.48 framing.

Also not done, and named so it is not rediscovered: the case-sensitive-literal
hole (§1). That is a bug fix, not prep, and it must land before any wiring or
less and jess will scan wrong.

---

## 5. The first real wiring step

Not "emit a scanner". This:

> **Add a token-keyed alternative to the `OP_CHOICE` gate at
> `emit-assembly.ts:1155`, selected per site at emit time, refusing exactly the
> way `emitScan` refuses, and gated by the existing byte-identity sweep.**

In order, each step independently landable and independently reversible:

1. **Fix the case-sensitive-literal hole** in `buildTrie`. Behavioural test, not
   a source assertion — `test/unit/token-scanner-memo.test.ts`'s header already
   asks for this the moment anything parses through the scanner.
2. **Strip the trivia loop and the `tight` bit out of `token-scanner.ts`.**
   The position handed to the scanner is already post-trivia. `tight` is
   `noTrivia` adjacency and belongs on `skipFor`'s output, not the scanner's.
3. **Delete the `emitDispatchId` half of `token-dispatch.ts`**, re-homing
   `packInts` / `PACK_MAX` / `foldCode` / `foldExpr` / the `unpack` helper. That
   is ~230 of 353 lines of measured-and-closed thread, and it removes the
   temptation to re-run a bake-off whose own evidence was 2.4%.
4. **Carry the candidate-set index through `encode.ts` → `ResolvedDispatch`**,
   behind the owner ruling in §4.
5. **One site, not a sweep.** Pick the worst masked choice in `less` (11 arms,
   all 11 entered) and emit the token gate for that site alone, everything else
   unchanged. `bench/table-lowering-identity.ts` gates it — and compare
   `RunResult.expected` directly, because it is **not** in the digest (the
   standing hazard at the foot of the 0.48 notes; six divergences hid there
   during 0.47).
6. **Only then** ask whether it is faster, with a frequency-weighted arm-entry
   counter on the **emitted** engine — which does not exist and has to be built
   before the question is answerable at all.

### The prediction, and what falsifies it

**Mechanism.** At a masked choice the gate is one `Uint32Array` load and a
popcount's worth of taken branches; the arms it admits beyond the right one each
cost a call, a failure, an `_accSet`, and a rollback. A token id would make the
admitted set exactly 1 wherever the arms' lead terminals are distinct. The win
is *arm entries avoided*, not *characters scanned*.

**Predicted.** A reduction of arm entries at masked choice sites toward 1.0 from
the 1.52–1.71 static mean, on the ~32%–44% of sites whose leads are distinct —
so on the order of **15%–25% of arm entries at gated choices**, concentrated in
the 3–8 worst sites per dialect. Nothing at `exclusive` sites, nothing at the
51%–65% that must stay scannerless.

**Falsified if** any of these:
- the frequency-weighted arm-entry count at masked sites is already near 1.0 —
  i.e. real documents land on the decided lead chars and the static mean is an
  artifact of weighting every ASCII char equally. *This is the single most
  likely outcome and it should be measured before step 4, not after step 5.*
- the scanner's per-position cost exceeds the arm entries it removes. It walks a
  trie *and* loops the candidate set against every regex terminal
  (`token-scanner.ts:279-290`, O(candidates × regexes)) where `lead()` is one
  `charCodeAt`. At a 2-arm site this loses outright.
- a token gate at a site forces the position past trivia earlier than the arm
  that wins would have, changing `expected` or a span. Caught by comparing
  `RunResult.expected`, not by the digest.

**What would make the whole thing not worth doing:** if §8's 2.2×–2.6×
regression is located and it is not choice speculation. Token streaming is a
~1.5×-arm-entry problem at best. A 2.6× regression is somewhere else, and
finding it is not this lane's work but it is strictly higher value than this
lane's work.
