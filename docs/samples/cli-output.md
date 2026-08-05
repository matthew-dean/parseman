# `parseman` CLI — captured output

Every block below is **verbatim**, non-TTY (so colour is off, which is what lands in a
CI log or a file). The command above each block reproduces it from the repository root.
Nothing here was hand-edited, with one stated exception: the trailing
`$ echo $?  ->  N` line is an ANNOTATION of the exit code each run returned. A real
shell prints the number on its own line; the arrow form keeps the code beside the
command it belongs to. Everything above it in each block is captured output.

## 1 — a clean grammar

The rendering people see most. Two lines.
```console
$ parseman diagnose examples/json/parser.ts --export jsonDoc
✓ examples/json/parser.ts — nothing to fix
  1/1 choices gate on first char
$ echo $?  ->  0
```

## 2 — MANY findings, few causes (the case that matters)

Thirteen ungated choices, four causes. Each cause is stated ONCE, given a glyph, and
followed by its sites; the first site in each group is expanded with its full arm
ordering and the corpus frame that illustrates the cause, and the rest are a table.
Exit code 1 — this is what a CI gate fails on.

**This transcript is the PLAIN form.** On a terminal the same run is coloured, and every
`file:line:col` is a clickable link. Nothing below shows either; run the command to see it.
```console
$ parseman diagnose examples/css/parser.ts --export cssRules --corpus fixtures/css
✗ examples/css/parser.ts — 13 problems in 20 choices
  4 underlying causes; fixing one fixes every choice listed under it.
  6 other choices already pick the right alternative straight from the next
  character. None of this is a correctness bug — the grammar parses the same
  either way; it is work the parser does and did not need to.

────────────────────────────────────────────────────────────────────────────────
 ◆ 7 choices the parser cannot narrow down   fails the check
    This arm can begin with any character, so no single-character test can
    rule it out. The parser has to enter it — set up, try, and undo — at every
    position it reaches, instead of skipping it for free.
    To fix: make the arm begin with a fixed character, word or keyword. If it
    is meant to be a catch-all that matches anything, leave it and add the
    choice to the accept list at the end.

    Each numbered line below is one alternative of a choice — an "arm" — in the
    order the parser tries them.

 ◆ AtRuleBlock#1  —  reached at 81 places in your corpus
     arm 0    → literal('(')  starts with "("              → could match at 0
     arm 1    regex(/[^()]+/) can start with any character → tried at all 81
     Because arm 1 can begin with any character, no single-character test can
     rule it out. At all 81 of those places the parser has to enter it — set
     up, try, undo — instead of skipping it for nothing.
     ⚠ one of the 81 places, in your own input

       ╭─[fixtures/css/decls.css:1:1]
     1 │ a {
       │ ╿
       │ ╰── the first place in your corpus this choice is reached
       ╰─

 ◆ AtRuleBlock#2        arm 1   regex(/[^[\]]+/)    same — tried at all 81
 ◆ CustomDeclaration#1  arm 1   regex(/[^()]+/)     same — tried at all 81
 ◆ CustomDeclaration#2  arm 1   regex(/[^[\]]+/)    same — tried at all 81
 ◆ CustomDeclaration#3  arm 1   regex(/[^{}]+/)     same — tried at all 81
 ◆ Url                  arm 2   regex(/[^)"'\s]+/)  same — tried at all 81
 ◆ pseudoArg#1          arm 1   regex(/[^()]+/)     same — tried at all 81

────────────────────────────────────────────────────────────────────────────────
 ▲ 2 choices the parser cannot narrow down   fails the check
    Two arms of this choice can begin with the same character, so the parser
    cannot tell from that character which one to try. It tries them in order
    and undoes the ones that do not match.
    To fix: pull the shared beginning out in front of the choice so it is
    matched once — sequence(shared, choice(rest…)) — instead of repeating it
    inside each arm. parseman recognises that shape automatically and turns it
    back into a single test.

 ▲ ComplexSelector  —  reached at 0 places in your corpus
     arm 0    literal('||') starts with "|"              → could match at 0
     arm 1    literal('>')  starts with ">"              → could match at 0
     arm 2    literal('+')  starts with "+"              → could match at 0
     arm 3    literal('~')  starts with "~"              → could match at 0
     arm 4    literal('|')  starts with "|"              → could match at 0
     arm 0 and arm 4 can both start with '|', so that character cannot tell
     the parser which to try

 ▲ atRuleBody       arm 0   and arm 1  can both start with '@'

────────────────────────────────────────────────────────────────────────────────
 ● 3 choices the parser cannot narrow down   fails the check
    This arm ends in a scanTo(...) catch-all, which reads forward until it
    finds something and so can begin at any character. The parser can never
    rule it out. That is usually exactly what you want from a fallback.
    To fix: usually nothing. Add this choice to the accept list at the end so
    the check keeps flagging the choices that are real problems.

 ● Stylesheet#0  —  reached at 81 places in your corpus  (+ another cause)
     arm 0    AtRuleBlock     starts with "@"              → could match at 0
     arm 1    AtRuleStatement starts with "@"              → could match at 0
     arm 2    Ruleset         starts with 8 char ranges    → could match at 40
     arm 3    scanTo          can start with any character → tried at all 81
     Because arm 3 can begin with any character, no single-character test can
     rule it out. At all 81 of those places the parser has to enter it — set
     up, try, undo — instead of skipping it for nothing.
     arm 0 and arm 1 can both start with '@', so that character cannot tell
     the parser which to try
     ⚠ one of the 81 places, in your own input

       ╭─[fixtures/css/decls.css:1:1]
     1 │ a {
       │ ╿
       │ ╰── arm 2 matches here; arm 3 is entered first anyway
       ╰─

 ● declarationList#0  arm 4   scanTo  same — tried at all 81
 ● pseudoArg#0        arm 2   scanTo  same — tried at all 81

────────────────────────────────────────────────────────────────────────────────
 ■ 1 choice the parser cannot narrow down   fails the check
    This arm hands off to another rule, and that rule has the same problem —
    it can begin with any character — so the cost is inherited rather than
    caused here.
    To fix: run this check on the rule it refers to and fix it there. One rule
    given a definite beginning fixes every choice that uses it.

 ■ value  —  reached at 81 places in your corpus  (+ another cause)
     arm 0    Dimension starts with one of + --. 0-9 → could match at 0
     arm 1    Num       starts with one of + --. 0-9 → could match at 0
     arm 2    Color     starts with "#"              → could match at 0
     arm 3    Url       starts with one of U u       → could match at 1
     arm 4    Call      starts with 5 char ranges    → could match at 34
     arm 5    Paren     starts with "("              → could match at 0
     arm 6    Quoted    starts with one of "         → could match at 0
     arm 7    anyValue  can start with any character → tried at all 81
     Because arm 7 can begin with any character, no single-character test can
     rule it out. At all 81 of those places the parser has to enter it — set
     up, try, undo — instead of skipping it for nothing.
     arm 0 and arm 1 can both start with '+','-'-'.','0'-'9', so that
     character cannot tell the parser which to try
     arm 0 and arm 4 can both start with '-', so that character cannot tell
     the parser which to try
     arm 1 and arm 4 can both start with '-', so that character cannot tell
     the parser which to try
     arm 3 and arm 4 can both start with 'U','u', so that character cannot
     tell the parser which to try
     ⚠ one of the 81 places, in your own input

       ╭─[fixtures/css/decls.css:3:12]
     3 │     background: white;
       │            ╿
       │            ╰── arm 3 matches here; arm 7 is entered first anyway
       ╰─

────────────────────────────────────────────────────────────────────────────────
 Meant to be this way? Pass this and they stop being reported:
   { accept: ['AtRuleBlock#1', 'AtRuleBlock#2', 'ComplexSelector',
   'CustomDeclaration#1', 'CustomDeclaration#2', 'CustomDeclaration#3',
   'Stylesheet#0', 'Url', 'atRuleBody', 'declarationList#0', 'pseudoArg#0',
   'pseudoArg#1', 'value'] }

✗ 13 problems, 13 failing the check, 4 causes  ·  exiting 1 (problems found)
$ echo $?  ->  1
```

## 2b — the same grammar with a fixable problem

`diagnose` marks a finding with a wrench ONLY when `fix` has actually proved a rewrite for
it — applied, parser rebuilt, corpus re-parsed, output identical. Without `--corpus` there
is nothing to prove it against, so nothing is marked.
```console
$ parseman diagnose examples/lang/parser.ts --export exprParser --corpus examples/lang/corpus
✗ examples/lang/parser.ts — 7 problems in 7 choices
  2 underlying causes; fixing one fixes every choice listed under it.
  3 other choices already pick the right alternative straight from the next
  character. None of this is a correctness bug — the grammar parses the same
  either way; it is work the parser does and did not need to.

────────────────────────────────────────────────────────────────────────────────
 ◆ 4 choices the parser cannot narrow down   fails the check
    Two arms of this choice can begin with the same character, so the parser
    cannot tell from that character which one to try. It tries them in order
    and undoes the ones that do not match.
    To fix: pull the shared beginning out in front of the choice so it is
    matched once — sequence(shared, choice(rest…)) — instead of repeating it
    inside each arm. parseman recognises that shape automatically and turns it
    back into a single test.

    Each numbered line below is one alternative of a choice — an "arm" — in the
    order the parser tries them.

 ◆ expr#0  —  reached at 41 places in your corpus
     arm 0    regex(/if(?!\w)/) starts with "i"              → could match at 2
     arm 1    transform         starts with 7 char ranges    → could match at 41
     arm 0 and arm 1 can both start with 'i', so that character cannot tell
     the parser which to try
     ⚠ one of those places in your corpus

       ╭─[examples/lang/corpus/conditional.lang:1:1]
     1 │ if true then 1 else 2
       │ ╿
       │ ╰── the first place in your corpus this choice is reached
       ╰─

 ◆ expr#1  arm 0   and arm 2  can both start with '-'
 ◆ expr#2  arm 1   and arm 4  can both start with 't'
 ◆ expr#5  arm 0   and arm 2  can both start with '<'

────────────────────────────────────────────────────────────────────────────────
 ▲ 3 arms that hide their first character   fails the check
    These arms match a fixed word using a regular expression. parseman cannot
    always tell from a regular expression which character it starts with, so
    the parser cannot skip the arm when that character rules it out.
    To fix: write the word with word('…') or keywords([…]). Same match, same
    compiled character scan, but parseman then knows the first character.

 ▲ expr#arm0  arm 0   of expr  matches `if(?!\w)`  🔧 fixable
 ▲ expr#arm1  arm 1   of expr  matches `true(?!\w)`  🔧 fixable
 ▲ expr#arm2  arm 2   of expr  matches `false(?!\w)`  🔧 fixable

────────────────────────────────────────────────────────────────────────────────
 Meant to be this way? Pass this and they stop being reported:
   { accept: ['expr#0', 'expr#1', 'expr#2', 'expr#5'] }

✗ 7 problems, 7 failing the check, 2 causes  ·  exiting 1 (problems found)
 🔧 3 of them can be fixed automatically. Run:
    parseman fix examples/lang/parser.ts --export exprParser --corpus
    examples/lang/corpus
    Each change is applied, the parser rebuilt and your files parsed again
    before it is offered, so nothing is suggested that has not been checked.
$ echo $?  ->  1
```

## 3 — `fix`: proposed rewrites, each one PROVEN

Preview is the default; nothing is written. Every rewrite below was applied to the
grammar, the grammar recompiled, the corpus re-parsed on both engines, and the output
compared. A rewrite that moved the output is discarded and never shown.
```console
$ parseman fix examples/lang/parser.ts --export exprParser --corpus examples/lang/corpus
● examples/lang/parser.ts — 3 changes that are safe to make
  Every change below was applied, the parser rebuilt, and your 3 files (64
  bytes) parsed again with both engines — the result was identical every time. A
  change that altered the result was thrown away and is not shown.
  Nothing has been written. Add --apply to make these edits.

────────────────────────────────────────────────────────────────────────────────
 🔧 SAFE TO APPLY  expr#arm0
   ℹ removes 1 of the 3 arms that hide their first character

      ╭─[examples/lang/parser.ts:76:7]
   76 │       regex(/if(?!\w)/), g.expr as Combinator<Expr>,
      │       ┖────────┬───────┚
      │                ╰── → word('if', '\w')
      ╰─
   size    the generated parser grows by 179 bytes
   checked this exact change was made, the parser rebuilt, and your 3 files
           parsed again — identical result

────────────────────────────────────────────────────────────────────────────────
 🔧 SAFE TO APPLY  expr#arm1
   ℹ removes 1 of the 3 arms that hide their first character

      ╭─[examples/lang/parser.ts:36:3]
   36 │   regex(/true(?!\w)/),
      │   ┖─────────┬────────┚
      │             ╰── → word('true', '\w')
      ╰─
   size    the generated parser grows by 144 bytes
   checked this exact change was made, the parser rebuilt, and your 3 files
           parsed again — identical result

────────────────────────────────────────────────────────────────────────────────
 🔧 SAFE TO APPLY  expr#arm2
   ℹ removes 1 of the 3 arms that hide their first character

      ╭─[examples/lang/parser.ts:41:3]
   41 │   regex(/false(?!\w)/),
      │   ┖─────────┬─────────┚
      │             ╰── → word('false', '\w')
      ╰─
   size    the generated parser grows by 144 bytes
   checked this exact change was made, the parser rebuilt, and your 3 files
           parsed again — identical result

🔧 3 safe to apply  ·  add --apply to make them  ·  exiting 0 (nothing written)
$ echo $?  ->  0
```

### 3b — the LOCATED state

A site that is real but cannot be rewritten prints the exact reason, never advice.
Here the grammar source given to `--source` is not the file the sites live in, which is
the ordinary case when a grammar is assembled from helpers in another module.
```console
$ parseman fix examples/lang/parser.ts --export exprParser --corpus examples/lang/corpus --source examples/lang/ast.ts
● examples/lang/parser.ts — 0 changes that are safe to make, 3 places that need you
  Every change below was applied, the parser rebuilt, and your 3 files (64
  bytes) parsed again with both engines — the result was identical every time. A
  change that altered the result was thrown away and is not shown.

────────────────────────────────────────────────────────────────────────────────
 ✋ NEEDS YOU      expr#arm0
   here    regex(/if(?!\w)/)
   why     No change can be offered here: the change itself is proven safe, but
           `regex(/if(?!\w)/)` does not appear literally in
           examples/lang/ast.ts, so parseman cannot tell which text to change
           (it is probably built from a helper or a shared constant). Make it
           by hand: regex(/if(?!\w)/) → word('if', '\w')

────────────────────────────────────────────────────────────────────────────────
 ✋ NEEDS YOU      expr#arm1
   here    regex(/true(?!\w)/)
   why     No change can be offered here: the change itself is proven safe, but
           `regex(/true(?!\w)/)` does not appear literally in
           examples/lang/ast.ts, so parseman cannot tell which text to change
           (it is probably built from a helper or a shared constant). Make it
           by hand: regex(/true(?!\w)/) → word('true', '\w')

────────────────────────────────────────────────────────────────────────────────
 ✋ NEEDS YOU      expr#arm2
   here    regex(/false(?!\w)/)
   why     No change can be offered here: the change itself is proven safe, but
           `regex(/false(?!\w)/)` does not appear literally in
           examples/lang/ast.ts, so parseman cannot tell which text to change
           (it is probably built from a helper or a shared constant). Make it
           by hand: regex(/false(?!\w)/) → word('false', '\w')

🔧 0 safe to apply, 3 need you  ·  add --apply to make them  ·  exiting 0 (nothing written)
$ echo $?  ->  0
```

## 4 — failing closed

No corpus means no evidence, and an unverified rewrite is not offered. Exit code 2:
"could not measure" is not a pass.
```console
$ parseman fix examples/lang/parser.ts --export exprParser
✗ examples/lang/parser.ts — nothing can be offered, because nothing could be checked
  no files were given to check against. Pass --corpus <dir> pointing at some
  input your grammar parses, and parseman will apply each candidate change,
  rebuild the parser, and offer only the ones that leave your parse output
  exactly as it was
  parseman only offers a change after it has applied it, rebuilt the parser and
  confirmed your files still parse to exactly the same thing. It could not do that
  here, so it is offering nothing rather than guessing.
$ echo $?  ->  2
```

And a usage failure names the exports it found rather than a stack trace:
```console
$ parseman diagnose examples/json/parser.ts
examples/json/parser.ts has no default export, and 6 named exports to choose between.
  Pick one with --export: jsonDoc, jsonString, jsonValue, makeJSONParser, parseJSON, ws
$ echo $?  ->  2
```

## 5 — `--json`

Machine-first: the same object the human rendering is derived from. With no path it
goes to stdout and the human report goes to stderr, so stdout stays one document.
Trimmed here with `jq` to show the structure.
```console
$ parseman diagnose examples/css/parser.ts --export cssRules --json 2>/dev/null | jq "{schema, ok, summary, first_finding: .findings[0], acceptSnapshot}"
{
  "schema": "parseman.diagnosis/1",
  "ok": false,
  "summary": {
    "totalChoices": 20,
    "gated": 6,
    "recoverable": 1,
    "ungated": 13,
    "accepted": 0,
    "deferred": 0,
    "antiPatterns": 0,
    "unanalysable": 0,
    "degraded": 0,
    "staleAccepts": 0
  },
  "first_finding": {
    "id": "AtRuleBlock#1",
    "code": "ungated-choice",
    "severity": "blocking",
    "rule": "AtRuleBlock",
    "message": "choice is UNGATED [firstMatch] — no first-char dispatch; every position speculatively enters doomed arms",
    "details": [
      "arm[1] first-set ANY (broad-recognizer): broad recognizer (regex)\nfix: This arm can begin with any character, so no single-character test can rule it out. The parser has to enter it — set up, try, and undo — at every position it reaches, instead of skipping it for free.\nTo fix: make the arm begin with a fixed character, word or keyword. If it is meant to be a catch-all that matches anything, leave it and add the choice to the accept list at the end."
    ],
    "acceptKey": "AtRuleBlock#1"
  },
  "acceptSnapshot": [
    "AtRuleBlock#1",
    "AtRuleBlock#2",
    "ComplexSelector",
    "CustomDeclaration#1",
    "CustomDeclaration#2",
    "CustomDeclaration#3",
    "Stylesheet#0",
    "Url",
    "atRuleBody",
    "declarationList#0",
    "pseudoArg#0",
    "pseudoArg#1",
    "value"
  ]
}
```

And the fix report, which is the one that carries evidence:

```console
$ parseman fix examples/lang/parser.ts --export exprParser --corpus examples/lang/corpus --json 2>/dev/null | jq ".verified[0]"
{
  "id": "expr#0#arm0",
  "code": "keyword-regex",
  "rule": "expr",
  "armIndex": 0,
  "before": "regex(/if(?!\\w)/)",
  "after": "word('if', '\\w')",
  "armFirstSetBefore": "'i'",
  "armFirstSetAfter": "'i'",
  "choiceId": "expr#0",
  "choiceGatesBefore": "no",
  "choiceGatesAfter": "no",
  "benefit": {
    "ungatedChoicesBefore": 4,
    "ungatedChoicesAfter": 4,
    "antiPatternsBefore": 3,
    "antiPatternsAfter": 2,
    "gatedChoicesBefore": 3,
    "gatedChoicesAfter": 3,
    "artifactBytesBefore": 3565,
    "artifactBytesAfter": 3575
  },
  "evidence": {
    "samples": 3,
    "bytes": 64,
    "engines": [
      "interpreted",
      "compiled"
    ],
    "outputUnchanged": true
  },
  "edit": {
    "path": "examples/lang/parser.ts",
    "line": 76,
    "column": 7,
    "start": 2478,
    "end": 2495,
    "oldText": "regex(/if(?!\\w)/)",
    "newText": "word('if', '\\w')",
    "lineText": "      regex(/if(?!\\w)/), g.expr as Combinator<Expr>,"
  }
}
```

## 6 — `--help`

```console
$ parseman --help
parseman — grammar diagnostics

  parseman diagnose <grammar> [options]     analyse a grammar; exit 1 on a blocking finding
  parseman fix <grammar> [options]          propose VERIFIED rewrites; preview by default

grammar
  A module path. The default export is used, or --export <name>. A .ts module needs
  `tsx` installed (parseman registers it automatically when it is resolvable).

options
  --corpus <path>     File or directory of sample inputs. On `diagnose` it adds the
                      measured second world; on `fix` it is REQUIRED — a rewrite with
                      no corpus cannot be verified and is never offered.
  --ext <list>        Corpus extensions to accept (default: every file). e.g. --ext .css
  --export <name>     Named export to analyse instead of the default export.
  --accept <ids>      Comma-separated choice ids accepted as intentionally ungated.
  --source <path>     Grammar source to locate edits in (default: the grammar path).
  --apply             `fix` only. Write the verified edits. Off by default.
  --json[=<path>]     Machine-readable report. With no path it goes to stdout and the
                      human rendering goes to stderr.
  --limit <n>         Findings to expand (default 20).
  --width <n>         Render width. Default: the terminal's when colouring, else 80.
  --no-links          Do not emit clickable file links (OSC-8). Some terminals show
                      the escape sequence as visible junk instead of a link.
  --color/--no-color  Force colour on/off. Default: on only when stdout is a TTY.
  -h, --help          This.

exit codes
  0 clean · 1 blocking findings · 2 could not analyse
$ echo $?  ->  0
```
