# Left-corner routing: the step-2 design

Status: partly built. The closure engine routes, from routes the encoder stores in the
program (`src/table/routes.ts`; see [What is built](#what-is-built)). The reference and emitted
readers, the statement corner and the pre-scan deletions are not built yet. The prototype
this is drawn from is the closure-engine study on branch `perf/left-corner-routing`,
measured in [Performance attempts](../future/perf-attempts.md) ("Left-corner routing
(accepted direction, prototype)" and "Less declarations above the value"). This document
describes what step 2 builds from it.

## What it does

A value, a statement or any other construct that sits under several nested levels starts,
at every level, at the same position and with the same piece: its left corner. Today each
level opens its frame, scope and gates on the way down, and each level's continuation is
tried and fails on the way back up.

Left-corner routing:

1. **Parses the corner once.** The character at the position, together with facts the
   encoder already lays down, picks the route: which levels to enter, and the deepest node
   to call.
2. **Routes on the next token.** After the corner, each level's continuation is decided on
   the next token. That token is either a **captured** token (one the grammar consumes as
   part of a continuation) or a **skipped** token (one the active scope's trivia skips).
   Which of the two it is comes from that scope's trivia definition, never from the
   character. Whitespace is captured where the scope has no trivia (a `noTrivia` scope, an
   `optional(<regex>)` gap, an `OP_GAPGATE` pad), and skipped where the trivia skips it.
   A gap is read once, and its end is handed to the term that reads it next.
3. **Completes a level whose continuation cannot start** as its reducer on the lone child.
   Its frame is never opened.
4. **Resumes a level whose continuation can start** by opening only the frame it skipped,
   with the value already in hand, and running the level's continuation from the corner's
   end. Nothing above it is entered again.

The output is byte-identical: values, spans, CSTs, trivia logs, errors and expected sets.

## Route rows: one table, four engines

The routes are derived at encode time from the table's own rows. They are stored as data
beside `code`, as `prog.routes`, and every engine reads the same rows. The node rows stay as
they are. A program without routes runs as it does today.

**The route index.** For each node site that tops a route, the index holds:

- a 129-entry map from the character (ASCII, plus one slot for "any non-ASCII") to a route
  number, or to "none";
- the route records, packed like `code`: flat integers, with indices into the existing
  pools (`k`, `cc`, `fx`, `fns`, the trivia array).

**A route record** is a list of levels, followed by its atom. A level is one of:

- a node, carrying its completion variant: plain, children-only, children-only with
  fields, collapse, children-only collapse, generic, or pass-through. These are the
  variants the node row already selects.
- a scope or a `withCtx` level, carrying the context it installs;
- a gate;
- a choice the character dispatches to one arm. Where several arms claim the character
  and all but one are pretested, the level also carries the guard: the pretest terminals
  whose match cuts the route back.
- a sequence, carrying its leading zero-width or decided-empty terms, its left-corner
  index, and its continuation descriptors;
- a repeat of `min: 1`, carrying its separator or item descriptor.

**A continuation decision** is one mask per sequence or repeat level: the characters its
continuation can start with, after the gap, derived when routes are derived from the rows
that run it:

- `optional` behind a gate: the gate's class;
- a repeat with an item class: that class (`OP_REP` ip+7);
- a repeat whose item opens with an `OP_GAPGATE` gap and has no item class: the gap's lead,
  the follow class and the other-arm class;
- a repeat whose item opens with `optional(<regex>)` and has no item class: every character,
  because its row reports the failure;
- a separator: its gate class, where the repeat row gates it.

A character outside the mask completes the level with each term's empty value, also derived.
A character inside it enters the row's own lowering, seeded with the corner, and the row
makes the rest of the decision. Nothing is decided twice and nothing about a term's kind is
read at parse time. The mask may hold more than the row can start with, but it must hold
every character on which the row would act, a report included.

Any other continuation (a separator the repeat does not gate, a gate that must match, a
term with no decidable start) has no mask: the level always enters its row. A level that
would always resume at the route's top drops the route for that character.

**The atom** is a node site, a routed token (inside an arm of a `dispatch()`), or a
`dispatch()`. A dispatch atom carries, for each arm, that arm's own route.

**Cuts.** A route can be cut back to a shallower depth on the current position, where a
guarded choice's pretest matches. The cut is a depth and the route to that depth. It is
decided before anything is entered. Trivia the labels cannot name before a leading
lookahead is decided when routes are derived: a character that may start any of the table's
trivia stops the route above that sequence.

### How each engine reads it

- **Reference (`exec.ts`).** Interprets the route rows directly: a descent loop over the
  levels, the atom, then an ascent loop. This is the definition of route semantics and the
  identity oracle for the other two table engines.
- **Closure engine (`assemble.ts`).** Links each route into a chain of closures when it
  assembles. Each level is a closure over the next level's, and a level that only routes
  (a gate already decided, a rule reference, an identity scope) adds none. A route-top
  site's piece reads its route map and calls the node's ordinary body where a character has
  no route; any other node site is its body, with no route read. The collector suppression
  (descendants publish nothing while their parents complete alone) is owned by the route's
  run, not by the node.
- **Emitted engine (`emit-assembly.ts`).** For a selected site, emits the same chain as
  straight-line code from the same rows. Selection prices a route-top site as its route
  plus its fallback body.
- **Interpreter (`compose()`).** Ruled: it does not route. It stays unrouted, as the
  semantic reference. The owner's words were "even the interpreter with a proper routing
  table could do this, not just a 'compiled' grammar". The ruling reads that as saying the
  mechanism is not compile-only, not as requiring that the interpreter route. Two reasons:
  - Routing the interpreter would need a second analysis over combinators, a parallel
    implementation. The route analysis is defined once, over table rows.
  - The identity sweeps need the interpreter as an unmodified oracle. 0.59.0's five review
    rounds showed how much.

  `compose()` also stays the pure interpreter path with zero build cost (see
  [Runtime and size contract](runtime-and-size-contract.md)). The owner may override this.

### What is built

The closure engine reads routes; the reference and emitted readers do not yet.

- **Routes are stored in the program (`prog.routes`).** The encoder derives them for an AST
  table without line tracking and stores them; nothing is derived when a table is loaded.
  What linking needs (the tops) is stored as numbers; the routes themselves are one JSON text, parsed the first time a route is built.
  A fold carries a variant's routes on its delta where they differ from the base's, because
  they are read from the code the fold overwrites. An artifact with a selective assembly
  does not print them, because nothing in it reads them.
- **A cold assembly's first parse is unrouted.** The tops are armed when the assembly's
  first parse completes (a top linked later is armed when it is linked); a route's chain is
  built the first time a character reaches it, and a continuation is lowered the first time
  it resumes. Building chains and compiling their pieces costs more than a route saves
  within one cold parse (`benchmark.less`: +3.5 ms on a 61 ms first parse when routes ran
  from the start), so the first parse runs today's pieces.
- **A node that tops no route keeps a piece with no route read.** Which sites are tops is
  decided when the site is linked, so a non-top pays nothing. A character with no route at a
  top pays the table read and one call to the node's body.

- **A parse that records trivia does not route.** Routes don't write the trivia logs
  (`_triviaLog`, `_rootTriviaLog`), so the entry selects, once per parse, an assembly with
  no routes for a parse that carries one (`RunCfg.logged`). It is not part of `cfgKey`: an
  emitted factory serves both. Jess passes `rootTrivia` on every parse, so until routes
  write the root log, Jess's parses do not route at any budget.
- **A late frame is a node level.** A route enters the node row under an `OP_CONT` at its
  corner like any other node's, and a route that stops there calls the `OP_CONT`. A
  continuation's first test is read by `continuationGate`, the late frame's own reading.

An assembly with a precompiled emitted assembly (`HYBRID`) does not route yet, so CSS,
built with `assemblyBudget` 1, is unrouted in production until the emitted reader lands.

## Lexical corner factoring (statement level)

At a Less statement that starts with an identifier, three arms claim the character:

- `FunctionStatement`, whose `dispatch()` selector is the `genericFunctionOpen` token;
- the guarded ruleset, whose guard is followed by the selector;
- `DeclarationItem`, which reaches the property token.

Each first token is a different `token()`, lowered to its own opaque `OP_LEX_PROGRAM` row,
so nothing at table level shows that they share anything. In the combinator graph they do:

- `genericFunctionOpen` is `token(noTrivia(sequence(not(<url( or calc(>), cssIdentifier, '(')))`;
- `lessDeclarationProperty` is `token(noTrivia(sequence(optional('*'), cssIdentifier)))`.

Both begin with the same `cssIdentifier` combinator.

So the factoring runs in the encoder, before tokens are lowered:

1. For a choice whose claiming arms' first tokens are each `pre_i, X, post_i`, the shared
   corner is `X`, the same combinator in every arm. Each `pre_i` must be zero-width or
   decided empty on the current character.
2. Lower `X` once, as the corner row.
3. Lower each arm's first token as a **resumable token**: given the corner's end, it runs
   only `post_i` and produces the token's value and span as the whole token would.
4. Give each arm a two-character lead set for what follows the corner: `post_i`'s, then the
   arm's continuation, with the scope's skipped tokens. This is the same derivation
   `OP_RGATE2` already uses.
5. The route reads `X`, then tries in arm order only the arms whose lead set admits the next
   one or two characters. Each arm resumes its token from the corner's end, and the arm's
   node completes or resumes as in any route.

This is also the derivation of `dispatch()` from `choice()` (see below). Jess's
hand-written version of it is [jess#515](https://github.com/jesscss/jess/pull/515), and it
is the benchmark (see the bar below).

## How a resume opens only the skipped frames

A route knows which frames it skipped: every level between the atom and the level whose
continuation can start. When a continuation can start at level *i*:

1. Find the nearest framed node *h* above *i*.
2. If *h*'s collector is not open yet, open it in place, as *h*'s own piece would: a
   capture buffer, or a children array for the children-only variants. Publish the value
   in hand into it, once, with its raw entry.
3. Run level *i*'s continuation from the corner's end:
   - for a sequence, its later terms, as its own runner runs them;
   - for a repeat, the loop from its second item;
   - with the gap already read handed over (the gap slot, or the trivia scan's end).
4. A later level between *i* and *h* that also resumes runs its continuation into the same
   collector and publishes nothing a second time.
5. Node *h* completes from the collector, exactly as its piece reads one.

Levels above *h* are untouched: they are still open in the route and complete as usual.
A resume therefore costs the continuation and one frame, which is what the plain path pays
for the same input.

## What deletes

- **The prototype's driver and wrapper** (`PM_LC`, the per-route entry, the collector save
  and restore around every route call, and the debug and plant switches). The route rows
  and the per-engine readers replace them.
- **Mirrored writes.** Re-proved on step 2's base (a planted `throw` in each branch, all
  four dialects, 11.5k inputs):
  - the separator-miss branch never runs: every Jess list's separator is gated. It is
    deleted, and an ungated separator now makes its level resume, so the separator's own
    piece reports its failure. This is correct by construction on any grammar.
  - the gate-fail branch runs on 32 Less inputs, always on a matching character; its miss
    never runs. It is deleted the same way: a gate that must match makes its level resume.
  - the `optional`-gap write runs (53 CSS inputs) and stays. Deleting it changes nothing on
    any sweep or on the value-ladder test (`table-left-corner-routes.test.ts`), because the
    write is a soft failure on a path that succeeds: every reader of the failure slots is a
    choice's failure handler, and an arm that fails writes its own failure after it. It is
    the same write the plain path's item makes, so it stays as the plain path's mirror.
- **The grammar pre-scans, once the statement corner lands:** the guarded ruleset's
  `/[-\w]+[ \t]*:[ \t\n\r\f]/` and the interpolated head arm's `peek(/[^:;{}]*[@$]\{/)`.
  Removing either one changes no tree, error or position on the 1316 Less inputs. They
  exist only for speed, and routing supplies that.
- **jess#515** closes once the generic version meets or beats it.

## Acceptance bar

Measured against `main` after 0.59.0, interleaved, with marginal instructions, JIT and
`--jitless`, an A/A null, and no V8 or Node flags:

- **Identity** on all four dialects and all four variants: values, spans, CSTs, trivia logs,
  errors and expected sets. Every mirrored write either has a planted defect the sweep
  catches, or is deleted as unreachable.
- **Whole files** faster in both modes in all four dialects, and at least as fast as the
  prototype's step-1b numbers. Re-measure `benchmark.css`, bootstrap JIT and
  `benchmark.less` `--jitless` with enough runs to separate noise; if the dip from 1b to 1c
  is real, find the change that caused it.
- **Every construct no slower than its null under `--jitless`.** That includes
  `font: 12px/1.5 a, b;` in CSS and `.jess`, `grid-area: 1 / 2 / 3;`,
  `border-radius: a / b;`, and nested `div:hover{}`. Per jess `docs/perf/BENCHMARKS.md`
  §8, a per-construct JIT reading within ±5% is not a verdict on its own.
- **No route cost for a character with no route:** no wrapper and no extra call on that
  path.
- **Collector suppression owned by the top node.**
- **The statement corner matches or beats jess#515 plus routes.** On the prototype that was
  −11.3% (`benchmark.less`) and −11.6% (bootstrap) `--jitless`, and −17.4% `--jitless` on
  `a{color: red;}`. The two grammar pre-scans are deleted, with identity on all four
  dialects.
- **Each grammar compiles to no more than 5× its source**
  ([Runtime and size contract](runtime-and-size-contract.md)).

## `dispatch()`

A route through `dispatch()` already beats the hand-written dispatch: on the prototype,
Less `color: red;` dropped from 278k to 257k `--jitless`. But it still reads the dispatch's
spec, its exact keys and its prefix and suffix matchers.

The open question is whether that spec can be derived from a plain `choice()`'s arms (their
shared identifier corner, the literals that follow it, and the next token) so that authors
need not write `dispatch()`. Lexical corner factoring is that derivation for the statement
case.

Removing `dispatch()` is not part of step 2. It stays the author API. What step 2 produces
is the evidence: whether the derived routing reaches the hand-written dispatch's efficiency
on Jess's dispatch sites.

## Dependencies on 0.59.0

The design relies only on what the narrowed 0.59.0 keeps:

- `OP_GAPGATE`, for the gap term's mask;
- the repeat item class (`OP_REP` ip+7), for the repeat term's mask;
- the operator gate;
- `OP_RGATE2`'s two-character derivation, for the statement corner's lead sets.

Two things it must not depend on:

- **Choice classes.** A route's choice level dispatches exactly as the choice row does, by
  reading the same dispatch table the encoder wrote. It does not depend on how narrow the
  arm classes are. With 0.58-level classes, fewer characters reach a single arm, so fewer
  routes pass a choice: that costs speed, never correctness.
- **Recovery.** Routes are built only for strict assemblies. Tolerant, probe, coverage and
  line-tracking assemblies keep today's pieces.

If the separator gate does not survive the narrowing, the separator-miss write becomes
reachable again. It then stays as a mirrored write with a targeted test, not as a deletion.
