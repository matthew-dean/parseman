# Parseman grammar authoring — rules for LLM agents

Crisp, machine-readable rules for writing FAST, CORRECT parseman grammars. These
target the mistakes LLMs actually make (pattern-matched from other parsers). The
build enforces most of them: `compile()` emits a gating WARNING by default when you
break a rule below. Read the warning; it names the arm and the fix.

Full docs: `docs/guide/first-char-gating.md`, `docs/guide/combinators.md`,
`docs/guide/context.md`.

## Before opening or updating a code PR

Run the local CI preflight and report its result before creating or pushing a
code PR:

```sh
pnpm typecheck && pnpm lint && pnpm check:invariants && pnpm check:differentials && pnpm test:coverage && pnpm coverage:guard && pnpm test && pnpm build && npm pack --dry-run && pnpm docs:verify
```

`check:invariants` decides five source-level rules that no type or test can
see: no accessor installed onto an already-built object, no field in a public
`*Options` type that nothing reads, no module unreachable from a published
entry point, no declaration body duplicated across modules, and no `delete` on
an object the enclosing function did not construct (a `delete` on a long-lived
object flips `%HasFastProperties` to false permanently — a `delete` on a scratch
local is fine and deliberately not flagged). It is a required CI
step and a pre-commit guard.

Its allowlist lives in `scripts/invariant-allowlist.mjs` and MAY ONLY GET
SHORTER — adding an entry to unblock new code is the failure it exists to stop.
That is now mechanical, not aspirational. `ALLOW_COUNT` is the committed entry
count and the gate fails unless the list matches it exactly, so adding an entry
costs a deliberate edit to one numbered line instead of hiding as one more line
in a list. Every entry must declare a category — `RULE-BUG` (the rule is wrong,
the code is right), `BY-DESIGN` (permanent and argued), or `DEBT` (must be
fixed, and must name a `ref` that owns the fix) — and a stale entry still fails
the gate. Outstanding `DEBT` is printed on every run, green ones included. See
`docs/design/invariant-gate.md`.

## A differential that has never been shown to fail is not evidence

Do not report a number from a sweep, oracle, identity check or A/B until you have
made that instrument go RED on purpose. A vacuous harness does not look broken —
it prints a clean, plausible, self-consistent number in exactly the shape you
expected. Six defects shipped through a fully green 3300-test suite in one day
this way. The modes, each with the instance that shipped:

- **Both legs the same engine.** `bench/jess/fixture.ts` builds every leg at
  HEAD, so a "table vs codegen" run through it was table-vs-table: 1.09×,
  reported as release quality.
- **A leg that throws identically on every row.** A `cst` table refuses to run
  without a build host, so a hostless `cst` leg was 87/87 identical `threw:`
  rows — and two dead legs agree perfectly. Three harnesses had this.
- **A success predicate that means "did not throw".** `!row.startsWith('threw:')`
  printed `parse ok: true` for a parse that read 218 bytes of 287,543 and ranked
  it a 200× speedup.
- **An option that selects a different artifact.** `tolerant` decides WHICH TABLE
  is built, so `run(entry, input)` with no options never realises the tolerant
  assembly; a before/after of a recovery change was guaranteed to show zero.
- **A result dominated by an artifact of the harness** — leg count changing V8
  inlining, leg order, output paths, a dirty working tree.
- **An import that reaches past the shipped export.** A sweep imported
  `tableRules` from `exec.ts` while the shipped name is `assembledRules`, and
  gated a driver nothing ships.

Two standing obligations:

- **Every harness prints what engine each leg ran and the resolved `realpath` of
  its source, before any number.** Three harnesses labelled a table as `codegen`
  this cycle.
- **`consumed` is `unconsumedFrom ?? bytes`** — a FAILED parse records the full
  byte count. Never read it without `ok`. That misreading has already happened.

`pnpm check:differentials` plants a real defect in `src/` and requires each
registered differential to catch it (`--list` for the registry and each entry's
contract, `--strict` for a release). Adding a differential means adding its
plant. Full standard, including how to register one and what the gate
deliberately does not check: `docs/design/differential-gates.md`.

If your change touches `src/codegen.ts`, dispatch, or anything else on the parse
hot path, also check it against the comparison-chart bar — **"still the fastest
compiled JS parser in the SVG tests"** — before claiming a trade-off is
acceptable:

```sh
pnpm bench:margin -- --charts graphql     # or the chart your change moves
```

It exits non-zero if any competitor overtakes Parséman, and prints an in-run A/A
control so you can tell a real shift from this box's noise. Getting *slower than
a previous Parséman is fine* if the margin holds — read `bench/MARGIN.md` for
what the numbers mean and how much headroom each bar actually has.

`coverage:guard` is a blocking ratchet, not an optional report. If it fails,
add tests for the changed behavior; do not regenerate the baseline merely to
make a PR green. Do not claim CI is green until the pushed head SHA has its own
completed checks. For a docs-only change, run the smallest applicable checks
and state what was intentionally not run.

## The one rule that matters most: every hot `choice` must first-char-gate

A `choice` compiles to O(1) character dispatch ONLY when every arm starts with a
disjoint, finite set of first characters. Otherwise it degrades to ordered
first-match: every input position speculatively enters each arm. This is correct
but slow, and nothing but the build warning tells you.

## DO

- Use `word('kw', boundary)` or `keywords([...], { boundary })` for keywords.
  They have an EXACT first-set and gate. `word('color', '-\\w')`, not
  `regex(/color/)`.
- For an ASCII case-insensitive keyword (CSS at-keywords, function names, units —
  case-insensitive PER SPEC), pass the option:
  `word('media', 'A-Za-z0-9_-', { caseInsensitive: true })`, never `regex(/media/i)`.
  Its first-set is ASCII case-FOLDED, so the arm still gates.
- A separated list of ONE OR MORE is `oneOrMoreSep(item, sep)`, **not** `sepBy`.
  Plain `sepBy` is `(item (sep item)*)?` — it MATCHES THE EMPTY STRING, which makes
  the arm nullable and kills the whole choice's dispatch. Reach for `sepBy` only
  when the empty list is genuinely legal.
- Need a positive lookahead? `peek(X)` — zero-width, and it CARRIES X's first-set,
  so `sequence(peek(regex(/[.#]/)), broadThing)` still first-char-dispatches.
- Use `literal('...')` for fixed punctuation/operators with no word boundary.
- Let each `choice` arm LEAD with a concrete terminal (`literal`/`word`/`keywords`/
  a narrow `regex`). First-char dispatch is then automatic.
- When alternatives first recognize the SAME broad token family and then branch
  by the value that came back, use `dispatch(combinator, when(...),
  otherwise(...))`. The combinator parses once; `when()` routes exact values or
  matchers; `routed()` lets the selected branch own the already-consumed
  value/span in its node. This is the canonical shape for identifier-or-function,
  at-keyword, pseudo, contextual keyword, and dialect-extension splits.
- To pick a branch by runtime context, use the gated-arm FIELD:
  `choice({ gate: s => cond, combinator: arm }, other)`. It keeps dispatch.
- Left-factor arms that share a leading terminal: make them bare `sequence`s with
  the same first term (parseman auto-detects `sharedPrefix`), or restructure.
- Accept a deliberately non-gating choice (e.g. one with a `scanTo` recovery
  fallback) by listing its reported `id` in the gating snapshot allowlist
  (`diagnoseGrammar(g, { accept: ['<id>'] })`) — the single suppression
  mechanism. Prefer fixing the gating over accepting it.
- Use `gate(predicate)` (the ASSERT combinator) only AFTER a concrete leading
  terminal inside a `sequence`, never as a leading arm term.

## DON'T

- DON'T use `regex(/keyword/)` for a keyword → use `word()`/`keywords()`.
  (Warning: `anti-pattern [keyword-regex]`.)
- DON'T write `choice(specialThing, genericThing, keywordThing)` when those arms
  all start by parsing the same opener shape. That is speculative parsing in
  disguise. Factor the opener into `dispatch(...)`, then route with `when(...)`
  and `otherwise(...)`.
- DON'T hand-roll first-char gating with `not(not(...))`. It miscompiles among
  shared-first-char sibling arms and its first-set is `any`. First-char gating is
  automatic; just lead with the terminal — and where a real positive lookahead IS
  needed, use **`peek(X)`**, which is zero-width like `not(not(X))` but carries X's
  first-set instead of poisoning dispatch. (Warning: `anti-pattern [double-not]`.)
- DON'T lead a `choice` arm with `not(...)`. `not()`'s first-set is `any` and
  poisons the whole choice's dispatch. Keep `not(...)` as a TRAILING boundary
  (`sequence(literal('true'), not(/\w/))`). (Warning: `anti-pattern [leading-not]`.)
- DON'T lead a `choice` arm with `optional`/`many`/`gate`/`guard`/plain `sepBy` —
  all are NULLABLE and widen the first-set. Put a concrete terminal first, or use
  the non-nullable form (`many(x, { min: 1 })` / `oneOrMore`, `oneOrMoreSep`).
- DON'T put a leaf-only "fast path" arm ahead of a structured one that builds the
  SAME `node()` type. On every input both accept, the fast path wins and yields
  that node over bare leaves — the parse succeeds, the span is right, the text
  round-trips, and only the TREE moved, so no test and no output diff reports it.
  Either the structured tree is the contract (delete the fast arm) or the flat one
  is (make it flat for every input of that shape). (Warning:
  `BUG [structure-loss]`, from `analyzeDuplication`.)
- DON'T wrap a spaced region in `noTrivia` and hand-roll `optional(ws)` back in to
  exclude comments. `noTrivia` clears trivia, so a matched `regex(/\s+/)` is
  CONTENT — the whitespace lands in the node's children as a value leaf. An inner
  trivia scope says it in one place: `parser({ trivia: wsOnly }, …)` (innermost
  wins). Reach for `noTrivia` only for a genuinely GLUED run.
- DON'T reach for `ctx.state` (`withCtx`/`gate`) when structure (separate rules),
  a document option, or recursion/`balanced` would express the distinction. See
  `docs/guide/context.md` § "Which tool".

## The two lookaheads

Both are zero-width — they assert and consume nothing.

- **`not(X)`** — NEGATIVE lookahead (PEG `!X`). Succeeds when X does NOT match.
  Its first-set is `any` (it cannot know what it forbids), so keep it as a TRAILING
  boundary, never leading an arm.
- **`peek(X)`** — POSITIVE lookahead (PEG `&X`). Succeeds when X DOES match. It
  carries X's first-set, so a LEADING `peek()` is fine — it narrows the arm's first
  chars instead of widening them. (A nullable X constrains nothing and reports
  `any`.)

## The four repetition combinators

Named combinators are sugar for the common option combinations. Opts are LAST on
all four; `min`/`max` count ITEMS, and `trailing` is separated-only (it is
meaningless without a separator).

| | nullable (min 0) | non-empty (min 1) |
|---|---|---|
| plain | `many(item, opts?)` | `oneOrMore(item, opts?)` |
| separated | `sepBy(item, sep, opts?)` | `oneOrMoreSep(item, sep, opts?)` |

- `oneOrMore(x)` **is** `many(x, { min: 1 })`; `oneOrMoreSep(i, s)` **is**
  `sepBy(i, s, { min: 1 })` — the same combinator, not a lookalike.
- `{ min: n }` is what makes a repeat NON-NULLABLE, which is what lets an arm led
  by it gate. `{ max: n }` never affects nullability.
- `{ trailing: 'forbid' | 'allow' }` (default `'forbid'`) decides what happens to a
  separator with no item after it: leave it for the enclosing rule, or consume it.
  There is deliberately no "require a separator after EVERY item" mode — that is not
  a separated list (n separators for n items, not n-1). Spell it
  `many(sequence(item, term))`.

## Naming

- `gate(predicate)` is the state-assertion combinator (formerly `guard()`, kept as
  a deprecated alias). Its name matches the `gate:` field on a gated choice arm:
  **arm field = SELECT a branch; `gate()` combinator = ASSERT a predicate.**

## Where the options object goes

**Opts go FIRST when they configure a SCOPE; LAST when they modify THIS
combinator.**

- Scope (opts first): `rules(opts, factory)`, `parser(opts, root)`. The config
  governs everything inside, so it reads as a preamble.
- Local (opts last): `literal(v, opts?)`, `word(s, boundary?, opts?)`,
  `keywords(words, opts?)`, `scanTo(sentinel, opts?)`, `balanced(open, close,
  opts?)`, `node(c, build?, opts?)`, `many`/`oneOrMore`/`sepBy`/`oneOrMoreSep`.
  Note `node` puts opts AFTER its `build` callback — "callbacks trail" is not the
  rule; scope-vs-local is.

Practical test for a new signature: **does omitting the opts still leave a sensible
call?** If yes → trailing sugar, opts last. If the config is the point of the
wrapper → opts first.

## How to check your grammar

```ts
import { diagnoseGrammar, formatGrammarDiagnosis } from 'parseman'
const d = diagnoseGrammar(myGrammar)   // combinator, rules() map, or compose() result
if (!d.ok) { console.error(formatGrammarDiagnosis(d).join('\n')); process.exit(1) }
// d.ok = every hot choice gates AND the whole grammar was actually examined.
```

Compiling reports NOTHING — `compile()` / `compileRuleMap()` / `compose()` produce an
artifact and stay silent. Diagnosing is a deliberate call. `d.ok` is false for any
ungated hot choice whose `id` is not in `{ accept: [...] }`, for any anti-pattern, and
for any part of the grammar that could not be examined — it fails CLOSED, so it is
usable directly as a CI exit code.
