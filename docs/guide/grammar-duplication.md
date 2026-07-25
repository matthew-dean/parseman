# Grammar duplication — finding the copies a review can't

A Parséman grammar is a **combinator tree**, not source text. So "did I write this
production twice?" is a structural question with an exact answer — and it is exactly
the question humans and LLMs answer worst. A few hundred productions is tens of
thousands of pairs; nobody reads that, so nobody catches the same comparison terminal
spelled seven times, or the general rule cloned with one slot swapped.

`analyzeDuplication()` walks the same tree [`analyzeGating()`](./first-char-gating)
walks and reports nine families. Some are tidy-ups. Three of them are bugs.

```ts
import { analyzeDuplicationRules, formatDuplicationFindings } from 'parseman'

const report = analyzeDuplicationRules(Object.entries(myRules))
for (const line of formatDuplicationFindings(report)) console.warn(line)
```

## What it looks for

| Family | What it finds | Why it matters |
| --- | --- | --- |
| `rewrites` | Mechanical algebra: `choice(sequence(A, B), B)` → `sequence(optional(A), B)`, a hand-rolled `sepBy`, `optional(optional(X))`, a duplicated or shadowed arm | Exact rewrites, not judgement calls. Two of them are latent **bugs** |
| `structureLoss` | An earlier `choice` arm that **flattens** the node a later arm structures | The parse still succeeds and the text still round-trips. Only the tree moved, so nothing else reports it |
| `divergentNodes` | One `node()` type built by several different productions that share terms | An edit to "the declaration shape" has to land in all of them, and nothing checks that it did |
| `nearDuplicates` | Subtrees identical **except at one slot** | The clone family: one production with a `choice` in the varying slot, not N copies of the scaffolding |
| `duplicates` | Structurally identical subtrees in ≥2 places | Ranked by nodes saved, so real copies outrank `optional(ws)` noise |
| `regexFragments` | One alternation run re-spelled across several `regex()` terminals | Structural hashing cannot see inside a regex; this pass can |
| `regexClasses` | Character classes re-spelled — and, more usefully, **near-identical** ones | Two classes this close cannot be told apart by reading. One of them is wrong |
| `overlaps` | `choice` arms whose first-sets intersect, with the shared prefix named | The same data gating uses, framed as *which* arms and *on what* |
| `keywordRegexes` | Hand-rolled keyword regexes that should be `word()`/`keywords()` | `/i` without `/u` case-folds non-ASCII wrong, and an unrescued prefix hazard makes the longer alternative unreachable |

## The unreachable-arm bug classes

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

## The third bug class: an arm that flattens what its sibling structures

`shadowed-arm` catches an arm that can never run. `structureLoss` catches the
opposite and much quieter failure — an arm that runs when it should not have, and
produces a **shallower tree** than the sibling it intercepted.

The shape is a "fast path" placed first in a `choice`: same `node()` type as the arm
below it, overlapping first characters, and a body containing no `node()` at all. On
every input both arms accept, the fast path wins and yields that node over bare
leaves.

```ts
// [verify]
import { analyzeDuplicationRules, choice, literal, node, oneOrMore, optional, regex, rules, sequence } from 'parseman'

const prop = regex(/[a-z-]+/)
const num = regex(/\d+(?:[a-z]+|%)?/)

const g = rules(r => ({
  Dimension: node('Dimension', num),
  // The "fast path": one numeric value, kept as a raw token.
  Scalar: node('Declaration', sequence(prop, literal(':'), num, optional(literal(';')))),
  Full: node('Declaration', sequence(prop, literal(':'), oneOrMore(r.Dimension), optional(literal(';')))),
  Declaration: choice(r.Scalar, r.Full),
}))

analyzeDuplicationRules(Object.entries(g)).structureLoss.map(f => [f.nodeType, f.earlier, f.later, f.lostNodeTypes])
// → [['Declaration', 0, 1, ['Dimension']]]
```

`margin: 0px` now parses through arm 0 and has **no** `Dimension` child;
`margin: 0px 0px` falls through to arm 1 and has two. Both parse, both spans are
right, both round-trip to the same text, and — if the value is re-read from source
downstream — both compile to the same output. A test suite asserting *does it parse*
stays green, and so does a corpus diff. The defect surfaces only in whatever reads the
tree: an editor lint keyed on the number node, a formatter, a rename.

So the finding names the arm, the arm it shadows, the characters the shadowing bites
on, and the node types deleted — and prints as `parseman BUG [structure-loss]`. The
fix is a decision, not a rewrite: **either** the structured tree is the contract, and
the flattening arm is deleted or moved below its sibling, **or** the flat tree is, and
it has to be flat for every input of that shape rather than the subset one arm happens
to match. A fast path that is not tree-neutral is not a fast path.

Two deliberate limits keep it a signal rather than a lint:

- **Only the empty case fires.** "Earlier arm is *poorer* than later arm" is the same
  family, but grading it means comparing two ref-reachable type sets, and in a
  recursive grammar the later set reaches most of the grammar — so the graded rule
  fires on nearly every pair. Empty-versus-non-empty needs no threshold.
- **A gated arm is never reported.** `choice({ gate, combinator }, …)` says which
  branch applies when. That is a deliberate split, not a shadow.

And one limit that is not deliberate but unavoidable. Overlap is decided on **first
sets**, so the finding reads *"these arms overlap on these characters, and if an input
reaches both then structure is lost"*. A shared leading character is necessary for the
shadowing, not sufficient: two arms can both start on `-` and still accept disjoint
languages (`-webkit-x` versus `-5px`), and then nothing is shadowed. Deciding whether
two arms genuinely share an input is language intersection, which is undecidable for a
general grammar — a first-set test is the strongest decidable proxy there is. So
`structure-loss` can over-report, which is why it names both shapes and the characters
rather than simply asserting a verdict. Under `duplication: 'error'` that means a
false positive can fail a build; if you hit one, the arms in question accept disjoint
languages and the honest fix is to say so in an issue, because the analysis cannot
see it.

This is the ordered, consequential half of `divergentNodes`. That family reports two
productions building one type and expressly allows *"the variants exist for a parse-order
reason (a fast path tried first)"*. `structureLoss` is the case where that defence is
the bug.

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
