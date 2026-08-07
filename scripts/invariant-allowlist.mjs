/**
 * INVARIANT GATE — THE ALLOWLIST, AND THE RATCHET ON IT.
 *
 * Every entry names one exact finding key that `scripts/check-invariants.mjs`
 * produces and states why it is not being fixed. There is deliberately no
 * wildcard syntax and no per-rule blanket.
 *
 * The list used to say "THIS LIST MAY ONLY GET SHORTER" and nothing enforced
 * it. That is how a live finding — `token-alphabet.ts` / `token-scanner.ts`,
 * built-but-never-wired analysis, the sixth instance of that shape in this
 * project — became a permanent accepted state with no owner and no expiry. An
 * entry with neither is a silent decision to never do the work. Two mechanisms
 * now stop that, and both are checked by the gate itself:
 *
 *   1. THE RATCHET. `ALLOW_COUNT` below is the committed entry count and the
 *      gate fails unless `ALLOW.size` equals it EXACTLY. Adding an entry can no
 *      longer hide inside a list: it costs a deliberate edit to a single
 *      numbered line, which a reviewer sees as its own hunk. Removing one costs
 *      the same edit, which is what keeps the ratchet tight instead of leaving
 *      slack that a later commit spends for free.
 *
 *   2. STRUCTURE. Every entry carries a machine-checked `category`, and a
 *      `DEBT` entry carries a `ref`. Free text cannot be checked and so was not
 *      checked; a field can be. `DEBT` entries are PRINTED on every green run —
 *      debt that is never restated is debt that is never paid.
 *
 * The categories, which are the whole point:
 *
 *   RULE-BUG   The rule is wrong and the code is right. The fix is to refine
 *              the rule; the entry leaves when it is refined.
 *   BY-DESIGN  A finished argument. The code is staying in this shape, and the
 *              entry leaves only if the design changes. Not debt.
 *   DEBT       An unfinished obligation. Must be fixed, and must carry a `ref`
 *              naming who owes it.
 *
 * BY-DESIGN and DEBT look identical on the day they are written and could not
 * be more different a year later, which is exactly how the token-alphabet /
 * token-scanner entries failed: a real obligation ("wire into the compiler or
 * delete") that nothing enforced and nothing restated, until it read like the
 * frozen-control entries above it. Debt decays into by-design by neglect, never
 * the other way round. Pick the category honestly; the DEBT list is printed on
 * every run precisely so it cannot quietly stop being debt.
 *
 * The ratchet is a ratchet, not a wall. A legitimate architectural change that
 * retires modules from the export graph raises ALLOW_COUNT in the same commit
 * and the gate goes green — that edit IS the review, which is the point.
 *
 * A stale entry — one whose finding no longer exists — still fails the gate, so
 * an exemption cannot outlive the violation it names and become a standing
 * licence to reintroduce it.
 */

/** The three categories an entry may claim. Anything else fails the gate. */
export const CATEGORIES = /** @type {const} */ (['RULE-BUG', 'BY-DESIGN', 'DEBT'])

/**
 * THE RATCHET. Must equal `ALLOW.size` exactly or the gate fails.
 *
 * Was 18. Two `INV-4` entries left when the analysis helpers they named were
 * deduplicated — `childrenOf` and `intersects` were collapsed into
 * `src/analysis/gating.ts`, imported by the modules that had copies.
 *
 * 13 -> 14 when `src/table/exec.ts` finally became unreachable. It was supposed
 * to be unreachable from `63666b6`; it was not, and INV-3 stayed quiet because
 * two modules were still importing the interpreter by mistake. Removing that
 * import is what surfaced the entry.
 *
 * THAT FIRST NOTE WAS WRONG ABOUT `intersects`, and INV-8 is why we know. It said the
 * helper "now lives once". It did not: `src/combinators/first-set.ts` had been
 * exporting its own `intersects` the whole time, and the dedup lane never saw it
 * because INV-4 decides on byte-identity after whitespace is stripped and the two
 * bodies differed only in whether the nested `for` carried braces. A rule that
 * compares BODIES cannot find a copy that was retyped; a rule that compares NAMES
 * can. `intersects` now genuinely lives once, in `src/combinators/first-set.ts`.
 *
 * 14 -> 28. Three new rules (INV-8/9/10) surfaced 13 findings that previously had
 * no representation at all — not "green", but invisible. Ten are historical prose
 * references (INV-10) that name a deleted file BECAUSE it is deleted, and three are
 * argued name/key collisions. Every one of them is a claim someone can now read,
 * rather than a fact nobody could see. Adding a rule always surfaces a backlog; the
 * backlog is the point.
 *
 * 14 -> 15 -> 14, WITHIN ONE LANE. INV-11 landed and immediately caught a second
 * instance of the shape it was written for: `src/index.ts` published
 * `compileTable` under the second name `compile`. It was entered as DEBT for
 * exactly as long as it took to get an owner ruling on which name survives —
 * `compile`, on the same argument that settled `assembledRules` -> `tableRules`:
 * it names WHAT the thing does, not HOW it currently does it. The declaration
 * was renamed and `compileTable` deleted, so the entry went with it and the
 * count came back down.
 *
 * That round trip is the ratchet behaving correctly, not churn. The count went
 * up because a real finding existed and nobody was licensed to guess at the fix;
 * it came down in the same lane because the fix arrived. DEBT that is paid is
 * the only kind that should ever have been entered.
 *
 * 28 -> 27, AT THE MERGE. The two lanes above met, and one of them paid the
 * other's debt. `lane/shared-definitions` entered the `tableRules` collision as
 * DEBT with `ref: lane/name-collision`; `lane/name-collision` renamed
 * `src/table/exec.ts`'s export to `execRules` and deleted `assembledRules`. Each
 * lane was internally consistent and both merged with the gate green ON THEIR
 * OWN BRANCH — the entry only went stale when the fix and the exemption arrived
 * in the same tree, and nothing but the stale-entry check would have said so.
 *
 * That is the case the check exists for. A DEBT entry naming the lane that owes
 * it is a promise, and this is what it looks like when the promise is kept: the
 * entry does not get to survive the fix.
 */
export const ALLOW_COUNT = 27

/**
 * finding key -> { category, why, ref? }
 * @type {Map<string, { category: string, why: string, ref?: string }>}
 */
export const ALLOW = new Map([
  /* ---- The frozen ablation controls: 5 entries -------------------------
   * `src/table/exec-baseline.ts` and `src/table/encode-baseline.ts` are
   * deliberate FROZEN COPIES of the table driver and encoder, kept alive in
   * process so bench/table-alloc-ablation.ts can measure one change against a
   * same-path control. Nothing imports them outside bench/ (INV-3) and their
   * helpers are byte-identical to the live ones by construction (INV-4) —
   * that IS the control. vitest.config.ts excludes them from coverage for the
   * same reason. All five entries leave when the ablation does. */
  ['INV-3:src/table/exec-baseline.ts',
    { category: 'BY-DESIGN', why: 'frozen ablation control — bench-only by design' }],
  ['INV-3:src/table/encode-baseline.ts',
    { category: 'BY-DESIGN', why: 'frozen ablation control — bench-only by design' }],
  ['INV-4:src/table/exec-baseline.ts:rawEntry|src/table/exec.ts:rawEntry',
    { category: 'BY-DESIGN', why: 'frozen ablation control — identity with the live copy is the control' }],
  ['INV-4:src/table/exec-baseline.ts:trackLines|src/table/exec.ts:trackLines',
    { category: 'BY-DESIGN', why: 'frozen ablation control — identity with the live copy is the control' }],
  // The live copy MOVED from `stamp.ts` to `run-support.ts`, where the emitted
  // engine can call it too. Three copies became two, and the survivor beside the
  // frozen control is now the only one. Same entry, same reason, new path.
  ['INV-4:src/table/exec-baseline.ts:lineCol|src/table/run-support.ts:lineCol',
    { category: 'BY-DESIGN', why: 'frozen ablation control — identity with the live copy is the control' }],

  /* `src/table/exec.ts` is the REFERENCE DRIVER, same category as the two frozen
   * controls above: the bytecode interpreter the closure assembler replaced at
   * `63666b6`, kept in-process because the identity sweep gates the assembler
   * against it and a divergence gets bisected against it. Bench- and test-only,
   * by design.
   *
   * IT SHOULD HAVE BEEN ALLOWLISTED AT `63666b6` AND WAS NOT — because it was
   * still genuinely reachable. That commit edited `src/table/index.ts` alone, and
   * `table/fold.ts` plus (later) `compiler/linker.ts` imported `exec.ts`'s
   * same-named `tableRules` directly, so INV-3 saw a live product path and said
   * nothing. The gate was not wrong; the reachability it measured was real. This
   * entry appearing is the SIGNAL that the last product import is gone, and it
   * must not be deleted to "fix" a future finding — a finding here means
   * something started importing the reference engine again.
   *
   * THE NAME COLLISION ITSELF IS GONE. `exec.ts` now exports `execRules`, so the
   * two engines can no longer be confused by import path, and INV-7 fails any
   * specifier that re-aliases one to the other across src/, test/ and bench/.
   * This entry stays exactly as it is: INV-7 bans the mechanism, this entry
   * records that the reference driver is deliberately unreachable from a
   * published entry, and the two answer different questions. */
  ['INV-3:src/table/exec.ts',
    { category: 'BY-DESIGN', why: 'reference driver — the identity sweep gates the assembler against it; bench/test only' }],

  // INV-1. RULE BUG, not a violation — INV-1 fires on the CORRECT pattern here.
  // This `defineProperty` runs ONCE at module load, on a PROTOTYPE, which is
  // exactly the fix that replaced per-instance installation (measured 42% on a
  // 7-byte parse). INV-1 should exempt module-scope prototype installation;
  // until it does, this entry keeps the gate green. REMOVE IT when the rule is
  // refined.
  ['INV-1:src/functional/run.ts:<module>',
    { category: 'RULE-BUG', why: 'module-scope prototype install is the correct pattern; refine INV-1 to exempt it' }],

  // INV-1. Lazy fuse on the composed rule map: one accessor per rule, once per
  // `composeLeaf()`, so the grammar you actually use is fused on first access
  // and a second conflicting one fails loudly. ARGUED, not debt — see the
  // comment at the site. Listed rather than exempted by a rule carve-out so
  // that if the site changes the entry goes stale and someone must look again.
  ['INV-1:src/compiler/linker.ts:composeLeaf',
    { category: 'BY-DESIGN', why: 'per-compose lazy fuse, not per parse; argued at the site' }],

  // INV-3 x2. The derived-tokenization lane landed its alphabet and scanner
  // before the consumer that reads them. This is precisely the "87 KB of
  // analysis nothing imports" shape, caught this time — the SIXTH instance of
  // it in this project. The entries go when the lane wires them into the
  // compiler or deletes them; a design lane owns which.
  ['INV-3:src/compiler/token-alphabet.ts',
    { category: 'DEBT', why: 'derived-tokenization lane — wire into the compiler or delete', ref: 'docs/design/derived-tokenization.md' }],
  ['INV-3:src/compiler/token-scanner.ts',
    { category: 'DEBT', why: 'derived-tokenization lane — wire into the compiler or delete', ref: 'docs/design/derived-tokenization.md' }],
  // `token-dispatch.ts` is the third module of that same lane. It became visible to
  // INV-3 only when the source lowering was deleted: `token-scanner.ts` imports it, and
  // token-scanner was already unreachable, so this was ALWAYS transitively dead — the
  // deletion did not orphan it, it stopped hiding it. Same lane, same obligation, and
  // it goes when the other two go.
  ['INV-3:src/compiler/token-dispatch.ts',
    { category: 'DEBT', why: 'derived-tokenization lane — wire into the compiler or delete', ref: 'docs/design/derived-tokenization.md' }],


  // INV-5 x3 on `_meta` — `const meta = slot._meta` / `value._meta` is an ALIAS
  // of a combinator's long-lived meta object, and `_meta` is read during
  // interpreted parses. Cold sites (fuse time), so the cost is the shape the
  // object carries afterwards rather than the delete itself. Fix is to assign a
  // fixed absent value, which is available here: these readers test
  // `!== undefined`, not presence. A stated, available fix with nobody assigned
  // to it is exactly what DEBT means; the `ref` points at where the fix is
  // argued, because no lane owns these three yet.
  ['INV-5:src/compiler/linker.ts:repointRef:meta.triviaKindLabels',
    { category: 'DEBT', why: 'delete on an aliased long-lived _meta — assignable to undefined, unlike ctx', ref: 'docs/design/invariant-gate.md#the-allowlist' }],
  ['INV-5:src/compiler/linker.ts:repointRef:meta.disjoint',
    { category: 'DEBT', why: 'delete on an aliased long-lived _meta — assignable to undefined, unlike ctx', ref: 'docs/design/invariant-gate.md#the-allowlist' }],
  ['INV-5:src/compiler/linker.ts:fusePieces:meta.grammarHostMode',
    { category: 'DEBT', why: 'delete on an aliased long-lived _meta — assignable to undefined, unlike ctx', ref: 'docs/design/invariant-gate.md#the-allowlist' }],

  /* ---- INV-8 x2: one name, two declarations ----------------------------
   * The other two findings this rule produced were COLLAPSED rather than listed
   * (`intersects` to `src/combinators/first-set.ts`, `groupDigits` to
   * `src/analysis/terminal.ts`). These two are not collapsible in this lane. */

  // `run` is the PUBLIC entry point and it means two different functions:
  // `parseman` hands out `functional/run-tabled.ts`'s (lowers a combinator entry to
  // a table, then drives), `parseman/run` hands out `functional/run.ts`'s (the bare
  // driver, whose tiny module closure is the whole reason that entry exists and is
  // pinned by test/unit/run-entry-closure.test.ts). Both sites argue for themselves
  // in prose. BY-DESIGN, not DEBT — but recorded here rather than trusted, because
  // this is `tableRules`'s exact shape on a far more used surface, and the argument
  // now has to survive being restated whenever either site moves. If the design ever
  // changes, the entry goes stale and the gate makes someone look again.
  ['INV-8:run:src/functional/run-tabled.ts#run|src/functional/run.ts#run',
    { category: 'BY-DESIGN', why: 'two published entry points, deliberately different drivers; argued at both sites' }],

  // `tableRules` — the finding this rule was built to prove it could see — WAS
  // entered here as DEBT owned by `lane/name-collision`, and that lane paid it.
  // `src/table/exec.ts` now exports `execRules`, `src/table/assemble.ts` exports
  // `tableRules`, and `assembledRules` exists nowhere. The finding stopped being
  // produced, the entry went stale, and the stale-entry check failed the gate on
  // the integration merge — which is the ratchet working exactly as specified:
  // an exemption may not outlive the violation it names.

  /* ---- INV-9 x1 --------------------------------------------------------
   * The other finding was COLLAPSED: `parseman.composedPieces` is now exported as
   * `COMPOSED_PIECES` from `src/compiler/linker.ts` and imported by the plugin. */

  // `Symbol('pm.fail')` is minted in THREE modules — `src/table/exec.ts`,
  // `src/table/assemble.ts` and `src/table/exec-baseline.ts` — so all three hold
  // symbols that are not equal to each other. Safe only because the `TableRule` ABI
  // converts before they cross, which is a property of the boundary and not of the
  // design. The known instance named two of the three; INV-9 found the third.
  ['INV-9:pm.fail',
    { category: 'DEBT', why: 'three private symbols for one sentinel; give it one owner (src/table/cell.ts)', ref: 'exp/mixture' }],

  /* ---- INV-10 x10: prose that names a deleted file BECAUSE it is deleted ----
   * These are the rule's honest limit. INV-10 decides whether a path in a comment
   * resolves; it cannot decide whether the sentence MEANT it to. Every entry below
   * is a historical reference — "`X` is DELETED at HEAD", "salvaged from `X`",
   * "imports from `X` rather than the package entry" — where naming the vanished
   * file is the whole point of the sentence.
   *
   * Listing them is not a shrug. It converts an ambiguous reference into a stated
   * one, and it arms a trap worth arming: if anyone ever re-creates a file named
   * here, the entry goes stale and the gate fails, forcing a re-read of prose that
   * would otherwise have silently started describing a different thing.
   *
   * Nine of the ten point at the source lowering deleted in `37c57b5`. That is the
   * measure of how far one deletion's prose reaches: the twelve references in
   * `src/` were repaired in this commit, and these ten are the ones where the past
   * tense is load-bearing. */
  // Arrived with the 0.47 merge, and it is the GOOD kind of historical reference:
  // the file exists to CORRECT `fixture.ts`'s mislabelled columns, and saying
  // "`src/compiler/codegen.ts` was deleted in 37c57b5" is the correction.
  ['INV-10:bench/jess/capoff-agg.mjs:src/compiler/codegen.ts',
    { category: 'BY-DESIGN', why: 'historical — the sentence exists to state that this file was deleted' }],
  ['INV-10:bench/alloc-model.ts:bench/alloc-profile.ts',
    { category: 'BY-DESIGN', why: 'historical — the sentence says the file existed only for one profiling run' }],
  ['INV-10:bench/jess/ab.ts:src/compiler/codegen.ts',
    { category: 'BY-DESIGN', why: 'historical — the A/B harness explains that HEAD DELETED this and the old side still has it' }],
  ['INV-10:bench/jess/ab.ts:test/parse-bench.mjs',
    { category: 'BY-DESIGN', why: 'historical — names where those files used to live' }],
  ['INV-10:bench/jess/load-one.ts:src/parse-error.ts',
    { category: 'BY-DESIGN', why: 'historical — names the path the loader must NOT point at' }],
  ['INV-10:bench/size-guard.ts:src/compiler/codegen.ts',
    { category: 'BY-DESIGN', why: 'historical — describes what the two-engine size split used to measure' }],
  ['INV-10:test/helpers/eval-macro-module.ts:src/compiler/codegen.ts',
    { category: 'BY-DESIGN', why: 'historical — records why the helper imported the lowering directly' }],
  ['INV-10:test/unit/choice-cost.test.ts:src/compiler/codegen.ts',
    { category: 'BY-DESIGN', why: 'historical — cites the deleted emitter the gating claim came from' }],
  ['INV-10:test/unit/choice-cost.test.ts:test/unit/codegen-output.test.ts',
    { category: 'BY-DESIGN', why: 'historical — names the suite that used to pin emitted output' }],
  ['INV-10:test/unit/first-set-dispatch.test.ts:test/unit/choice-dispatch.test.ts',
    { category: 'BY-DESIGN', why: 'historical — "salvaged from", naming the suite this one replaced' }],
  ['INV-10:test/unit/macro-grammar-coverage.test.ts:src/compiler/codegen.ts',
    { category: 'BY-DESIGN', why: 'historical — records why coverage was imported from the lowering' }],
])
