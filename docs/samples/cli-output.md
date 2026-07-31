# `parseman` CLI — captured output

Every block below is **verbatim**, non-TTY (so colour is off, which is what lands in a
CI log or a file). The command above each block reproduces it from the repository root.
Nothing here was hand-edited.

## 1 — a clean grammar

The rendering people see most. Two lines.
```console
$ parseman diagnose examples/json/parser.ts --export jsonDoc
✓ examples/json/parser.ts — nothing to fix
  1/1 choices gate on first char
$ echo $?  ->  0
```

## 2 — a grammar with real findings, and the second world

`--corpus` adds the measured input side. The per-arm table is the whole idea: the
ordering, each arm's dispatch key, and what it costs, so the fix argues for itself.
Exit code 1 — this is what a CI gate fails on.
```console
$ parseman diagnose examples/css/parser.ts --export Stylesheet --corpus fixtures/css --limit 13
✗ examples/css/parser.ts — 13 blocking findings over 20 choices (6 gate, 1 recoverable)

✗ 13 UNGATED CHOICES
  No first-char dispatch. Every position that reaches these choices enters
  their arms in order until one matches; a gated choice jumps straight to the
  only arm that can.

  AtRuleBlock#1   81 corpus positions can enter it
      arm 0  → literal('(')  '('            0 pos
      arm 1  regex(/[^()]+/) ANY            entered at all 81
  ⚠ arm 1 has an ANY first set — entered at all 81 of these positions

    ╭─[fixtures/css/decls.css:1:1]
  1 │ a {
    │ ╿
    │ ╰── first input arm 1 can start on
    ╰─
    do  this arm leads with a recognizer that can start at ANY character, so
        no first char can skip it. [A]
    ok as-is? { accept: ['AtRuleBlock#1'] }

  AtRuleBlock#2   81 corpus positions can enter it
      arm 0  → literal('[')   '['            0 pos
      arm 1  regex(/[^[\]]+/) ANY            entered at all 81
  ⚠ arm 1 has an ANY first set — entered at all 81 of these positions

    ╭─[fixtures/css/decls.css:1:1]
  1 │ a {
    │ ╿
    │ ╰── first input arm 1 can start on
    ╰─
    do  this arm leads with a recognizer that can start at ANY character, so
        no first char can skip it. [A]
    ok as-is? { accept: ['AtRuleBlock#2'] }

  ComplexSelector   0 corpus positions can enter it
      arm 0  literal('||') '|'            0 pos
      arm 1  literal('>')  '>'            0 pos
      arm 2  literal('+')  '+'            0 pos
      arm 3  literal('~')  '~'            0 pos
      arm 4  literal('|')  '|'            0 pos
      arm[0] ∩ arm[4] overlap on '|'
    do  arms share a first char — left-factor. [B]
    ok as-is? { accept: ['ComplexSelector'] }

  CustomDeclaration#1   81 corpus positions can enter it
      arm 0  → literal('(')  '('            0 pos
      arm 1  regex(/[^()]+/) ANY            entered at all 81
  ⚠ arm 1 has an ANY first set — entered at all 81 of these positions

    ╭─[fixtures/css/decls.css:1:1]
  1 │ a {
    │ ╿
    │ ╰── first input arm 1 can start on
    ╰─
    do  this arm leads with a recognizer that can start at ANY character, so
        no first char can skip it. [A]
    ok as-is? { accept: ['CustomDeclaration#1'] }

  CustomDeclaration#2   81 corpus positions can enter it
      arm 0  → literal('[')   '['            0 pos
      arm 1  regex(/[^[\]]+/) ANY            entered at all 81
  ⚠ arm 1 has an ANY first set — entered at all 81 of these positions

    ╭─[fixtures/css/decls.css:1:1]
  1 │ a {
    │ ╿
    │ ╰── first input arm 1 can start on
    ╰─
    do  this arm leads with a recognizer that can start at ANY character, so
        no first char can skip it. [A]
    ok as-is? { accept: ['CustomDeclaration#2'] }

  CustomDeclaration#3   81 corpus positions can enter it
      arm 0  → literal('{')  '{'            4 pos
      arm 1  regex(/[^{}]+/) ANY            entered at all 81
  ⚠ arm 1 has an ANY first set — entered at all 81 of these positions

    ╭─[fixtures/css/decls.css:1:3]
  1 │ a {
    │   ╿
    │   ╰── arm 0 can start here; arm 1 is entered first
    ╰─
    do  this arm leads with a recognizer that can start at ANY character, so
        no first char can skip it. [A]
    ok as-is? { accept: ['CustomDeclaration#3'] }

  Stylesheet#0   81 corpus positions can enter it
      arm 0  AtRuleBlock     '@'            0 pos
      arm 1  AtRuleStatement '@'            0 pos
      arm 2  Ruleset         '#','*','-'-'… 40 pos
      arm 3  scanTo          ANY            entered at all 81
  ⚠ arm 3 has an ANY first set — entered at all 81 of these positions

    ╭─[fixtures/css/decls.css:1:1]
  1 │ a {
    │ ╿
    │ ╰── arm 2 can start here; arm 3 is entered first
    ╰─
      arm[0] ∩ arm[1] overlap on '@'
    do  a scanTo fallback can start anywhere by definition. [C]
    do  arms share a first char — left-factor. [B]
    ok as-is? { accept: ['Stylesheet#0'] }

  Url   81 corpus positions can enter it
      arm 0  regex(/'(?:[^'\\]|\\.)*'/) '''            0 pos
      arm 1  regex(/"(?:[^"\\]|\\.)*"/) '"'            0 pos
      arm 2  regex(/[^)"'\s]+/)         ANY            entered at all 81
  ⚠ arm 2 has an ANY first set — entered at all 81 of these positions

    ╭─[fixtures/css/decls.css:1:1]
  1 │ a {
    │ ╿
    │ ╰── first input arm 2 can start on
    ╰─
    do  this arm leads with a recognizer that can start at ANY character, so
        no first char can skip it. [A]
    ok as-is? { accept: ['Url'] }

  atRuleBody   42 corpus positions can enter it
      arm 0  AtRuleBlock       '@'            0 pos
      arm 1  AtRuleStatement   '@'            0 pos
      arm 2  Ruleset           '#','*','-'-'… 40 pos
      arm 3  Declaration       '-','A'-'Z','… 34 pos
      arm 4  CustomDeclaration '-'            0 pos
      arm 5  literal(';')      ';'            2 pos
  ⚠ 42 corpus positions can enter this choice

    ╭─[fixtures/css/decls.css:1:1]
  1 │ a {
    │ ╿
    │ ╰── first input arm 2 can start on
    ╰─
      arm[0] ∩ arm[1] overlap on '@'
      arm[2] ∩ arm[3] overlap on '-','A'-'Z','_','a'-'z',\u128-\u65535
      arm[2] ∩ arm[4] overlap on '-'
      arm[3] ∩ arm[4] overlap on '-'
    do  arms share a first char — left-factor. [B]
    ok as-is? { accept: ['atRuleBody'] }

  declarationList#0   81 corpus positions can enter it
      arm 0  Declaration       '-','A'-'Z','… 34 pos
      arm 1  CustomDeclaration '-'            0 pos
      arm 2  Ruleset           '#','*','-'-'… 40 pos
      arm 3  literal(';')      ';'            2 pos
      arm 4  scanTo            ANY            entered at all 81
  ⚠ arm 4 has an ANY first set — entered at all 81 of these positions

    ╭─[fixtures/css/decls.css:1:1]
  1 │ a {
    │ ╿
    │ ╰── arm 0 can start here; arm 4 is entered first
    ╰─
      arm[0] ∩ arm[1] overlap on '-'
      arm[0] ∩ arm[2] overlap on '-','A'-'Z','_','a'-'z',\u128-\u65535
      arm[1] ∩ arm[2] overlap on '-'
    do  a scanTo fallback can start anywhere by definition. [C]
    do  arms share a first char — left-factor. [B]
    ok as-is? { accept: ['declarationList#0'] }

  pseudoArg#0   81 corpus positions can enter it
      arm 0  regex(/even|odd|[-+]?\d*n(?:[  '+','-','0'-'… 6 pos
      arm 1  SelectorList                   '#','*','-'-'… 40 pos
      arm 2  scanTo                         ANY            entered at all 81
  ⚠ arm 2 has an ANY first set — entered at all 81 of these positions

    ╭─[fixtures/css/decls.css:2:6]
  2 │     color: black;
    │      ╿
    │      ╰── arm 0 can start here; arm 2 is entered first
    ╰─
      arm[0] ∩ arm[1] overlap on '-','0'-'9','E','N'-'O','e','n'-'o'
    do  a scanTo fallback can start anywhere by definition. [C]
    do  arms share a first char — left-factor. [B]
    ok as-is? { accept: ['pseudoArg#0'] }

  pseudoArg#1   81 corpus positions can enter it
      arm 0  → literal('(')  '('            0 pos
      arm 1  regex(/[^()]+/) ANY            entered at all 81
  ⚠ arm 1 has an ANY first set — entered at all 81 of these positions

    ╭─[fixtures/css/decls.css:1:1]
  1 │ a {
    │ ╿
    │ ╰── first input arm 1 can start on
    ╰─
    do  this arm leads with a recognizer that can start at ANY character, so
        no first char can skip it. [A]
    ok as-is? { accept: ['pseudoArg#1'] }

  value   81 corpus positions can enter it
      arm 0  Dimension '+','-'-'.','… 0 pos
      arm 1  Num       '+','-'-'.','… 0 pos
      arm 2  Color     '#'            0 pos
      arm 3  Url       'U','u'        1 pos
      arm 4  Call      '-','A'-'Z','… 34 pos
      arm 5  Paren     '('            0 pos
      arm 6  Quoted    '"','''        0 pos
      arm 7  anyValue  ANY            entered at all 81
  ⚠ arm 7 has an ANY first set — entered at all 81 of these positions

    ╭─[fixtures/css/decls.css:3:12]
  3 │     background: white;
    │            ╿
    │            ╰── arm 3 can start here; arm 7 is entered first
    ╰─
      arm[0] ∩ arm[1] overlap on '+','-'-'.','0'-'9'
      arm[0] ∩ arm[4] overlap on '-'
      arm[1] ∩ arm[4] overlap on '-'
      arm[3] ∩ arm[4] overlap on 'U','u'
    do  parseman >=0.32.0 resolves a g.Foo ref first-set at fuse time; if
        still ANY the target rule is itself ungated — analyze it and give it
        a concrete non-nullable lead.
    do  arms share a first char — left-factor. [B]
    ok as-is? { accept: ['value'] }

notes
  A  this arm leads with a recognizer that can start at ANY character, so no
     first char can skip it. Give the arm a concrete leading terminal, or —
     if it is a deliberate catch-all fallback — accept the choice in the
     gating snapshot.
  B  arms share a first char — left-factor. parseman auto-detects the
     sharedPrefix strategy for bare sequences (choice.ts); make the arms
     bare sequences with a common leading terminal, or restructure.
  C  a scanTo fallback can start anywhere by definition. This is usually
     intentional — accept the choice in the gating snapshot so the gate
     stays meaningful for the choices that are not.

  all intentional? paste this and the gate goes green:
    { accept: ['AtRuleBlock#1', 'AtRuleBlock#2', 'ComplexSelector', 'CustomDeclaration#1', 'CustomDeclaration#2', 'CustomDeclaration#3', 'Stylesheet#0', 'Url', 'atRuleBody', 'declarationList#0', 'pseudoArg#0', 'pseudoArg#1', 'value'] }
$ echo $?  ->  1
```

## 3 — `fix`: proposed rewrites, each one PROVEN

Preview is the default; nothing is written. Every rewrite below was applied to the
grammar, the grammar recompiled, the corpus re-parsed on both engines, and the output
compared. A rewrite that moved the output is discarded and never shown.
```console
$ parseman fix examples/lang/parser.ts --export exprParser --corpus examples/lang/corpus
● examples/lang/parser.ts — 3 verified fixes
  verified by re-parsing 3 sample(s) / 64 bytes on interpreted + compiled; output identical
  PREVIEW — nothing was written. Re-run with --apply to write these edits.

ACTIONABLE expr#arm0  keyword-regex
  ℹ anti-patterns 3 → 2

     ╭─[examples/lang/parser.ts:76:7]
  76 │       regex(/if(?!\w)/), g.expr as Combinator<Expr>,
     │       ┖────────┬───────┚
     │                ╰── → word('if', '\w')
     ╰─
  cost    compiled artifact +179 B
  proven  applied, recompiled, 3 sample(s) re-parsed on interpreted + compiled — output identical

ACTIONABLE expr#arm1  keyword-regex
  ℹ anti-patterns 3 → 2

     ╭─[examples/lang/parser.ts:36:3]
  36 │   regex(/true(?!\w)/),
     │   ┖─────────┬────────┚
     │             ╰── → word('true', '\w')
     ╰─
  cost    compiled artifact +144 B
  proven  applied, recompiled, 3 sample(s) re-parsed on interpreted + compiled — output identical

ACTIONABLE expr#arm2  keyword-regex
  ℹ anti-patterns 3 → 2

     ╭─[examples/lang/parser.ts:41:3]
  41 │   regex(/false(?!\w)/),
     │   ┖─────────┬─────────┚
     │             ╰── → word('false', '\w')
     ╰─
  cost    compiled artifact +144 B
  proven  applied, recompiled, 3 sample(s) re-parsed on interpreted + compiled — output identical

$ echo $?  ->  0
```

### 3b — the LOCATED state

A site that is real but cannot be rewritten prints the exact reason, never advice.
Here the grammar source given to `--source` is not the file the sites live in, which is
the ordinary case when a grammar is assembled from helpers in another module.
```console
$ parseman fix examples/lang/parser.ts --export exprParser --corpus examples/lang/corpus --source examples/lang/ast.ts
● examples/lang/parser.ts — 0 verified fixes, 3 located sites with no rewrite
  verified by re-parsing 3 sample(s) / 64 bytes on interpreted + compiled; output identical

LOCATED    expr#arm0  keyword-regex
  site    regex(/if(?!\w)/)
  reason  the rewrite is PROVEN output-neutral, but no occurrence of
          `regex(/if(?!\w)/)` in examples/lang/ast.ts — the site is written
          some other way (a string pattern, a helper, or a shared const) —
          apply it by hand: regex(/if(?!\w)/) → word('if', '\w')

LOCATED    expr#arm1  keyword-regex
  site    regex(/true(?!\w)/)
  reason  the rewrite is PROVEN output-neutral, but no occurrence of
          `regex(/true(?!\w)/)` in examples/lang/ast.ts — the site is
          written some other way (a string pattern, a helper, or a shared
          const) — apply it by hand: regex(/true(?!\w)/) → word('true',
          '\w')

LOCATED    expr#arm2  keyword-regex
  site    regex(/false(?!\w)/)
  reason  the rewrite is PROVEN output-neutral, but no occurrence of
          `regex(/false(?!\w)/)` in examples/lang/ast.ts — the site is
          written some other way (a string pattern, a helper, or a shared
          const) — apply it by hand: regex(/false(?!\w)/) → word('false',
          '\w')

$ echo $?  ->  0
```

## 4 — failing closed

No corpus means no evidence, and an unverified rewrite is not offered. Exit code 2:
"could not measure" is not a pass.
```console
$ parseman fix examples/lang/parser.ts --export exprParser
✗ examples/lang/parser.ts — no fix can be verified
  no corpus supplied — a rewrite cannot be verified, and unverified rewrites
  are not offered
  Nothing is offered: an unverified rewrite is not a fix.
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
$ parseman diagnose examples/css/parser.ts --export Stylesheet --json 2>/dev/null | jq "{schema, ok, summary, first_finding: .findings[0], acceptSnapshot}"
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
      "arm[1] first-set ANY (broad-recognizer): broad recognizer (regex)\nfix: this arm leads with a recognizer that can start at ANY character, so no first char can skip it. Give the arm a concrete leading terminal, or — if it is a deliberate catch-all fallback — accept the choice in the gating snapshot."
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
  "id": "expr#arm0",
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
    "codegenBytesBefore": 44845,
    "codegenBytesAfter": 45024
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
  --color/--no-color  Force colour on/off. Default: on only when stdout is a TTY.
  -h, --help          This.

exit codes
  0 clean · 1 blocking findings · 2 could not analyse
$ echo $?  ->  0
```
