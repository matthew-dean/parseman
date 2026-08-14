/**
 * Opcodes for the TABLE lowering (design ledger row G5).
 *
 * The premise, stated so it can be falsified: today every rule's recognizer is
 * INLINED BESPOKE into its own emitted function, so an artifact pays the full
 * cost of the recognition machinery once PER RULE (measured: ~4.9 kB for a
 * `node()` rule; ~186 B for each additional call site). Emitting a rule as a
 * TABLE ROW interpreted by one shared driver moves that machinery out of the
 * artifact and into the runtime, where it is emitted ONCE for all grammars and
 * all variants.
 *
 * The instruction stream is a flat `number[]`: `code[ip]` is the opcode and the
 * operands follow it inline. Child instructions are referenced by ABSOLUTE code
 * offset, never by nesting, so the driver is a plain recursive read — no node
 * objects, no closures, no per-combinator allocation.
 *
 * Operand layouts are documented per opcode below and are the contract between
 * `encode.ts` and `exec.ts`. Nothing else may read the stream.
 */

/** `LIT k` — `k` indexes a string in the const pool. */
export const OP_LIT = 1
/** `RX k` — `k` indexes a STICKY `RegExp` in the const pool. */
export const OP_RX = 2
/** `SEQ n c1 … cn` — n child offsets; value is the array of their values. */
export const OP_SEQ = 3
/** `SEQV n c1 … cn` — `SEQ` with `valueUnused`: terms run, no tuple is built. */
export const OP_SEQV = 4
/**
 * `CHOICE d n fx c1 … cn` — `d` indexes a dispatch table (or −1 for ordered
 * try); `fx` indexes the choice's OWN expected set.
 *
 * Ordered failure keeps the expected sets at the deepest arm offset, merging
 * exact ties in source order. Exclusive dispatch propagates its sole selected
 * arm. A pure dispatch miss uses `fx`, the static union of every arm opener, so
 * the result never names nothing merely because no arm claimed the lead.
 */
export const OP_CHOICE = 5
/**
 * `REP c min max sep flags fx sepClass` — `sep` is a child offset or −1; `max`
 * −1 = ∞. `fx` is recovery metadata. The last class is the separator sentinel
 * for a separated list, otherwise the finite/non-nullable optional-item class
 * (or −1). `flags` bit 0 = trailing separator allowed, bit 1 =
 * `keepSeparators`, bit 2 = item expected reporting.
 */
export const OP_REP = 6
/** `REPV …` — `REP` with `valueUnused`. */
export const OP_REPV = 7
/** `OPT c` — child, or `null` at the same position. NOT `undefined`: `optional()`
 * yields `null` on no-match (src/combinators/repeat.ts:269,277) and grammars TEST for
 * it — examples/lang's `call` reducer is `if (args === null) return callee`, so
 * `undefined` there turned a bare identifier into a call node with `args: undefined`.
 * The parse succeeded and only the tree moved. */
export const OP_OPT = 8
/** `XFORM f c` — `f` indexes the reducer; called `(value, span)`. */
export const OP_XFORM = 9
/**
 * `NODE b c flags proj type tags` — SEVEN words. `b` indexes the build reducer
 * (−1 = none), `c` is the child offset, `proj` the projected child index (−1 =
 * none), `type` and `tags` index the const pool (`tags` −1 = none).
 *
 * `flags` is a BIT FIELD, not a boolean: bit 0 (`&1`) = grammar-owned explicit
 * `captureTrivia`, bit 1 (`&2`) = a direct builder is proven not to read
 * `rawChildren`, bit 2 (`&4`) = the builder reads
 * `triviaLog`, bit 3 (`&8`) = it reads `ctx.state`, bit 4 (`&16`) = the node has
 * read fields, bit 5 (`&32`) = `collapse`, bit 6 (`&64`) = `unwrap`, bit 7
 * (`&128`) = `trailingTrivia`. Bit 0 distinguishes capture a host may not
 * suppress from a structural node's default capture. Bits 2 and 3 are resolved at ENCODE time
 * from the reducer's declared arity by the same analysis codegen runs, and
 * forced on under `hostMode: 'cst'`. The driver reads the bits and re-derives
 * nothing.
 *
 * TWO ENCODERS SHARE THIS OPCODE and they do NOT agree on its length. The layout
 * above is `encode.ts` / `exec.ts`. `encode-baseline.ts` / `exec-baseline.ts` emit
 * the FOUR-word form `NODE b c flags` with bits 2 and 3 only, and refuse
 * `collapse` / `unwrap` / `project` outright. Neither driver walks the stream by
 * instruction length, so the divergence is contained — but read the pair you are
 * in, not this comment alone. */
export const OP_NODE = 10
/** `RULE r` — `r` indexes `prog.rules`. */
export const OP_RULE = 11
/** `GATE cc c` — first-char gate: `cc` indexes a char class; then run `c`. */
export const OP_GATE = 12
/** `NOT c` — zero-width negative lookahead. */
export const OP_NOT = 13
/**
 * `PEEK c fx` — zero-width positive lookahead. `fx` is the ASSERTION's own set,
 * `['peek(<child tag>)']`, because `peek.ts:60` DISCARDS the body's expectation:
 * a lookahead's failure is "the guard did not hold", not a request for whatever
 * token the body happened to stop on.
 *
 * `encode-baseline.ts` / `exec-baseline.ts` emit and read the two-word form and
 * are internally consistent; read the pair you are in.
 */
export const OP_PEEK = 14
/** `LEAF f c` — `leaf()`: reduce, then record as a spanned leaf. */
export const OP_LEAF = 15
/** `EMPTY` — matches the empty string. */
export const OP_EMPTY = 16
/**
 * Line-tracking twins of `LIT` / `RX` / `NODE`.
 *
 * This is the variant axis, made concrete. `trackLines` picks these rows when
 * the TABLE IS BUILT; the driver holds a case for each and never asks whether
 * line tracking is on. Same driver, different table contents — G5 exactly.
 */
export const OP_LIT_TRACK = 17
export const OP_RX_TRACK = 18
export const OP_NODE_TRACK = 19
/**
 * `SCOPE k c policy` — a policy-bearing `parser({ trivia })` scope.
 *
 * `k` is the scope's trivia COMBINATOR in the const pool. The driver installs it
 * on `ctx.trivia` for the duration and restores the outer one after, which is
 * how the runtime's own `advanceTrivia` fast scanner gets reached — the same
 * shared machinery the interpreter uses, not a second copy of it.
 *
 * `policy` bit 0 suppresses selected root capture for an opaque scope; bit 1
 * refuses an unclassified local scope while selected root capture is active.
 * Synthetic rule-entry and cross-rule restoration scopes have no policy and use
 * the three-word `OP_SCOPE_PLAIN` row below. Keeping the opcodes distinct means
 * a zero policy costs no extra program word without changing this opcode's ABI.
 */
export const OP_SCOPE = 20
/**
 * `EXPECT c e` — `expect()`. Never fails: on a failed child it yields a
 * zero-width `ParseError` value carrying the expected set at `e`.
 */
export const OP_EXPECT = 21
/**
 * `SEQX f n c1 … cn` — a `transform()` whose child is a `sequence()`.
 *
 * `f >= 0` indexes the reducer in `prog.fns`. `f < 0` is the descriptor
 * `~childIndex`: the transform is the exact direct projection
 * `([…, value, …]) => value`, so the row returns that already-parsed child and
 * carries no reducer.  Both forms have the same row width.
 *
 * That pair is the dominant shape in every grammar here (json is nine of them),
 * and running it as two rows costs two switch dispatches and two JS call frames
 * per rule invocation where the emitted code pays neither. Fusing them into one
 * row halves that for the shape that occurs most.
 */
export const OP_SEQX = 22
/**
 * `SCAN s` — the scanning constructs. `s` indexes a `ScanSpec` in `prog.scans`.
 *
 * WAS `OP_CALL k`, which parked the LIVE combinator in the const pool. That ran
 * correctly and made the program unprintable — `emitConst` refuses a live object
 * — so no shipping grammar could be emitted at all: all four jess dialects use
 * `scanTo()`, three of them also `balanced()`. The number is reused because
 * `OP_CALL` has no other user and nothing in the const pool may be a live object
 * any more; that is now an invariant rather than a convention.
 *
 * Neither construct needs a live object. Both are DESCRIBED by data:
 *
 *   `scanTo()`   is a sentinel, an ordered skipper list, and two flags. Sentinel
 *                and skippers are ordinary grammar-graph combinators, so they are
 *                encoded as ordinary table SUBTREES and referenced by offset.
 *   `balanced()` is an open string, a close string, an own-skip list and two
 *                flags. Its `_def` is its EAGER interior (per-call skip only) and
 *                its ambient re-resolution lives on `.parse`, so encoding it from
 *                `_def` builds the wrong parser — the spec carries the
 *                CONSTRUCTOR ARGUMENTS instead, and `balanced()` itself rebuilds.
 *
 * The driver does not re-implement either scan. `resolveTable`'s pool rebuilds
 * each spec with the SHARED constructor (`scanTo`/`balanced`), handing it
 * subtree-backed combinators, exactly as `triviaSpecs` rebuilds trivia with the
 * shared `classifiedTrivia`. So there is one implementation of each, and the
 * table carries only its arguments.
 */
export const OP_SCAN = 23
/**
 * `FIELD k c` — `field(name, parser)`. `k` indexes the NAME in the const pool.
 *
 * Runs the child and, on success, records `{ name, value, span }` into
 * `ctx._fields` for the nearest enclosing `node()` to assemble. The recording is
 * conditional on `ctx._fields` being live, exactly as `src/combinators/map.ts`
 * has it — a field outside any field-reading node costs nothing.
 */
export const OP_FIELD = 24
/**
 * `LIT_CI k fx` — a case-insensitive `literal()`.
 *
 * Its own row rather than a flag on `LIT`, so the hot exact-match path keeps a
 * bare `startsWith`. NOTE it yields the INPUT's casing, not the literal's —
 * `literal.ts:86` returns `input.slice(pos, end)` — so a node built from it
 * carries the source text. Returning the literal would silently normalise case.
 */
export const OP_LIT_CI = 27
/** `LIT_CI_TRACK k fx` — the line-tracking twin of `LIT_CI`. */
export const OP_LIT_CI_TRACK = 28
/**
 * `TOKEN c` — `token()`. Clears trivia AND every capture sink for the child,
 * then contributes ONE leaf spanning the whole match.
 *
 * Was `OP_CALL` (a live combinator in the const pool), which ran correctly but
 * made the table unprintable — `emitConst` refuses non-serialisable entries, so
 * no grammar using `token()` could be emitted as a module. Nothing about it
 * needs a live object: it is save / clear / run / restore / one leaf.
 */
export const OP_TOKEN = 29
/**
 * `SCOPE_CAP k c` — a `parser({ trivia, captureTrivia: true })` scope. Identical
 * operands to `SCOPE`; it additionally sets `ctx.captureTrivia` for the child.
 *
 * A SEPARATE OPCODE rather than a third operand on `SCOPE`, for two reasons.
 * Widening an instruction means every walker that knows its shape has to learn
 * the new one, and there is no central arity table here to change in one place.
 * And the driver should SELECT this piece, not test a flag inside the scope
 * piece — capture is fixed for the whole parse, so it is an assembly decision.
 *
 * The interpreter's equivalent is `grammar.ts:129`:
 * `if (opts.captureTrivia || _ctx?.captureTrivia) ctx.captureTrivia = true`.
 * Note the INHERITANCE — an inner scope does not switch capture back off, which
 * is why this restores the saved value rather than writing `false`.
 */
export const OP_SCOPE_CAP = 30
/**
 * `WITHCTX k c` — `withCtx(extra, c)`. `k` is `extra` in the const pool.
 *
 * SAVE / RESTORE, matching `withCtx.ts`. Both used to CLONE the context, which
 * scoped far more than the state: every scalar the child wrote on `ctx` landed
 * on the clone and died with it, `_fe` / `_fx` included, so a failing `withCtx`
 * subtree contributed nothing to the parent's expected set. That isolation was
 * an implementation detail nobody asked for, not the combinator's contract, so
 * it was fixed at the source rather than mirrored here.
 */
export const OP_WITHCTX = 31
/**
 * `GUARD f e` — `gate(predicate)`. Zero-width: runs `fns[f]` against
 * `ctx.state` and yields `null` at `pos`, or fails with the expected set at `e`.
 *
 * NOT `OP_GATE`, which is the first-CHAR gate — different question, different
 * operand (a char class, not a predicate). The names are close because the
 * combinator was renamed to `gate()` at the API surface while its def tag stayed
 * `guard`; the opcode follows the TAG, since that is what the encoder switches on.
 *
 * Its first set is `any` (a state predicate cannot narrow the input), so a
 * `gate()` leading a choice arm poisons that arm's first-char dispatch. That is
 * a grammar-authoring caveat, not a lowering one.
 */
export const OP_GUARD = 32
/**
 * `ADJ neg kinds fx` — `adjacent()` / `notAdjacent()`. `neg` is 1 for
 * `notAdjacent`, `kinds` indexes the category filter (a `readonly string[]`) in
 * the const pool or is −1, and `fx` is the expected set.
 *
 * A BOUNDARY TEST, NOT A TERM, and that is the whole reason it is its own
 * opcode rather than a zero-width leaf like `OP_GUARD`. It asks whether trivia
 * sat between the PREVIOUS term and here, so it must be evaluated at the
 * sequence cursor — BEFORE the ambient trivia scan that precedes an ordinary
 * non-first term. A piece handed the post-scan position would find the gap
 * already consumed and answer "adjacent" every time, silently: `adjacent()`
 * would become a no-op and `notAdjacent()` a guaranteed failure. So the SEQ
 * pieces read this row at assembly and run the test themselves, exactly as
 * `sequence()` forks `parseAdjacent` (combinators/sequence.ts:118) and as
 * codegen lowers it at the boundary (codegen.ts:1765).
 *
 * Reached as a row in its own right only where there IS no boundary — a bare
 * choice arm, a `node()` body, a repeat item. The interpreter throws there
 * (adjacency.ts) rather than answering a question that was never asked, and so
 * does the driver: same sentence, from `adjacencyMisuse`.
 *
 * The kind filter is resolved against the ACTIVE trivia table at parse time,
 * matching the interpreter — a scope can swap the table, so it is not an
 * assembly-time fact. (Codegen resolves it at COMPILE time and therefore
 * reports an unlabelled table or an unknown category earlier; both engines
 * raise the same `TypeError`, only the moment differs.)
 */
export const OP_ADJ = 33
/**
 * `GREEDY sup n w1 a1 … wn an` — `choice(strategy = greedyClassify)`.
 *
 * NOT a choice. `choice()` auto-selects this strategy (choice.ts:186-202) for the
 * canonical identifier-vs-keyword shape — ONE regex arm that subsumes every other
 * arm, all of which are literals — and it runs a DIFFERENT execution, not a
 * different arm order: the regex arm runs, and then the match is RE-ATTRIBUTED by
 * string equality to a literal arm, whose transform chain is what produces the
 * value (choice.ts:124-136). Encoding it as an ordered `OP_CHOICE` would let the
 * regex arm win every time; the parse would still succeed and only the VALUE and
 * the tree would move. So it gets its own row.
 *
 * `sup` is the super arm's offset, `n` the number of classified literals, and
 * each pair is `(const-pool index of the literal string, that arm's offset)`.
 *
 * The literal arm is RE-RUN at `pos` rather than having its transform chain
 * applied to a known value, and the two are the same thing here: the classified
 * word IS the arm's literal, so `literal()` re-matches at `pos` over exactly
 * `[pos, END)` and every transform then sees the same `(value, span)` pair the
 * interpreter's `applyTransforms` passes. `getCoreLiteralValue` admits only a
 * case-SENSITIVE literal under `transform` wrappers, so the re-run cannot fail
 * and cannot land at a different end. What it does do is push a SECOND CST leaf,
 * which is why the capture sinks are rolled back to the pre-`sup` mark first —
 * leaving exactly one leaf, with the same text and span the interpreter's kept
 * regex leaf has.
 *
 * On a failed `sup` the failure propagates VERBATIM (the regex's own expected
 * set), not the union of the arms — choice.ts:126 returns `superResult` itself,
 * and codegen's `emitGreedyClassify` reports `deriveExpected(superParser)`.
 */
export const OP_GREEDY = 34
/**
 * `REJECT c n t1 o1 … tn on` — one choice arm plus its `autoNot` checks.
 *
 * `autoNot` is the OTHER thing `choice()` computes on its own (choice.ts:55,
 * 325-346): for a literal arm, the inline lookahead that a LATER arm — a longer
 * literal with this one as a prefix, or a regex that subsumes it — would have
 * consumed more. It runs AFTER the arm has already succeeded and can still
 * reject it, so a matched arm loses and a later arm wins (choice.ts:160-164).
 * Ignoring it lowers `if` out of `iffy` and the parse still succeeds.
 *
 * `c` is the arm's offset; each check is a pair `(kind, operand)` — kind 0 is
 * `startsWith`, operand a const-pool string; kind 1 is `firstSet`, operand a
 * char-class index. Both are tested at the arm's END, mirroring `autoNotFires`.
 *
 * Rejection returns `FAIL` and CLEARS `_fc`, because the interpreter's rejection
 * is a `continue` — "pretend this arm was never entered" — whereas an ordinary
 * failing arm's committed flag cuts the whole choice. The enclosing choice does
 * the capture-sink rollback, exactly as it does for a failing arm.
 *
 * A site with any `autoNot` can never take the O(1) first-char dispatch: a check
 * exists only when a later arm shares the arm's leading character, so those two
 * arms' classes intersect and `resolveDispatch` reports the site non-exclusive.
 */
export const OP_REJECT = 35
/**
 * `ARMGATE f c e` — one choice arm plus its PER-ARM state gate,
 * `choice({ gate, combinator })`. `f` indexes the predicate in `prog.fns`, `c` is
 * the arm's offset, and `e` is the arm's own expected set.
 *
 * NOT `OP_GUARD`, and the difference is the entire reason the option exists.
 * `gate()` is a zero-width TERM whose first set is `any`, so leading an arm with
 * one replaces that arm's first set and collapses the whole choice from O(1)
 * first-char dispatch to the ordered `firstMatch` loop (docs/guide/
 * first-char-gating.md lists that as a known gating defect). This row wraps the
 * arm INSTEAD of sitting inside it, so the encoder still reads the arm's own
 * first set for `disp` and the site keeps its dispatch slot.
 *
 * A blocked arm is SKIPPED, not failed — `choice.ts:150` is `continue`. The row
 * therefore clears `_fc` on the gate-false path exactly as `OP_REJECT` does:
 * "pretend this arm was never entered", so no cut it might have raised survives
 * to cut the choice. It still reports `e`, because the OTHER path a blocked arm
 * can be reached by is first-char dispatch, where skip-and-retry and
 * fail-the-choice are the same thing (choice.ts:23-34, :100-105) and the
 * interpreter answers with `deriveExpected(arm)` — this set.
 *
 * The predicate is a live function, like `OP_GUARD`'s, so a grammar using one is
 * runtime-only for `emitTableModule` unless `fnSources` are supplied.
 */
export const OP_ARMGATE = 36
/**
 * `LIVE f` — RUN A HAND-WRITTEN COMBINATOR through its own `.parse`. `f` indexes
 * the combinator in `prog.fns`.
 *
 * NOT the old `OP_CALL` (numbers 23 and 29 both record having been it): that row
 * parked live combinators for `scanTo`/`balanced`/`token` in the CONST pool, and
 * the fix was to describe those constructs AS DATA, which they are. This is the
 * opposite case and the only one left: `Combinator` is a PUBLIC interface, so a
 * caller can hand `compile()` a parser whose `_def.tag` no encoder will ever
 * know. There is nothing to describe — the behaviour lives in a closure the
 * library never sees.
 *
 * It exists because codegen accepts exactly this and delegates at run time
 * (`compiler/codegen.ts`, `emitRuntimeFallback`'s `_rp[i].parse(...)` row). The
 * encoder used to throw `UnsupportedConstruct`, so the table lowering REJECTED
 * grammars the source lowering compiles, and the two lowerings must accept the
 * same language.
 *
 * The cost is stated, not hidden: a live combinator is not data, so a program
 * holding one is `runtimeOnly` — it runs, and `emitTableModule` refuses to print
 * it BY NAME. Codegen degrades identically (a non-empty `runtimeParsers` makes
 * `inlineExpression` null). It never appears for a construct the library itself
 * builds; reaching it means the encoder met a foreign `_def`.
 *
 * The child result is the real interpreter's, so `expected`/`span` propagate
 * verbatim and its `committed` flag is copied into `_fc`, as codegen's does.
 */
export const OP_LIVE = 37
/**
 * `ATTEMPT c` — `attempt()`, the transactional ordered-choice arm.
 *
 * WAS A TRANSPARENT WRAPPER (`case 'attempt': return this.node(d.parser).ip`),
 * which is correct for exactly one placement — an arm of an `OP_CHOICE`, whose
 * per-arm loop already saves and restores the eight capture sinks. Anywhere else
 * — a `sequence()` term, a repeat item, a `node()` body — a failed transaction
 * left its CST leaves, raw children, fields, recovery diagnostics and trivia-log
 * entries behind, and reported the failure at the INNER position rather than
 * re-anchored at the transaction's entry. Both are `attempt()`'s whole contract
 * (`combinators/attempt.ts`), not a choice-arm detail.
 *
 * One child operand and no expected-set operand: on a non-committed inner
 * failure the row keeps the inner's `_fx` VERBATIM and only re-anchors `_fe` to
 * `pos`, exactly as `attempt.ts` returns `{ expected: result.expected, span:
 * { start: pos, end: pos } }`. A committed failure propagates untouched — the
 * rollback still happens, the re-anchor does not.
 *
 * The interpreter's first-set fail-fast guard is NOT lowered. It is an
 * optimisation that reports `deriveExpected(parser)` in place of the start-fail
 * the inner would have produced; running the inner produces that set for real,
 * so the row is behaviourally the guard's post-condition without the second
 * definition of what the inner expects.
 */
export const OP_ATTEMPT = 38
/**
 * `LABEL c fx` — `label(name, parser)`. `fx` is the one-element set `[name]`.
 *
 * WAS A TRANSPARENT WRAPPER, and a label is not transparent: `map.ts:84` returns
 * `{ expected: [name], span: result.span }` on a failed child, i.e. it REPLACES
 * the child's expected set and keeps the child's span. Dropping the row dropped
 * the whole point of the combinator — a table lowering reported
 * `['/[a-z]+/']` where the grammar had said `label('identifier', …)`, so every
 * labelled diagnostic in every grammar regressed to raw regex source.
 *
 * `_fe` IS NOT TOUCHED, deliberately: `label()` keeps `result.span`, so the
 * failure stays where the child put it.
 */
export const OP_LABEL = 39
/**
 * `COV c id on` — A GRAMMAR-COVERAGE COUNTER SITE. Emitted ONLY into a table
 * encoded with `TableSettings.coverage`; an ordinary table contains no such row,
 * which is why turning coverage off costs an ordinary build exactly zero bytes.
 *
 * `c` is the wrapped child's offset — deliberately at `ip + 1`, the slot every
 * other single-child wrapper uses, so `collapseIndirection`, `inspect.ts` and
 * `exec.ts` each gain this opcode by adding it to an existing `case` list rather
 * than by growing a new shape. `id` indexes `prog.cov`, the definition pool.
 *
 * `on` is 0 for ENTRY and 1 for SUCCESS, and it is read at ASSEMBLY TIME, never
 * per parse: `assemble.ts` picks one of two closures from it, exactly as it picks
 * pieces from `RunCfg`. The two phases are not decoration — the source lowering
 * credits a RULE on entry (`codegen.ts:4529`) and a choice arm, dispatch arm or
 * label only once it has SUCCEEDED, and a table that credited all four alike
 * would report a different denominator's worth of hits than the engine it is a
 * drop-in for.
 *
 * THE ROW IS WHY THIS IS NOT A SIDE TABLE keyed by code offset. `encode.ts`
 * memoises by combinator IDENTITY, so one `g.X` reference object that is an arm
 * of three different choices is ONE row — and an offset→id map would have to
 * credit all three arms whenever any one of them ran. A wrapper row is per SITE,
 * which is the granularity the IDs are minted at.
 */
export const OP_COV = 40
/**
 * `SCOPE_PLAIN k c` — a synthetic zero-policy ambient-trivia scope.
 *
 * This is the same scanner/context swap as `OP_SCOPE`, with policy fixed to
 * zero at assembly. `encodeRule()` uses it for a rule entry and `scopedRef()`
 * for the lexical-trivia restoration around a reference reached from
 * `noTrivia()`. Neither row represents an authored `parser()` scope, so neither
 * can be opaque or require the unclassified-scope refusal.
 *
 * A separate opcode is load-bearing: treating a three-word synthetic row as the
 * four-word `OP_SCOPE` makes the following row's opcode become the policy bits.
 */
export const OP_SCOPE_PLAIN = 41
/**
 * `LEX_BODY b fx suffixFx` — one compiler-selected childless lexical replacement
 * body. `b` indexes `prog.lex`; `fx` is the exact base-recognizer failure set;
 * `suffixFx` is optional()'s swallowed literal failure publication.
 *
 * There is deliberately no child operand and no mode bit. The complete
 * CHARACTER and TOKEN candidates were compared before serialization; this row
 * is only the winning TOKEN body. A program without a selected TOKEN body has
 * no row or lexical pool.
 */
/** `LEX_BODY body fx suffixFx lineFlags` — selected childless lexical body.
 * lineFlags bit 0 publishes the regex range; bit 1 publishes a matched suffix. */
export const OP_LEX_BODY = 42
/** `LEX_PROGRAM p` — selected fixed composite lexical body, childless. */
export const OP_LEX_PROGRAM = 43
/**
 * `DISPATCH sel d other otherRouted n a1 … an` — `dispatch()`.
 *
 * `sel` is the selector's offset, `d` indexes a dispatch table in `prog.dsp`,
 * `other` is the `otherwise()` offset (or −1), `otherRouted` is 1 when the
 * fallback consumes the routed token, and `a1…an` are the arm offsets. Arm
 * `usesRouted` bits live in the `dsp` entry beside the key maps.
 *
 * The selector runs ONCE; the key it returns picks the arm. That is the whole
 * point of `dispatch()` over a `choice()` of arms that each re-parse the opener.
 */
export const OP_DISPATCH = 25
/**
 * `ROUTED fallback` — `routed()`. Yields the token the enclosing `dispatch()`
 * already consumed, so the selected branch can own it. `fallback` is an offset
 * or −1; it runs when there is no routed token at this position.
 */
export const OP_ROUTED = 26

export const OP_NAMES: Record<number, string> = {
  [OP_LIT]: 'LIT', [OP_RX]: 'RX', [OP_SEQ]: 'SEQ', [OP_SEQV]: 'SEQV',
  [OP_CHOICE]: 'CHOICE', [OP_REP]: 'REP', [OP_REPV]: 'REPV', [OP_OPT]: 'OPT',
  [OP_XFORM]: 'XFORM', [OP_NODE]: 'NODE', [OP_RULE]: 'RULE', [OP_GATE]: 'GATE',
  [OP_NOT]: 'NOT', [OP_PEEK]: 'PEEK', [OP_LEAF]: 'LEAF', [OP_EMPTY]: 'EMPTY',
  [OP_LIT_TRACK]: 'LIT_TRACK', [OP_RX_TRACK]: 'RX_TRACK', [OP_NODE_TRACK]: 'NODE_TRACK',
  [OP_SCOPE]: 'SCOPE', [OP_EXPECT]: 'EXPECT', [OP_SEQX]: 'SEQX', [OP_SCAN]: 'SCAN',
  [OP_FIELD]: 'FIELD', [OP_LIT_CI]: 'LIT_CI', [OP_LIT_CI_TRACK]: 'LIT_CI_TRACK', [OP_DISPATCH]: 'DISPATCH', [OP_ROUTED]: 'ROUTED',
  [OP_TOKEN]: 'TOKEN', [OP_SCOPE_CAP]: 'SCOPE_CAP', [OP_WITHCTX]: 'WITHCTX', [OP_GUARD]: 'GUARD',
  [OP_ADJ]: 'ADJ',
  [OP_GREEDY]: 'GREEDY', [OP_REJECT]: 'REJECT', [OP_ARMGATE]: 'ARMGATE',
  [OP_LIVE]: 'LIVE', [OP_ATTEMPT]: 'ATTEMPT', [OP_LABEL]: 'LABEL', [OP_COV]: 'COV',
  [OP_SCOPE_PLAIN]: 'SCOPE_PLAIN',
  [OP_LEX_BODY]: 'LEX_BODY',
  [OP_LEX_PROGRAM]: 'LEX_PROGRAM',
}
