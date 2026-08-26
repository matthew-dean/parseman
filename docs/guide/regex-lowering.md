# Under the hood: regex lowering

When you compile a grammar — with [`compile()`](./modes#compile-runtime-jit) or the
[macro build](./macro-mode) — Parséman doesn't just wrap your `regex(…)` terminals in
`RegExp.exec`. Where it can *prove* the result is identical, it rewrites the pattern into a
tight `charCodeAt` scan loop instead — no regex engine, no match object, no allocation on
the hot path.

This page explains what gets lowered, why, into what, how we test that the rewrite is both
correct and actually faster, and how we keep the generated code from ballooning.

If you just want to write fast grammars, [Performance](./performance) covers the one lever
you control. This page is the "how the sausage is made" companion — useful when you're
wondering why a particular pattern did, or didn't, get the fast path.

## Why lower at all

Run a `regex(/[0-9]+/)` terminal through the regex engine and it costs a `lastIndex`
write, an `exec` call into the engine, and a match-array allocation — every single call.
A terminal on a hot path gets called a lot, so for a JIT-friendly parser, that's the
dominant cost of matching something as simple as a token.

The same match, expressed directly, is just a loop over character codes:

```js
let e = pos
while (e < input.length && input.charCodeAt(e) >= 48 && input.charCodeAt(e) <= 57) e++
```

No engine, no match object, no `lastIndex` bookkeeping — just a bounds check and an integer
comparison that the JIT compiles down to a handful of machine instructions. It's the same
idea as the grammar-level
["collapse tokens into one regex"](./performance#collapse-opaque-shapes-into-one-regex)
lever, pushed one level down: instead of *one regex instead of many combinators*, it's
*one scan loop instead of one regex*.

The catch is that a regex can express things a single greedy left-to-right scan can't —
backtracking, alternation, lookaround. So lowering is shape-directed and conservative. We
recognize a fixed set of structural shapes, and if a pattern doesn't fit one — or fits but
can't be *proven* equivalent to a one-pass scan — we leave it on the regex engine. A
pattern that isn't lowered still works. It's just not accelerated.

## What we lower — the shape taxonomy

Recognition is purely structural — derived from the regex's shape, never from any
hardcoded knowledge that a given pattern "is whitespace" or "is a comment." Each shape
maps a class of patterns to an emit strategy:

| Shape | Recognizes (examples) | Lowers to |
| --- | --- | --- |
| `chars` | `[0-9]+`, `[a-z]*` | a single `while` run over a char-class |
| `ident` | `[_a-zA-Z][-\w]*` | a head-char check + a tail run |
| `seq` | `-?[0-9]+`, `--[-\w]*`, `::?` | a linear chain of literal segments and char runs |
| `until` | `//[^\n]*` (line comment) | consume opener, run until a stop char |
| `delimited` | `/*(?:…)*\*/` (block comment) | consume opener, run to a closing literal |
| `string` | `"(?:[^"\\]\|\\.)*"` | quote-delimited scan with backslash-escape handling |
| `litFold` | `url\(` under `/i` | fixed literal compared case-insensitively |
| `lookahead` | `[a-z]+(?!\w)` (keyword boundary) | inner shape + a zero-width `charCodeAt(end)` check |
| `alt` | `-?[a-z]+\|%` | first-char dispatch, or ordered choice |

`seq` is the general category the others specialize: any fixed linear chain of literal
segments (required or optional `x?`) and character-class runs (positive or negated,
`?`/`*`/`+`). It covers CSS and Less tokens like `-?ident`, `--custom-prop`, `@-?keyword`,
`[^…]+`, and `::?` — without hardcoding a single byte for any of them.

## Into what — worked examples

These are trimmed from the actual compiled output — the `function _parse(…)` wrapper, the
failure branch, and the leaf-capture tail are elided for readability.

### `chars` — `/[0-9]+/`

```js
let _e1 = _pos
while (_e1 < input.length && (input.charCodeAt(_e1) >= 48 && input.charCodeAt(_e1) <= 57)) _e1++
// fail unless _e1 > _pos
```

### `ident` — `/[_a-zA-Z][-_a-zA-Z0-9]*/`

A head-character test, then a tail run — the classic identifier shape:

```js
let _e1 = _pos
if (_pos < input.length && (input.charCodeAt(_pos) === 95 ||
    (input.charCodeAt(_pos) >= 97 && input.charCodeAt(_pos) <= 122) ||
    (input.charCodeAt(_pos) >= 65 && input.charCodeAt(_pos) <= 90))) {
  _e1 = _pos + 1
  while (_e1 < input.length && (/* - _ a-z A-Z 0-9 */)) _e1++
}
```

### `seq` — `/--[-_a-zA-Z0-9]*/` (a CSS custom property)

A required `--` literal, followed by a character run. The literal becomes an unrolled
`charCodeAt` chain; the run becomes a `while` loop:

```js
let _e1 = _pos
let _ok2 = false
do {
  if (!(_e1 + 2 <= input.length && input.charCodeAt(_e1) === 45 && input.charCodeAt(_e1 + 1) === 45)) break
  _e1 += 2
  while (_e1 < input.length && (/* - _ a-z A-Z 0-9 */)) _e1++
  _ok2 = true
} while (false)
if (!_ok2) _e1 = _pos
```

### `lookahead` — `/[a-z]+(?!\w)/` (a keyword boundary)

The inner `chars` run, then a zero-width post-match check: succeed only if the next
character is *not* a word character. `end` never advances past where the inner shape
stopped.

```js
let _e1 = _pos
while (_e1 < input.length && (input.charCodeAt(_e1) >= 97 && input.charCodeAt(_e1) <= 122)) _e1++
let _ok2 = _e1 > _pos
let _end3 = _e1
if (_ok2 && (_e1 < input.length && (/* \w */))) { _ok2 = false; _end3 = _pos }
```

### `alt` — `/-?[a-z]+|%/`

Two arms with disjoint first characters (`-`/`a`–`z` vs `%`), so it dispatches straight to
the matching arm with an `if`/`else if` on the first character — no trying, no
backtracking:

```js
if (_pos < input.length && (input.charCodeAt(_pos) === 45 ||
    (input.charCodeAt(_pos) >= 97 && input.charCodeAt(_pos) <= 122))) {
  /* -?[a-z]+ arm */
}
else if (_pos < input.length && input.charCodeAt(_pos) === 37) {
  /* % arm */
}
```

When arms' first-character sets overlap, `alt` instead emits an ordered labeled block that
tries each arm in turn and takes the first that succeeds. That's exactly regex `|`'s own
semantics — the first alternative to match at all wins, on its own length; it is **not**
longest-match — so the lowering stays faithful.

### The fallback — `/\S+/`

Not every pattern lowers. An open-ended shorthand negation like `\S+` stays on the engine,
compiled as a hoisted sticky regex:

```js
const _re0 = /\S+/y
// …
_re0.lastIndex = _pos
const _m0 = _re0.exec(input)
if (_m0 === null) { /* fail */ }
```

Same correctness, just not accelerated.

## Correctness: when we *decline*

The guiding rule: we'd rather fall back to `exec` than emit a scan that might disagree
with the regex engine. A greedy one-pass scan only gets substituted in when it provably
matches the engine's backtracking behavior. Concretely, lowering is declined when:

- **A greedy scan could diverge from backtracking.** `seq` shapes are gated by a
  `seqIsUnambiguous` check: a chain only lowers when each part's match length is forced,
  so greedy scanning can't consume a character an earlier part needed. Ambiguous chains
  stay on the engine.
- **A lookahead sits on a backtrackable tail.** `[0-9]+(?=[5-9])` looks lowerable, but the
  engine can give back digits to satisfy the lookahead — `/^[0-9]+(?=[5-9])/.exec('12345')`
  matches `"1234"`, not nothing. A `lookahead` only lowers when the inner shape's trailing
  class is a subset of the operand (negative lookahead), disjoint from it (positive), or
  has no backtrackable tail at all (a fixed literal). Otherwise it stays on the engine.
- **An alternation arm doesn't lower.** If any arm of `A|B|C` contains something
  unlowerable — its own nested group, say — the whole `alt` declines rather than lowering
  some arms and leaving others behind.
- **Unicode or case-insensitive flags change the semantics.** The `u` flag (surrogate-pair
  semantics) and `/i` on anything but a pure literal are declined. The scan advances one
  UTF-16 unit per code point, which only holds true on the BMP, and ASCII case-folding a
  whole character class is a separate feature we haven't built.

The payoff of being conservative: a wrong read of a pattern can only ever cost you a
missed optimization, never cause a mis-parse. Unrecognized or unprovable patterns just
quietly keep using the regex engine.

## How we test lowering shapes

Two things have to hold for every shape: it has to produce the same match as the regex
engine, and it actually has to be faster.

**Differential fuzzing against native `RegExp`.** Each shape family gets checked by
generating tens of thousands of randomized inputs and asserting the lowered scan agrees
with `RegExp.exec`, byte-for-byte, on match/no-match and match length. The lookahead,
alternation, and keyword fast paths each carry 100k+ fuzzed inputs.

The safety guards are checked by asserting the lowering decision itself, not just the
output. A shape that must lower asserts the emitted source contains no `.exec(input)`. A
shape the guard must decline — a non-ASCII `/i` pattern like `/café/i`, where an
ASCII-only fold would miss `CAFÉ` — asserts the opposite: that it fell back to
`RegExp.exec`. Both then check agreement with the interpreter across case variants. So a
guard that stops declining fails the decision assertion directly, instead of only getting
caught downstream if some input happens to expose the mismatch.

**Cross-mode parity.** The same grammar runs through the interpreter, `compile()`, and the
macro build, and the outputs are asserted identical. Lowering only lives in the compiled
paths, so this catches any drift between what the interpreter does (always the regex
engine) and what compiled code does.

**Perf guards and benchmarks.**

```bash
pnpm perf:guard      # fast pre-commit check: CSS speed vs a committed baseline
pnpm bench           # parser-to-parser comparison (JSON/CSV/GraphQL)
pnpm bench:parseman  # interpreted vs compiled Parseman suite
pnpm test:perf       # heavier perf assertions
```

`perf:guard` runs on every commit and fails if the compiled-vs-interpreted speedup on the
CSS grammar regresses past a tolerance — so a lowering change that accidentally makes
things slower gets caught immediately, not in review.

## Balancing speed against code size

Lowering trades bundle size for speed — an unrolled scan is more source code than a call
into the engine. Two decisions keep that trade in check.

**Bounded literal unrolling (`CHARCODE_CHAIN_MAX`).** A literal can be emitted either as
an unrolled `charCodeAt` chain (`c(pos)===… && c(pos+1)===…`) or as a
`String.prototype.startsWith` call. Measurement showed the unrolled chain is faster, or at
least tied, out to surprisingly long literals — but its generated source grows linearly
with length, while `startsWith` is a near-constant call site. So the crossover is set at
16 characters: a literal of 16 characters or fewer gets the fast unrolled form, and
anything longer falls back to `startsWith` to cap worst-case codegen bloat. Most grammar
terminals sit well under that — keywords, operators, and punctuation are short (the
longest in the example grammars is `important`, 9 characters) — so the unrolled path is
what almost every literal actually takes.

**Decline rather than emit sprawl.** The shapes deliberately stop where the generated code
would get large or the equivalence proof would get shaky — bounded repeats `{n,m}`, nested
groups, Unicode case-folding. Those stay on the compact `RegExp.exec` fallback. The upshot
is that lowering targets the high-frequency, low-complexity terminals, where the runtime
win is biggest and the code-size cost is smallest, and leaves the long tail to the engine.

For the whole-grammar picture of this tradeoff — generated lines of code and gzip size per
example grammar — see [Macro mode → Code size](./macro-mode#code-size-what-to-expect).

## Where this lives in the repo

The recognizer and emitters live in
[`src/compiler/scannable-run.ts`](https://github.com/matthew-dean/parseman/blob/main/src/compiler/scannable-run.ts).
The per-shape catalog, with rationale and measurements, is in
[`notes/PERF_IDEAS.md`](https://github.com/matthew-dean/parseman/blob/main/notes/PERF_IDEAS.md).
This page is the conceptual overview; the catalog is the shape-by-shape detail.
