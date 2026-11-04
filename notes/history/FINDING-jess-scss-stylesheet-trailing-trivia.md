# `benchmark.jess` accepts 0 of 124 bytes — the `.jess` and `.scss` `Stylesheet`
# nodes are missing `{ trailingTrivia: true }`

Parseman `lane/jessfixture` @ `90aa867b5fbd6b504df8ed59b4959d0e8ad893ff`
(`origin/release/0.47.0`). jess checkout `/Users/matthew/git/oss/jess`, read-only.
No timed benchmark was run; every figure here is a byte count from `run()`.

## Verdict

**It is a grammar defect (explanation 2), not an invalid fixture and not a bad
entry rule.** The 124 bytes of `packages/jess/benchmark/benchmark.jess` are valid,
comment-only stylesheet content — the *CSS* grammar consumes all 124 of them at
this same SHA. The `.jess` grammar consumes 0 because its `Stylesheet` node does
not carry the option that makes a root node absorb the trivia after its last term.

The defect is **not specific to the benchmark fixture and not specific to `.jess`.**
It costs the trailing newline of essentially every `.jess` and `.scss` file in the
repo. `benchmark.jess` is only the extreme case: it contains *no* statements, so
*all* of it is trailing trivia.

## The evidence

`node()`'s `trailingTrivia` option (`src/combinators/node.ts:48,193,267`): after a
successful node body, consume the active grammar trivia. Grep across the four
shipping grammars:

| grammar | `Stylesheet` node | `trailingTrivia` |
| --- | --- | --- |
| css  | `css-parser/src/grammar.ts:3937`  | **yes** — `:3944` |
| less | `less-parser/src/grammar.ts:6319` | **yes** — `:6323` |
| scss | `scss-parser/src/grammar.ts:5066` | **NO** |
| jess | `jess-parser/src/grammar.ts:5895` | **NO** |

All four set `trivia` at the `rules({ trivia: whitespace, … })` level, so the
option is available to all four; two of them simply never passed it.

Measured with the ordinary `bench/jess` loader (`loadGrammar(d, 'ast')`,
`ENTRY = 'Stylesheet'` — the harness's own entry resolution, unmodified) and
`run(entry, src)` with no `trivia` option, exactly as `bench/jess/consumed-sweep.ts`
does:

```
jess grammar, packages/jess/benchmark/benchmark.jess
  bytes=124 ok=true span=0..0 unconsumedFrom=0 errors=0 expected=[]
  at "\n/** See https://github.com/less/less.js/tree/master/package…"

css  grammar, same 124 bytes
  bytes=124 ok=true span=0..124 unconsumedFrom=null
```

`expected` is **empty** and `ok` is **true**: nothing failed. The root node matched
a zero-width body and reported success, and every byte of the file is trailing
trivia it declined to own. This is the exact silent-early-stop failure mode
`consumed-sweep.ts` was written for.

The file itself:

```
(blank line)
/** See https://github.com/less/less.js/tree/master/packages/less/benchmark/benchmark.less */
(blank line)
/** @todo - automate this */
```

It is a placeholder — a `@todo` and a pointer at less.js's benchmark. It contains
no rules at all, which is a separate (and much less interesting) fact: the `.jess`
row of every parse benchmark has been timing a 124-byte comment. That is worth the
owner's attention, but it is not why the parse consumed nothing.

## Blast radius, at this SHA

`.jess` — 21 of the 24 `.jess` files in the repo (`bench/jess/grammars.ts`
`CORPUS.jess`) do not consume their input; only 3 do:

* **16 short by exactly 1 byte** — the trailing `\n`, `expected=[]`, `ok=true`.
* `packages/jess/benchmark/benchmark.jess` — 0 of 124 (this defect, total).
* `test/errors/bare-declaration.jess` 0/11 and `test/errors/unclosed-brace.jess`
  0/16 — error fixtures; rejection is the point.
* `packages/jess/benchmark/chunk.jess` — 4292 of 11047. **Unrelated, real, see below.**
* `test/data/imports.jess` — throws `Jess CSS import lost its opaque tail.`
  (reducer error, unrelated, not investigated here).

`.scss` — of 2409 sass-spec inputs plus `gen-workload.scss`: **1626 short by
exactly one byte.** Including the fixture believed clean:

```
packages/jess/benchmark/gen-workload.scss
  bytes=287543 ok=true span=0..287542 unconsumedFrom=287542
```

So the "287,542 of 287,543" figure on record for `gen-workload.scss` is **not**
"consuming fully" — it is this defect, one byte, reading as a rounding artefact.
(275 further scss files stop short by more than a byte and 499 return `ok: false`;
sass-spec carries error fixtures, so that is not by itself a defect claim. It has
not been triaged and no one should assume it is clean.)

`.css` and `.less` — genuinely clean on the fixtures in question.
`benchmark.css` (123029 B), `benchmark.less` (106802 B) and `gen-workload.less`
all reach `unconsumedFrom: null`. The css corpus has one throwing fixture
(`test/css/custom-properties.css`: `Declaration requires a captured
custom-property value`) and the less corpus has 15 non-error-fixture stops, most
of them deliberate v5 rejections (backtick JS, `@variable` interpolation,
`ie-filters-REMOVED`). Neither set is this defect.

## What should change, and where

**In `/Users/matthew/git/oss/jess` (owner to apply — not touched from here):**

1. `packages/syntax/jess/jess-parser/src/grammar.ts:5895` — the
   `node<Stylesheet>('Stylesheet', sequence(…), children => …)` call takes a fourth
   argument `{ trailingTrivia: true }`, matching css `grammar.ts:3944` and less
   `grammar.ts:6323`.
2. `packages/syntax/scss/scss-parser/src/grammar.ts:5066` — the same fourth
   argument on scss's `Stylesheet`.

Both are one-token changes and both are the *same* change css and less already
carry, so this is bringing two grammars back onto the line the other two are on,
not inventing a rule.

**Separately, and an owner decision, not a defect claim:**

3. `packages/jess/benchmark/benchmark.jess` has no stylesheet content. Once (1)
   lands it will parse 124/124 bytes and still measure nothing. The `.jess` row of
   the parse benchmark needs a real fixture before any `.jess` timing means
   anything.
4. `packages/jess/benchmark/chunk.jess` stops at offset **4292**, at
   `\nmixinx($a: 1px, $b: 50%) {`. The mixin definition is not the problem — it
   parses standalone. The body is: **bare infix `*`, `+` and `-` are rejected in a
   `.jess` declaration value.** Minimal repro, jess grammar, `ok: true`,
   `span 0..0`, `expected: []`:

   ```
   .x { width: $a * 5; }     SHORT  0 of 21
   .x { width: 2 * 5; }      SHORT  0 of 20
   .x { width: $a + 5; }     SHORT  0 of 21
   .x { width: $a - 5; }     SHORT  0 of 21
   .x { width: $a / 5; }     FULL          (CSS separator)
   .x { width: $(a * 5); }   FULL          (jess expression form)
   .x { width: calc($a*5); } FULL
   ```

   `chunk.jess` uses the `$(…)` form correctly elsewhere in the same file
   (`color: $(#111111 - #444444)`), so the `width: $a * 5` lines read as
   unconverted Less that the mechanical port left behind — i.e. explanation 1, for
   *this* fixture only. There is no external oracle for `.jess`; whether bare infix
   math outside `$(…)` should be accepted is the owner's call, and nothing here
   guesses at it. What is fact is that the parser rejects it today and the fixture
   uses it.

**On the parseman side:** nothing to fix. `bench/jess/consumed-sweep.ts` calls
`run(entry, input)` without `RunOptions.trivia`, which is the *correct* strictness
for this sweep — `trivia` would have papered over exactly the defect being looked
for, and css and less prove a root rule can and does own its own trailing trivia.
The `EXTRA` map in `consumed-sweep.ts:100` has `jess: []`, but that is harmless:
`benchmark.jess` and `chunk.jess` are already inside the `packages/jess/benchmark`
corpus root.

## What this cost

`notes/results/parse-consumed.jsonl` has been recording `consumed !== bytes` for
all 21 of these `.jess` files, across 11 (build, engine) legs, since the sweep
existed. The data was right; nobody read the `.jess` rows. Every `.jess` timing
ever published measured a zero-width parse of a comment block.
