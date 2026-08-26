# The `parseman` CLI

```sh
parseman diagnose src/grammar.ts
parseman fix src/grammar.ts --corpus test/fixtures
```

Compiling a grammar prints nothing on its own — running a diagnostic is something you ask
for, not a side effect of building an artifact. This page is how you ask.

You can see captured output for every command in
[`docs/samples/cli-output.md`](../samples/cli-output.md) — verbatim, and captured outside
a terminal (no TTY), so it's exactly what you'd get piped into a log or CI.

## Exit codes

| code | meaning |
| ---- | ------- |
| `0`  | analysed; no blocking finding |
| `1`  | analysed; blocking findings — the gate fails |
| `2`  | **could not analyse** — bad usage, unloadable grammar, unreadable corpus, I/O failure |

`2` is the one to watch for. A tool that can't measure something must never exit `0` as if
it did — this project has, in fact, shipped a coverage report that claimed 100% over zero
analyzable input.

One CI line:

```yaml
- run: npx parseman diagnose src/grammar.ts --export Document
```

## `diagnose`

`diagnose` runs static analysis on your grammar: which choices gate on their first
character, which don't (and why), and which arms are spelled in a way that defeats
analysis parseman would otherwise do for free. It's the `diagnoseGrammar()` surface with a
rendering on top.

```sh
parseman diagnose examples/css/parser.ts --export Stylesheet
parseman diagnose examples/css/parser.ts --export Stylesheet --corpus fixtures/css
```

### The second world

`--corpus` adds the input side. A type error has one place to point at; a grammar finding
has two — the ordered choice whose arms cost time, and the input that pays for it.
Relating those two is the whole diagnostic:

```text
  value   81 corpus positions can enter it
      arm 3  Url       'U','u'        1 pos
      arm 4  Call      '-','A'-'Z','… 34 pos
      arm 7  anyValue  ANY            entered at all 81
  ⚠ arm 7 has an ANY first set — entered at all 81 of these positions

     ╭─[fixtures/css/decls.css:3:12]
   3 │     background: white;
     │            ╿
     │            ╰── arm 3 can start here; arm 7 is entered first
     ╰─
```

That count is characters in the corpus whose value some arm accepts. It's an upper bound
on how often the choice is entered, not a measurement of how often it actually was — a
choice nested three rules deep gets reached far less often than its first characters
occur. It's reported as exactly that, never as "this choice ran N times." What it does
settle for certain: an arm whose first set is `ANY` gets entered at every one of those
positions, because no first character can rule it out.

## `fix`

```sh
parseman fix src/grammar.ts --corpus test/fixtures          # preview a diff
parseman fix src/grammar.ts --corpus test/fixtures --apply  # write it
```

### Why these rewrites can be trusted

rustc can tell you a suggestion is machine-applicable. It can't tell you the suggestion is
*correct* — there's no cheap oracle for "this rewrite of your program means the same
thing" in a general-purpose language. A parser generator has one, though: a grammar's
entire observable behavior is the tree it produces:

```text
propose  →  apply  →  recompile  →  compare parse output
                                     unchanged → PROVEN; offer it
                                     changed   → WRONG; discard, never show it
```

Every rewrite `fix` offers has gone through that loop, on every available engine, over
your corpus. That means both engines when the grammar compiles; if it doesn't compile,
the rewrite is verified on the interpreted engine alone, and the report names whichever
engines it actually used. The evidence prints right beside it:

```text
  proven  applied, recompiled, 3 sample(s) re-parsed on interpreted + compiled — output identical
```

`--corpus` is required. With no corpus there's no evidence, so nothing is offered and the
command exits `2`.

### What "proven" means, exactly

Proven over the corpus you supplied — nothing more. A corpus that never reaches the
rewritten arm proves nothing about it, which is why the sample and byte counts always
print alongside the result.

Two things are deliberately excluded from the comparison. Failure `expected` labels are
compared by position only, not text — a keyword rewrite changing `/if/` to `keyword` is
diagnostic text changing by design, not parse output changing. And the rebuilder itself
gets checked before it's trusted, by rebuilding with no substitution and requiring
identical output. If any part of the rebuild isn't faithful, no fix gets offered at all.

### Two states, never a third

| state | means |
| ----- | ----- |
| `ACTIONABLE` | here is the rewrite, its evidence, and the measured benefit |
| `LOCATED` | here is the exact site and the exact reason no rewrite can be offered |

There's no "consider refactoring" middle ground. A verified rewrite that removes no
ungated choice and no anti-pattern isn't offered either — being output-neutral doesn't
save a change that's simply pointless.

### `--apply` and source edits

The diff is the primary interface. `--apply` is a deliberate second step, and it only
offers an edit when the site's spelling occurs exactly once in the source file. The loop
proves a *graph* rewrite is output-neutral — a text edit is only that same rewrite if the
text really is the site. When it's ambiguous, `fix` declines and prints the rewrite for
you to apply by hand instead. An edit landing on the wrong site is worse than no `--apply`
at all.

## `--json`

`--json` gives you the same structured object the human rendering is derived from — it's
machine-first, not a stringified version of the report. Pass a path and it writes the
file; leave it off and the JSON goes to stdout while the human report moves to stderr, so
stdout stays one clean, parseable document.

Both forms are deterministic: stable ordering, no timings, no dates, no absolute paths.
That means a diagnosis can be committed to your repo and diffed like any other file.

## Reading the output

Findings are grouped by cause. Each cause is explained once, given a glyph, and followed
by every choice that has it. The first is expanded in full — its alternative ordering, and
a frame showing a real place in your corpus. The last line summarizes the tally and what
the exit code means.

A finding marked 🔧 has a rewrite that parseman has already proved: it applied the change,
rebuilt the parser, re-parsed your corpus, and got identical output. The wrench never
shows up otherwise — not for a candidate it rejected, and never at all without `--corpus`,
since there'd be nothing to prove it against.

## Rendering

Output goes through [linecraft](https://www.npmjs.com/package/linecraft), so a caret, a
code frame, and a file link look the way they do in every other compiler you've squinted
at on a Tuesday.

Every `file:line:col` is a clickable OSC-8 hyperlink on a terminal that supports it;
`--no-links` turns them off. Links are zero-width and wrap only the visible text, so
column alignment stays identical whether they're on or off.

Under the hood, the renderer emits lines of spans — text plus a semantic style — and never
writes an escape byte itself. Without color, the output is just those spans' own text, so
the plain form can't drift from the styled one; there's nothing to strip. Width is pinned
to 80 columns off a TTY, which is why a piped run comes out byte-identical no matter which
terminal it was piped from.

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
| `--no-links` | do not emit OSC-8 file hyperlinks (for terminals that show them as junk) |
| `--width <n>` | render width; default the terminal's when colouring, else 80 |

A `.ts` grammar needs `tsx` installed. parseman registers it automatically when it can
resolve it, and says so plainly when it can't.

## Using it as a library

Everything the CLI does is also available at `parseman/diagnostics` — a separate entry
point, because the verification loop reaches into the compiler, and nobody who just wants
to parse something should have to carry codegen along for the ride.

```ts
import { proposeFixes, renderFixReport } from 'parseman/diagnostics'

const report = proposeFixes(Document, { corpus })
if (report.verified.length > 0) console.log(renderFixReport(report))
```
