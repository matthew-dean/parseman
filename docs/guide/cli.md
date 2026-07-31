# The `parseman` CLI

```sh
parseman diagnose src/grammar.ts
parseman fix src/grammar.ts --corpus test/fixtures
```

Compiling a grammar prints nothing — a diagnostic is a deliberate act, not a side effect
of producing an artifact. This is how you ask.

Captured output for every command is in [`docs/samples/cli-output.md`](../samples/cli-output.md),
verbatim and non-TTY.

## Exit codes

| code | meaning |
| ---- | ------- |
| `0`  | analysed; no blocking finding |
| `1`  | analysed; blocking findings — the gate fails |
| `2`  | **could not analyse** — bad usage, unloadable grammar, unreadable corpus, I/O failure |

`2` is the one that matters. A tool that cannot measure must not exit `0`; this project
has already shipped a coverage report claiming 100% over zero analysable input.

One CI line:

```yaml
- run: npx parseman diagnose src/grammar.ts --export Document
```

## `diagnose`

Static analysis of the grammar: which choices gate on their first character, which do
not and why, and which arms are spelled in a way that defeats the analysis parseman
would otherwise do for free. It is the `diagnoseGrammar()` surface with a rendering on
top.

```sh
parseman diagnose examples/css/parser.ts --export Stylesheet
parseman diagnose examples/css/parser.ts --export Stylesheet --corpus fixtures/css
```

### The second world

`--corpus` adds the input side. A type error has one source to point at; a grammar
finding has two — the ordered choice whose arms cost the time, and the input that pays
for it — and relating them is the diagnostic:

```
  value   81 corpus positions can enter it
      arm 3  Url       'U','u'        1 pos
      arm 4  Call      '-','A'-'Z','… 34 pos
      arm 7  anyValue  ANY            ← entered at all 81
      ↳ fixtures/css/decls.css:3:12  arm 3 can start here; arm 7 is entered first
             background: white;
                    ^
```

The count is a count of CHARACTERS in the corpus whose value some arm accepts. It is an
upper bound on how often the choice is entered, not a measurement of how often it was —
a choice nested three rules deep is reached far less often than its first characters
occur. It is reported as exactly that and never as "this choice ran N times". What it
does settle exactly: an arm whose first set is `ANY` is entered at every one of those
positions, because no first character can exclude it.

## `fix`

```sh
parseman fix src/grammar.ts --corpus test/fixtures          # preview a diff
parseman fix src/grammar.ts --corpus test/fixtures --apply  # write it
```

### Why these rewrites can be trusted

rustc can tell you a suggestion is machine-applicable. It cannot tell you the suggestion
is *correct*, because there is no cheap oracle for "this rewrite of your program means
the same thing". A parser generator has one — a grammar's whole observable behaviour is
the tree it produces:

```
propose  →  apply  →  recompile  →  compare parse output
                                     unchanged → PROVEN; offer it
                                     changed   → WRONG; discard, never show it
```

Every rewrite `fix` offers went through that loop, on both engines, over your corpus.
The evidence prints beside it:

```
  proven  applied, recompiled, 3 sample(s) re-parsed on interpreted + compiled — output identical
```

`--corpus` is **required**. With no corpus there is no evidence, so nothing is offered
and the command exits `2`.

### What "proven" means, exactly

Proven over the corpus you supplied. A corpus that never reaches the rewritten arm
proves nothing about it, which is why the sample and byte counts are always printed.

Two deliberate exclusions from the comparison: failure `expected` LABELS are compared as
position only, not text (a keyword rewrite changes `/if/` to `keyword` by design — that
is diagnostic text, not parse output), and the rebuilder itself is checked before it is
used, by rebuilding with no substitution and requiring identical output. If any part of
the rebuild is unfaithful, no fix is offered at all.

### Two states, never a third

| state | means |
| ----- | ----- |
| `ACTIONABLE` | here is the rewrite, its evidence, and the measured benefit |
| `LOCATED` | here is the exact site and the exact reason no rewrite can be offered |

There is no "consider refactoring". A verified rewrite that removes no ungated choice and
no anti-pattern is not offered either — output-neutral and pointless is still pointless.

### `--apply` and source edits

The diff is the primary interface; `--apply` is an explicit second step. An edit is
offered only when the site's spelling occurs **exactly once** in the source file: the
loop proves a *graph* rewrite is output-neutral, and a text edit is only that rewrite if
the text really is the site. Ambiguity declines, with the rewrite printed for you to
apply by hand. An edit applied to the wrong site is worse than no `--fix` at all.

## `--json`

The same structured object the human rendering is derived from — machine-first, not a
stringified render. With a path it writes the file; with no path it goes to stdout and
the human report moves to stderr, so stdout stays one parseable document.

Both documents are deterministic: stable ordering, no timings, no dates, no absolute
paths. A diagnosis can be committed and diffed.

## Options

| option | |
| ------ | - |
| `--corpus <path>` | file or directory of sample inputs |
| `--ext <list>` | corpus extensions to accept, e.g. `--ext .css` |
| `--export <name>` | named export to analyse instead of the default export |
| `--accept <ids>` | comma-separated choice ids accepted as intentionally ungated |
| `--source <path>` | grammar source to locate edits in (default: the grammar path) |
| `--apply` | `fix` only — write the verified edits. Off by default |
| `--json[=<path>]` | machine-readable report |
| `--limit <n>` | findings to expand (default 20) |
| `--color` / `--no-color` | default: colour only when stdout is a TTY and `NO_COLOR` is unset |

A `.ts` grammar needs `tsx` installed; parseman registers it when it is resolvable and
says so plainly when it is not.

## Using it as a library

Everything the CLI does is available at `parseman/diagnostics` — a separate entry point,
because the verification loop reaches the compiler and no consumer who only wanted to
parse something should carry codegen on its account.

```ts
import { proposeFixes, renderFixReport } from 'parseman/diagnostics'

const report = proposeFixes(Document, { corpus })
if (report.verified.length > 0) console.log(renderFixReport(report))
```
