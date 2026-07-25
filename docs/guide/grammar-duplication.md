# Grammar duplication — finding the copies a review can't

A Parséman grammar is a **combinator tree**, not source text. So "did I write this
production twice?" is a structural question with an exact answer — and it is exactly
the question humans and LLMs answer worst. A few hundred productions is tens of
thousands of pairs; nobody reads that, so nobody catches the same comparison terminal
spelled seven times, or the general rule cloned with one slot swapped.

`analyzeDuplication()` walks the same tree [`analyzeGating()`](./first-char-gating)
walks and reports seven families. Some are tidy-ups. Two of them are bugs.

```ts
import { analyzeDuplicationRules, formatDuplicationFindings } from 'parseman'

const report = analyzeDuplicationRules(Object.entries(myRules))
for (const line of formatDuplicationFindings(report)) console.warn(line)
```

## What it looks for

| Family | What it finds | Why it matters |
| --- | --- | --- |
| `rewrites` | Mechanical algebra: `choice(sequence(A, B), B)` → `sequence(optional(A), B)`, a hand-rolled `sepBy`, `optional(optional(X))`, a duplicated or shadowed arm | Exact rewrites, not judgement calls. Two of them are latent **bugs** |
| `divergentNodes` | One `node()` type built by several different productions that share terms | An edit to "the declaration shape" has to land in all of them, and nothing checks that it did |
| `nearDuplicates` | Subtrees identical **except at one slot** | The clone family: one production with a `choice` in the varying slot, not N copies of the scaffolding |
| `duplicates` | Structurally identical subtrees in ≥2 places | Ranked by nodes saved, so real copies outrank `optional(ws)` noise |
| `regexFragments` | One alternation run re-spelled across several `regex()` terminals | Structural hashing cannot see inside a regex; this pass can |
| `regexClasses` | Character classes re-spelled — and, more usefully, **near-identical** ones | Two classes this close cannot be told apart by reading. One of them is wrong |
| `overlaps` | `choice` arms whose first-sets intersect, with the shared prefix named | The same data gating uses, framed as *which* arms and *on what* |

## The two bug classes

Most findings are refactors you may decline. These two are not:

```ts
// [verify]
import { analyzeDuplication, choice, literal, sequence } from 'parseman'

// The shorter arm comes first, so ordered choice commits to it and the second
// arm can never be selected.
const g = choice(sequence(literal('a')), sequence(literal('a'), literal('b')))
analyzeDuplication(g).rewrites.filter(f => f.bug).map(f => [f.rewrite, f.astNeutral])
// → [['shadowed-arm', true]]
```

`duplicate-arm` (the same arm twice) is the other. Both are `astNeutral: true`: an
arm that can never be selected contributes nothing to any parse, so deleting it
cannot move the tree.

## Everything else is a candidate, not a fix

Every other rewrite changes the child array the site produces. `choice(sequence(A, B),
B)` yields two children on one arm and one on the other; `sequence(optional(A), B)`
yields two children with an absent optional. If a `node()` build fn or a downstream
consumer reads children positionally, the rewrite **moves the tree**.

So those findings say `astNeutral: false` and their text says *candidate — verify AST
identity*, naming the enclosing `node()` when there is one. A suggestion that silently
moves the tree is worse than no suggestion.

The same discipline applies per site rather than per pattern. A hand-rolled
`sequence(item, many(sequence(sep, item)))` is only sometimes convertible to `sepBy`,
so each site carries a `sepByVerdict`:

- **`convertible`** — no capture, no reducer reading these children.
- **`blocked-by-capture`** — the repetition `field()`s its separator. `sepBy` yields
  items and discards separators, so byte-faithful layout replay is lost. This one is a
  Parséman gap, not work.
- **`reducer-stride-review`** — an enclosing reducer reads the children, and a
  left-associating one typically strides by two over `[item, sep, item, …]`. Convert
  only together with the reducer.

On a real grammar those split roughly evenly. A count of matches is not a worklist.

## Keyword regexes are a correctness finding

`regex(/not(?![-\w])/i)` hand-rolls what [`word()`/`keywords()`](./keywords) owns. The
report names the exact replacement — `word('not', '-\\w', { caseInsensitive: true })` —
and flags the part that is not style:

> `/i` without `/u` does not fold case the way `{c, toUpperCase(c), toLowerCase(c)}`
> suggests. 67 BMP code points fold in ways those three miss (`ς`/`σ`, `µ`/`μ`, the
> `Ǆǅǆ` digraphs, combining iota subscript).

Parséman fixed exactly this **inside** `keywords()` (see `combinators/case-fold.ts`).
A hand-rolled copy never received the fix, so its first-set is unsound for those
inputs.

### A regex enumerating a fixed vocabulary is a keyword set written the hard way

The principle generalises past single keywords, and it explains several findings at
once. When a `regex()` is an alternation of literal words — CSS named colours, at-rule
names, import options, units — it is a **vocabulary**, and writing it as a regex costs
three separate things:

- **First-set gating.** `keywords()` exposes an exact first-set, so an enclosing
  `choice` dispatches on one character. A 150-branch alternation exposes none, and
  every position that reaches the choice runs the whole alternation.
- **Ordering, hand-maintained.** Regex alternation is **first-match, not
  longest-match**. `keywords()` sorts longest-first by construction; a hand-written
  list does not, and nothing checks it.
- **Case folding.** With `/i` and no `/u`, the whole vocabulary inherits the bug above.

So a regex of ≥ 3 literal alternatives is reported as `vocabulary: true` even with no
boundary guard, with `words.length`, `longestFirst`, and the exact `keywords([…])` call
(elided rather than reprinting 150 names).

The ordering analysis is the part that makes this a **bug class** rather than a
cleanup. `hazards` lists every earlier alternative that is a strict prefix of a later
one, and says whether the boundary guard rescues it:

```ts
// [verify]
import { keywordAlternationHazards } from 'parseman'

// No guard: `in` matches first and `instanceof` is UNREACHABLE.
keywordAlternationHazards(['in', 'instanceof'], null)
// → [{ shorter: 'in', longer: 'instanceof', at: 's', rescuedByBoundary: false }]

// A guard rejecting the following `s` makes the engine backtrack into the longer
// branch — correct today, but only because the guard covers that character.
keywordAlternationHazards(['in', 'instanceof'], '_0-9A-Za-z')[0].rescuedByBoundary
// → true
```

An unrescued hazard sets `bug: true` and prints as `parseman BUG keyword-regex`: a
later alternative that can never match is a live defect, not a style preference. A
rescued one is reported as an ordering hazard, because the correctness rests on a
hand-maintained order *plus* a guard that happens to cover the right characters —
neither of which `keywords()` needs.

## Input: the rules map, never a composed artifact

The analysis walks combinators. The value `compose()` / `composeLeaf()` returns is a
fused, already-compiled artifact whose entries are parse **functions** with no `_def`.

Passing one **throws**, by design and at the door:

```text
analyzeDuplicationRules: rule 'Declaration' is not a combinator (no _def).
This analysis walks the COMBINATOR TREE; the value returned by compose()/composeLeaf()
is a fused, already-compiled artifact whose entries are parse functions. Pass the
rules() map itself …
```

That loudness is the point. A diagnostic that walks an artifact it cannot read reports
"no findings", and a clean run then reads as a clean grammar. Silence is not a
permitted outcome — either the input is analyzable, or the call fails and says why.

## Wiring it into a build

Opt-in, on all three lowering paths — `compile()`, `compileRuleMap()` and
`compileLinkable()`. The macro build never calls `compile()`, and a diagnostic wired
only there reports zero findings forever, which is what happened to the gating
diagnostic for two minor versions.

```ts
compile(grammar, undefined, { duplication: 'warn' })   // print findings
compile(grammar, undefined, { duplication: 'error' })  // fail the build
// or PARSEMAN_DUPLICATION=warn
```

The default is **`'off'`**, unlike gating. An ungated hot choice is a cliff with no
other symptom; a duplicated subtree is a maintenance cost the author may have chosen.
And most findings here are candidates needing an AST check — printing "candidate,
verify" on every build teaches people to stop reading the output. Run it deliberately:
a lint script, a review pass, a periodic sweep.

Acknowledge an intentional finding by id, the same way the gating snapshot works:

```ts
analyzeDuplicationRules(entries, { accept: ['rewrite:left-factor:Value › seq[1]'] })
```

`acceptedUnused` lists ids that matched nothing, so a stale acknowledgement gets
pruned rather than quietly protecting a finding that moved.

## What it cannot see

Structural hashing is exactly that: **structural**.

- Two productions that accept the same language but are shaped differently —
  `many(x)` versus `optional(oneOrMore(x))`, a `regex` spelling of what another rule
  builds from combinators, a rule inlined once and referenced once — are invisible to
  `duplicates` and `nearDuplicates` unless they happen to fall inside the `rewrites`
  algebra.
- Two subtrees differing only in a `transform`/`node` **callback** are treated as
  distinct when the callbacks' source text differs, even if the functions are
  equivalent.
- Duplication that lives in ordinary TypeScript rather than in combinators — a shared
  operator list spelled once as a `regex` and once as a `string[]` in a reducer — is
  outside the tree entirely.
- Single-regex hygiene (duplicate class members, obscure ranges, a missing `u` flag)
  belongs to `eslint-plugin-regexp` and is not duplicated here. That tool sees one
  regex at a time, which is precisely why it cannot see the cross-regex drift above.

This finds copy-paste and mechanical redundancy. A clean report is not a proof that a
grammar has none.
