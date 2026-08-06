# REVIEW — child-kind specialisation, lens 2 of 3: LAW COMPLIANCE

**Reviewing** `notes/DESIGN-child-kind-specialisation.md` @ `eb516a49c` (branch `review/law`,
cut from `origin/design/child-kind`).
**Law under enforcement:** *"the LOGIC BRANCHING of the options should be used to BUILD
parser paths. The parser paths CANNOT HAVE LOGIC BRANCHING, at least not for things like
trivia or CST vs AST."*
**Priority order applied throughout:** V8 execution speed > artifact size > tests.
Read-only on `src/`. No benchmark was run and nothing here is a timing. Three things
were *executed*, all shape/correctness observations, all named at their finding.

**Bottom line up front.** The law is violated in 57 places, the gate that exists to
catch them reports **0**, and the single largest violation is not in the design at all:
on every capturing workload each non-first sequence term allocates a fresh
`ParseContext` and **re-enters the combinator interpreter** to scan trivia. The design's
foundational V8 argument (§0.3) is **correct** — I verified the mechanism and its
consequence directly — which means "just restructure the assembler" is dead and U4 is
required. Two design proposals are unsound as written and would produce silently wrong
output; both have a cheap correct form.

---

## 0. Evidence provenance

| what | how established |
|---|---|
| 57 config reads inside piece-internal bodies | executed — `scratchpad/inv6x.mjs`, a diagnostic re-run of INV-6's own AST shape with a fixed `isPiece`, an extended field list, and the parse-path module set. Assignment targets excluded, so save/restore is not counted. |
| gate reports 0 | executed — `node scripts/check-invariants.mjs` → `105 modules examined, 0 findings` |
| `SCAN === null` for css, non-null for json | executed — `fastTriviaScanner(trivia(oneOrMore(choice(ws, comment))))` → `null`; `fastTriviaScanner(trivia(regex(/[ \t\n\r]*/)))` → `function`. Closes the design's own open item §9.3. |
| FeedbackVector sharing + its consequence | executed — `node --trace-turbo-inlining` on four minimal programs. §6 below. Shape observation (inlining decisions), not a timing. |
| literal-length distribution | read — every `literal()` across `examples/{json,css,graphql}` is 1–9 chars. **Zero** exceed 16. |
| everything else | read, with file:line |

`node v24.11.1`. The checker needed `node_modules`; a symlink to the main checkout's
was used (worktree has none).

---

## 1. The violation table

Failure mode **O** = option test on the parse path. **D** = dispatch defeat.
"Design fixes?" is against the design *as written*, not as I would amend it.

### 1.1 — Option tests

| # | file:line | mode | what | design fixes? | if not, what would |
|---|---|---|---|---|---|
| O1 | `trivia-skip.ts:219-262` reached from `assemble.ts:466` | O | `scanTrivia` — 8 config reads (`trivia`, `_triviaLog`, `_rootTriviaLog`, `captureTrivia`, `_cstBuf`, `_cstTriviaLog`, `trackLines`×2, `triviaKindLabels`×4) + a `WeakMap` lookup + **`createDetachedParseContext`** (`parse-context.ts:86` → a whole fresh `ParseContext`) + a full `triviaP.parse` interpreter re-entry + `{end, commit}` + a `commit` closure. **Per non-first sequence term.** | **PARTIALLY.** §0.6 describes this as "two allocations per term". It is three allocations, a fresh context, and an interpreter re-entry. U2 removes the protocol; U3 removes the scan. Neither, alone, removes the detached-context re-entry — that only dies when a real scanner exists (U3) *and* the capture tail moves into the loop (U2). **The design is right that both are needed; it under-states why by roughly an order of magnitude.** | Nothing new — but the U2/U3 sequencing note must say "neither unit alone removes the interpreter re-entry", or a reader will land U2, see css move less than predicted, and conclude the model failed. |
| O2 | `trivia-skip.ts:192,196,199` (`advanceTrivia`), `:226,240,254,257` (`scanTrivia`), `:88`, `recovery/scan.ts:117,118` | O | **10 reads of `ctx.trackLines` — a field ALREADY in `CONFIG_FIELDS`** — on the parse path. Every one is invisible because `INV-6` sets `ASSEMBLER = 'src/table/assemble.ts'` and scans that file only. | **NO — not mentioned.** The design names two holes in INV-6; **file scope is the third and the largest.** The gate's own field list already forbids these reads. | `INV-6a` (§7). Extend the scanned set to the parse-path closure. Zero new rule semantics; the rule is already right. |
| O3 | `assemble.ts:669,687,706,726,749,763` | O | `ctx._probe !== undefined` per leaf, ×6 | YES — U1 + field list | — |
| O4 | `assemble.ts:803` | O | `OP_GATE`: `ctx._probe === undefined && !ctx._tolerant` — **two** option tests on the entry path of every first-set-gated child. `_tolerant` is already a `RunCfg` bit and is still tested here. | **NO.** §5's table credits `_probe`→bit with "6 per-leaf tests"; the true count is 9 (`inv6x` output), and this site — the only one that is not a leaf-*failure* path — is missed entirely. Per repo memory first-set gating is *"the parse lever"* (25–48% landed), so this is the `_probe` site that matters most. | Select at `link`: `if (cfg.tolerant \|\| cfg.probe) return child` — the gate is a no-op under both, so the tolerant/probe assemblies drop the closure **and its call frame** entirely. The strict assembly gets a body that is one `classHas`. |
| O5 | `assemble.ts:526` | O | `nextTerm`: `ctx.trivia === undefined`, per term | YES — U2 site label | — |
| O6 | `assemble.ts:1922, 2009` | O | `OP_REP`/`OP_REPV`: `const hasTrivia = ctx.trivia !== undefined`, per repetition entry | YES — §3.2 puts the label on `OP_REP`/`OP_REPV` rows. §5's table omits them; cosmetic. | — |
| O7 | `assemble.ts:2231` | O | `OP_NODE`: `ctx.trivia !== undefined`, per node — 145,512 nodes/parse on `benchmark.less` | **NO.** §3.2's label list stops at seq/rep; `OP_NODE`/`OP_NODE_TRACK` are not on it. | Same operand, two more opcodes. One line of encoder change, already being written for O5/O6. |
| O8 | `assemble.ts:2227` | O | `OP_NODE`: `host?._parsemanTriviaKinds !== undefined` — an optional chain plus a property load **off a `JSFunction` object** per node | **NO — not mentioned.** | Latch in `begin` beside `HOST`/`COV`: `let HOSTKINDS`, `let HOSTCOLLAPSE`. The design's own argument for `HOST` (`assemble.ts:483-496`) applies verbatim — per-parse VALUE, not bakeable, so hoist to the boundary. Turns 2 property loads + 2 branches per node into 2 context-cell loads. |
| O9 | `assemble.ts:2260, 2263` | O | `host?._parsemanCstCollapse !== undefined`, per node | **NO** | as O8 |
| O10 | `assemble.ts:2267, 2271, 2277` | O | `host !== undefined` ×3 per node. In the `hostCst` assembly this is **provably true** — `cfgKey` derives `hostCst` from `host !== undefined && cstOutputHost(host)` (`:2411`). | **NO** | Select on `hostCst` at `link`, as `OP_SCOPE_CAP` already does at `:1007`. Two node bodies, no test. |
| O11 | `assemble.ts:462` + `markCst` `:413` + `mEr`/`mLog`/`mRoot` at `:538-540, 1066-68, 1090-92, 1112-14, 1132-34, 1700-02, 1752-54, 1786-88, 1935-37, 2027-29` | O | **14 reads of `ctx._errors`** and paired `_triviaLog`/`_rootTriviaLog` reads inside the mark protocol. `_errors` presence is **per-parse-fixed**: written only by `run.ts:391` and `compile.ts:224` before the parse, and by `recovery/scan.ts:29/40` — the sentinel save/restore that `RunCfg.tolerant`'s own doc (`assemble.ts:204-210`) already argues no piece runs under. | **NO — not mentioned.** | `_errors` qualifies for a `RunCfg` bit by exactly the argument already written for `_tolerant`. Cheaper still: a `begin`-latched boolean, since only *presence* is consulted. `nextTerm` alone reaches this >200,000×/parse (`assemble.ts:372`). |
| O12 | `assemble.ts:908, 1970` | O | `ctx._tolerant === true` **inside a body already selected by `REC`**, where `REC = prog.rec === 1 && cfg.tolerant` (`:298`). Provably constant-true. | **NO.** The comment at `:294` justifies it as *"so `exec.ts` stays the identity reference"* — a justification the law does not admit, and which `RunCfg.tolerant`'s own doc contradicts. | Delete both. Identity with `exec.ts` is a *test* property; the interpreter is the semantic reference and it keeps its own gate. Failure-path only, so speed impact ≈ 0 — this is a law-hygiene fix, ranked last. |
| O13 | `assemble.ts:1153,1161,1176` / `1009,1014,1019,1025,1029,1032` | — | `ctx.trivia` save/restore in `OP_TOKEN`/`OP_SCOPE`. **NOT a violation** — genuine per-region state mutation. Listed so the gate is written not to flag it. | n/a | This is the noise case. `INV-6c` (§7) distinguishes read from write for exactly this reason. |

### 1.2 — Dispatch defeats

| # | file:line | what | design fixes? | if not, what would |
|---|---|---|---|---|
| D1 | `assemble.ts:525`, called from `:1264, 1326, 1392, 1496, 1506, 1515, 1528, 1531, 1541, 1544, 1553, 1555` | `nextTerm(child, …)` — the piece as a **parameter**. Its two internal call sites (`:527`, `:542`) see every piece kind in the process. | YES — U2 dissolves it | — |
| D2 | `assemble.ts:458`, `s(input, cur)` at `:463` | `skipTrivia` — one module-level helper reading the `SCAN` slot. `s(…)` is **one FunctionLiteral's call site seeing every `FastTriviaScanner` in the process.** Structurally identical to D1, for scanners. | **NO — not mentioned.** | U2 must inline the scan *call* into the term body too, not merely the trivia decision. If `skipTrivia` survives as a shared helper, U2 removes the branch and keeps the megamorphism. |
| D3 | `assemble.ts:1259, 1264` (`runTerms`), `:1345, 1351` (`runSyncTerms`), `:1413, 1418` (`runAdjTerms`) | `kids[i]!(…)`, `runners[i]!(…)` — array index to find a callee, then a megamorphic call. Also: **all three are 4-parameter functions, so `isPiece` cannot see them either.** | PARTIALLY — INV-7 names `kids[i]`/`runners[i]`. But the design's proposed `isPiece` fix ("parameter list *ends* in `(input, cur\|pos, ctx)`") **does not match `runTerms(input, pos, ctx, values)`** — `ctx` is not last. | `INV-6d` (§7): match on *"the parameter list contains an identifier named `ctx`"*. Arity- and order-free. Catches `nextTerm` and all three loop bodies. |
| D4 | `assemble.ts:1627, 1716, 1734, 1760` | `OP_CHOICE`: `arms[arm]!(…)` / `arms[i]!(…)` — four call sites, each seeing every choice arm in the process | YES — U4 | — |
| D5 | `assemble.ts:2116, 2135, 2146` | `OP_DISPATCH`: `matchFn[i]!(key)`, `arms[arm]!`, `target(…)` | YES — U4 | — |
| D6 | `assemble.ts:639` | `link`'s cycle stub: `const fwd: Piece = (input, pos, ctx) => target!(input, pos, ctx)`. **One FunctionLiteral for every recursive rule in the process.** Every grammar's back-edges funnel through it. | **NO — not mentioned.** The comment at `:626` says "4 reachable `OP_RULE` sites in the less table", which understates it: the stub is created per back-edge but they all share one literal, so the `target!(…)` site is megamorphic across grammars. | Under U4 the stub is unnecessary: emitted source hoists `let _sN` and assigns after, so a back-edge is a direct binding reference with no forwarding call. **Name this as a U4 deliverable** — it is currently invisible because the site count is small and the *sharing* is what costs. |
| D7 | `trivia-skip.ts:367-382` | `loopScanner`: `for (const arm of arms) { const end = arm(input, pos) … }` — one FunctionLiteral, `arm(…)` sees every trivia arm in the process, plus an array iteration per character position | PARTIALLY — U3 replaces `loopScanner` with a fused scanner. Design says so at U3. | — |
| D8 | `assemble.ts:963` | `OP_SCAN`: `bound ?? (bound = scans[si]!)` — a lazy-bind null test *and* an array index on the parse path. Design's INV-7, keyed on `Piece[]`-typed bindings, **would not see it**: `scans` is `Combinator<unknown>[]`. | NO (invisible to the proposed check) | `INV-7` restated as callee-provenance (§7). Speed impact ≈ 0 (3 sites, 6 executions/parse) — listed for gate completeness only. |
| D9 | `assemble.ts:1794` | `OP_GREEDY`: `byWord.get(input.slice(pos, end))` — a **string allocation** per greedy execution, then a `Map` lookup, then a megamorphic `lit(…)` | NO | Out of scope for the staged plan; note it on the mining list beside §8b.3's `sharedPrefix`. |
| D10 | `assemble.ts:2446` | `a.pieces[names[ri]!]!(…)` — string-keyed dictionary lookup + array index + megamorphic call. Per rule *entry*, not per node. | NO | Negligible. Listed for completeness. |

### 1.3 — `exec.ts`

`exec.ts` is the bytecode interpreter and is *by construction* a per-row switch with
per-row option tests (`:347, 365, 381, 400, 421, 447, 516, 752, 1059, 1178, 1290, 1304`).
**The law does not bind it** — it is the semantic reference. But two facts belong in the
review:

- `src/table/index.ts:28` exports **`assembledRules` as `tableRules`**. `assemble.ts` is
  the shipping engine; `exec.ts` reaches production only through `src/table/fold.ts:1`
  and `src/compiler/linker.ts:24`. Worth an owner ruling on whether `fold.ts` can put the
  interpreter on a shipped path.
- **Confirmed, and it is worse than a gate hole — it is the gate being pointed at the
  wrong engine.** `bench/table-lowering-identity.ts:19` imports `tableRules` from
  **`../src/table/exec.ts`**. The ~2,800-file corpus identity sweep therefore
  **never executes `assemble.ts`**. Every specialised leaf body this design adds would be
  gated by a harness that does not run the engine it is added to. The design flags this
  at §8; I confirm it and raise its priority: **this is a prerequisite for U1, not for
  U2 onward.** U1 adds four literal bodies whose whole risk is a changed `expected` set.

---

## 2. The two design proposals that are unsound

These are the findings with a correctness consequence, and both are the class §9.5 warns
about: *silently wrong output, not a slow parse.*

### 2.1 — `triviaCapture` as a `RunCfg` bit is **unsound**. §2.1 must be corrected.

The design (§2.1, table row 6) proposes `triviaCapture` as a sixth `RunCfg` bit, with the
justification: *"`_triviaLog`/`_rootTriviaLog` presence is fixed before the parse"*.

It is not. `assemble.ts:1168-1169` (`OP_TOKEN`) and `:1209` (`OP_LEAF`) set
`ctx._triviaLog = undefined` / `ctx._rootTriviaLog = undefined` for the duration of the
boundary and restore in `finally` (`:1183-1184`, `:1220`). This is exactly the pattern
that made the design **correctly** refuse to lift `ctx.trivia` to `cfgKey` — `OP_SCOPE`
swaps it mid-parse — and the same reasoning applies unchanged.

The bit also silently absorbs `ctx.captureTrivia`, which is written by `OP_SCOPE_CAP`
(`:1016`, restored `:1018`) and by **`OP_NODE` on every node** (`:2218`, restored
`:2243`). That one is not even per-region; it is per-node, i.e. the exact class
`RunCfg`'s own doc rejects at `:212-214`.

A piece selected for capture and reached under an `OP_TOKEN` boundary would capture
trivia the interpreter does not. That is a wrong tree, not a slow parse.

**Fix, and it is cheap because the machinery is already being built.** `_triviaLog`
presence is a **per-REGION** fact whose boundary is a static table property — the nearest
enclosing `OP_TOKEN`/`OP_LEAF`. It gets the *same* treatment `ctx.trivia` gets: a site
label from the same downward encoder pass §3.2 already specifies, with a second label
value. Not a seventh bit. Concretely, §3.2's operand becomes two small enums rather than
one, and `captureTrivia` stays runtime and is **not** covered by either.

Net effect on the plan: U2's body-variant count goes from 2 to 4 at each term position
(trivia × logging), still finite, still generated. §8b.1 already asks for the trivia label
to be an enum with room to grow — it needs room for two axes, not one.

### 2.2 — `RunCfg` needs the discipline its own doc demands, applied to `probe`

`_probe` genuinely is per-parse-fixed (`combinators/completions.ts` sets it before the
parse), so the bit is sound. But `recovery/scan.ts:29` does
`ctx._probe = undefined; ctx._errors = undefined` and restores at `:40` — the same
sentinel-probe window that `RunCfg.tolerant`'s doc already addresses. The `probe` bit's
doc paragraph must state that window explicitly and by line number, or the next reader
will find it and reasonably conclude the bit is unsound. Same for the `_errors` latch I
propose in O11.

---

## 3. Ranking — how much of the measured regression each finding could explain

The regression has two independent terms and they must be ranked separately, exactly as
the design's §0.6 insists. Nothing below is a measurement; each is a mechanism with a
static site count.

### css/less (+500–835%) — ranked

| rank | finding | why it is ranked here |
|---|---|---|
| **1** | **O1 + D2** — `scanTrivia`'s detached-context interpreter re-entry, per non-first sequence term | The workloads are `withCapture` (`bench/workloads/index.ts:113-133` sets `_triviaLog: []`), so `skipTrivia`'s fast clause is disabled by `_triviaLog !== undefined` **and** by O2 below. Every term then reaches `scanTrivia`'s `log !== undefined` branch, which builds a **fresh `ParseContext`** and runs the full `oneOrMore(choice(ws, comment))` combinator graph. v0.46 emitted a `_tfN` loop with the capture tail inline and allocated nothing. **This alone is a plausible majority of the 6–9× second term.** |
| **2** | **O2 / §9.3** — `SCAN === null` for css. **Executed and confirmed.** | Independent of capture: css's block-comment arm is a *delimited* shape and `regexTriviaScanner` accepts only `classRunSource ?? altStarSource` (`trivia-skip.ts:384-389`); `altStarSource` requires `^\(\?:(.*)\)[*+]$` (`:524`), which `/\/\*(?:[^*]\|\*(?!\/))*\*\//` fails. So `arms.some(s => s === null)` → `buildFastTriviaScanner` returns `null` (`:365`). json's `/[ \t\n\r]*/` is a bare class and gets a scanner. **The design's sharpest prediction is now verified without a benchmark.** |
| **3** | O7–O10 — `OP_NODE`'s five per-node config tests + two `JSFunction` property loads | 145,512 nodes/parse on `benchmark.less`. css/less are node-dense; json is not. |
| **4** | O11 — the mark protocol's `_errors`/`_triviaLog`/`_rootTriviaLog` reads | ~13–20 property loads per sequence term before the child runs, of which 5 are link- or `begin`-resolvable. Hits both terms; ranked higher on css because css has more terms per byte. |
| 5 | D7 — `loopScanner`'s megamorphic arm call | Only reachable once a scanner exists; today css has none. Becomes rank-2-sized *after* U3. |

### json/document (+137%) — ranked

| rank | finding | why it is ranked here |
|---|---|---|
| **1** | **D1/D3/D4/D5/D6 — megamorphic dispatch** | Verified in §6 below: the shared-FunctionLiteral form **blocks callee inlining outright**; the emitted form restores it. json is `withoutCapture` with a working fast scanner, so the trivia term is near-free and what remains is dispatch + leaf work. The design's U4 40–60% apportionment is the right ordering. |
| **2** | **O3 — `startsWith` for short literals** | **Zero of ~72 literals across `examples/{json,css,graphql}` exceed 16 characters.** Every one takes a builtin call where codegen took 1–9 inline `charCodeAt` compares. json's hot loop is `{ } [ ] , : "` plus two `"` per string. |
| **3** | O11 — the mark protocol | Same mechanism, per term, in a grammar whose terms are cheap — so the protocol is a larger *fraction* of json's term cost than of css's. |
| **4** | O4 — `OP_GATE`'s `_probe` + `_tolerant` pair | Ranked above the leaf `_probe` sites because it sits on the *success* path of the first-set gate, which repo memory records as the parse lever. Needs a `reachableOps` count (`src/table/inspect.ts:22`) to size — cheap, no timing. |
| 5 | O3's `_probe` half (leaf failure paths) | One load + branch, failure path only. The design's own 5% apportionment is right. |
| 6 | O12 — redundant `_tolerant` inside REC bodies | Failure path, tolerant assembly only. ≈ 0. Law hygiene. |

**Where I disagree with the design's apportionment:** it puts U2 at 10–20% of json's floor
on the strength of the removed `ctx.trivia` branch and one fewer call frame. I would put
the same U2 work higher, because U2 is also the only unit that removes **D2** and
**O11** — the `skipTrivia` megamorphic scanner call and the mark protocol's five
resolvable reads — and the design counts neither. That does not change the *ordering*
(U4 > U1 ≳ U2 for json), which I agree with.

---

## 4. What the design's proposed checks would and would not catch

The design proposes three detection changes (§5). Against the 57 reads and 10 dispatch
defeats above:

| proposed change | catches | misses |
|---|---|---|
| `CONFIG_FIELDS` += `_probe`, `_tolerant`, `trivia` | O3, O4(half), O5, O6, O7, O12 — **21 of 57** | O1, O2 (**10 `trackLines` reads — a field already on the list**), O8–O11 (`_errors`×14, host property loads). Misses **36 of 57**, because the miss is *file scope*, not field list. |
| `isPiece` → "parameter list *ends* in `(input, cur\|pos, ctx)`" | `nextTerm(child, input, cur, ctx)` ✓ | **`runTerms(input, pos, ctx, values)`, `runSyncTerms`, `runAdjTerms`** — `ctx` is not last. Three loop bodies with `kids[i](…)` and `runners[i](…)` in them stay invisible. The proposed fix has a hole shaped like the *other* half of the same defect. |
| `INV-7` — "no parse-path array index", decided on `Piece[]`-typed bindings | D3, D4, D5 | D8 (`scans[si]`, typed `Combinator[]`), D2 (`s(…)` — no index at all, a slot read), D6 (`target!(…)` — no index at all). And as a *type-keyed* rule it is fragile: rename the type and the rule stops firing. |

Adding to the coordinator's warning about gate noise: **"no parse-path array index" as
literally stated would fire on `ascii[c]`, `mask[c]`, `hi[i]`, `starts[mid]`, `strs[i]`,
`clss[i]`, `armFx[j]`, `syncs[i]` and `routed[arm]`** — every one a scalar or typed-array
load that V8 handles for free and that the design *wants*. That is exactly the noise
profile that left INV-6 untightened. The rule has to be about **callee provenance**, not
about indexing. §7 states it that way.

---

## 5. Verdict on the FunctionLiteral argument (§0.3)

**The argument holds. U4 is required. "Just restructure `assemble.ts`" is dead.**
The mechanism claim and its consequence were both verified, by inlining-decision
observation under `--trace-turbo-inlining`. No timing.

**Test A — is the FeedbackVector shared?** One `CreateClosure` site (`lower`'s
`(input, pos) => k0(input, pos)`) minting four closures, each binding a different callee.
TurboFan inlined that SFI at four distinct call sites and reported the **same feedback
vector object at all four**:

```
Considering 0x…{<SharedFunctionInfo>} for inlining with 0xc590631e8 {<FeedbackVector[2]>}   # site #83
Considering 0x…{<SharedFunctionInfo>} for inlining with 0xc590631e8 {<FeedbackVector[2]>}   # site #98
Considering 0x…{<SharedFunctionInfo>} for inlining with 0xc590631e8 {<FeedbackVector[2]>}   # site #113
Considering 0x…{<SharedFunctionInfo>} for inlining with 0xc590631e8 {<FeedbackVector[2]>}   # site #69
```

Same address, same `FeedbackVector[2]`. **`kManyClosures` sharing confirmed.**

**Test C vs D — does the sharing block inlining?** Identical programs, 24 pieces, 6
distinct callee shapes, reached through a *varying* array index so no constant closure is
available (the real grammar case).

- **C** (assemble.ts's shape — one FunctionLiteral): TurboFan inlined the piece into the
  driver and **stopped**. The `k0(input, pos)` site was never inlined. Three trace lines
  total; no callee ever considered.
- **D** (U4's shape — 24 distinct FunctionLiterals, each naming one binding): **20+
  separate `Inlining <callee> into <q0N>` lines** — every emitted piece got its callee
  inlined into its own body, each with its own feedback vector.

**One honest boundary, which strengthens rather than weakens the design.** In Test A —
where the closure was a *constant* (module-level array, 4 entries, TurboFan-visible) —
V8 recovered the callee anyway via context specialisation: it inlined the piece with a
known `Context` and constant-folded the `k0` slot. So the design's absolute phrasing,
*"no rearrangement of `assemble.ts` can produce a monomorphic call site"*, is **true of
the IC and slightly too strong of the outcome**. The precise statement is:

> The shared FeedbackVector makes the IC at `k0(…)` megamorphic. The callee is recovered
> **only when TurboFan inlines the piece with a concrete, statically-known closure** —
> which requires ≤4 targets at the calling site and a constant-foldable reference. At
> 2,241 reachable sites reached through `kids[i]`, `arms[i]`, and a `child` *parameter*,
> neither condition holds anywhere in a real grammar.

Rephrase §0.3 that way. It survives the strongest attack I can make on it and it stops a
future reader from "falsifying" it with a four-piece toy.

**Two corollaries the design does not draw, both of which strengthen U4:**

1. **The megamorphism does not require multiple grammars in the process.** The design
   argues from `assemble()` being called once per table. It is simpler than that: within
   a *single* `lower` closure, the arity-2 `CreateClosure` site fires once per 2-ary
   sequence in that one grammar. The second 2-ary sequence is enough. A single-grammar,
   single-cfg process is already `kManyClosures`.
2. **U4's per-piece win is *inlining*, not merely a cheaper call.** Test D's callees were
   inlined into the pieces. That is the mechanism behind §3's unexplained
   "48 ns/piece vs codegen's ~28 ns with ~20 ns of work" — the missing ~20 ns is the
   callee body not being inlined, plus the `END` Context-cell store the design correctly
   identifies at §0.4.3.

**Does U4's call side reintroduce megamorphism at scale?** No, and this is the right
answer to the brief's question. A grammar with 200 rule references emits **200 distinct
call sites, each naming one binding** — 200 monomorphic sites, not one 200-way
megamorphic site. Today all 200 funnel through `nextTerm`'s `child(…)`, `kids[i](…)` and
`arms[i](…)` — a handful of sites seeing everything. The trade is:

- **cost:** feedback-vector *size* grows linearly with grammar size (one IC slot per
  emitted call site). That is memory, not speed, and it is second-priority.
- **benefit:** every one of those sites is a direct call with no megamorphic stub-cache
  probe, and each callee gets its own feedback rather than sharing one polluted vector.
- **honest bound:** a *rule reference* callee is a large function and will **not** be
  inlined — the win there is the monomorphic call only. The inlining win (Test D) is for
  the **scannable leaves**, which is precisely where the design puts the paste side of the
  paste-vs-call dichotomy. **The dichotomy is correctly placed.** Say so in §2.3 rather
  than leaving the reader to infer that 200 call sites all get inlined.

---

## 6. Test breakage, classified

Per the priority order: a test pinning an assembler internal is stale; a test pinning
parse *behaviour* is a defect signal.

| fix | what breaks | class |
|---|---|---|
| O12 — delete the redundant `_tolerant` gates | Possibly a test asserting `assemble.ts` ≡ `exec.ts` line-for-line on the recovery path. The comment at `:294` explicitly cites identity-with-`exec` as the reason to keep them. | **Stale.** Identity is gated by the interpreter as semantic reference, not by matching the interpreter's *implementation*. If a test pins the redundant read, name and delete it. |
| O4 — `OP_GATE` returns `child` under tolerant/probe | Nothing behavioural: the gate is already a no-op under both (`:803`). A test counting `reached` sites (`test/unit/table-assemble-subset.test.ts`) may see a smaller set. | **Stale**, and in fact the *intended* direction — that test asserts `reached` is a strict subset when an option excludes something. |
| U0 — extending INV-6 | `check-invariants.mjs:667` makes a **stale allowlist entry a hard failure**. Landing the extended fields without either fixing the sites or adding entries turns the gate red immediately. | **Not a test problem — a sequencing constraint.** U0 must land in reporting-only mode, or land *with* the O3/O4/O11 fixes. The design says "reporting-only mode" for INV-7 but not for the field-list extension. Say it for both. |
| U2 / U4 — size | `size-guard` ratchet (`ratchetSlackPct` 0.1) fires. | **Deliberate trade, owner ruling.** Design already says: name it in the PR, do not smuggle it. Correct. Priority 2 loses to priority 1 here. |
| Any new leaf body | `expected`-set drift is the real risk. | **Defect if it fires.** And it currently **cannot** fire at corpus scale, because `bench/table-lowering-identity.ts:19` runs `exec.ts`. Fix the harness first (§1.3). |

---

## 7. The invariant rules I would add — ranked by the speed each protects

Written to be implementable against `scripts/check-invariants.mjs`'s existing
`walkScoped` / `parsed` machinery. Each rule states its **decision procedure**, and each
is scoped to fire only on things that cost speed.

---

**INV-6a — SCOPE. `#1 by speed protected.`**

> Replace `const ASSEMBLER = 'src/table/assemble.ts'` with a **parse-path module set**.
> Seed it statically:
> `src/table/assemble.ts`, `src/combinators/trivia-skip.ts`, `src/cst/capture-buffer.ts`,
> `src/combinators/adjacency.ts`, `src/combinators/probe.ts`, `src/recovery/scan.ts`,
> `src/combinators/node.ts`, `src/combinators/literal.ts`, `src/combinators/dispatch.ts`,
> `src/compiler/fields.ts`, `src/line-index.ts`.
> Maintain it by a second check: any module `assemble.ts` imports a *function* from, that
> is called inside a piece-internal body, must be in the set or the gate fails naming it.

Protects: **10 `ctx.trackLines` reads that the gate's own field list already forbids** —
`trivia-skip.ts:88,192,196,199,226,240,254,257`, `recovery/scan.ts:117,118` — plus O1's
whole read chain. This is the highest speed-per-line-of-checker change available and it
requires **no new rule semantics at all**.

---

**INV-8 — PIECE-AS-PARAMETER. `#2.`**

> No function may accept a parameter whose declared type is `Piece`, `TermRunner`, or
> `Combinator<…>` **and call it**, unless that function is itself a value returned from
> `lower`. Decidable from the TS type annotation plus a `CallExpression` whose callee is
> that identifier.

Protects: D1 (`nextTerm`) — the design's own headline defect — and forbids its
reintroduction. Directly states the law's dispatch half, which nothing in the design's
three proposals does.

---

**INV-7 (restated) — CALLEE PROVENANCE. `#3.` Replaces "no parse-path array index".**

> Inside a piece-internal body, the callee of every `CallExpression` must be **either**
> (a) an identifier bound by a `const` in an enclosing *lowering* scope (i.e. inside
> `lower`, outside the returned closure), **or** (b) an imported module-level function.
> A callee that is a computed member expression (`kids[i]`, `arms[i]`, `runners[i]`,
> `matchFn[i]`, `scans[si]`), a parameter, or an assembly-scope mutable slot (`SCAN`,
> `COV`, `HOST`) is a finding.

Why this shape and not the design's: it catches D2 (`s(…)` where `s = SCAN` — *no index
at all*), D6 (`target!(…)` — *no index at all*), and D8 (`scans[si]` — *not `Piece[]`*),
all three of which the design's type-keyed index rule misses. And it is **silent on
`ascii[c]`, `mask[c]`, `hi[i]`, `starts[mid]`, `strs[i]`, `clss[i]`, `armFx[j]`,
`syncs[i]`, `routed[arm]`** — scalar and typed-array data loads the design wants and V8
handles for free. Noise-free by construction.

`COV` is a deliberate exception to allow (`assemble.ts:509` argues it correctly): one
slot, one `begin` write, no shape variation. Allowlist it with that sentence.

---

**INV-6d — `isPiece` BY `ctx`, NOT BY ARITY. `#4.`**

> Replace `if (!p \|\| p.length !== 3) return false` with:
> a function is **piece-internal** iff its parameter list contains an identifier named
> `ctx` or `_ctx`. No arity constraint, no ordering constraint.

Rationale, one line: *the piece signature's `ctx` is what makes a body piece-internal;
arity is not.* Catches `nextTerm(child, input, cur, ctx)` **and**
`runTerms(input, pos, ctx, values)` / `runSyncTerms` / `runAdjTerms`, which the design's
trailing-suffix rule misses (§4). Verified: this predicate is what `scratchpad/inv6x.mjs`
uses to surface all 57.

---

**INV-6b — CONFIG FIELD LIST. `#5.`**

> `CONFIG_FIELDS = { trackLines, build, _probe, _tolerant, _errors }`.

`_errors` is added on the O11 evidence and belongs with `_tolerant`: same writers, same
sentinel window, same argument. **`trivia`, `_triviaLog`, `_rootTriviaLog` and
`captureTrivia` are deliberately NOT here** — see INV-6c.

---

**INV-6c — REGION FIELDS: READS ARE FINDINGS, WRITES ARE NOT. `#6.`**

> `REGION_FIELDS = { trivia, triviaKindLabels, _triviaLog, _rootTriviaLog, captureTrivia }`.
> A **read** of one of these inside a piece-internal body is a finding whose message
> names the site-label mechanism as the fix. An **assignment target** is not a finding.
> Decision procedure: collect `AssignmentExpression.left` nodes first; skip any member
> expression identical to one.

This is the rule that keeps the gate quiet on `OP_SCOPE`'s and `OP_TOKEN`'s legitimate
save/restore (O13) — 16 sites that would otherwise be pure noise — while still firing on
O5, O6, O7 and O1's read chain. **It is also the rule that would have caught §2.1's
unsound `triviaCapture` bit**, by refusing to let `_triviaLog` join `CONFIG_FIELDS`.

---

**INV-9 — ALLOCATION ON THE TERM PATH. `#7. Reporting-only.`**

> An `ObjectExpression`, `ArrayExpression`, or `ArrowFunctionExpression` evaluated inside
> a piece-internal body in a module in the INV-6a set, where the body is reachable
> per-term. Report, do not fail.

Confidence is lower — "reachable per-term" is not syntactically decidable without a call
graph, so seed it with a declared hot-function list (`nextTerm`, `skipTrivia`,
`scanTrivia`, `advanceTrivia`, `markCst`, the `OP_SEQ`/`OP_REP` bodies). **This is the
only rule that would have caught O1**, the largest finding in this review, which no
option-test rule and no dispatch rule can see. Worth building even at reporting-only
strength for that reason alone.

---

**Not proposed:** a rule about `END`/`TERMV` Context-cell stores (§0.4.3). Real, but it is
a property of `assemble.ts` existing at all, and U4 removes it wholesale. A gate for it
would fire on every piece and be turned off within a week.

---

## 8. Summary of what the design must change

1. **§0.3** — rephrase the conclusion as *"the callee is recovered only when TurboFan
   inlines the piece with a concrete statically-known closure, which needs ≤4 targets and
   a constant reference — neither holds at grammar scale"*. Verified; §5 has the trace.
   Add the two corollaries (single grammar suffices; the win is *inlining*, not call cost).
2. **§0.6 / U2 / U3** — O1: the capturing trivia path allocates a **fresh `ParseContext`
   and re-enters the combinator interpreter**, per term. Say so, and say that neither U2
   nor U3 alone removes it.
3. **§2.1** — `triviaCapture` as a `RunCfg` bit is **unsound**. `_triviaLog` is
   per-region (`OP_TOKEN`/`OP_LEAF`), `captureTrivia` is per-node (`OP_NODE`). Both get
   the site-label treatment `ctx.trivia` gets; the label is two axes, not one.
4. **§3.2** — the site trivia label must reach `OP_NODE`/`OP_NODE_TRACK` (O7), not only
   seq/rep.
5. **§5 / U0** — three additions the design does not have: **file scope is the biggest
   INV-6 hole** (O2, 10 already-forbidden reads); the proposed `isPiece` fix misses
   `runTerms`/`runSyncTerms`/`runAdjTerms` (D3); INV-7 must be callee-provenance, not
   array-index, or it is both leaky and noisy (§4). U0's field-list extension needs
   reporting-only mode too, not just INV-7 — `check-invariants.mjs:667` makes a stale
   allowlist a hard failure.
6. **§5** — add O4 (`OP_GATE`'s `_probe` + `_tolerant`), O8–O10 (`OP_NODE`'s host
   property loads and redundant `host !== undefined`), O11 (`_errors` × 14),
   D2 (`skipTrivia`'s megamorphic scanner call), D6 (`link`'s shared forwarding stub).
7. **§8** — raise the identity-harness fix from "extend it" to **a prerequisite for U1**.
   `bench/table-lowering-identity.ts:19` imports from `exec.ts`; the corpus sweep does not
   run the shipping engine. **Confirmed.**
8. **§9.3** — resolved. `fastTriviaScanner` returns `null` for css and a function for
   json. Executed.
