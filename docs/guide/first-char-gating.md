# First-char gating — making the compiler dispatch your choices

The single biggest lever on parse speed in a Parséman grammar is whether each `choice`
**first-char-gates**. When every arm starts with a different character, the compiler
turns the whole `choice` into an O(1) dispatch: check one character, and you already know
which arm to try. A non-matching position gets rejected with a single comparison.

When it doesn't gate, you're back to ordered first-match. Every position speculatively
enters each arm in turn — saving context, allocating a child array, running the
recognizer, rolling back — until one matches or all of them fail.

Gating comes from a shared first-set analysis, so it pays off no matter how you run the
grammar. The interpreter dispatches through a prebuilt ASCII lookup table
(`src/combinators/choice.ts`); the compiled `TableProgram` links an indexed dispatch body
instead of trying each arm in turn. The diagnostics below report on the gating decision
itself — a property of the grammar, not of how you run it.

Here's the trap: a PEG grammar is correct whether or not a choice gates. An ungated hot
choice passes every test and builds the right tree — it just does far more work per
character. The only symptom shows up in a CPU profile, and the cost is real: on real
Parséman grammars, fixing the one arm that breaks a hot choice's dispatch is worth
25–48% of total parse time. You don't need a profiler to find it, though — the compiler
already knows statically which choices don't gate, and why.

So Parséman will tell you — when you ask.

## Ask for it: `diagnoseGrammar()`

```ts
// [verify]
import { choice, literal, regex, diagnoseGrammar, formatGrammarDiagnosis } from 'parseman'

const grammar = { value: choice(literal('a'), regex(/[\s\S]*/)) }
const d = diagnoseGrammar(grammar)

d.ok
// → false
d.findings[0].code
// → 'ungated-choice'
d.findings[0].id
// → 'value'
formatGrammarDiagnosis(d)[0]
// → 'parseman: grammar NOT OK — 1 blocking finding(s) over 1 examined choice(s).'
```

`diagnoseGrammar` takes any grammar shape — a bare combinator, an array of
`[name, combinator]` entries, a `rules()` map, or a `compose()` result — and returns a
plain, JSON-serializable [`GrammarDiagnosis`](../reference/api#diagnosegrammar-grammar-opts-grammardiagnosis).
`formatGrammarDiagnosis(d)` renders it for a human: the offending arm, the cause, and the
fix, all inline.

```text
parseman: grammar NOT OK — 1 blocking finding(s) over 1 examined choice(s).
✗ [ungated-choice] value: choice is UNGATED [firstMatch] — no first-char dispatch;
    every position speculatively enters doomed arms
    arm[7] first-set ANY (cross-artifact-ref): via ref g.anyValue → broad recognizer (regex)
    fix: parseman resolves a g.Foo ref first-set at fuse time; if still ANY the
         target rule is itself ungated — analyze it and give it a concrete non-nullable lead.
    arm[0] ∩ arm[1] overlap on '+','-'-'.','0'-'9'
    fix: arms share a first char — left-factor. …
    intentional? add to the gating snapshot: { accept: ['value'] }
```

It's precise, not spammy. It fires only on choices that genuinely can't dispatch — never
on a `recoverable` choice, one that looks ungated at construction because its arms are
`ref()`s, but whose first-sets turn out disjoint once fusing resolves them. The compiled
code still guards each arm there.

### Why this is not a compile-time warning

It used to be. `compile()` ran the analysis by default and printed it through
`console.warn`, so importing one example grammar emitted 51 lines of advice before a
single byte was parsed. The advice was correct, and nobody read it — it showed up
unasked, buried in an unrelated build log, on a build that hadn't gone wrong.

Since 0.45.0 the two jobs are separate. `compile()`, `compileRuleMap()`, `compose()`, and
the macro transform produce an artifact and say nothing — there's no `gating` compile
option, no `PARSEMAN_GATING` env var, no `CompiledParser.gating` field. Diagnosing is
`diagnoseGrammar()`'s job, and you run it where a diagnosis belongs: a test, a lint
script, a CI job.

(This doesn't apply to the `[parseman] degraded` channel, which stays on by default — see
[Degradation diagnostics](./degradation-diagnostics). A degradation isn't advice; it's
Parséman telling you it couldn't do what you asked.)

## What poisons a first-set

A choice gates only when the compiler can prove each arm's set of possible first
characters is finite and disjoint from every other arm's. Here's what widens an arm's
first-set to `any` — or makes two arms overlap — and breaks that proof:

| Poison | Why | Fix |
| --- | --- | --- |
| **broad `regex`** — `regex(/[\s\S]*/)`, an over-broad value token | its first-set is every character | narrow it; for keywords use `word()`/`keywords()` |
| **keyword `regex`** — `regex(/color/)` used as a keyword | works, but the analyzer can't always give it an exact first-set, and it invites the boundary bug | `word('color', boundary)` / `keywords([...])` — exact first-set, same compiled scan |
| **leading `not(...)`** — `sequence(not(x), y)` as an arm | `not()`'s first-set is `any` | let the arm lead with its consuming terminal; keep `not()` as a TRAILING boundary |
| **`not(not(...))`** — hand-rolled first-char gating | first-set `any` **and it miscompiles** among shared-first-char siblings | delete it; first-char gating is automatic |
| **leading `optional`/`many`** | a skippable prefix lets a later, possibly-broad term start the arm | split the empty case into its own arm, or gate on the prefix |
| **`gate()` / `guard()` as a leading arm term** | a state predicate's first-set is `any` | use the gated-arm **field** to SELECT a branch (it keeps dispatch); put `gate()` after a terminal |
| **cross-artifact `g.Foo` ref → `any`** | a composed rule's first-set couldn't resolve across the artifact boundary | the ref is resolved at fuse time; if it is still `any`, the target rule is itself ungated — fix it there. In a [shared shape](#shared-shapes-the-verdict-belongs-to-the-fuse) the ref is a HOLE, and the finding is reported against the artifact that binds it |
| **shared prefix** — two arms starting with the same terminal | first-sets overlap, so no unique dispatch key | left-factor: parseman auto-detects `sharedPrefix` for bare sequences — make the arms bare sequences with the common leading terminal |

## Common mistakes (and what the diagnosis tells you)

These are the exact mistakes real authors — humans and LLMs — make. The point of the
diagnostic is that you don't have to remember them; one call names them.

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

Not every choice needs to be hot. A top-level statement dispatcher with a broad
error-recovery arm should fall through arm by arm — that's the point of it. Rather than a
per-node marker, there's one suppression mechanism: list the choice's stable `id` in the
gating snapshot's `accept` allowlist. The `id` is the finding's `id` — for `statement`
here that's `statement` (or `statement#0`, `statement#1`, … when a rule holds several
choices) — and `diagnosis.acceptSnapshot` hands you the whole list, ready to paste.

```ts
const ACCEPTED = ['statement', 'value#1']   // ideally kept with a reason per entry
const d = diagnoseGrammar(grammar, { accept: ACCEPTED })
```

An accepted choice is excluded from `ok`; any ungated choice not in `accept` still blocks
the build. Stale entries come back as advisory `stale-accept` findings (also in
`d.gating.acceptedUnused`), so a stale allowlist is easy to prune. Prefer fixing the
gating — a concrete leading terminal, `word()`/`keywords()`, reordering a leading `not` —
over accepting it. The allowlist is for genuinely unavoidable cases like recovery
fallbacks, not the default move.

## Shared shapes: the verdict belongs to the fuse

A [shared shape](./extending#shared-shapes-one-shape-many-bindings) is a `rules()` map that
references a rule it does not define — the shape written once, each dialect binding the
hole:

```ts
// shape.ts — `Value` is a HOLE; this module never defines it
export const shape = rules(g => ({
  Term: choice(sequence(g.Value, literal('/')), sequence(literal('@'), regex(/[a-z]+/))),
}))
```

Does `Term` gate? The shape can't know. `g.Value` has no body here, so its first-set
reads `any`, and whether the arms collide depends entirely on what a consumer binds
later. The shape module is never run as a parser, so its author has nothing to fix.

So the shape has no finding to give. A choice like this comes back `deferred` —
excluded from `ok`, counted in `d.summary.deferred`, visible as `d.gating.deferred`. Ask
the question again of the fused grammar, where the hole gets bound:

```ts
diagnoseGrammar(compose([shape, rules(_g => ({ Value: regex(/[0-9]+/) }))]))    // ✅ '0'-'9' vs '@' — gates
diagnoseGrammar(compose([shape, rules(_g => ({ Value: regex(/@[0-9]+/) }))]))   // ✗ Term is UNGATED
//                                                                      arm[0] ∩ arm[1] overlap on '@'
```

The finding lands on the artifact that can actually act on it, and it names the real
cause — a concrete overlap on `'@'`, not "unresolved ref `g.Value`." Fix it where you'd
expect: bind a narrower `Value`, or left-factor the shape's arms.

### Asking a composed grammar directly

`diagnoseGrammar` handles a `compose()` result for you. The lower-level
`analyzeGrammarGating()` does the same and returns the raw `GatingReport`:

```ts
import { analyzeGrammarGating } from 'parseman'

const report = analyzeGrammarGating(myComposedGrammar)
if (report.unanalysable.length > 0) throw new Error('gating report is PARTIAL')
```

Don't reach for `analyzeGatingRules(Object.entries(composed))` instead. A `compose()`
result is a map of fused rule functions — fusion lowers each rule to executable code, so
there's no combinator graph left in that map to walk. `analyzeGrammarGating` recovers the
graph from the composition's carried IR first.

Two things this buys you over analyzing a single contributing `rules()` map on its own.
The cross-artifact holes are bound, so choices that were `deferred` resolve to a real
verdict. And you see the union of every contributing grammar's rules — something no
single `rules()` map contains.

Always check `report.unanalysable` before reading `report.ungated` as a pass. It's
non-empty when part of the grammar couldn't be examined — a contributing piece that's an
opaque precompiled artifact, say — and in that case an empty `ungated` means "nothing was
looked at," not "nothing is wrong."

## CI: one call, one exit code

`d.ok` is the whole contract. It's false when there's any blocking finding, and an
analysis that couldn't run counts as blocking too. Keep an `accept` allowlist of the
choice ids you've already reviewed, so a refactor that ungates a new hot choice fails the
build:

```ts
// scripts/check-gating.ts
import { diagnoseGrammar, formatGrammarDiagnosis } from 'parseman'
import { grammar } from '../src/grammar.ts'

const ACCEPTED = ['statement', 'value#1']    // reviewed, intentional (keep a reason each)
const d = diagnoseGrammar(grammar, { accept: ACCEPTED })
if (!d.ok) {
  console.error(formatGrammarDiagnosis(d).join('\n'))
  process.exit(1)
}
```

It fails closed: `ok` is false whenever part of the grammar couldn't be examined — an
opaque precompiled artifact, a value that isn't a combinator, an analysis that threw — so
an empty `ungated` can never be mistaken for "nothing is wrong." Write
`JSON.stringify(d.findings)` to a committed file if you want a diffable snapshot; findings
are sorted, so two runs over the same grammar come out byte-identical.

## Why this is implicit in Parséman (the Chevrotain contrast)

A tokenizing parser like Chevrotain forces you to declare dispatch: the lexer assigns
each input a token type, and the parser branches on that type. You can't forget to
dispatch — that cliff is impossible to hit — but you also lose the scannerless tricks:
overlapping tokens, per-position re-lexing, context-dependent tokenization.

Parséman is scannerless: dispatch is implicit in first-sets, computed straight from the
combinators. That's more flexible — no lexer, tokens can overlap, a rule can mean
different things in different positions — but it hides the cliff, because a choice that
doesn't dispatch is still correct. `diagnoseGrammar()` buys back Chevrotain's "you can't
forget to dispatch" guarantee without the lexer: the compiler already knows which choices
dispatch, and for the ones that don't, exactly which arm to fix. Wire the call into CI,
and forgetting becomes a failed build instead of a silent tax.

## See also

- [Ordered choice & keywords](./keywords) — `sharedPrefix`, `word`/`keywords`, gated arms.
- [Context-sensitive parsing](./context) — `gate()` vs the gated-arm field.
- [Performance](./performance) — the broader hot-path picture.
- [`analyzeGating` / `GatingReport`](../reference/api#analyzegating-entry-gatingreport).
