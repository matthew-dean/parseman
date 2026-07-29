# `captureTo` Design For Parseman 0.41

`captureTo` is a proposed semantic text-capture combinator for permissive
fallbacks inside otherwise structured grammar regions. It is for places like CSS
custom-property fallback tails, generic at-rule prelude remainders,
selector-ish headers, or dialect extension payloads: the grammar needs to
consume text up to a terminator, respect strings and balanced groups while
looking for that terminator, and return a clean semantic string without turning
comments into grammar nodes or parser-package string scrubbing.

## Problem

`scanTo(sentinel, { skip })` is a delimiter-safe scanner. It answers one
question: "where is the next sentinel that is not inside a skipped region?"

Some grammars also use the returned bytes as semantic source text. That is the
wrong abstraction when trivia is active:

- a skipped comment should not terminate the scan;
- that same comment should not become semantic `Any.src` / custom-value text;
- deleting the comment must not glue adjacent tokens into a different token;
- the root trivia log still has to retain the authored comment for rendering,
  formatting, editor queries, and source maps.

Forcing every grammar to hand-roll segment rules such as `AtPreludeGroup`,
`AtPreludeQuoted`, and `AtPreludeText` solves only one local case and makes the
grammar read like a partial scanner. Those helper rules are implementation
detail; the intended grammar concept is "capture semantic text to this boundary."

This does not mean CSS custom-property values or unknown at-rules should be raw
strings. Both allow unknown CSS tokens, but token-level permissiveness is still
different from flattening the whole region. The grammar should parse known
component-value structure where that is useful, allow unknown tokens where the
spec allows them, and use `captureTo` only for the bounded permissive remainder.
For custom properties, that means trying value-like structure such as `Value`,
`ValueSequence`, and `ValueList` before the fallback. For unknown at-rules, that
means trying prelude component values, declaration-like structures, and
ruleset-like structures where the generic at-rule/block syntax permits them.
The best grammar shape may be one shared value/component grammar with a context
or policy flag that decides whether otherwise-extra tokens are accepted or
reported as errors, rather than a parallel "custom-property value grammar" or
"unknown-at-rule prelude grammar."

## Proposed API

```ts
const prelude = captureTo(sentinel, options?)
```

`captureTo` consumes from the current position up to, but not including, the
first matching sentinel. It returns the captured semantic text as a string. The
parse result span covers the full consumed source range, including trivia that
was excluded from the returned value.

```ts
type CaptureToOptions = {
  opaque?: Combinator<unknown>[]
  groups?: CaptureGroup[]
  /**
   * Compatibility spelling for existing scan-oriented call sites. In the final
   * 0.41 API, prefer `opaque` or `groups` so semantic behavior is explicit.
   * `skip` is a deprecated alias for `opaque`: skipped regions protect sentinels
   * and are appended to the semantic text as authored bytes. It is evaluated
   * after explicit `opaque` entries and before `groups`; it does not inherit
   * `scanTo`'s non-emitting/probe-only behavior.
   */
  skip?: Combinator<unknown>[]
  raw?: boolean
  orEOF?: boolean
  gaps?: CaptureGapPolicy
  trim?: false | 'left' | 'right' | 'both'
}

type CaptureGroup = {
  open: string
  close: string
  opaque?: Combinator<unknown>[]
}

type CaptureGapPolicy =
  | 'preserveWhitespace'
  | 'space'
  | 'drop'
  | {
      whitespace?: 'preserve' | 'space' | 'drop'
      comments?: 'space' | 'drop'
      unknownTrivia?: 'space' | 'drop'
    }
```

Defaults:

```ts
{
  raw: false,
  orEOF: false,
  gaps: 'preserveWhitespace',
  trim: false,
}
```

Default gap behavior:

- whitespace trivia is preserved as authored text;
- comment trivia contributes one ASCII space;
- unlabeled trivia contributes one ASCII space;
- adjacent gap emissions coalesce so `a /* x */   /* y */ b` does not inflate
  into surprising extra spaces unless authored whitespace is explicitly
  preserved between non-comment runs.

The default is intentionally CSS-family friendly: comments separate tokens, but
they are not semantic text. `a/*x*/b` captures as `a b`, not `ab` and not
`a/*x*/b`.

Use `scanTo` for a truly raw byte capture that should include comments.

`makeCaptureTo(defaults)` should mirror `makeWhen` and `makeWord`: grammars can
define one dialect policy once and keep individual call sites small.

```ts
const cssCaptureTo = makeCaptureTo({
  opaque: [customEscape, customDoubleQuoted, customSingleQuoted],
  groups: [
    pair('(', ')'),
    pair('[', ']'),
    pair('{', '}'),
  ],
  gaps: 'preserveWhitespace',
})
```

## Examples

CSS custom property loose fallback:

```ts
const customValueEnd = choice(
  customImportantTail,
  literal(';'),
  literal('}'),
)

const CustomValueFallback = node(
  'CustomValueFallback',
  captureTo(customValueEnd, {
    opaque: [customEscape, customDoubleQuoted, customSingleQuoted],
    groups: [pair('(', ')'), pair('[', ']'), pair('{', '}')],
    trim: 'right',
  }),
  children => any(children[0] ?? ''),
)
```

That is not a statement that custom-property values should be raw strings. CSS
custom properties use the `<declaration-value>` grammar and allow unknown
tokens, while the variables spec requires custom-property values to preserve
authored casing and specified value semantics. A downstream grammar should still
parse CSS-like component values opportunistically where the structure is known
and useful, allow unknown tokens where the grammar is open-ended, then fall back
to `captureTo` for the bounded remainder. Value atoms, value sequences, and value
lists should be the first-class path when they cover the authored value.
`captureTo` is the permissive escape hatch, not the only custom-property value
model.

For example, a dialect parser can make the typed path own the terminator check
and only fall back when the full structured value cannot cover the region:

```ts
const CustomValue = parser(
  { state: { valueMode: 'custom-property' } },
  sequence(g.ValueList, peek(customValueEnd)),
)
```

That shape is illustrative; a real grammar should keep the terminator/list rule
ownership correct and avoid reparsing a value that already matched. The important
part is that the value grammar is reused under a mode that admits custom-property
extra tokens, while ordinary declaration values can reject those same tokens.

Generic CSS at-rule prelude fallback:

```ts
const StatementPrelude = node(
  'StatementPrelude',
  captureTo(choice(literal('{'), literal(';')), {
    opaque: [customEscape, customDoubleQuoted, customSingleQuoted],
    groups: [pair('(', ')'), pair('[', ']')],
    trim: 'both',
  }),
  children => children[0] === '' ? null : any(children[0]),
)
```

The grammar no longer needs public-looking `AtPreludeGroup`,
`AtPreludeQuoted`, or `AtPreludeText` rules. Strings and groups are still
respected, but they are part of the combinator's delimiter-safe lowering.

As with custom properties, this is a fallback shape, not a license to flatten
unknown at-rules wholesale. CSS at-rules share a generic structure: an at-keyword
followed by a prelude and then either a semicolon or a block. Known at-rules
should route through `dispatch()` and parse their own typed tails. The generic
route should parse component-value structure when the grammar can do so without
inventing unsupported semantics, allow unknown tokens in the generic prelude,
and in block contexts opportunistically parse declaration-like and ruleset-like
children before falling back to bounded loose capture.

```ts
const AtRule = dispatch(
  atKeyword,
  atCase('@media', MediaRuleTail),
  atCase('@supports', SupportsRuleTail),
  otherwise(GenericAtRuleTail),
)

const GenericPrelude = parser(
  { state: { componentMode: 'unknown-at-rule-prelude' } },
  sequence(g.ComponentValueList, peek(choice(literal('{'), literal(';')))),
)

const GenericAtRuleBody = choice(
  g.DeclarationList,
  g.RulesetList,
  g.GenericBodyFallback,
)
```

Again, the exact production must preserve list/terminator ownership. The design
point is that `captureTo` should remove raw-scanner boilerplate while still
encouraging grammars to recognize useful CSS structure.

Less ambiguous headers:

```ts
const lessAtPayload = captureTo(choice(literal(';'), literal('{')), {
  opaque: [lessInterpolation, customDoubleQuoted, customSingleQuoted],
  groups: [pair('(', ')'), pair('[', ']')],
  trim: 'both',
})
```

This does not replace `dispatch()` for known openers. It is the fallback for the
opaque tail after routing has already selected the generic branch.

## Semantics

At each position, `captureTo` checks the sentinel first. If it matches, capture
stops and the sentinel is left unconsumed, matching `scanTo`.

If the sentinel does not match, `captureTo` checks effective non-text regions in
this order:

1. ambient trivia, unless `raw`;
2. ambient `scanSkip`, unless `raw`;
3. per-call `opaque`;
4. per-call `groups`.

Trivia skippers are not appended to the returned text. They are converted to a
gap according to `gaps`.

Opaque skippers are appended as authored text. This is for string literals,
escapes, raw URL bodies, interpolation forms whose interior grammar owns its own
semantics, or any region where comments are intentionally part of that region's
source text.

Groups are delimiter-safe and recursively semantic-cleaned. Their delimiters are
appended, their interior is captured using the same trivia policy, and comments
inside the group are excluded from the returned text. This distinction is
load-bearing:

```css
@media (min-width /* comment */ : 50em) {}
```

The prelude text must not contain `/* comment */`, even though the comment lives
inside a parenthesized group. Treating that whole group as an opaque
`balanced('(', ')')` copy would preserve the same bug under a different API.

If no skipper matches, one source character is appended and scanning continues.

`orEOF` follows `scanTo`: EOF succeeds only when explicitly enabled.

`trim` is applied to the returned semantic string only. It does not alter the
parse span, root trivia log, CST node span, or diagnostics.

## CST And AST Capture

`captureTo` should push one CST projection leaf when capture is active. It must
not reuse the ordinary raw leaf contract, where `leaf.value` is expected to equal
`input.slice(span.start, span.end)`. The projection leaf should carry both the
semantic string and the authored source range explicitly:

```ts
{
  _tag: 'projectionLeaf',
  kind: 'captureTo',
  value: semanticText,
  raw: input.slice(start, end),
  span: { start, end },
}
```

The exact tag name can change before implementation, but the contract should not:
ordinary leaves remain raw, while projection leaves say that their value is a
semantic projection. Tools that need authored bytes can use `raw`, slice by span,
or use the root trivia map. AST builders can consume the string directly without
re-scanning or stripping comments.

## Macro Lowering

The interpreter and macro compiler should share the same decision model as
`scanTo`:

- compile the sentinel and skippers as non-capturing probes;
- keep sentinel priority over skippers;
- fold grammar-level trivia and `scanSkip` into the effective skipper list;
- emit a tight while loop with one semantic-string accumulator;
- append raw slices in chunks, not one character at a time, whenever no stopper
  or skipper can start in the current run.

The first release can use the existing `scanTo` loop shape plus chunk marks:

```ts
let text = ''
let chunkStart = pos
while (cur < input.length) {
  if (sentinelAtCur) break
  if (triviaAtCur) {
    text += input.slice(chunkStart, cur)
    text += gapForTrivia(...)
    cur = triviaEnd
    chunkStart = cur
    continue
  }
  if (opaqueAtCur) {
    cur = opaqueEnd
    continue
  }
  if (groupOpenAtCur) {
    text += input.slice(chunkStart, cur)
    const group = captureGroupRecursively(cur)
    if (!group.ok) return group.error
    text += group.text
    cur = group.end
    chunkStart = cur
    continue
  }
  cur++
}
text += input.slice(chunkStart, cur)
```

`captureGroupRecursively` uses the group's close delimiter as its local boundary
and applies the same trivia, opaque, and nested-group policies inside the group.
Sentinels from the outer capture do not terminate inside a group. An unmatched
group is a parse failure unless the call site explicitly opts into a recovery
policy; interpreted and compiled parsers must report the same failure span.

A follow-up optimizer can reuse first-set information from `balanced()` to jump
between possible sentinel/skipper starts. That is an optimization, not a semantic
dependency.

## Diagnostics And Diagrams

Diagnostics should name the sentinel just like `scanTo`; if EOF is reached and
`orEOF` is false, the expected set should be the literal sentinel when available
or `"sentinel"` otherwise.

Railroad and generated specs should render `captureTo(X)` as a bounded capture,
not expand the lowering into quoted/group/text internals. The displayed label
should be concise:

```txt
capture to (";" | "}")
```

If `orEOF` is enabled, the diagram should include EOF as an allowed boundary.

## Tests

Minimum 0.41 tests:

- `captureTo(literal(';'))` returns source text before `;` and leaves `;`
  unconsumed.
- comments do not terminate and do not appear in the returned value;
  `a/*x*/b;` captures `a b`.
- whitespace is preserved by default around comments and between tokens.
- multiple adjacent comments/gaps do not create runaway spaces.
- quoted strings containing sentinels are captured as authored text.
- balanced parens/brackets/braces containing sentinels are captured as authored
  text.
- nested balanced groups preserve delimiter ownership and do not let inner
  sentinels terminate the outer capture.
- unmatched group delimiters produce consistent interpreted and compiled failure
  spans/diagnostics.
- group-local opaque regions protect sentinels and are preserved as authored
  text inside the semantic group projection.
- sentinels inside comments, strings, and groups do not terminate.
- `raw: true` includes comments and ignores ambient trivia/scanSkip.
- `orEOF: true` succeeds at EOF; default fails at EOF.
- interpreted and compiled results are byte-identical.
- macro output contains no runtime `scanTo(` fallback.
- root trivia log still contains skipped comments with correct spans and labels.
- CST capture creates one projection leaf with semantic value and full source
  span.
- railroad/spec generation emits one bounded-capture node.

Jess-driven fixtures:

- CSS custom property: `--x: a/*c*/b;` semantic value `a b`, render can preserve
  comment through trivia.
- CSS unknown at-rule: `@foo a /*c*/ (b; c);` prelude excludes comment and does
  not stop inside parens.
- CSS at-rule block: `@foo a /*c*/ {}` prelude excludes comment, block delimiter
  remains structural.
- Less generic at-rule payload with interpolation and comments.
- Less variable/at-rule ambiguous form where the generic branch uses
  `captureTo` only after dispatch/when has selected it.

## Rejected Shapes

Do not make every grammar spell a segment grammar:

```ts
many(choice(Whitespace, Comment, Quoted, Group, Text))
```

That is exactly the boilerplate this feature should delete. It also tempts
parser authors to promote comments into AST/CST semantic children.

Do not recommend post-processing `scanTo` output with regex replacement. Parser
packages must not re-scan or scrub source strings after Parseman recognition,
and regex scrubbing cannot preserve spans, trivia labels, or nested syntax.

Do not make `captureTo` attach comments to the resulting node. Comments remain
root/document trivia. The returned string is semantic text; the parse span is
only a locator for querying trivia.

Do not use `captureTo` as a replacement for typed grammar where the language has
real structure. Known CSS at-rules, functions, selectors, and declaration lists
should keep their typed Parseman rules and use `dispatch()` where a broad opener
routes to specialized tails.

## Open Questions

- Should the default `gaps` policy require labeled trivia to distinguish
  whitespace from comments? Proposed answer: no. Labels improve fidelity, but
  unlabeled trivia should safely emit one space.
- Should the projection leaf value/span mismatch be exposed as a distinct leaf
  tag? Proposed answer: not initially; document it and add a focused CST test.
- Should `trim` be part of `captureTo`, or should grammars call a tiny
  projection helper? Proposed answer: include it. Left/right trimming is part of
  bounded semantic capture and removes repetitive reducers without hiding CST
  spans.
- Should `captureTo` support returning segments? Proposed answer: not for 0.41.
  A future `captureSegmentsTo` could serve formatters, but the immediate grammar
  simplification needs a string projection plus root trivia.
