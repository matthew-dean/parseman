# DESIGN — child-kind specialisation, or: how the table gets codegen's shape back

**Base.** `design/child-kind` cut from `origin/release/0.47.0` @ `382c4424a4dca58a6066476f53f5de8ff4736401`.
Reference tree for the deleted engine: `archive/codegen-fastpaths` (tag object `ad3c06f`, commit `3d4dac6`).
Design only. No `src/` change. No benchmark was run for this document; every number
below labelled PREDICTED is a prediction to be measured against, not a measurement.

---

## 0. Corrections to the brief, before anything is built on it

I was asked to correct the framing where the tree disagrees with it. Six places do.
Three of them change the design.

### 0.1 — `expected` IS in the identity digest. `notes/RELEASE-0.48-TARGET.md`'s closing section is stale.

`bench/table-lowering-identity.ts:57-62`:

```ts
return digestValue({
  ok: r.ok,
  value: r.value,
  unconsumedFrom: r.unconsumedFrom,
  expected: r.ok ? undefined : [...(r.expected ?? [])].sort(),
})
```

Added by `71bf4bc` ("digest failure"). The brief is right and
`RELEASE-0.48-TARGET.md:437-444` is wrong — it was not updated after that commit.
Two other sites carry the same stale claim and should be corrected when this lands:
`test/parity/table-lowering-gaps.test.ts:4-5`, and (as past-tense narration, so
harmless) `src/table/encode.ts:1199`.

What the digest still does *not* cover: failure **position**, `errors`, `rootTrivia`,
`committed`, and `expected` **order** (it sorts). §8 names what fills those gaps.

### 0.2 — §8's "the real gap is 4–9%" is not a measurement of this gap at all. Delete it.

`notes/RELEASE-0.48-TARGET.md:287-304` reports `bench/jess/fixture.ts` measuring
css 1.09× / less 1.05× "table at HEAD against the `ref|` leg (the shipped engine at
the pinned reference commit)". There is no pinned reference commit in that file.
`bench/jess/fixture.ts:263` reads `ref|` out of the contest labelled
`'compiled -> table'` (:254), whose `compiled` leg is `import('pm-macro:...')`
(:195-197) — the macro lowering **as it exists in the working tree**. And in this
tree `src/plugin/index.ts:28` imports `compileTable` and nothing else;
`src/compiler/codegen.ts` does not exist.

**So `bench/jess/fixture.ts` measures table-emitted-module against
table-assembled-in-process.** Both legs are the table. Its 4–9% is a plumbing delta,
not a codegen delta. §9's third candidate explanation
(`RELEASE-0.48-TARGET.md:412-414`) is the correct one, and the "UNRECONCILED"
standoff is resolved in favour of the CI numbers.

`bench/workload-perf-guard.ts` is sound by contrast: `bench/ab-harness.ts:214-256`
`materialise()` does `git worktree add --detach` at `a5dc9bd` and builds that
checkout's own `src/`, with `bench/workloads` and `examples` copied over **both**
sides so only `src/` differs. That leg genuinely is the pre-deletion engine.

**Consequence for this design:** the +137% / +500-835% figures stand as the target,
and there is no counter-evidence suggesting the gap is small. Nobody should size
this work off the 4–9%.

### 0.3 — Term 0 of an unrolled sequence is NOT monomorphic either. This is the load-bearing correction.

The brief (and `assemble.ts:1252-1256`) rests on: `nextTerm` is megamorphic because
the piece arrives as an argument, whereas `k0(input, pos, ctx)` at `assemble.ts:1494`
is a bound closure variable and therefore monomorphic and inlinable.

That reasoning holds for *source* text. It does not hold for closures, because V8
attaches inline-cache feedback to the **FunctionLiteral**, not to the closure instance.
Each `CreateClosure` bytecode owns one `FeedbackCell` in the enclosing function's
feedback vector. The cell transitions `kNoClosures → kOneClosure → kManyClosures`;
once a second closure is created from that same literal, the cell is shared and every
closure minted there **shares one feedback vector**, hence one set of ICs.

Trace it here. `assemble()` (`assemble.ts:268`) is a top-level function, created once,
so its vector is shared across every `assemble()` call in the process. `link`
(`:632`) is created from one `CreateClosure` site inside it — shared cell. The
arity-2 piece at `:1493` is created from one `CreateClosure` site inside `lower`.
Therefore **every 2-ary sequence piece in every grammar in the process shares one
feedback vector**, and the `k0(input, pos, ctx)` site inside it sees `OP_LIT` pieces,
`OP_CHOICE` pieces, `OP_RULE` pieces, `OP_NODE` pieces — all of them.

`k0(...)` is megamorphic for exactly the same reason `nextTerm`'s `child(...)` is.
Binding to a named `const` moved the array read earlier; it did not create a call site.

This is why the owner says *"we should still be codegenning"* and *"they're static
bindings."* **A distinct call site requires a distinct FunctionLiteral, and the only
way to get one per grammar site is to emit source.** No rearrangement of
`assemble.ts` can produce it — that is not a tuning failure, it is a property of the
mechanism. Any staged unit whose payoff is claimed to be "now this call is
monomorphic" while still living inside `assemble.ts` is claiming something the
runtime cannot deliver.

I flag this as the single assumption most worth attacking. §9.1 gives the
falsification test, which costs no timing run.

### 0.4 — The hottest piece in the engine carries two runtime option tests. `OP_LIT`.

`assemble.ts:657-668`, the whole of it:

```ts
case OP_LIT: {
  const s = k[code[ip + 1]!] as string
  const len = s.length
  const xf = fx[code[ip + 2]!] as string[]
  return (input, pos, ctx) => {
    if (input.startsWith(s, pos)) {
      const e = pos + len
      if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
      END = e
      return s
    }
    ctx._fe = pos; ctx._fx = xf
      if (ctx._probe !== undefined) failAt(ctx, xf, pos)
    return FAIL
  }
}
```

Three separate defects against the target, in the piece that runs most:

1. **`input.startsWith(s, pos)` for every literal length.** Codegen never emitted
   this for a literal under 17 characters. `emitLit` (`codegen.ts:1379-1428`) had
   four forms keyed on length, `CHARCODE_CHAIN_MAX = 16` (`:1377`): length 1 was a
   bare `input.charCodeAt(pos) !== 123`; lengths 2–16 were an unrolled OR-chain of
   `charCodeAt` compares behind one bounds check; only `> 16` reached `startsWith`.
   Every literal in `examples/json/parser.ts` is 1–5 chars — `{`, `}`, `[`, `]`,
   `,`, `:`, `"`, `null`, `true`, `false`. **The json workload takes the
   `startsWith` builtin call on every literal where codegen took one inline
   integer compare.** The brief's claim that codegen emitted
   `input.startsWith('@media', pos)` is wrong in the direction that matters: it
   emitted six `charCodeAt` compares.
2. **`ctx._probe !== undefined` is a per-leaf option test.** `_probe` is set by
   recovery/IDE paths before a parse and is constant for its lifetime — it is
   exactly what `RunCfg.tolerant` already keys on (`assemble.ts:216-229` argues at
   length that `_tolerant` is per-parse-fixed). Codegen resolved this at build
   time: `probeUpdate` (`codegen.ts:694-699`) emits **the empty string** when
   recovery is off. Here it is a load and a branch on every leaf of every parse,
   including the 99% of parses that will never probe.
3. **`END = e` is a store into a closure Context cell**, not a local. `END`
   (`assemble.ts:322`) is a `let` in `assemble()`'s scope captured by all ~29 piece
   kinds. Codegen's inlined leaves wrote SSA locals (`const ev = pos + len`,
   `codegen.ts:1424`) and only touched the module slot `_pfEnd` when actually
   crossing a real function boundary (`:793-798`). The table pays a heap-cell
   store at every leaf; codegen paid it at function boundaries only.

`cstCaptureActive(ctx)` is legitimately runtime (per-`node()` state, correctly
excluded from `RunCfg` at `:212-214`) — but see §3.4, it can still be selected
against once `hostCst` is false.

Counts across `assemble.ts`: 6 `_probe !== undefined` tests, 9 `cstCaptureActive`,
7 `ctx.captureTrivia`, 1 `ctx.trivia === undefined`, 9 `ctx._tolerant`.

### 0.5 — `INV-6` exists and would catch most of this, but its field list is two entries long and its detector cannot see `nextTerm`.

`scripts/check-invariants.mjs:548-613`. The rule is exactly the standing law
("no assembled PIECE body may read a per-parse CONFIG field") and its rationale
is stated correctly. Two holes:

- `CONFIG_FIELDS = new Set(['trackLines', 'build'])`. `_probe`, `_tolerant` and
  `trivia` are all per-parse-fixed and all absent. That is why §0.4's `_probe` test
  survives in the hottest piece with the checker green.
- `isPiece(n)` requires `params.length === 3` with `names[2] === 'ctx'`.
  `nextTerm(child, input, cur, ctx)` has four parameters, so **the checker does not
  consider it a piece** and its `if (ctx.trivia === undefined)` is invisible. The
  same shape defect that hides the call from TurboFan hides the branch from the
  invariant checker. That is not a coincidence — both are asking "is this one
  specialised body?" and both get "no".

### 0.6 — The css/less 6–9× second term is locatable statically, and it is not the same defect as the json floor.

The brief asked me to say in advance which unit addresses which term. The evidence:

`skipTrivia` (`assemble.ts:458-471`) takes the fast scanner **only** when
`ctx._triviaLog === undefined` and no CST trivia capture is live. The
`less/stylesheet`, `less/mixins` and `css/stylesheet` workloads are all built
`withCapture` (`bench/workloads/index.ts:113-133`) — `_triviaLog` is set.
`graphql/document` and `json/document` are `withoutCapture`.

So on css/less every non-first sequence term runs:
`nextTerm` → `skipTrivia` → `needsDeferredTriviaCommit(ctx)` true →
`scanTrivia(input, cur, ctx)` → `.commit()` → discard.
`scanTrivia` returns a `{ end, commit }` **object**, and in the capturing case a
real `commit` closure over the scan — **two allocations per sequence term**, then
thrown away.

And independently: css's trivia is `trivia(oneOrMore(choice(ws, comment)))` with
`comment = regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)`
(`examples/css/parser.ts:17-18`). `buildFastTriviaScanner`
(`trivia-skip.ts:348-365`) accepts an arm only via `regexTriviaScanner` →
`classRunSource ?? altStarSource`, i.e. a positive char class or a
`(?:…)*` alternation of classes and `C[^\n\r]*` line-comment leaders. A
`/*…*/` block comment is a **delimited** shape. It matches neither.
`arms.some(s => s === null)` → `buildFastTriviaScanner` returns **null** for css.

`scannable-run.ts` handled that shape: `delimited` is one of its nine `ScanShape`
variants, with a soundness proof (`delimitedBodySound`, `:967`) and an emitted form
(`emitShapeMatch` `delimited`, `:1557`). `trivia-skip.ts` is what survived the
cutover, and it is a small fraction of that coverage.

**Predicted split, stated in advance as instructed:**
- The **json/document +137% floor** is the per-leaf and per-term *shape* cost:
  `startsWith` for short literals, the `_probe` test, the `END` cell, megamorphic
  dispatch, `nextTerm`'s option branch.
- The **css/less extra 6–9×** is almost entirely the trivia path: capture forcing
  the deferred branch with two allocations per term, plus `SCAN === null` because
  block comments lost their recogniser.
- These are **different defects**. A unit that fixes one will not move the other,
  and if a unit moves both, my model is wrong and should be reported as such.

---

## 1. What the target shape is

Three artefacts, kept strictly separate. The design's whole discipline is that
nothing leaks between them.

```
_s0 = link('s0', opts)      // resolve this binding to a static piece — ONCE, at run start
_s1 = link('s1', opts)
_s2 = link('s2', opts)
_s3 = link('s3', opts)
_r1 = make(_s0, _s1, _s2, _s3)
_r1.parse(input)
```

**1. The piece library.** Fixed, generated, static functions. Emitted once, shared by
every grammar in the bundle. Its cost is source size and maintenance, not per-grammar
bytes. This is the superset §2 enumerates.

**2. `link(name, opts)`.** Runs once at startup. **Every** option branch is paid here
and nowhere else: trivia present or absent, CST or AST, line tracking, tolerance,
probe. `link` returns the piece; the piece does not know the option exists.

**3. `make(...)`.** Composes resolved bindings into the rule's parse function.

After `make`, the parse path holds no option test, no array index, no lookup — and,
per §0.3, each call site names one binding **in emitted source**, so it is a distinct
FunctionLiteral with its own feedback vector.

**Where the per-grammar artifact ends up.** It stops being pure data and becomes
generated wiring: a static binding per node plus a `make(...)` naming its children.
A line or two per node, **not** an inlined body per node. That is the middle ground
— codegen's shape without codegen's bulk. §6 puts a predicted byte figure on each
stage against `bench/size-baseline.json` (`example/json` 1,336 B; `example/css`
9,229 B; ceiling 10, `ratchetSlackPct` 0.1).

---

## 2. The piece taxonomy

The superset is over **emitted body shapes**, indexed by `(option × arity × child-kind)`.
It is finite, emitted once, and generated — but it is not free to author or maintain,
and that maintenance cost is the real constraint on how far specialisation goes.

### 2.1 The option axis — already solved, keep it exactly as is

`RunCfg` (`assemble.ts:193-236`) plus `cfgKey` (`:239-241`) is the correct mechanism
and the correct argument for it. Four bits, sixteen assemblies. The design **adds two
bits and no new mechanism**:

| bit | today | after |
|---|---|---|
| `hostCst` | `RunCfg` | unchanged |
| `trackLines` | `RunCfg` | unchanged |
| `tolerant` | `RunCfg` | unchanged |
| `coverage` | `RunCfg` | unchanged |
| **`probe`** | per-leaf `ctx._probe !== undefined` | `RunCfg` bit (§0.4, and codegen's `probeUpdate` precedent) |
| **`triviaCapture`** | per-term inside `skipTrivia` | `RunCfg` bit — `_triviaLog`/`_rootTriviaLog` presence is fixed before the parse |

Six bits, 64 assemblies worst case, and most grammars realise two or three of them.
`RunCfg`'s existing doc discipline — *state why the field cannot change during a
parse* — must be extended to both new bits, and both must survive the same
scrutiny that rejected `cstCaptureActive` at `:212-214`.

**`ctx.trivia` presence is the one that does NOT become a bit,** and this is the
subtlety the design has to get right. `OP_SCOPE` swaps `ctx.trivia` mid-parse
(`assemble.ts:1014`, `:1019`, `:1029`, `:1161`, `:1176`) — `rules({ trivia })` is
per-scope, not per-parse. So `nextTerm`'s `if (ctx.trivia === undefined)` cannot be
lifted to `cfgKey`.

It can be lifted to **the site**, which is strictly better. Whether a given `OP_SEQ`
sits under a trivia-bearing scope is a static property of the encoded table: it is
the nearest enclosing `OP_SCOPE`/`OP_SCOPE_CAP`, and `encode.ts:520` already emits
that wrapper with the trivia slot. A downward pass over the code array labels each
sequence site `trivia: none | slot-N`. That is an **encoder-side** analysis, resolved
before `link` ever runs, and it makes the trivia decision a child of the *site* rather
than of the *options* — which is what codegen did (`ctx.activeTrivia`,
`codegen.ts:1774`).

### 2.2 The arity axis — already solved, extend the ceiling once and stop

`assemble.ts:1467-1560` unrolls 1/2/3 and falls to `runTerms`. That is the right
mechanism and the right cutoff argument. In emitted form the same cutoff applies:
generate unrolled bodies for arity 1–4, generic loop above. Arity 4 is worth adding
because css declarations (`sequence(ident, ':', valueList, optional(important),
optional(';'))`) are 5-ary and less rules are wider; I would **not** go past 4
without a measured row histogram, which `src/table/inspect.ts:48` (`reachableOps`)
can produce without timing anything.

### 2.3 The child-kind axis — the missing third

This is the new work. A child's opcode is **already visible to the parent at
assembly time** — `assemble.ts:1385` does exactly this today:

```ts
for (let i = 1; i < n; i++) if (code[code[base + i]!] === OP_ADJ) { hasAdj = true; break }
```

`code[base + i]` is the child's ip; `code[<ip>]` is the child's opcode. **No encoder
change is required to see child kind.** That is a significant de-risking of the
staging: selection is available today, only the pieces are missing.

**The child shapes that earn a dedicated body**, and the cutoff rule.

The cutoff rule is: **a child kind earns an inlined body when its entire matcher is
branch-free straight-line code with no call into another piece and no allocation.**
That is not an aesthetic rule — it is codegen's own rule, read off its behaviour.
`emitLit`, `emitRegex`-when-scannable, and `emitShapeMatch` all paste; `emitLazy`
pastes only under a node budget (`INLINE_MAX_NODES = 1000`, `codegen.ts:5036`) and
otherwise calls `_pfN`; named rules **never** inline (`:4349-4352`); multi-use
subtrees over `HOIST_MIN_SUBTREE = 3` nodes hoist to a call (`:4545-4585`,
`:5002`). Codegen bounded its own explosion with a node budget and a use-count
threshold, and inlined nothing that had internal control flow of its own.

| child kind | opcode | inline into parent? | body |
|---|---|---|---|
| literal, len 1 | `OP_LIT` | **yes** | `input.charCodeAt(p) !== 123` |
| literal, len 2–16 | `OP_LIT` | **yes** | bounds check + unrolled `charCodeAt` OR-chain |
| literal, len > 16 | `OP_LIT` | **yes** | `input.startsWith(s, p)` |
| literal, case-insensitive | `OP_LIT_CI` | **yes** | `foldEq` chain (`scannable-run.ts:120`) |
| regex with a `ScanShape` | `OP_RX` | **yes** | `emitShapeMatch` form — char loop, ident, until, delimited, string, seq, litFold, alt, lookahead |
| regex without a `ScanShape` | `OP_RX` | **yes** | hoisted sticky `re.exec`, still straight-line |
| char class | (a `chars` `ScanShape`) | **yes** | `while` + `classCond` |
| trivia scan | site property, not a child | **yes** | the specialised scan loop, spliced per term position |
| `OP_EMPTY`, `OP_ADJ` | | **yes** | zero-width, already trivial |
| rule reference | `OP_RULE` | **no — call** | named binding `_s0(input, p, ctx)` |
| nested seq / choice / rep / opt / node | `OP_SEQ`… | **no — call** | named binding |
| everything else (24 opcodes) | | **no — call** | named binding |

**So the taxonomy is small.** Two child classes: *scannable leaves*, which paste;
and *everything else*, which becomes a named static binding called from a distinct
site. The apparent combinatorial explosion `(option × arity × child-kind)` does not
materialise, because:

- the option axis is resolved into `cfgKey` before body selection, and the trivia
  variant is a site label, so it multiplies the *selection table*, not the *body set*;
- the child-kind axis has **two** values at each term position (paste / call), not
  seven, so an arity-`n` sequence has 2^n body variants in principle — and here the
  bound bites: **only the paste bodies are generated, and they are generated by
  composing the leaf emitters, exactly as `emitSeqValues` did.** There is no
  hand-written piece per combination. `emitShapeMatch` (`scannable-run.ts:1244`) is
  the single source of truth for nine shapes and is consumed by both the terminal
  emitter and the trivia loop precisely so the two can never disagree; that
  composition property is what keeps the library authorable.

**Where specialisation stops:** at anything with internal control flow. A choice arm,
a repetition body, a `node()` — these get a binding and a call. Codegen did the same
and its `example/css` was still 224,100 B; the difference here is that codegen also
pasted whole rule bodies under a 1000-node budget, and we do not. That single
decision is most of the 224,100 → target-few-tens-of-KB gap.

---

## 3. Selection — how assembly picks a body without a runtime test

### 3.1 What is already available

- **Child opcode:** `code[code[base + i]!]`, no encoder change (§2.3).
- **Literal length:** `(k[code[kidIp + 1]!] as string).length`, no encoder change.
- **Regex source and flags:** `k[code[kidIp + 1]!]` is the `RegExp`; `.source` /
  `.flags` feed `scanShapeFromRegex` directly. No encoder change.
- **Option set:** `RunCfg` / `cfgKey`, plus the two new bits.

### 3.2 What the encoder must add

One thing, and it is an analysis rather than a new opcode:

**A per-site trivia label.** Each `OP_SEQ`/`OP_SEQV`/`OP_SEQX`/`OP_REP`/`OP_REPV`
row gains an operand: `-1` for "no trivia in scope", else the trivia slot index
of the nearest enclosing scope. Computed by one downward walk during `encode`,
where the scope wrapper is already emitted (`encode.ts:520`, `:1160`). This is what
turns `nextTerm`'s `if (ctx.trivia === undefined)` into a selection.

Optionally, a **precomputed `ScanShape` id** per `OP_RX` row, so `parseScanShape`
runs at encode time and the shape is table data rather than re-derived per assembly.
I would defer this: `scanShapeFromRegex` is memoisable on the `RegExp` object
(`fastTriviaCache` already demonstrates the pattern at `trivia-skip.ts:34`) and
assembly runs once per grammar per cfg. Adding it to the table costs bytes for no
parse-path benefit.

### 3.3 The one thing selection must not do

It must not consult anything that varies during a parse. The four rejected candidates
are already documented and the reasoning is correct and reusable: `cstCaptureActive`
(`assemble.ts:212-214`), `ctx._cstBuf` (`:227-229`), the capture sinks
(`check-invariants.mjs`'s RUNTIME column), and the position. Any new bit must come
with the same paragraph.

### 3.4 `cstCaptureActive` — selectable in the common case even though it is runtime

`cstCaptureActive(ctx)` appears 9 times and is genuinely per-node. But when
`RunCfg.hostCst` is false **and** the grammar has no `OP_LEAF`/CST-capturing scope
reachable from a site, capture can never become active there. That is a reachability
fact the assembler can compute from the code array. The AST-host assembly then
selects leaf bodies with no capture test at all — which is what codegen emitted,
since it generated per-host-mode variants.

I am moderately confident in this and it is the sort of claim that produces a silent
wrong-output bug if the reachability analysis is wrong. It should land **after** the
cheap units and behind the §8 gates, not before.

---

## 4. The archived capabilities, as pieces

Per the owner's clarification: recover the **capabilities**, not the modules. No file
is restored to `src/compiler/`. `codegen.ts` does not come back as a shipping engine;
it is the reference for the shapes, and `a5dc9bd` remains reachable as a measurement
leg through `bench/ab-harness.ts`'s `materialise`.

| archived capability | becomes | why |
|---|---|---|
| `scannable-run.ts` — `parseScanShape` / `scanShapeFromRegex` (lines 1–1152, the analysis half) | **encoder-side or assembly-side analysis, not a piece.** Ported as a shape recogniser consumed by `link`. | It is a *classifier*: regex source → one of nine shapes. Nothing about it runs at parse time. ~71% of the file is soundness proofs (`seqIsUnambiguous`, `trailingBacktrackClass`, `allPairsDisjoint`, `delimitedBodySound`) answering "does greedy one-pass scanning provably equal the backtracking engine" — that is exactly the correctness argument the new pieces need, and re-deriving it is the largest avoidable cost in this project. |
| `scannable-run.ts` — `emitShapeMatch` (lines 1154–1627, the emission half) | **nine piece bodies**, one per `ScanShape` variant, selected by `link` from the recognised shape. | These *are* the piece library's leaf half. `chars`, `ident`, `until`, `delimited`, `string`, `seq`, `litFold`, `lookahead`, `alt`. `delimited` is the one css needs back (§0.6). |
| `scannable-terminal.ts` (31 lines) | **the composition rule**, not a piece. | Correcting the brief: this file contains no classification. It is a five-line wrapper — run `emitShapeMatch`, fail if `ok !== 'true'`, slice the value. Its value is its header claim: terminal and trivia share **one** match core so they can never disagree about an incomplete token. That invariant must be preserved by construction in the new library. |
| `trivia-fast-path.ts` (296 lines) | **trivia-scan piece bodies, spliced per term position**, selected by the site's trivia label × the capture bit. | Four tiers: unlabeled scannable, labeled scannable, labeled all-regex arms, labeled runtime arms (`ensureTriviaFn`, `codegen.ts:1044-1130`). The capture tail (`CAP_RECORD`, `:74-79`) is **part of the loop body**, which is how it captures with zero allocation — versus today's `{end, commit}` object per term (§0.6). Note it never emitted inline into the sequence body either: it built a whole `_tfN` function and the sequence called it. That is a real precedent for a *call* being acceptable here, and it is why §6's U2 targets the option branch and the allocation rather than the call. |
| `trivia-fast-path.ts` — the commit-only-if-the-term-consumed rule (`codegen.ts:1785`, `:1832`) | **selection**: when `alwaysConsumes(term)` is statically true, emit no marks and no rollback at all. | This is `nextTerm`'s `if (END > scanEnd) … else rollbackTriviaAt(…)` (`assemble.ts:545-549`) turned into a compile-time fact. `alwaysConsumes` is derivable from the child opcode. Free win on every term whose child is a literal or a `min>=1` regex. |
| `module-hoist.ts` (221 lines) | **encoder-side decision.** | `HOIST_MIN_SUBTREE = 3` plus a use count. The table already memoises by code offset (`assemble.ts:632-650`), so subtree sharing exists; what is missing is the *threshold*, i.e. deciding when a shared subtree should be a named binding rather than pasted. That is precisely the size lever in §6. |
| `inline-build.ts` (111), `inline-callback.ts` (105) | **encoder-side decisions.** | Both are analyses answering "may this reducer/build call be pasted". They inform `OP_SEQX` fusion, which the table already has. Port the analysis; there is no piece. |
| `line-index.ts` | **reference only.** | §4 of `RELEASE-0.48-TARGET.md` is the open item (`TODO(table/expect-span-lines)`); it is a correctness gap, not a speed one, and orthogonal to this design. |
| `codegen.ts` | **reference only. Recommend it does not come back.** | Owner decision, flagged. My recommendation and its cost are in §4.1. |

### 4.1 On `codegen.ts` specifically — recommendation, with the tradeoff stated

**Recommend: do not restore it as a shipping engine.** Reasons, in order of weight:

1. Restoring it restores *two* recognisers, and the entire cost of 0.47 was paid to
   have one. Every divergence class that `bench/jess/digest.ts` and
   `test/parity/*` exist to catch would double.
2. Its bulk is the thing being rejected: `example/css` 224,100 B against 9,229 B.
   The middle ground is not reachable by keeping the high end and adding a low end.
3. Its emitted shapes are what this design reconstructs. Once they are reconstructed,
   the emitter is redundant by construction — and if it is *not* redundant, that is
   a coverage bug in the new library which having the old emitter around would hide.

**The tradeoff, honestly:** restoring it is the only way to get the old numbers back
*immediately*, and this design is a multi-stage project whose later stages are the
expensive ones. If the release schedule cannot absorb that, restoring codegen as a
temporary opt-in engine buys time at the cost of maintaining two recognisers for the
duration. **Design so either answer works:** nothing in §2–§3 depends on codegen's
absence, and `a5dc9bd` stays reachable through `materialise` regardless, so the
measurement leg does not depend on this ruling either.

---

## 5. The invariant, and how a reviewer detects a violation

**The invariant.** Options are resolved by selecting a body. No parse path contains a
test on a fact that is fixed before the parse (or fixed for the site). No parse path
indexes an array to find a child.

**How each proposal preserves it**, and this is the table a reviewer should demand:

| proposal | option decisions it removes from the path | new tests introduced |
|---|---|---|
| `_probe` → `RunCfg` bit | 6 per-leaf `ctx._probe !== undefined` | none |
| trivia label per site | `nextTerm`'s `ctx.trivia === undefined`, per term | none |
| `triviaCapture` → `RunCfg` bit | `skipTrivia`'s 3-clause test, per term | none |
| `alwaysConsumes` at selection | the mark block + `END > scanEnd` + rollback, per term | none |
| length-keyed literal bodies | — (it is a *work* reduction, not a branch reduction) | none |
| `ScanShape` leaf bodies | `re.exec` for shapes that lower | none |
| AST-host capture elision (§3.4) | 9 `cstCaptureActive` on the AST assembly | none |

**Detection — three mechanisms, in increasing strength.**

1. **Extend `INV-6`'s `CONFIG_FIELDS`** to `{ trackLines, build, _probe, _tolerant, trivia }`.
   That alone makes §0.4's defect a build failure. Cheap, and it should land in the
   first unit so every later unit is checked by it.
2. **Fix `INV-6`'s `isPiece`** so a helper that takes a `Piece` as a parameter is
   treated as piece-internal. The current 3-parameter test is exactly why `nextTerm`
   evaded it (§0.5). Concretely: any function whose parameter list *ends* in
   `(input, cur|pos, ctx)` is piece-internal, regardless of leading parameters.
3. **A new invariant, `INV-7`: no parse-path array index.** Decidable syntactically —
   a computed member expression on a `Piece[]`-typed binding inside a piece body.
   `kids[i]`, `arms[i]` (`assemble.ts:1627`, `:1716`, `:1734`, `:1760`, `:2135`),
   `runners[i]` (`:1351`, `:1418`) are the current population. This is the invariant
   that keeps §1's "no arrays on the parse path" enforced rather than aspirational.

A reviewer who is handed a unit and asked "does this violate the invariant" should
run these three and then ask, for every remaining `ctx.` read inside a piece, *when
can this field change* — the `RunCfg` doc comments are the model for the answer, and
an answer of "never during a parse" is a violation, not a justification.

---

## 6. Staging

Ordered by evidence gained ÷ cost. Every prediction is mine to defend; none is measured.
Discriminator is `json/document` throughout (138 rows, zero `OP_LIVE`, stable to a
tenth of a percent, +137% floor) except where stated.

Baseline for size claims: `bench/size-baseline.json` — `example/json` 1,336 B,
`example/css` 9,229 B, ceiling 10, `ratchetSlackPct` 0.1.

---

### U0 — Tighten the invariant checker. *Land first, alone.*

**Change.** `CONFIG_FIELDS` += `_probe`, `_tolerant`, `trivia`. `isPiece` matches on a
trailing `(input, pos|cur, ctx)` parameter suffix. Add `INV-7` (no parse-path array
index) in *reporting-only* mode.

**Hypothesis.** The checker currently green-lights the defects this design exists to
remove; making it red is how every later unit gets checked for free.

**Predicted effect.** Zero on performance. It will report ~6 `_probe` sites, 1
`ctx.trivia` site, and ~9 array-index sites. If it reports substantially more than
that, my reading of `assemble.ts` is incomplete and the staging below needs revisiting
before anything else lands.

**Measurement.** `node scripts/check-invariants.mjs`. No timing run.

**Cost.** Hours. **Evidence/cost: highest in the list.**

---

### U1 — Length-keyed literal bodies + `_probe` as a `RunCfg` bit.

**Change.** `OP_LIT`/`OP_LIT_TRACK`/`OP_LIT_CI` select among four bodies by literal
length, per `emitLit`'s `CHARCODE_CHAIN_MAX = 16` pivot. `_probe` joins `RunCfg`; the
probe-bearing bodies are a separate selection. Still inside `assemble.ts` — this unit
does **not** require emitted source.

**Hypothesis.** json's literals are 1–5 chars and its parse is literal-dominated. It
is paying a `startsWith` builtin call plus a `_probe` load-and-branch per literal,
where codegen paid one to five inline integer compares and nothing.

**PREDICTED: recovers 20–30% of json/document's +137%.** Reasoning: `startsWith` on a
1-char needle is a call into a builtin with its own receiver check, bounds arithmetic
and (for a sliced/rope string) a flattening check — a plausible 10–20 ns against
~1 ns for `charCodeAt(p) !== 123`. json's hot loop hits `{`, `}`, `[`, `]`, `,`, `:`,
`"` constantly, and the string parse alone is two `"` literals per string. The
`_probe` test is cheap individually but is one of very few instructions in the
success path of the shortest piece in the engine. I am putting more of this on the
literal bodies than on `_probe` — roughly 20% and 5%.

**Kills the hypothesis if:** json moves less than 10%. That would say leaf work is not
where json's floor lives, and U2/U4 should be re-ranked ahead of any further leaf work.

**Size.** Zero — no per-grammar bytes change; the bodies live in the runtime.

**Cost.** Small. Self-contained. **This is the unit I would land first after U0** —
see §7.

---

### U2 — Inline `nextTerm` away: per-position term bodies, trivia decided at the site.

**Change.** The per-site trivia label (§3.2) lands in the encoder. `nextTerm`
disappears as a shared helper; each unrolled arity body inlines the term body at each
position, in the variant the site's label and the `triviaCapture` bit select. The
`alwaysConsumes` selection removes the mark/rollback block wherever the child cannot
match empty. `triviaCapture` joins `RunCfg`, and the capture tail moves *into* the
scan loop (`CAP_RECORD`'s shape), killing the `{end, commit}` object and its closure.

**Hypothesis.** Two defects in one function: a per-term option branch that assembly
could have resolved, and — on capture workloads — two allocations per term.

**PREDICTED, and the prediction is split because the split is the test:**
- **json/document: recovers 10–20%** of the +137%. json is `withoutCapture`, so the
  allocation half does not apply; what it gets is the removed `ctx.trivia` branch,
  the removed mark block on `alwaysConsumes` terms, and one fewer call frame. I
  deliberately do **not** predict a large monomorphism win here — see §0.3; inside
  `assemble.ts` the call site does not become monomorphic, it only disappears.
- **css/stylesheet and less/*: recovers a large share of the 6–9× second term** —
  PREDICTED 200–400 percentage points of the ~500–835%. Two allocations per sequence
  term across a 64 KB css parse is a young-generation pressure story, and while §3 of
  `RELEASE-0.48-TARGET.md` correctly records that V8 absorbs non-escaping young-gen
  allocation, the `commit` closure captures the scan and is passed to `.commit()` —
  it is not obviously non-escaping, and the `{end, commit}` pair is returned across a
  function boundary.

**Kills the hypothesis if:** css/less move less than 100 points. That would say the
trivia cost is in the *scan* rather than the *protocol*, and U3 should absorb the
whole css/less term instead.

**Size.** One extra operand per sequence row. PREDICTED `example/json` +40–80 B
(~3–6%), `example/css` +200–400 B (~2–4%). Both are inside the ceiling of 10 but
**outside `ratchetSlackPct` 0.1**, so `size-guard` will fail and the baseline must be
re-cut with owner sign-off. Name it in the PR; do not smuggle it.

**Cost.** Medium — encoder analysis plus the body set. **Evidence/cost: high, and it
is the only unit that addresses the css/less term.**

---

### U3 — `ScanShape` recognition and the nine leaf bodies, including `delimited`.

**Change.** Port `parseScanShape` / `scanShapeFromRegex` and their soundness proofs
from `archive/codegen-fastpaths:src/compiler/scannable-run.ts` as an assembly-time
classifier. Add the nine leaf bodies. Route both the terminal path (`OP_RX`) and the
trivia scan through the same match core, preserving `scannable-terminal.ts`'s
one-core invariant. `trivia-skip.ts`'s `buildFastTriviaScanner` is replaced by the
classifier, so block comments get a scanner again and `loopScanner`'s
`for (const arm of arms)` array iteration with a megamorphic `arm(...)` call goes
away, as does `inRanges`' per-character range loop in favour of an inline
`classCond` chain.

**Hypothesis.** css/less trivia currently has **no** fast scanner at all
(`SCAN === null`, §0.6), so every term falls to `advanceTrivia`, which re-enters the
combinator parser. That is a per-term interpreter re-entry on a 64 KB input.

**PREDICTED: recovers most of whatever U2 leaves of the css/less term** — if U2 lands
first and takes 200–400 points, U3 takes a further 150–300. **Predicted effect on
json: near zero.** json's trivia is `regex(/[ \t\n\r]*/)`, a bare `chars` class that
`classRunSource` already recognises, so json already has a fast scanner. This is the
sharpest before/after prediction in the document and the one I would most want
checked: **U3 should move css/less a great deal and json essentially not at all.**
If it moves json, my model of the split (§0.6) is wrong.

**Falsification available without timing:** print `fastTriviaScanner(rw) === null` for
`examples/css/parser.ts`'s `rw`. One line, no benchmark. Do this before building U3.

**Size.** Zero per-grammar bytes if the classifier runs at assembly; a `ScanShape` id
operand per `OP_RX` row if it is precomputed (§3.2 — I recommend against).

**Cost.** Large — 1627 lines of which ~71% is soundness argument that must be ported
rather than re-derived. **Evidence/cost: medium. High value, high cost, and it is
where the archive saves the most work.**

---

### U4 — Emitted source with static bindings: the actual `link`/`make` shape.

**Change.** The per-grammar artifact becomes generated wiring: `const _s0 = link(...)`
per node, `const _r1 = make(_s0, _s1, _s2, _s3)` per rule, with the sequence bodies
emitted per site so each call site is a distinct FunctionLiteral. `kids`, `arms` and
`runners` cease to exist on the parse path.

**Hypothesis.** §0.3 — inline-cache feedback is per-FunctionLiteral, so process-wide
megamorphism at every piece call site is unavoidable inside `assemble.ts` and can only
be fixed by emitting distinct sites.

**PREDICTED: recovers the remaining 40–60% of json/document's +137%,** and this is
the largest single term. Reasoning: after U1–U3 the leaf *work* matches codegen's, so
what is left is dispatch. A megamorphic call in V8 is a hash lookup in the megamorphic
stub cache with no inlining and no type feedback for the callee's body; a monomorphic
call at a hot site is typically inlined outright. §3's unexplained "48 ns per piece
against codegen's ~28 ns, ~20 ns of *work* per piece, nobody has located it" is, I
believe, mostly this plus the `END` Context-cell traffic — both of which U4 removes,
since emitted bodies use SSA locals for `end` exactly as `codegen.ts:1424` did.

**Kills the hypothesis if:** json moves less than 20% after U1–U3 have landed. That
would mean the feedback-vector model is wrong, and the residual is somewhere nobody
has looked — in which case say so loudly, because it would be the third failed
mechanism in a row for this gap and the diagnosis should be restarted from a
profile rather than a model.

**Size.** This is the unit that moves bytes. PREDICTED `example/json` 1,336 B →
**2,200–3,000 B**; `example/css` 9,229 B → **16,000–24,000 B**. Reasoning: one
binding line (~25 B) plus one `make(...)` argument list per node, against codegen's
15,138 B / 224,100 B which pasted whole bodies. That lands roughly 1.7–2.5× above the
table and 5–10× below codegen — the middle ground, biased small, as instructed.
`bytesRatio` for `example/css` is 0.95 today against a ceiling of 10, so there is
headroom; but the **baseline must be re-cut with owner sign-off**, and the ratchet
will fire.

**Cost.** Largest. Requires the emitter, and it changes what a shipped artifact is.

**Ordering note.** U4 is where the biggest win is predicted and it is deliberately
last, because U1–U3 are cheap, independently valuable, and *reduce the size of U4* —
every option branch resolved and every leaf body settled before U4 is one fewer thing
the emitter has to get right.

---

### U5 — Arity 4, AST-host capture elision (§3.4), `module-hoist` thresholds.

Deferred deliberately. Each is a modest win behind a correctness risk (U5's capture
elision especially — a wrong reachability analysis silently drops CST children,
which is exactly the failure class §8 is built to catch). PREDICTED: single-digit
percent each. Land them once the gates in §8 have proven themselves against U1–U4.

---

## 7. The one unit I would land first

**U1** (after U0, which is a checker change and not really a unit).

Not because it is the biggest — U4 is, by my own prediction. Because it is the
cheapest thing that **discriminates between two live models of the json floor**.

The two models are: (a) json's floor is per-leaf *work* — `startsWith` where codegen
had a compare, plus a `_probe` branch; (b) json's floor is *dispatch* — megamorphic
piece calls and `END` cell traffic, which only U4 fixes. They predict different
outcomes for the same small change. U1 costs a day and settles which of U1-shaped or
U4-shaped work should absorb the budget.

It is also the unit where I am most confident the archive is right and the current
tree is wrong: `emitLit`'s four-form length pivot is not a subtle optimisation, it is
the obvious thing, and the table simply does not do it. Even if model (b) turns out to
dominate, U1's change is correct on its own terms and stays.

And it is fully self-contained: no encoder change, no emitted-source change, no size
movement, one opcode family, and `test/parity/failure-diagnostics.test.ts` plus the
identity sweep cover it completely.

---

## 8. Correctness gates

The failure class this design most plausibly produces is: **a specialised body that
accepts and rejects identically but reports a different `expected` set, or a
different failure position.** Length-keyed literal bodies, `ScanShape` leaf bodies,
and inlined term bodies each rewrite a failure site.

`bench/table-lowering-identity.ts` catches part of this and misses part of it
(§0.1): it digests sorted `expected` but not position, order, `errors`, or
`rootTrivia`. The full gate is four instruments, and all four must be named in
any PR from this design:

| instrument | what it catches | note |
|---|---|---|
| `bench/table-lowering-identity.ts` (~2,800 files) | accept/reject, value, `unconsumedFrom`, sorted `expected` | **Runs only `tableRules` (exec), never `assembledRules`** — `:19`, `:84`. Extend it, or every assembler-only divergence stays invisible at corpus scale. |
| `bench/jess/digest.ts` | `FACETS = ['value','span','expected','expected-order','errors','rootTrivia']`, per file per engine, three processes joined by `bench/jess/divergence.ts` | The **widest** instrument in the repo and the right one for this work. `expected-order` is the facet the identity sweep sorts away. |
| `test/parity/failure-diagnostics.test.ts` | `span.start`, `span.end`, sorted `expected`, interpreter vs table, plus a macro leg | The direct test for the failure class above. Every new leaf body needs a case here. |
| `test/parity/table-lowering-gaps.test.ts` | all three current engines (`interpreted`, `exec`, `assembled`) | Hand-written cases only. **The named gap: nothing A/Bs `expected` between `exec.ts` and `assemble.ts` at corpus scale.** Closing that is a prerequisite for U2 onward. |

**The semantic reference is the interpreter** (`test/parity/helpers/engine-parity.ts`,
header `:1-24`), and the rule there is right: compare **whole objects**, not a field
checklist, because a field checklist is how the `sepBy trailing:'require'`
divergence got through.

**Two gates specific to this design:**

- **Every unit that adds a leaf body adds a failure case** asserting the `expected`
  label is byte-identical to the unspecialised body. Codegen preserved this by
  construction (`emitLit` computes one `expectedStr` and feeds all four forms —
  `codegen.ts:1383`, used at `:1396`, `:1404`, `:1412`, `:1419`); the port must
  preserve it the same way, by deriving the label once above the length switch.
- **`scripts/check-invariants.mjs` as extended in U0** runs in preflight on every
  unit. A unit that needs an exemption is a unit that has misunderstood the design.

**A note on `check:control-bytes`:** per repo memory it is not in preflight and scans
tracked files only — re-run it after committing anything with generated source.

---

## 8b. Queued 0.48 work — does this architecture accommodate it?

Three items in `RELEASE-0.48-TARGET.md` interact with the piece library. The
question for each is whether it becomes a new **row** in the library or a second
architecture.

### 8b.1 Token streaming (§2) — a new axis, and the axis is already implied

`src/compiler/token-scanner.ts` (14,800 B), `token-alphabet.ts` (9,099 B) and
`token-dispatch.ts` (15,558 B) are in-tree, built and never wired, carrying `DEBT`
entries at `scripts/invariant-allowlist.mjs:111-116` pointing at
`docs/design/derived-tokenization.md`.

**Answer: yes, the axes accommodate it, and the accommodation is cheap — but it is a
fourth axis, not a value on an existing one.** The selection key becomes

```
(input-representation × option × arity × child-kind)
```

with `input-representation ∈ { chars, tokens }`. A char-consuming literal body and a
token-consuming literal body are two members of one family, chosen by `link` at run
start, with no parse-path branch either way. That is exactly the property §2 is built
on and it holds without modification.

**What has to be true for that to work, and it is not free.** The piece signature
`(input: string, pos: number, ctx: ParseContext)` (`assemble.ts:174`) hard-codes the
representation in its first two parameters. A token-consuming body wants
`(stream, index, ctx)`. There are two ways out and they differ in cost:

- **Keep the signature, change what `input`/`pos` mean per assembly.** The token
  stream carries the source string; `pos` becomes a token index. Every piece in an
  assembly agrees on the interpretation because the assembly was selected for it.
  Cheap, type-hostile, and the type-hostility is the point at which it would want
  `any` — which is banned. It needs a genuine discriminated parameter type with two
  branches resolved at selection, not a widened one.
- **Two signatures, two families.** Honest, and doubles the library.

**I recommend deciding this now and doing nothing about it now.** The decision that
must be made today is only: *the piece signature is a type that can have two members*.
That costs one type alias and no code. Building token bodies today would be
overbuilding against the middle-ground mandate.

**Which staged units are token-neutral, and which are not:**

| unit | token-streaming impact |
|---|---|
| U0 (invariant checker) | **neutral.** It checks for option tests, which is representation-independent. |
| U1 (length-keyed literals, `_probe` bit) | **superseded, not reworked.** A token-consuming literal body is an integer compare on token kind — it replaces the `charCodeAt` chain rather than modifying it. U1's `_probe` half is neutral and survives. U1 is a day's work, so losing half of it later is not a reason to defer it. |
| U2 (`nextTerm` inlined away) | **the one to design for, per the brief's own point.** If trivia is classified once by the stream, the per-term scan does not shrink — it *disappears*, because the stream has already skipped it. So U2's term bodies must be selected in three variants, not two: `no-trivia`, `scan-trivia`, and (later) `stream-pre-classified`. **Cheap choice available now:** make the site's trivia label an enum with room for a third value rather than a boolean. That is the "cheap choice now that avoids a rewrite later" the brief asked for, and it costs nothing. |
| U3 (`ScanShape` recognition) | **partly superseded, and this is the strongest argument for sequencing it after U4.** The nine shape bodies are char-level recognisers. If tokens land, `delimited` (block comments) and `string` become the *tokeniser's* job, not the leaf's — `token-alphabet.ts` exists to classify exactly those. U3 is the largest unit by cost (1627 lines, ~71% soundness proofs) and the most exposed to being redone. **Flagging this as a real sequencing risk:** if token streaming is going to land in 0.48, U3 should be scoped down to *only* what the trivia path needs (the `chars`, `alt` and `delimited` shapes) rather than porting all nine. |
| U4 (emitted source, static bindings) | **neutral, and it is the enabler.** `link`/`make` is representation-agnostic by construction. Whether `_s0` resolves to a char body or a token body is one more thing `link` decides. |

**The bound I am not allowed to use, and am not using.** `RELEASE-0.48-TARGET.md:32-45`
records ~1.4 ms for token scanning, ~1.6 ms for superoperators, ~10% for
materialisation, ~0.1 ms for builder megamorphism — all measured against the bytecode
interpreter, an architecture that no longer exists, and the token figure was
structurally blind to entry elimination. **None of them appear anywhere in this
document as evidence, and I make no prediction of token streaming's payoff.** The
correct next step for that is to re-derive a bound against the closure assembler,
which is a separate piece of work from this design.

### 8b.2 `_grammarTrace` parity (§1) — a clean variant, plus one honest caveat

Codegen emits the six trace phases at ~40 fine-grained sites. In this architecture
trace is **a clean additional variant**: one more `RunCfg` bit, and `link` resolves
traced/untraced bodies exactly as it resolves probe/tolerant. That is the same law
this design already enforces, so trace costs no new mechanism.

The caveat is the multiplication, and it is where the six-bit key starts to bite.
With `probe` and `triviaCapture` added (§2.1) plus `trace`, `cfgKey` is seven bits =
128 assemblies. The *cache* is fine — realised assemblies are what cost memory, and a
grammar realises two or three. The *library* is the question: a traced variant of
every body is a second copy of every body's source. **Recommendation: trace bodies are
generated from the untraced ones by the same emitter rather than hand-authored**, which
keeps the maintenance cost at one body per shape. This is the same discipline that
makes `emitShapeMatch` one source of truth for nine shapes and two consumers.

### 8b.3 `sharedPrefix` scan-once is unpaid-for in the table — add it to the mining list

`src/table/encode.ts:668-676`. The comment argues that arm ORDER is the only thing
`literalsLongestFirst` and `sharedPrefix` change, and that declared order is already
correct for `sharedPrefix` because `choice.ts:52` documents it as a `firstMatch`
specialisation. **The order argument is correct. The conclusion that nothing is owed
is not.**

`sharedPrefix` in codegen was not an ordering strategy, it was a **scan-once**
strategy: `emitNonDisjoint` (`codegen.ts:2933-2967`) dispatched to a `sharedPrefix`
emitter that matched the common prefix **one time** and then discriminated among the
arms from the position after it. Encoding the arms in declared order preserves
*semantics* and discards the *optimisation* — every arm re-matches the shared prefix
from scratch.

This belongs on the mining list beside `scannable-run.ts`, and it fits the taxonomy
without a new axis: a `sharedPrefix` choice is a **choice-kind child shape**, selected
at link time from a table-recorded prefix, with a body that matches the prefix once
and then dispatches. It is a `U5`-class item — I have no evidence about its magnitude
and will not invent one. The concrete deliverable now is to correct the comment at
`encode.ts:668-676`, which currently reads as though the strategy were fully
accounted for and would stop the next reader from looking.

Same class of finding, same list: codegen's `greedyClassify` and its 4/48/3 switch-vs-
if-chain plan (`SWITCH_RANGE_LIMIT`, `SWITCH_MAX_CASES`, `SWITCH_MIN_CASES`,
`codegen.ts:1163-1203`) should be checked against `OP_DISPATCH`'s current dispatch
selection before U5 is scoped. I did not check it and am not claiming it is missing.

---

## 9. What I am least sure of

Listed so a reviewer can attack the weak points rather than hunt for them.

**9.1 — The feedback-vector claim (§0.3) is the foundation of U4 and I have not
verified it in this process.** I am reasoning from V8's `FeedbackCell`
`kNoClosures → kOneClosure → kManyClosures` transition, which shares one feedback
vector across all closures minted from one `CreateClosure` site. If V8 in the shipped
Node version allocates per-closure vectors more aggressively than I think, then term 0
really is monomorphic today, the brief's model is right and mine is wrong, and U4's
predicted 40–60% mostly evaporates.

**Falsification, no timing needed:** run the json workload under
`--trace-turbo-inlining` (or `--trace-deopt` / `%GetOptimizationStatus`) and look for
whether the `k0(...)` call site inside the arity-2 piece is inlined or reported as
megamorphic. This should be done **before** U4 is scheduled. It is cheap and it is the
highest-value single check in this document.

**9.2 — The css/less allocation story in U2.** I claim the `{end, commit}` pair plus
the `commit` closure escape and therefore cost. §3 of `RELEASE-0.48-TARGET.md` records
a measured **zero** for a per-`node()` capture allocation of ~291k/parse, which is a
direct precedent against me. My distinguishing argument is that those allocations were
non-escaping and these cross a return boundary and are invoked — but that argument is
exactly the kind that sampled profiling flatters. Treat U2's css/less prediction as
the softest number in §6.

**9.3 — `SCAN === null` for css.** I derived this by reading
`buildFastTriviaScanner` against `examples/css/parser.ts:17-18` and concluding the
block-comment arm is unclassifiable. I did not execute it. It is one line to check and
it should be checked before U3 is costed, because U3's entire justification rests on
it.

**9.4 — The magnitudes in §6 are apportionments of a single measured number, not
independent estimates.** They sum to roughly 100% of +137% because I made them sum.
The *ordering* (U4 > U1 > U2 for json; U2 and U3 own css/less) is what I am willing to
defend; the individual percentages are much softer than their precision suggests.

**9.5 — §3.4's capture-reachability elision** is the one proposal here that can
produce silently wrong output rather than a slow parse. I have put it in U5 for that
reason, and I would accept an argument that it should be dropped entirely.

**9.6 — I have not read all 2,457 lines of `assemble.ts`.** I read `OP_SEQ` in full,
the leaf terminals, `nextTerm`, `skipTrivia`, `markCst`, `link`, and `RunCfg`. The
choice/repetition/dispatch pieces I have only grepped for array indexing. There may be
further option tests on the parse path in the pieces I did not read — U0's extended
checker is precisely the instrument that would enumerate them, which is another reason
it goes first.

**9.7 — U3's exposure to token streaming (§8b.1) is the sequencing risk I would most
want an owner ruling on.** It is the most expensive unit in the plan and the one most
likely to be partly redone. If token streaming is in scope for 0.48, U3 should be cut
down to the trivia-path shapes only; if it is not, the full nine-shape port is right.
I cannot resolve that from the tree.

**9.8 — The `graphql/document` +107–137% row is unexplained by my model.** graphql is
`withoutCapture` like json and lands at the same floor, which is consistent. But I did
not read `examples/graphql/parser.ts` and cannot say whether its literal-length
distribution supports U1's prediction there. If U1 moves json and not graphql, that is
informative and I have no prediction for it.
