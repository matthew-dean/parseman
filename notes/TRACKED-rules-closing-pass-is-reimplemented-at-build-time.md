# TRACKED — `rules()`'s closing pass is reimplemented at build time

**Status:** the drift that has already happened is FIXED and GATED. The
structural collapse that would make it impossible is NOT done, deliberately, and
this is the note for whoever takes it.

**Landed:** `lane/macro-lowering`, `86b78fe` (fix) and `b4a7d1d` (gate), over
`6747872`.

## What is actually wrong

`rules()` (`src/combinators/parser.ts`) and `evaluateParserFactory`
(`src/plugin/evaluator.ts`) are two implementations of one job: take a factory
over a `g` proxy, mint a ref per key, evaluate, define each slot, hand back the
rule map. One runs at runtime, one at build time, and both feed the SAME encoder
— `encodeTable` is one line over `encodeTableProgram`, so there is no second
encoder for them to diverge through. Everything downstream is shared. The only
thing that can differ is the MAP, and nothing asserted the two produce the same
one.

They had diverged, in a way that cost ~29% on `benchmark.less` on the path every
consumer ships:

- `evaluateParserFactory` never ran `rules()`'s closing `markUnusedValues`
  (`parser.ts:246-249`). Nothing else sets `valueUnused`, and `encode.ts:748`
  / `:895` branch on it directly, so the shipped artifact carried 326
  tuple-building `SEQ` rows against 8 and 110 array-building `REP` rows against
  20 on jess's less grammar — 318 sequence tuples and 90 repeat arrays built per
  execution that nothing reads.

The fix for THAT pass is already the right shape: the evaluator now calls the
same `markUnusedValues` `rules()` calls, rather than reimplementing it. What is
missing is anything that forces the next pass added to `rules()` to reach the
evaluator too.

## What a shared `finalizeRuleMap()` would have to reconcile

This is why it was not done in the same change, and it is the real content of
this note. `rules()`'s closing sequence is, in order:

1. **`hostMode` stamp** — writes `_meta.grammarHostMode = 'cst'` on every
   non-trivia rule, and only for `'cst'` (`'ast'` is the default and stamping it
   would put a field on every rule of every grammar to say "unchanged").
2. **`trackLines` stamp AND wrap** — sets `_meta.grammarTrackLines`, then
   REPLACES each non-trivia, non-`grammar` rule with a `grammarParser({
   trackLines: true }, rule)` wrapper. This one MUTATES THE MAP, not just the
   metadata.
3. **`markUnusedValues`** per rule.
4. **`RULE_ORDER`** — a non-enumerable record of the factory's declaration order,
   because `cache`'s own key order is reference-creation order, a Proxy artifact.
5. **`attachGrammarReflection`**.

The obstacle is (1) and (2). On the RUNTIME route those arrive as `rules()`
options and are applied here. On the MACRO route they arrive as `TableSettings`
and are applied somewhere else entirely — `compile-rule-map.ts`'s `applyAmbient`
and `resolveHostMode`/`resolveTrackLines`, reading either an explicit option or a
stamp left on the rules. That is not an accident of style: the macro passes no
compile options and the stamp is the only channel it has, which
`resolveHostMode`'s own comment says outright.

So a shared closing pass has to answer:

- **Where does the trackLines WRAP happen for a macro build?** Today it does not
  — the setting rides to the encoder instead. A shared pass that wraps would
  either double-wrap the macro route or have to be told not to, and "told not to"
  is a flag, which is the thing being removed.
- **Is the stamp or the setting authoritative?** `resolveHostMode` currently
  prefers the explicit option and falls back to the stamp. A shared pass that
  writes the stamp makes those two the same channel, which is probably the right
  end state but changes what a `composeLeaf` map whose pieces legitimately
  disagree resolves to (`applyAmbient` only fills a GAP, on purpose).
- **`RULE_ORDER` and reflection** are already computed on both routes by
  different code (`collectGrammarReflection` is called from both), so those two
  are the cheap half and could move first.

The honest read is that (3), (4) and (5) collapse easily and (1)+(2) are a real
design decision about whether stamps or settings are the single channel. Doing
the cheap half alone would leave the expensive half looking done, which is worse
than the current state.

## What holds the line until then

`test/unit/encode-route-agreement.test.ts`. One grammar source per case,
macro-transformed on one leg and evaluated with the real combinators on the
other, asserting the two encode to the same program — reachable opcode
histogram, char-class pool, and the gating summary (`openArms`, `exclusive`).

It compares those and NOT the raw code stream on purpose: the two routes lay
rules out in different orders and always have, so word-for-word identity would go
red for something nobody claims is a defect. Every quantity it compares is
order-independent, and every one of them moved under both defects.

It fails on unmodified `6747872` for two independent reasons and passes a third
case that neither defect can touch, so a red is the defect rather than an
artefact of comparing two routes at all.

A gate is second-best to impossible-by-construction. It does buy the durable
property — a future pass added to `rules()` and not to the evaluator goes red —
which is the actual recurrence risk, and it is why this is tracked rather than
open.
