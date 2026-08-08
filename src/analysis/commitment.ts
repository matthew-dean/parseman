/**
 * COMMITMENT ANALYSIS — where a construct can still fail after it has consumed
 * input or dirtied the capture buffers.
 *
 * This is a whole-grammar property of the rule graph, and it has exactly two
 * consumers: the compiler, which bakes the decisions into the emitted source,
 * and the interpreter, which must reach the SAME decisions at load time. It
 * lives here, in one module, for that reason. Two hand-written copies of a
 * predicate like `mayFail` would drift, and a drift here is not a size
 * regression — it is the compiled and interpreted parsers accepting different
 * languages. One module, two consumers.
 *
 * Every predicate in this file is a sound OVER-approximation of "something can
 * go wrong": each MUST err toward `true`. A `false` is a proof obligation
 * discharged on the caller's behalf, and callers delete code on the strength of
 * it. Elide only where non-failure is PROVEN; when in doubt, say `true` and keep
 * the machinery.
 */
import type { Combinator, ParserDef } from '../types.ts'
import { regexCanMatchEmpty } from '../regex/first-set.ts'
import { childrenOf } from './gating.ts'

/**
 * Can `p` FAIL at all?
 *
 * `false` needs a construct whose definition is total: the empty literal,
 * trivia (a scan of width 0 is a match), and the repeats — but the repeats only
 * conditionally, see below.
 *
 * Everything else stays `true`, including two cases that look elidable and are
 * not. A `choice` whose last arm is infallible is NOT infallible, because
 * first-set gating decides at runtime which arms are entered at all and the
 * total arm may be skipped. And a re-entered cycle is `true` rather than
 * `false`: a recursive rule's own fallibility is exactly what the recursion is
 * being asked about, so the safe fixpoint seed is the conservative one.
 *
 * TODO(0.47): `expect` is conservative here. It converts its inner parser's
 * failure into a zero-width success carrying a parse-error node and therefore
 * never fails, but it currently reports its inner parser's fallibility. Making
 * it `false` would elide further; it needs its own pass through the tree-diff
 * gate first, because `expect` sits at exactly the closing-delimiter positions
 * where a wrong answer is most visible.
 */
export function mayFail(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return true
  seen.add(p)
  const d = p._def as ParserDef
  switch (d.tag) {
    case 'literal':   return d.value.length > 0
    case 'trivia':    return false
    // `optional`/`many`/a min-0 `sepBy` swallow an ORDINARY failure — zero
    // repetitions is a match. They do NOT swallow a COMMITTED one: a dispatch
    // that has selected an arm and then failed inside it breaks out past every
    // enclosing repeat, straight to the fallible boundary. So these are total
    // exactly when their body cannot commit. (Measured: treating them as
    // unconditionally total left an extra zero-width leaf in
    // `BareInterpolatedSelector` on benchmark.less — a rollback the legacy
    // build fired and this one had deleted.)
    case 'optional':
    case 'many':      return mayCommitFailure(d.parser)
    case 'sepBy':     return d.min >= 1
      ? mayFail(d.parser, seen)
      : mayCommitFailure(d.parser) || mayCommitFailure(d.separator)
    case 'oneOrMore': return mayFail(d.parser, seen)
    case 'sequence':  return d.parsers.some(x => mayFail(x, seen))
    // Delegating wrappers: as fallible as what they wrap.
    case 'node':
    case 'transform':
    case 'label':
    case 'field':
    case 'expect':
    case 'withCtx':
    case 'grammar':
    case 'token':
    case 'leaf':      return mayFail(d.parser, seen)
    case 'lazy':      { try { return mayFail(d.thunk(), seen) } catch { return true } }
    // An adjacency assertion is a TEST — failing is its whole job.
    case 'adjacency': return true
    default:          return true
  }
}

/**
 * Does this regex source consume at least one character on every match?
 *
 * `exec('')` alone is NOT this test, and the difference is not academic. A pure
 * lookahead like `/(?=[ \t\n\r\f]*(?:[,{]))/` — the Less grammar's
 * `bareInterpolatedSelectorEnd` — never matches the EMPTY STRING (there is no
 * `,` or `{` to look at) yet matches ZERO-WIDTH wherever it succeeds. Reading
 * `exec('') === null` as "always consumes" put an extra empty leaf inside
 * `BareInterpolatedSelector` on benchmark.less.
 *
 * So the test is in two parts. A pattern built only from character-consuming
 * constructs is position-INdependent: if it can match ε anywhere it can match ε
 * in `''`, which `exec('')` detects. The constructs that break that equivalence
 * — matching zero-width at a position inside a string but not at position 0 of
 * `''` — are exactly lookaround and the word boundaries; `^`/`$` still match in
 * `''`. Reject those syntactically and `exec('')` covers the rest.
 */
function regexAlwaysConsumes(source: string): boolean {
  // STRUCTURAL, not a probe. The previous form rejected any pattern CONTAINING a
  // lookaround and then asked `new RegExp(source).exec('')`. Both halves were
  // imprecise in the same direction:
  //   - the blanket lookaround test fails a pattern whose lookaround is buried
  //     inside mandatory content — `/\/\*(?:[^*]|\*(?!\/))*\*\//` must consume
  //     `/*` and cannot match empty, yet was reported nullable;
  //   - `exec('')` cannot see a pattern that matches zero-width only at a
  //     NON-empty position, which is why the blanket test had to exist.
  // `regexCanMatchEmpty` walks the same AST `firstSetFromRegex` uses, where
  // anchors, lookaround and word boundaries are already `EMPTY`, so it answers
  // both cases correctly and neither guard is needed.
  return !regexCanMatchEmpty(source)
}

/**
 * Does `p`, WHEN IT SUCCEEDS, always consume at least one character?
 *
 * The mirror of `mayFail`, and the opposite polarity from
 * `first-set.ts`'s `matchesEmpty`: this one MUST err toward `false`. A `true`
 * is a proof that the success path advanced the position, and the sequence
 * emitter deletes a trivia rewind on the strength of it.
 *
 * It cannot be written as `!matchesEmpty(p)`. `matchesEmpty` answers a
 * first-set question and is allowed to under-report nullability; for `expect`
 * it does, and that case is exactly the one that matters here. `expect(X)`
 * turns X's FAILURE into a zero-width SUCCESS carrying a parse-error node —
 * so `expect(literal('}'))` succeeds having consumed nothing, while
 * `matchesEmpty` looks through to the non-nullable literal and says "always
 * consumes". Eliding on that answer moves a rule's span end past trailing
 * trivia (measured: 38 tree mismatches across the css corpus, spans absorbing
 * whitespace their legacy build excluded). `recover` manufactures the same
 * zero-width success, and both are `false` here.
 *
 * `dispatch` is `false` rather than deferring to its selector: the selector's
 * consumption is not unconditionally part of the dispatch's own span, and the
 * few bytes are not worth the proof obligation.
 */
export function alwaysConsumes(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def as ParserDef
  switch (d.tag) {
    case 'literal':   return d.value.length > 0
    case 'keywords':  return true
    case 'regex':      return regexAlwaysConsumes(d.source)
    case 'routed':    return d.fallback === undefined ? true : alwaysConsumes(d.fallback, seen)
    // One consuming term is enough for the whole sequence to consume.
    case 'sequence':  return d.parsers.some(x => alwaysConsumes(x, seen))
    // A choice consumes only if EVERY arm it could take consumes.
    case 'choice':    return d.parsers.every(x => alwaysConsumes(x, seen))
    case 'oneOrMore': return alwaysConsumes(d.parser, seen)
    case 'sepBy':     return d.min >= 1 && alwaysConsumes(d.parser, seen)
    case 'node':
    case 'transform':
    case 'label':
    case 'field':
    case 'withCtx':
    case 'grammar':
    case 'token':
    case 'leaf':      return alwaysConsumes(d.parser, seen)
    case 'lazy':      { try { return alwaysConsumes(d.thunk(), seen) } catch { return false } }
    // Zero-width by definition — it asserts over the gap and moves nothing. This
    // `false` is load-bearing: it is what keeps the TRIVIA REWIND in place for the
    // term that follows, so the assertion changes no span it does not mean to.
    case 'adjacency': return false
    // `expect`/`recover` synthesise a zero-width success; `optional`/`many`/
    // `not`/`peek`/`trivia` are zero-width by definition; `dispatch`/`scanTo`/
    // `guard`/`attempt`/`unknown` are unproven.
    default:          return false
  }
}

/**
 * True when parsing `p` may push a capture (leaf/child/trivia) into the active
 * buffers and THEN fail, leaving partial state that an enclosing node() would
 * wrongly absorb. Used to decide whether a fallible block needs CST-rollback.
 *
 * Sound over-approximation: the ONLY constructs that capture-then-fail are
 *   - a sequence whose non-final term captures before a later term can fail
 *   - a sepBy/oneOrMore item-then-separator partial (handled by their own
 *     dedicated rollback, so still covered conservatively here)
 * Atomic terminals (literal/regex/keywords/charClass/guard/not) fail without
 * having captured. node() buffers into a private sub-scope and discards it on
 * failure, so it never leaks. choice/firstMatch roll back each failed arm
 * internally. optional/many never "fail" with partial output. Delegating
 * wrappers (transform/label/grammar/withCtx/expect) pass through to inner.
 */
export function mayLeavePartialCapture(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set(), triviaActive = true): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    // Atomic / non-capturing-then-failing: a failure happens before any push.
    case 'literal':
    case 'regex':
    case 'keywords':
    case 'guard':
    // Adjacency probes with `_cap = 0` / no `commit()`: it cannot push anything.
    case 'adjacency':
    case 'not':
    // peek(): emitted under a non-capturing probe ctx and zero-width on both
    // outcomes, so it can never leave a partial capture behind.
    case 'peek':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'scanTo':
    case 'unknown':
      return false
    // node() captures into its own private buffers and rolls them back on
    // failure (emitNode restores _ctx.* and never pushes on the !ok path).
    case 'node':
      return false
    // choice/firstMatch already roll back each failed arm; on overall failure
    // nothing committed remains.
    case 'choice':
      return false
    case 'dispatch':
      // These are independent graph predicates. Sharing one mutable `seen` set
      // between them made the first walk hide the arm from the second: an atomic
      // literal arm, for example, was visited by `mayLeavePartialCapture` (false)
      // and then skipped by `capturesLeaf` (also false because already seen).
      // Fork the ancestor set for each proof so cycle protection remains, while
      // one proof cannot erase evidence needed by another.
      return capturesLeaf(d.selector, new Set(seen)) ||
        d.cases.some(x => mayLeavePartialCapture(x.parser, new Set(seen), triviaActive) || capturesLeaf(x.parser, new Set(seen))) ||
        (d.matchers ? d.matchers.some(x => mayLeavePartialCapture(x.parser, new Set(seen), triviaActive) || capturesLeaf(x.parser, new Set(seen))) : false) ||
        (d.otherwise ? mayLeavePartialCapture(d.otherwise, new Set(seen), triviaActive) || capturesLeaf(d.otherwise, new Set(seen)) : false)
    case 'attempt':
      return false
    // optional never fails; many/oneOrMore only "fail" with zero captured items.
    case 'optional':
    case 'many':
    case 'oneOrMore':
      return false
    // sepBy emits its own per-iteration rollback in emitSepBy.
    case 'sepBy':
      return false
    // A sequence is the real case: an earlier capturing term followed by a term
    // that can fail leaves the earlier captures buffered.
    //
    // BOTH halves of that sentence are load-bearing, and the second half is what
    // this walk exists to exploit. "Some earlier term captures" alone was the old
    // test, and it is true of very nearly every sequence in a real grammar — a
    // sequence almost always opens with a literal or a node. The rollback is only
    // reachable if something AFTER the capture can still fail; once the remainder
    // is total (`optional`/`many`/trivia/a min-0 `sepBy`), the sequence has no
    // failure path left to roll back from, and the save+restore is dead code.
    //
    // `captured` tracks whether anything is in the buffers yet as the scan moves
    // left to right. Two things put it there:
    //   - a term that captures (`capturesLeaf`/`hasNodeDef`), and
    //   - the inter-term TRIVIA scan, which under `capturing` pushes into
    //     `_cstRawChildren`/`_cstTriviaLog` BEFORE the term at each boundary
    //     i >= 1. `emitSeqValues` only rewinds that push on the term's SUCCESS
    //     path (the "matched empty, so leave the whitespace out of the span"
    //     branch); a term that FAILS breaks straight out with the trivia still
    //     buffered, so from boundary 1 onward the buffers are dirty regardless of
    //     what the earlier terms did.
    // Each term is also asked about itself: a nested sequence can leave its own
    // partial capture behind, and its terms are emitted inline into this same
    // block with no boundary of their own to roll them back.
    case 'sequence': {
      const parts = d.parsers
      let captured = false
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!
        if (i > 0 && triviaActive) captured = true
        if (captured && mayFail(part)) return true
        if (mayLeavePartialCapture(part, seen, triviaActive)) return true
        if (capturesLeaf(part) || hasNodeDef(part)) captured = true
      }
      return false
    }
    // Delegating wrappers: defer to the wrapped parser.
    case 'transform':
    case 'label':
    case 'field':
    case 'expect':
    case 'withCtx':
    case 'grammar':
      return mayLeavePartialCapture(d.parser, seen, triviaActive)
    case 'recover':
      return mayLeavePartialCapture(d.parser, seen, triviaActive)
    case 'lazy': {
      try { return mayLeavePartialCapture(d.thunk(), seen, triviaActive) } catch { return true }
    }
    // Unknown shapes: be safe and keep the rollback.
    default:
      return true
  }
}

/** True when `p` can push a leaf/node into the capture buffers on success. */
export function capturesLeaf(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'literal':
    case 'regex':
    case 'keywords':
    case 'node':
    case 'token':
    case 'routed':
    case 'leaf':
      return true
    case 'not':
    case 'peek':
    case 'guard':
    case 'adjacency':
    case 'trivia':
    case 'unknown':
      return false
    case 'sequence':
    case 'choice':
      return d.parsers.some(x => capturesLeaf(x, seen))
    case 'dispatch':
      return capturesLeaf(d.selector, seen) ||
        d.cases.some(x => capturesLeaf(x.parser, seen)) ||
        (d.matchers ? d.matchers.some(entry => capturesLeaf(entry.parser, seen)) : false) ||
        (d.otherwise ? capturesLeaf(d.otherwise, seen) : false)
    case 'sepBy':
      return capturesLeaf(d.parser, seen) || capturesLeaf(d.separator, seen)
    case 'many':
    case 'oneOrMore':
    case 'optional':
    case 'attempt':
    case 'transform':
    case 'label':
    case 'field':
    case 'expect':
    case 'withCtx':
    case 'grammar':
    case 'recover':
      return capturesLeaf(d.parser, seen)
    case 'scanTo':
      return true
    case 'lazy': {
      try { return capturesLeaf(d.thunk(), seen) } catch { return true }
    }
    default:
      return true
  }
}

/**
 * Does this combinator tree contain a node() anywhere (following ref/lazy
 * thunks)? Determines whether the compile emits CST capture — so non-node
 * grammars stay byte-identical. `seen` guards against recursion cycles.
 */
export function hasNodeDef(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'node':      return true
    case 'lazy':      { try { return hasNodeDef(d.thunk(), seen) } catch { return false } }
    case 'grammar':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'label':
    case 'field':
    case 'optional':
    case 'many':
    case 'oneOrMore':
    case 'not':
    case 'peek':
    case 'transform': return hasNodeDef(d.parser, seen)
    case 'sequence':
    case 'choice':    return d.parsers.some(x => hasNodeDef(x, seen))
    case 'dispatch':  return hasNodeDef(d.selector, seen) || d.cases.some(x => hasNodeDef(x.parser, seen)) || (d.matchers ? d.matchers.some(entry => hasNodeDef(entry.parser, seen)) : false) || (d.otherwise ? hasNodeDef(d.otherwise, seen) : false)
    case 'sepBy':     return hasNodeDef(d.parser, seen) || hasNodeDef(d.separator, seen)
    case 'scanTo':    return hasNodeDef(d.sentinel, seen) || d.skip.some(x => hasNodeDef(x, seen))
    case 'recover':   return hasNodeDef(d.parser, seen) || hasNodeDef(d.sentinel, seen)
    case 'expect':    return hasNodeDef(d.parser, seen)
    case 'withCtx':   return hasNodeDef(d.parser, seen)
    default:          return false
  }
}

/**
 * Whether a grammar tree owns a DIRECT semantic node reduction — a `node(..., build)`
 * whose callback produces the value itself, as opposed to a purely structural
 * `node(parser)`.
 *
 * It is the predicate behind `hostBranchElided`: an artifact only drops a
 * positioned-CST branch if there was a direct builder to drop, so an all-structural
 * grammar stays usable with either host (`cst/host-mode.ts`).
 *
 * It belongs in THIS module for the reason stated at the top of it: both lowerings
 * must reach the same answer, and a stamp they disagree about is a driver that
 * accepts a host it should refuse. It previously lived in `compiler/codegen.ts`,
 * which forced `table/compile-rule-map.ts` to import the engine the table replaced.
 *
 * The descent mirrors the source lowering's own `childrenOf` exactly — including a
 * `routed()` fallback and a `dispatch` matcher arm, both of which are real emit
 * sites and neither of which `hasNodeDef` above walks.
 */
export function hasDirectBuildDef(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'node':      return d.build !== undefined || hasDirectBuildDef(d.parser, seen)
    case 'lazy':      { try { return hasDirectBuildDef(d.thunk(), seen) } catch { return false } }
    case 'grammar':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'label':
    case 'field':
    case 'optional':
    case 'many':
    case 'oneOrMore':
    case 'attempt':
    case 'not':
    case 'peek':
    case 'withCtx':
    case 'expect':
    case 'transform': return hasDirectBuildDef(d.parser, seen)
    case 'sequence':
    case 'choice':    return d.parsers.some(x => hasDirectBuildDef(x, seen))
    case 'dispatch':  return hasDirectBuildDef(d.selector, seen)
      || d.cases.some(x => hasDirectBuildDef(x.parser, seen))
      || (d.matchers ? d.matchers.some(x => hasDirectBuildDef(x.parser, seen)) : false)
      || (d.otherwise ? hasDirectBuildDef(d.otherwise, seen) : false)
    case 'sepBy':     return hasDirectBuildDef(d.parser, seen) || hasDirectBuildDef(d.separator, seen)
    case 'scanTo':    return hasDirectBuildDef(d.sentinel, seen) || d.skip.some(x => hasDirectBuildDef(x, seen))
    case 'recover':   return hasDirectBuildDef(d.parser, seen) || hasDirectBuildDef(d.sentinel, seen)
    case 'routed':    return d.fallback ? hasDirectBuildDef(d.fallback, seen) : false
    default:          return false
  }
}

/** True when `p` can report a committed failure through emitFallible's failure channel. */
export function mayCommitFailure(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'dispatch':
      return true
    case 'choice':
    case 'sequence':
      return d.parsers.some(x => mayCommitFailure(x, seen))
    case 'many':
    case 'oneOrMore':
    case 'optional':
    case 'attempt':
    case 'transform':
    case 'label':
    case 'field':
    case 'grammar':
    case 'node':
      return mayCommitFailure(d.parser, seen)
    case 'sepBy':
      return mayCommitFailure(d.parser, seen) || mayCommitFailure(d.separator, seen)
    case 'token':
    case 'leaf':
      return mayCommitFailure(d.parser, seen)
    case 'withCtx':
      return mayCommitFailure(d.parser, seen)
    case 'scanTo':
      return mayCommitFailure(d.sentinel, seen) || d.skip.some(x => mayCommitFailure(x, seen))
    case 'lazy': {
      try { return mayCommitFailure(d.thunk(), seen) } catch { return true }
    }
    case 'unknown':
      return true
    default:
      return false
  }
}

/** A leaf-composed imported piece may carry Parseman's own structural balanced
 * text reconstruction, but never a grammar-authored semantic callback.
 *
 * `externalRefs` are the unresolved NAMED refs `compileLinkable`'s pre-pass already
 * classified as external (`g.Value` naming a rule this artifact doesn't define). They
 * are the one case that fails OPEN: the ref is a HOLE, it holds no callback of its
 * own, and codegen emits it as a by-name `_r_<Name>` call bound at fuse time by
 * whichever piece supplies the name — either another pre-final piece (itself put
 * through this same gate) or the local leaf (allowed to be semantic by design). So
 * an artifact whose only "unknown" is a hole is genuinely recognition-only.
 *
 * EVERY other lazy failure still fails CLOSED. In particular an UNNAMED `ref()` that
 * was never `.define()`d is NOT external — nobody can bind it by name — so it stays
 * an opaque subtree of unknown semantics and the answer is "semantic". Catching all
 * errors here instead would let that (and any future thunk failure) pass the
 * recognition-only gate. */
function hasSemanticReduction(
  roots: readonly Combinator<unknown>[],
  externalRefs?: ReadonlySet<Combinator<unknown>>,
): boolean {
  const seen = new Set<Combinator<unknown>>()
  const visit = (parser: Combinator<unknown>): boolean => {
    if (seen.has(parser)) return false
    seen.add(parser)
    const def = parser._def
    if (def.tag === 'transform' && !def.recognitionOnly) return true
    if (def.tag === 'choice' && def.gates.some(Boolean)) return true
    if (def.tag === 'guard' || def.tag === 'withCtx') return true
    if (def.tag === 'node' && def.build !== undefined) return true
    if (def.tag === 'lazy') {
      if (externalRefs?.has(parser)) return false
      try { return visit(def.thunk()) } catch { return true }
    }
    return childrenOf(def).some(visit)
  }
  return roots.some(visit)
}

/**
 * `hasDirectBuilders` / `isRecognitionOnly` for a rule map WITHOUT lowering it.
 *
 * `composeLeaf()` gates on both: every pre-final grammar must prove recognition-only,
 * and the local leaf's direct builders decide whether the recognition pieces need
 * terminal capture. Both were only ever available as fields on `LinkablePieces`, so
 * the gate forced a full `compileLinkable()` of every piece purely to read two
 * booleans off the result — which is why the table lowering appeared to be blocked on
 * porting the source lowering wholesale.
 *
 * They are not lowering products. Both are predicates over the COMBINATOR GRAPH, and
 * this computes them from the graph directly, with the SAME `externalRefs` rule the
 * lowering applies (`:6008`): a named `lazy` whose thunk throws is a HOLE, bound by
 * name at fuse time, and is therefore not evidence of unknown semantics. An UNNAMED
 * unresolved `ref()` stays semantic — nobody can bind it, so it fails closed.
 */
export function classifyRuleMap(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
): { hasDirectBuilders: boolean; isRecognitionOnly: boolean } {
  const externalRefs = new Set<Combinator<unknown>>()
  const scanned = new Set<Combinator<unknown>>()
  const scanExternal = (p: Combinator<unknown>): void => {
    if (scanned.has(p)) return
    scanned.add(p)
    const def = p._def
    if (def.tag === 'lazy') {
      let resolved: Combinator<unknown> | undefined
      try { resolved = def.thunk() } catch { resolved = undefined }
      if (resolved === undefined) {
        if ((p as unknown as { _ruleName?: string })._ruleName) externalRefs.add(p)
        return
      }
      scanExternal(resolved)
      return
    }
    for (const child of childrenOf(def)) scanExternal(child)
  }
  for (const [, rule] of ruleMap) scanExternal(rule)
  return {
    hasDirectBuilders: ruleMap.some(([, rule]) => hasDirectBuildDef(rule)),
    isRecognitionOnly: !hasSemanticReduction(ruleMap.map(([, rule]) => rule), externalRefs),
  }
}
