# Deferred: escape-aware ident run (§8k) — the CSS/Less/SCSS/Jess hot path

**Status: DEFERRED (owner-sanctioned). Not implemented.**

This is the ONE un-lowered regex category that would actually move CSS parse
time — every selector and property name goes through it. The `/i` keyword
lowering (§8d) and the alt/keyword `switch`-dispatch that DID ship do NOT move
real CSS parse time (measured: bootstrap4.css ≈ 7ms, unchanged) because
keyword/at-rule regexes are a tiny fraction of a stylesheet; **idents dominate.**

The pattern (css/less/scss/jess `ident`, `basicSel`, `propName`) is a run whose
every position is a class char OR a CSS escape (`-￿` written literally):

```
-?(?:[_a-zA-Z-￿]|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n]))
  (?:[-_a-zA-Z0-9-￿]|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n]))*
```

`parseSeqParts` declines it: the `(?:[class]|\\<esc>)` alternation isn't a plain
`run`. It CANNOT be split in the grammar — a no-escape fast arm would match a
prefix of `foo\41 bar` and corrupt the parse — so it needs a parseman feature.

## Precise design (implement later; differential-test HARD before trusting)

1. Add `escapes?: boolean` to the `run` SeqPart:
   `{ part: 'run', ranges, negated, min, unbounded, escapes }`.

2. In `parseSeqParts`' `(?:…)` group handler, recognize a two-arm alternation
   `[class] | \\<escSpec>` where `<escSpec>` is exactly
   `[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n]` (the CSS escape). Emit a `run` with
   `escapes: true` + the class ranges, honoring a trailing `*`/`+`/`?` (ident =
   head `min1 bounded` + tail `*`).

3. In the `run` emitter, when `escapes` is set, the scan loop also consumes an
   escape:

   ```js
   while (e < len) {
     const c = input.charCodeAt(e)
     if (/* c in ranges */) { e++; continue }
     if (c === 92 && e + 1 < len && input.charCodeAt(e + 1) !== 10) { // '\' + non-newline
       e++
       if (/* isHex(charCodeAt(e)) */) {          // 1–6 hex + optional 1 whitespace
         let h = 0
         while (h < 6 && e < len && /* isHex */) { e++; h++ }
         if (e < len && /* isWs */) e++
       } else {
         e++                                        // one non-newline char
       }
       continue
     }
     break                                          // '\' at EOF or '\'+newline → escape can't match; stop
   }
   ```

   Ordered-alt note: the regex tries the hex arm first, but `[^\n]` also matches
   hex — equivalent, because "1–6 hex greedy, then optional single ws" and the
   single-char arm never both apply to the same `\x`.

4. `trailingBacktrackClass` for an `escapes` run: its right-edge wiggle is the
   union of the class ranges AND the escape-lead `\` (92), so a trailing
   lookahead over it must account for `\` (or decline). These grammars put no
   trailing lookahead on idents, so a conservative `'unsupported'` there is fine
   initially.

## Differential-test inputs (must match `RegExp.exec` exactly)

`foo`, `-x`, `a\41 b`, `\26 B`, `x\g`, `end\`, `\\`, a `\`+newline, a leading
digit (`3px` — must NOT match ident), and mixed BMP / non-BMP.

## Payoff

Lowers `ident` / `basicSel` / `propName` in css/less/scss/jess — the actual CSS
parse hot path — unlike everything lowered so far. Also enables lowering the
number regex (`§8l`, similar bounded-quantifier + trailing-lookahead work) and,
optionally, the `@(?:media|…)` prefix-distribution and hex `{3,8}` (both cold, so
low priority).
