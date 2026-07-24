# First-char gating — making the compiler dispatch your choices

The single biggest hot-path lever in a Parséman grammar is whether each `choice`
**first-char-gates**: when every arm starts with a disjoint character, the compiler
turns the whole `choice` into an O(1) character dispatch (a `switch`/jump table), so a
non-matching position is rejected with one comparison. When it doesn't, the `choice`
falls back to ordered first-match: **every** position speculatively ENTERS each arm in
turn (context save/restore, a child array, the recognizer, then rollback) until one
matches or all fail.

Here's the trap: **PEG grammars are correct regardless of whether a choice gates.** An
ungated hot choice passes every test and produces the right tree — it just does a lot
more work per input character. The only symptom is a CPU profile. Four real Parséman
grammars were hand-optimized 25–48% by finding ungated hot choices in profiles and
fixing the one arm that broke dispatch. The compiler already knew, statically, which
choices didn't gate and why.

So Parséman tells you at build time.

## The default-on build warning

`compile()` runs the [static gating diagnostic](../reference/api#analyzegating-entry-gatingreport)
by **default** and warns for every genuinely-ungated choice — with the offending arm, the
cause, and the fix inline:

```text
parseman gating: choice @ value is UNGATED [firstMatch] — no first-char dispatch;
  every position speculatively enters doomed arms.
  · arm[7] first-set ANY (cross-artifact-ref): via ref g.anyValue → broad recognizer (regex)
    fix: parseman >=0.32.0 resolves a g.Foo ref first-set at fuse time; if still ANY the
         target rule is itself ungated — analyze it and give it a concrete non-nullable lead.
  · arm[0] ∩ arm[1] overlap on '+','-'-'.','0'-'9'
    fix: arms share a first char — left-factor. …
  (intentional? accept it in the gating snapshot: { accept: ['value'] }.)
```

It is **precise, not spammy**: it fires only on choices that genuinely can't dispatch —
never on a `recoverable` choice (one that looks ungated at construction because its arms
are `ref()`s, but whose deep/fuse-resolved first-sets are actually disjoint, so the
compiled code still guards each arm).

Configure it with the `gating` option (or the `PARSEMAN_GATING` env var):

```ts
compile(grammar)                        // default: 'warn'
compile(grammar, undefined, { gating: 'off' })    // silence entirely
compile(grammar, undefined, { gating: 'error' })  // fail the build (CI)
const report = compile(grammar).gating  // programmatic GatingReport for snapshots
```

`analyzeGating(entry)` gives you the same `GatingReport` without compiling.

## What poisons a first-set

A choice gates only when the compiler can prove each arm's set of possible first
characters is disjoint from the others and finite. These are the things that widen an
arm's first-set to `any` (or make two arms overlap) and break that proof:

| Poison | Why | Fix |
| --- | --- | --- |
| **broad `regex`** — `regex(/[\s\S]*/)`, an over-broad value token | its first-set is every character | narrow it; for keywords use `word()`/`keywords()` |
| **keyword `regex`** — `regex(/color/)` used as a keyword | works, but the analyzer can't always give it an exact first-set, and it invites the boundary bug | `word('color', boundary)` / `keywords([...])` — exact first-set, same compiled scan |
| **leading `not(...)`** — `sequence(not(x), y)` as an arm | `not()`'s first-set is `any` | let the arm lead with its consuming terminal; keep `not()` as a TRAILING boundary |
| **`not(not(...))`** — hand-rolled first-char gating | first-set `any` **and it miscompiles** among shared-first-char siblings | delete it; first-char gating is automatic |
| **leading `optional`/`many`** | a skippable prefix lets a later, possibly-broad term start the arm | split the empty case into its own arm, or gate on the prefix |
| **`gate()` / `guard()` as a leading arm term** | a state predicate's first-set is `any` | use the gated-arm **field** to SELECT a branch (it keeps dispatch); put `gate()` after a terminal |
| **cross-artifact `g.Foo` ref → `any`** | a composed rule's first-set couldn't resolve across the artifact boundary | parseman ≥ 0.32.0 resolves it at fuse time; if still `any`, the target rule is itself ungated — fix it there |
| **shared prefix** — two arms starting with the same terminal | first-sets overlap, so no unique dispatch key | left-factor: parseman auto-detects `sharedPrefix` for bare sequences — make the arms bare sequences with the common leading terminal |

## Common mistakes (and what the build warning tells you)

These are the exact mistakes real authors — humans and LLMs — make. The point of the
default-on warning is that you don't have to remember them; the build tells you.

1. **Using `regex(/keyword/)` for a keyword.**
   ```ts
   choice(sequence(regex(/@supports/), prelude), otherAtRule)   // ⚠️
   choice(sequence(word('@supports', '-\\w'), prelude), otherAtRule)  // ✅ exact first-set
   ```
   → *anti-pattern [keyword-regex]: use `word('…', boundary)` / `keywords([…])` for an exact
   resolvable first-set.*

2. **Hand-rolling first-char gating with `not(not(...))`.**
   ```ts
   choice(sequence(not(not(literal('@'))), atRule), ruleset)   // ⚠️ MISCOMPILES
   ```
   → *anti-pattern [double-not]: not(not(...)) hand-rolls automatic first-char gating and
   MISCOMPILES among shared-first-char sibling arms. Remove it.* First-char dispatch is
   automatic — just let the arm lead with `literal('@')`.

3. **A `scanTo` / broad fallback arm in an otherwise-fine choice.**
   ```ts
   const stmt = choice(atRule, ruleset, scanTo(literal(';')))   // ⚠️ ungated (a recovery fallback)
   ```
   A recovery fallback legitimately can't gate. That's fine — accept it in the gating
   snapshot (below) so it's silent and doesn't fail the CI gate.

4. **Two arms sharing a leading token** (`Dimension` and `Num` both leading with the number
   regex). → *overlap on `+ - . 0-9` … left-factor.* Parse the shared prefix once and
   branch on what follows.

## Accepting an intentional ungated choice (the snapshot allowlist)

Not every choice is hot. A top-level statement dispatcher with a broad error-recovery arm
*should* fall through arm by arm. Rather than a per-node marker, there is **one**
suppression mechanism: list the choice's stable `id` in the gating snapshot's `accept`
allowlist. The `id` is printed in the warning (`choice @ <id>`) — for `statement` here it
is `statement` (or `statement#0`, `statement#1`, … when a rule holds several choices).

```ts
const ACCEPTED = ['statement', 'value#1']   // ideally kept with a reason per entry
compile(grammar, undefined, { gating: { level: 'error', accept: ACCEPTED } })
```

An accepted choice is silent AND excluded from the `'error'` gate; any ungated choice NOT
in `accept` still warns and fails. `report.acceptedUnused` lists ids that no longer match
an ungated choice, so a stale allowlist entry is easy to prune. **Prefer fixing the
gating** (a concrete leading terminal, `word()`/`keywords()`, reordering a leading `not`)
over accepting it; the allowlist is for the genuinely-unavoidable cases (recovery
fallbacks), not the default.

## CI: budget the ungated set with the allowlist

`analyzeGating(entry)` returns a structured `GatingReport`. Keep an `accept` allowlist of
the choice ids you've reviewed and gate on it, so a refactor that silently ungates a NEW
hot choice fails the build:

```ts
import { analyzeGating } from 'parseman'
const ACCEPTED = ['statement', 'value#1']    // reviewed, intentional (keep a reason each)
const report = analyzeGating(grammarEntry, { accept: ACCEPTED })
expect(report.ungated.map(c => c.id)).toEqual([])   // fails when a NEW choice ungates
expect(report.acceptedUnused).toEqual([])           // fails when an allowlist entry goes stale
```

(Use `analyzeGating()` for the snapshot — `compile(g, undefined, { gating: 'off' })`
leaves `CompiledParser.gating` **undefined**, so reading `.gating` there would throw.)

Or compile with `{ gating: { level: 'error', accept: ACCEPTED } }` to fail the build on any
ungated choice that isn't in the allowlist.

## Why this is implicit in Parséman (the Chevrotain contrast)

A tokenizing parser like Chevrotain forces you to declare dispatch: the lexer assigns each
input a token *type*, and the parser branches on that type. You **cannot** forget to
dispatch — the cliff is impossible to hit — but you also can't do scannerless things
(overlapping tokens, per-position re-lexing, context-dependent tokenization).

Parséman is scannerless: dispatch is *implicit in first-sets*, computed from the
combinators themselves. That's more flexible — no lexer, tokens can overlap, a rule can
mean different things in different positions — but it hides the cliff, because a choice
that doesn't dispatch is still correct. The default-on gating diagnostic buys back
Chevrotain's "you can't forget to dispatch" guarantee **without** the lexer: the compiler
tells you which choices dispatch and, for the ones that don't, exactly which arm to fix.

## See also

- [Ordered choice & keywords](./keywords) — `sharedPrefix`, `word`/`keywords`, gated arms.
- [Context-sensitive parsing](./context) — `gate()` vs the gated-arm field.
- [Performance](./performance) — the broader hot-path picture.
- [`analyzeGating` / `GatingReport`](../reference/api#analyzegating-entry-gatingreport).
