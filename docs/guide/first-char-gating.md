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
more work per input character. The only symptom is a CPU profile, and the stakes are
large: on real Parséman grammars, fixing the single arm that breaks a hot choice's
dispatch is worth 25–48% of total parse time. None of that requires profiling to find —
the compiler can tell statically which choices don't gate, and why.

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
| **cross-artifact `g.Foo` ref → `any`** | a composed rule's first-set couldn't resolve across the artifact boundary | often **not yours to fix** — see [warnings you cannot act on](#warnings-you-cannot-act-on). In a [shared shape](#shared-shapes-the-verdict-belongs-to-the-fuse) the ref is a HOLE, and the finding is reported against the artifact that binds it |
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

## The shapes that actually occur

The table above lists everything that *can* poison a first-set. This section lists what
actually **does**, in what proportion, with the rewrite for each.

The ordering is measured, not editorial. Across the four [jess](https://github.com/jesscss/jess)
dialect grammars compiled to their shipping artifacts, 15.2% of all arm entries land on
an arm that got no first-char guard. Splitting those by cause and weighting by **real arm
entries** on `bootstrap4.css` and a 4.4k-line Less benchmark:

| Cause | Share of unguarded arm entries | Fixable in your grammar? |
| --- | --- | --- |
| nullable prefix | 37% | yes — §1 |
| broad `regex` | 21% | yes — §2 |
| unresolved cross-artifact ref | 41% | **no** — [see below](#warnings-you-cannot-act-on) |
| leading `not(...)` / `not(not(...))` / `gate()` | 0% | yes — but they did not occur at all |

So the two rewrites below cover **all** of the actionable half. The hand-rolled-gating
mistakes in the list above are worth knowing precisely because they are so rare in
grammars that have had a gating diagnostic running — but a mistake being rare in this
table does not make it harmless in **your** grammar. The warning names the choice; let it
tell you which one you have.

### 1. A nullable prefix in front of a broad term

An arm that starts with something skippable lets a **later** term begin the arm, so the
arm inherits that term's first-set.

```
parseman gating: choice @ declaration is UNGATED [firstMatch] — no first-char dispatch; every position speculatively enters doomed arms.
  · arm[0] first-set ANY (nullable-prefix): nullable prefix → broad recognizer (regex)
```

Read that detail line carefully: it takes **both** halves. A nullable head in front of a
*narrow* term is fine — the first-sets simply union, and the arm still gates. It only
poisons the arm when the term it exposes is itself broad:

```ts
// [verify]
import { literal, optional, regex, sequence } from 'parseman'

const broadValue = regex(/[^;]+/)

// ⚠️ `--` is skippable, so `broadValue` can start the arm → ANY
sequence(optional(literal('--')), broadValue)._meta.firstSet.kind
// → 'any'

// ✅ the prefix is required here; the empty case becomes its own arm
sequence(literal('--'), broadValue)._meta.firstSet.kind
// → 'ranges'
```

The trap is that `optional(...)` is not the only nullable head. `many()`, a `regex` that
can match empty, and a **default `sepBy`** — which is `(item (sep item)*)?`, so it matches
the empty string — all qualify:

```ts
// [verify]
import { literal, regex, sepBy, sequence } from 'parseman'

const ident = regex(/[a-z]+/)
const broadValue = regex(/[^;]+/)

// ⚠️ a default sepBy matches nothing, so the broad term can lead
sequence(sepBy(ident, literal(',')), broadValue)._meta.firstSet.kind
// → 'any'

// ✅ a list that cannot be empty keeps its own first char
sequence(sepBy(ident, literal(','), { min: 1 }), broadValue)._meta.firstSet.kind
// → 'ranges'
```

**Three rewrites, cheapest first:**

- **`sepBy(item, sep, { min: 1 })`** when the list can't actually be empty. Usually just a
  correctness fix: a default `sepBy` claims to match nothing, which is rarely the intent.
- **Narrow the broad term** instead of the prefix — often the honest fix, since the
  nullable head was never the real problem. That is §2.
- **Split the empty case into its own arm**, so each arm has a concrete lead.

::: warning What the rewrite costs
`{ min: 1 }` is free — same tree, same reducer, same output. Splitting one arm into two is
**not**: two arms means two reducers, and whatever consumed a single node now sees one of
two shapes. That is a refactor, not a tuning knob. Try the first two first.
:::

### 2. A broad `regex` — usually a negated character class

The realistic offender is a value/fallback token written as "anything up to a
delimiter". A negated class has no finite first-set, so the analyzer can only report
`any`:

```ts
// [verify]
import { regex } from 'parseman'

// ⚠️ negated classes are broad by construction
regex(/[^;]+/)._meta.firstSet.kind
// → 'any'

regex(/\S+/)._meta.firstSet.kind
// → 'any'

// ✅ say what the token can actually start with
regex(/[a-z-]+/)._meta.firstSet.kind
// → 'ranges'
```

::: warning What the rewrite costs
Narrowing a recogniser **changes the language it accepts** — that is the whole point, and
it is the one rewrite here that can silently start rejecting valid input. Widen the class
until the tests pass rather than guessing, and if the arm genuinely must accept anything,
it is not fixable: [accept it in the snapshot](#accepting-an-intentional-ungated-choice-the-snapshot-allowlist).
A `scanTo` error-recovery fallback is always in this category.
:::

**A related lint, not the same problem.** `regex(/@supports/)` used as a keyword *does*
expose a first-set, so it is not what the `any` numbers above are counting — but it still
earns the `keyword-regex` anti-pattern, because `word()`/`keywords()` give an exact set
*and* a word boundary, and lower to the same `charCodeAt` scan:

```ts
// [verify]
import { keywords, word } from 'parseman'

word('@supports', '-\\w')._meta.firstSet.kind
// → 'ranges'

keywords(['and', 'or', 'not'])._meta.firstSet.kind
// → 'ranges'
```

Switching to `word()` adds the boundary — `word('if', '-\\w')` will not match `ifdef`
where `regex(/if/)` would. That is nearly always the intent, but it *is* a behaviour
change; re-run the tests rather than assuming.

## Warnings you cannot act on

Some `cross-artifact-ref` findings are a **parseman limitation, not a defect in your
grammar**, and no rewrite will clear them. In the measurement above they were **41% of
all unguarded arm entries** — the single largest bucket, and none of it is grammar-side.

The shape is:

```
  · arm[0] first-set ANY (cross-artifact-ref): unresolved ref g.CssAstSyntaxSupportsAtKeyword
```

…where `CssAstSyntaxSupportsAtKeyword` **is** defined, **is** compiled into the artifact,
and **does** have a perfectly good first-set. The fuse knows its winner map — the gating
diagnostic itself resolves names through it (`runFusedGatingDiagnostic` passes a
`resolveRef`) — but codegen's guard derivation calls `firstSetOf` without a resolver, so
the `lazy` thunk throws and the set degrades to `any`. The information exists; the guard
path just doesn't consult it.

**How to tell you are looking at one:** the detail line names a `g.Foo` you can point at
in your own sources, and the referenced rule is not itself reported as ungated. If the
target rule *is* also warned about, that one is real — fix it there and this one clears
too.

**What to do meanwhile:** accept these ids in the snapshot with a comment saying why, so
they stay silent without hiding the real findings. Do not restructure a correct grammar
to chase them.

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

Does `Term` gate? **The shape cannot know.** `g.Value` has no body here, so its first-set
reads `any` — and whether the arms collide depends entirely on what a consumer binds. The
shape module is never executed as a parser, and its author has nothing to fix.

So the diagnostic does not warn there. Such a choice is `deferred`: silent, excluded from
the `'error'` gate, and visible programmatically as `report.deferred`. The question is
re-asked at each `compose()` / `composeLeaf()`, over the **fused** rule map, where the hole
is bound:

```ts
compose([shape, rules(_g => ({ Value: regex(/[0-9]+/) }))])    // ✅ '0'-'9' vs '@' — gates, silent
compose([shape, rules(_g => ({ Value: regex(/@[0-9]+/) }))])   // ⚠️ choice @ Term is UNGATED
//                                                                    · arm[0] ∩ arm[1] overlap on '@'
```

The warning lands on the build that can act on it, and names the real cause — a concrete
overlap on `'@'`, not "unresolved ref `g.Value`". Fix it where you'd expect: bind a
narrower `Value`, or left-factor the shape's arms.

Only DEFERRED choices are reported at the fuse. An ordinary hole-free grammar is analyzed
once, where it is authored, however many times it is later composed.

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
