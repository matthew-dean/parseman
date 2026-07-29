# Choice, dispatch & keywords

`choice()` uses PEG ordered-choice semantics: **first match wins**. That single rule has
two consequences you have to design around — keyword/identifier collisions and
shared prefixes. `dispatch()` is the companion for the common case where several forms
start by reading the same token family and only diverge after that token's value is known.

This page is the decision guide. The [Combinators](./combinators#choice-and-dispatch)
page gives the full API examples; [First-char gating](./first-char-gating) explains the
performance diagnostic that tells you when a hot choice stopped dispatching.

## Which shape should I use?

| Shape | Use it when | Why |
| --- | --- | --- |
| `choice(a, b, c)` | Arms have distinct leading punctuation/keywords, or the ordered fallback is intentional. | PEG semantics stay visible, and disjoint first characters compile to O(1) dispatch. |
| `keywords([...])` / `word(...)` | You are recognizing keywords, especially before an identifier fallback. | Boundaries are correct and the first-set stays exact. |
| `dispatch(head, when(...), otherwise(...))` | Every branch starts by parsing the same broad family: command names, name-or-call openers, contextual keywords, at-keywords. | The shared head parses once; the route table decides the specialized tail; `routed()` lets a branch node own that head. |
| `attempt(composite)` | You need a larger parser's failure reported at the composite's entry, not at the inner token that failed. | It is the public failure re-anchoring boundary for composite parsers; ordinary rejected `choice` arms already roll back. |

The smell to watch for is a `choice` where two or more arms begin with the same broad
recognizer:

```ts
// Often slow and harder to reason about: every arm reparses the same opener.
choice(setStatement, printStatement, extensionStatement)

// Usually clearer: parse the opener once, then route by value.
dispatch(commandName, when('set', setTail), when('print', printTail), otherwise(extensionTail))
```

Keep `choice` for genuinely different leading shapes. Reach for `dispatch` when the
branches are "same opener, different continuation." If the opener belongs inside
the selected branch's CST/AST node, put `routed()` in that branch; the
[Combinators dispatch section](./combinators#dispatch) shows both tail-only and
`routed()` forms.

## Order matters

When alternatives share a prefix, put the longer one first, or the shorter one will
match and the longer one will never be reached:

```ts
// [verify]
import { choice, literal, regex, parse } from 'parseman'

const op = choice(literal('instanceof'), literal('in'), literal('if'))
parse(op, 'instanceof x').value
// → 'instanceof'

// Short arm first → it matches the prefix and the long arm is unreachable.
const shadowed = choice(regex(/in/), regex(/instanceof/))
parse(shadowed, 'instanceof x').value
// → 'in'
```

Two shapes are exceptions, and both resolve by longest match rather than by position —
in the interpreter and the compiled parser alike:

- **Every arm is a bare `literal()`**
  ([`literalsLongestFirst`](./natural-grammars#the-one-place-order-defers-to-length)), so
  an all-literal `choice` is order-insensitive.
- **One regex arm provably subsumes every other arm, and the rest are literals**
  ([`greedyClassify`](./natural-grammars#literal-heavy-choices-collapse-to-one-scan)) —
  the regex runs once and the matched text is classified by string equality, so the
  keywords win over the general token whichever order they are written in.

Both detections are conservative. Mix in a `sequence()` or `word()` arm, or add a second
regex, and neither applies — ordering is load-bearing again. Write the long arm first
regardless, and don't make a grammar's correctness depend on a rewrite applying.

You rarely need `attempt()` just to make an ordinary `choice()` safe: rejected
choice arms already roll back Parseman's capture and recovery sinks. Reach for
`attempt()` when the user-facing failure should be anchored at a larger parser's
entry while preserving the inner expected token.

```ts
import { attempt, literal, sequence } from 'parseman'

const value = sequence(literal('x'), attempt(sequence(literal('a'), literal('b'))))
```

## Keyword vs. identifier boundaries

The classic hazard: `if` should not match the `if` at the start of `ifdef`. A bare
`literal('if')` happily matches that prefix. Use the **`word`** combinator, which adds a
trailing word-boundary guard.

```ts
import { word, makeWord, choice, regex } from 'parseman'

word('true')                  // combinator — default boundary (_0-9A-Za-z)
word('color', 'A-Za-z0-9_-')  // combinator — one-off custom boundary

// makeWord: bake a boundary into a small factory
const kw    = makeWord()
const cssKw = makeWord('A-Za-z0-9_-', { caseInsensitive: true })

const token = choice(
  kw('if'),               // each call yields a combinator
  kw('else'),
  cssKw('color'),
  regex(/[a-zA-Z_]\w*/),  // ident fallback
)
```

The **boundary** is the character class that must *not* follow the match. Pass it per
call to `word`, or bake it into a factory with `makeWord`. `makeWord` can also carry
the same `caseInsensitive` option as `word`; omitting it keeps the shared
case-sensitive default.

## Matching many keywords at once

When you have a whole set of keywords, `keywords()` matches one of many — longest-first,
compiled into a single sticky regex — with the same boundary and case-folding options:

```ts
import { keywords } from 'parseman'

const httpVerb = keywords(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const cssAtRule = keywords(['media', 'supports', 'keyframes'], { boundary: 'A-Za-z0-9_-' })
const caseless  = keywords(['true', 'false'], { caseInsensitive: true })
```

This is both faster and clearer than a hand-written `choice` of `word`s when the set is
large.

## Rolling the guard by hand

If you need something the boundary class can't express, build the guard with `not()`:

```ts
import { not, sequence, literal, regex, transform, choice } from 'parseman'

const wordChar = regex(/\w/)
const keyword  = (s: string) => transform(sequence(literal(s), not(wordChar)), ([kw]) => kw)
const ident    = regex(/[a-zA-Z_]\w*/)

const token = choice(
  keyword('if'),
  keyword('else'),
  keyword('return'),
  ident,
)
```

`not(wordChar)` succeeds only when the next character is *not* a word character,
consuming nothing — so `keyword('if')` matches `if` but rejects the `if` in `ifdef`.

## Gated alternatives

`choice` arms can be **gated** on the parse context — an arm is only tried when its gate
predicate returns true. This is the choice-level companion to [`gate`](./context) — the
arm field SELECTS a branch (keeping dispatch), the `gate()` combinator ASSERTS mid-sequence:

```ts
import { choice } from 'parseman'

const stmt = choice(
  { gate: (state) => state.inFunction === true, combinator: returnStmt },
  exprStmt,
)
```

The `returnStmt` arm is skipped entirely unless `state.inFunction` is set — handy for
context-sensitive grammars where a construct is only legal in certain positions.
