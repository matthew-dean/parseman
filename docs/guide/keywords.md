# Ordered choice & keywords

`choice()` uses PEG ordered-choice semantics: **first match wins**. That single rule has
two consequences you have to design around — keyword/identifier collisions and
shared prefixes.

## Order matters

When alternatives share a prefix, put the longer one first, or the shorter one will
match and the longer one will never be reached:

```ts
import { choice, literal } from 'parseman'

// Wrong: choice(literal('in'), literal('instanceof'))
//        → 'instanceof' is never reached; 'in' matches its prefix first.
const op = choice(literal('instanceof'), literal('in'), literal('if'))
```

When an alternative needs to consume past a shared prefix before deciding, wrap
that alternative in `attempt()`. A failed attempt restores Parseman's CST,
trivia, field, and recovery-diagnostic capture before the next arm runs; it
does not roll back user-owned parse state.

```ts
import { attempt, choice, literal, sequence } from 'parseman'

const value = choice(
  attempt(sequence(literal('a'), literal('b'))),
  literal('a'),
)
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
const cssKw = makeWord('A-Za-z0-9_-')

const token = choice(
  kw('if'),               // each call yields a combinator
  kw('else'),
  cssKw('color'),
  regex(/[a-zA-Z_]\w*/),  // ident fallback
)
```

The **boundary** is the character class that must *not* follow the match. Pass it per
call to `word`, or bake it into a factory with `makeWord`. `makeWord` is optional —
`(s) => word(s, 'A-Za-z0-9_-')` is equivalent.

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
predicate returns true. This is the choice-level companion to [`guard`](./context):

```ts
import { choice } from 'parseman'

const stmt = choice(
  { gate: (state) => state.inFunction === true, combinator: returnStmt },
  exprStmt,
)
```

The `returnStmt` arm is skipped entirely unless `state.inFunction` is set — handy for
context-sensitive grammars where a construct is only legal in certain positions.
