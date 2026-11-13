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
import { resolvedLazyTarget, type RefResolver, type RefTargets } from '../combinators/first-set.ts'

export type { RefTargets }

/**
 * Every commitment analysis reads a reference through a `RefTargets`, and must be
 * handed one. The table encoder passes what its capability walk recorded; a caller
 * with a rule map passes `ruleMapTargets`; a caller with neither passes this, each
 * reference read as its own thunk.
 */
export const THUNK_TARGETS: RefTargets = { get: ref => resolvedLazyTarget(ref) }

/** Each reference read the way the table encoder reads it in `ruleMap`: by name first. */
export function ruleMapTargets(ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>): RefTargets {
  const byName = new Map(ruleMap)
  const resolve: RefResolver = name => byName.get(name)
  return { get: ref => resolvedLazyTarget(ref, resolve) }
}

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
export function mayFail(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set(), targets: RefTargets): boolean {
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
    case 'many':      return mayCommitFailure(d.parser, targets)
    // A list with a minimum also fails short of a minimum above one (a separator
    // can miss), and on a separator that commits a failure, whatever its item.
    case 'sepBy':     return d.min >= 1
      ? d.min > 1 || mayFail(d.parser, seen, targets) || mayCommitFailure(d.separator, targets)
      : mayCommitFailure(d.parser, targets) || mayCommitFailure(d.separator, targets)
    // Mandatory items are attempted at every position, EOF included (`repeat.ts`),
    // so a repeat whose item cannot fail cannot fall short of its minimum.
    case 'oneOrMore': return mayFail(d.parser, seen, targets)
    case 'sequence':  return d.parsers.some(x => mayFail(x, seen, targets))
    // Delegating wrappers: as fallible as what they wrap.
    case 'node':
    case 'transform':
    case 'label':
    case 'field':
    case 'expect':
    case 'withCtx':
    case 'grammar':
    case 'token':
    case 'leaf':      return mayFail(d.parser, seen, targets)
    case 'lazy':      { const t = targets.get(p); return t === undefined || mayFail(t, seen, targets) }
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
export function alwaysConsumes(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set(), targets: RefTargets): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def as ParserDef
  switch (d.tag) {
    case 'literal':   return d.value.length > 0
    case 'keywords':  return true
    case 'regex':      return regexAlwaysConsumes(d.source)
    case 'routed':    return d.fallback === undefined ? true : alwaysConsumes(d.fallback, seen, targets)
    // One consuming term is enough for the whole sequence to consume.
    case 'sequence':  return d.parsers.some(x => alwaysConsumes(x, seen, targets))
    // A choice consumes only if EVERY arm it could take consumes.
    case 'choice':    return d.parsers.every(x => alwaysConsumes(x, seen, targets))
    case 'oneOrMore': return alwaysConsumes(d.parser, seen, targets)
    case 'sepBy':     return d.min >= 1 && alwaysConsumes(d.parser, seen, targets)
    case 'node':
    case 'transform':
    case 'label':
    case 'field':
    case 'withCtx':
    case 'grammar':
    case 'token':
    case 'leaf':      return alwaysConsumes(d.parser, seen, targets)
    case 'lazy':      { const t = targets.get(p); return t !== undefined && alwaysConsumes(t, seen, targets) }
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
 *   - a sepBy/oneOrMore with a minimum above one, failing after the items it kept
 *   - an optional, many or list whose child can commit a failure, which it passes on
 * Atomic terminals (literal/regex/keywords/charClass/guard/not) fail without
 * having captured. node() buffers into a private sub-scope and discards it on
 * failure, so it never leaks. A choice leaves what one of its arms leaves.
 * Delegating wrappers (transform/label/grammar/withCtx/expect) pass through to inner.
 *
 * `commits` answers `mayCommitFailure` for a child; a caller with a resolver and
 * a memo passes its own. `targets` is how a named reference reads (`RefTargets`).
 */
export function mayLeavePartialCapture(
  p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set(), triviaActive = true,
  throughNodes = false,
  restores: ReadonlySet<Combinator<unknown>> | undefined,
  targets: RefTargets,
  commits: (child: Combinator<unknown>) => boolean = child => mayCommitFailure(child, targets),
): boolean {
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
    case 'columns':
      return false
    // A run's prefixes are probed detached; only its body can capture.
    case 'lines':
      return mayLeavePartialCapture(d.body, seen, triviaActive, throughNodes, restores, targets, commits)
    // node() captures its children into a frame of its own and drops it on
    // failure. The trivia logs (`_triviaLog`, `_rootTriviaLog`) are not part of
    // that frame: trivia its body scanned before failing stays recorded. With
    // `throughNodes` (a program that installs trivia somewhere) a node leaves
    // what its body leaves; without, it leaves nothing.
    case 'node':
      return throughNodes && mayLeavePartialCapture(d.parser, seen, triviaActive, throughNodes, restores, targets, commits)
    // A choice leaves what one of its arms leaves. The table lowers a choice whose
    // openers are disjoint as an exclusive dispatch, which runs its one selected
    // arm with no mark of its own (`emit-assembly.ts`, `table.exclusive`), and an
    // ordered choice returns a committed arm's failure before restoring. So
    // whatever holds this choice has to restore for it, unless the encoder has
    // lowered it to restore each arm it enters (`restores`), captures and trivia
    // logs alike.
    case 'choice':
      if (restores?.has(p) === true) return false
      for (const arm of d.parsers) if (mayLeavePartialCapture(arm, new Set(seen), triviaActive, throughNodes, restores, targets, commits)) return true
      return false
    case 'dispatch':
      // These are independent graph predicates. Sharing one mutable `seen` set
      // between them made the first walk hide the arm from the second: an atomic
      // literal arm, for example, was visited by `mayLeavePartialCapture` (false)
      // and then skipped by `capturesLeaf` (also false because already seen).
      // Fork the ancestor set for each proof so cycle protection remains, while
      // one proof cannot erase evidence needed by another.
      return capturesLeaf(d.selector, new Set(seen), targets) ||
        d.cases.some(x => mayLeavePartialCapture(x.parser, new Set(seen), triviaActive, throughNodes, restores, targets, commits) || capturesLeaf(x.parser, new Set(seen), targets)) ||
        (d.matchers ? d.matchers.some(x => mayLeavePartialCapture(x.parser, new Set(seen), triviaActive, throughNodes, restores, targets, commits) || capturesLeaf(x.parser, new Set(seen), targets)) : false) ||
        (d.otherwise ? mayLeavePartialCapture(d.otherwise, new Set(seen), triviaActive, throughNodes, restores, targets, commits) || capturesLeaf(d.otherwise, new Set(seen), targets) : false)
    case 'attempt':
      return false
    // optional and many fail only by passing on a committed failure of their child,
    // without restoring it (`repeat.ts`, and `OP_OPT` / the repeat loop in
    // `emit-assembly.ts`). An optional then leaves what its child leaves; a many keeps
    // the items before the one that failed.
    case 'optional':
      return commits(d.parser) && mayLeavePartialCapture(d.parser, seen, triviaActive, throughNodes, restores, targets, commits)
    case 'many':
      return commits(d.parser)
    // A list restores the item it failed on and keeps the ones before it, so a
    // list short of a minimum above one fails with those still captured, and so
    // does one whose item or separator can commit a failure.
    case 'oneOrMore':
      return d.min > 1 || commits(d.parser)
    case 'sepBy':
      return d.min > 1 || commits(d.parser) || commits(d.separator)
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
        if (captured && mayFail(part, undefined, targets)) return true
        if (mayLeavePartialCapture(part, seen, triviaActive, throughNodes, restores, targets, commits)) return true
        if (capturesLeaf(part, undefined, targets) || hasNodeDef(part, undefined, targets)) captured = true
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
      return mayLeavePartialCapture(d.parser, seen, triviaActive, throughNodes, restores, targets, commits)
    case 'recover':
      return mayLeavePartialCapture(d.parser, seen, triviaActive, throughNodes, restores, targets, commits)
    case 'lazy': {
      const t = targets.get(p)
      return t === undefined || mayLeavePartialCapture(t, seen, triviaActive, throughNodes, restores, targets, commits)
    }
    // Unknown shapes: be safe and keep the rollback.
    default:
      return true
  }
}

/** True when `p` can push a leaf/node into the capture buffers on success. */
export function capturesLeaf(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set(), targets: RefTargets): boolean {
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
      return d.parsers.some(x => capturesLeaf(x, seen, targets))
    case 'dispatch':
      return capturesLeaf(d.selector, seen, targets) ||
        d.cases.some(x => capturesLeaf(x.parser, seen, targets)) ||
        (d.matchers ? d.matchers.some(entry => capturesLeaf(entry.parser, seen, targets)) : false) ||
        (d.otherwise ? capturesLeaf(d.otherwise, seen, targets) : false)
    case 'sepBy':
      return capturesLeaf(d.parser, seen, targets) || capturesLeaf(d.separator, seen, targets)
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
      return capturesLeaf(d.parser, seen, targets)
    case 'scanTo':
      return true
    case 'lines':
      return capturesLeaf(d.body, seen, targets)
    case 'columns':
      return true
    case 'lazy': {
      const t = targets.get(p)
      return t === undefined || capturesLeaf(t, seen, targets)
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
export function hasNodeDef(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set(), targets: RefTargets): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'node':      return true
    case 'lazy':      { const t = targets.get(p); return t !== undefined && hasNodeDef(t, seen, targets) }
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
    case 'transform': return hasNodeDef(d.parser, seen, targets)
    case 'sequence':
    case 'choice':    return d.parsers.some(x => hasNodeDef(x, seen, targets))
    case 'dispatch':  return hasNodeDef(d.selector, seen, targets) || d.cases.some(x => hasNodeDef(x.parser, seen, targets)) || (d.matchers ? d.matchers.some(entry => hasNodeDef(entry.parser, seen, targets)) : false) || (d.otherwise ? hasNodeDef(d.otherwise, seen, targets) : false)
    case 'sepBy':     return hasNodeDef(d.parser, seen, targets) || hasNodeDef(d.separator, seen, targets)
    case 'scanTo':    return hasNodeDef(d.sentinel, seen, targets)
      || d.skip.some(x => hasNodeDef(x, seen, targets))
      || (d.recoverAt !== undefined && hasNodeDef(d.recoverAt, seen, targets))
      || (d.stopAt !== undefined && hasNodeDef(d.stopAt, seen, targets))
    case 'lines':     return hasNodeDef(d.body, seen, targets)
    case 'recover':   return hasNodeDef(d.parser, seen, targets) || hasNodeDef(d.sentinel, seen, targets)
    case 'expect':    return hasNodeDef(d.parser, seen, targets)
    case 'withCtx':   return hasNodeDef(d.parser, seen, targets)
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
 * accepts a host it should refuse. It previously lived in the source lowering,
 * which forced `table/compile-rule-map.ts` to import the engine the table replaced.
 *
 * The descent mirrors the source lowering's own `childrenOf` exactly — including a
 * `routed()` fallback and a `dispatch` matcher arm, both of which are real emit
 * sites and neither of which `hasNodeDef` above walks.
 */
export function hasDirectBuildDef(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set(), targets: RefTargets): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'node':      return d.build !== undefined || hasDirectBuildDef(d.parser, seen, targets)
    case 'lazy':      { const t = targets.get(p); return t !== undefined && hasDirectBuildDef(t, seen, targets) }
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
    case 'transform': return hasDirectBuildDef(d.parser, seen, targets)
    case 'sequence':
    case 'choice':    return d.parsers.some(x => hasDirectBuildDef(x, seen, targets))
    case 'dispatch':  return hasDirectBuildDef(d.selector, seen, targets)
      || d.cases.some(x => hasDirectBuildDef(x.parser, seen, targets))
      || (d.matchers ? d.matchers.some(x => hasDirectBuildDef(x.parser, seen, targets)) : false)
      || (d.otherwise ? hasDirectBuildDef(d.otherwise, seen, targets) : false)
    case 'sepBy':     return hasDirectBuildDef(d.parser, seen, targets) || hasDirectBuildDef(d.separator, seen, targets)
    case 'scanTo':    return hasDirectBuildDef(d.sentinel, seen, targets)
      || d.skip.some(x => hasDirectBuildDef(x, seen, targets))
      || (d.recoverAt !== undefined && hasDirectBuildDef(d.recoverAt, seen, targets))
      || (d.stopAt !== undefined && hasDirectBuildDef(d.stopAt, seen, targets))
    case 'lines':     return hasDirectBuildDef(d.body, seen, targets)
    case 'recover':   return hasDirectBuildDef(d.parser, seen, targets) || hasDirectBuildDef(d.sentinel, seen, targets)
    case 'routed':    return d.fallback ? hasDirectBuildDef(d.fallback, seen, targets) : false
    default:          return false
  }
}

/**
 * True when `p` can report a committed failure through emitFallible's failure
 * channel: a `dispatch`, or a shape this analysis cannot see into, is reachable
 * along `commitFailureSuccessors`' edges.
 *
 * `memo` carries exact answers between calls over one graph and one `targets`;
 * a caller asking at many sites passes the same map to every call, so the graph
 * is walked once rather than once per site.
 */
export function mayCommitFailure(
  p: Combinator<unknown>,
  targets: RefTargets,
  memo: Map<Combinator<unknown>, boolean> = new Map(),
): boolean {
  return reachesMarked(p, node => commitFailureSuccessors(node, targets), memo)
}

const NO_EDGES: readonly Combinator<unknown>[] = []

/** `mayCommitFailure`'s edges out of `p`, or `true` when `p` itself can commit. */
function commitFailureSuccessors(
  p: Combinator<unknown>,
  targets: RefTargets,
): readonly Combinator<unknown>[] | true {
  const d = p._def
  switch (d.tag) {
    case 'dispatch':
    case 'unknown':
      return true
    case 'choice':
    case 'sequence':
      return d.parsers
    // A contained transaction reports every failure uncommitted.
    case 'attempt':
      return d.contain === true ? NO_EDGES : [d.parser]
    case 'many':
    case 'oneOrMore':
    case 'optional':
    case 'transform':
    case 'label':
    case 'field':
    case 'grammar':
    case 'node':
    case 'token':
    case 'leaf':
    case 'withCtx':
      return [d.parser]
    case 'sepBy':
      return [d.parser, d.separator]
    case 'scanTo':
      return [
        d.sentinel,
        ...d.skip,
        ...(d.recoverAt === undefined ? NO_EDGES : [d.recoverAt]),
        ...(d.stopAt === undefined ? NO_EDGES : [d.stopAt]),
      ]
    // A run's prefixes are probed detached; a committed failure reaches it only from its body.
    case 'lines':
      return [d.body]
    case 'lazy': {
      const t = targets.get(p)
      return t === undefined ? true : [t]
    }
    default:
      return NO_EDGES
  }
}

/**
 * Whether a MARKED node — one `successors` answers `true` for — is reachable
 * from `root`.
 *
 * Reachability over a cyclic graph, decided with Tarjan's strongly connected
 * components so that every node the walk enters leaves with its exact answer in
 * `memo`: the members of one component reach each other, so they share one
 * answer, settled when the walk returns to the component's first node. A DFS
 * that instead cuts a cycle at its own ancestor path learns nothing it can keep
 * about a node whose walk hit the cut; one that keeps a visited set per call
 * keeps nothing past the call. Shared across calls, `memo` makes every node
 * entered once however many roots are asked about.
 *
 * `memo` must only ever be used with one `successors`: its entries are answers
 * about that graph.
 */
export function reachesMarked<T>(
  root: T,
  successors: (node: T) => readonly T[] | true,
  memo: Map<T, boolean>,
): boolean {
  const known = memo.get(root)
  if (known !== undefined) return known
  const order = new Map<T, number>()
  const low: number[] = []
  const found: boolean[] = []
  const stack: T[] = []
  const visit = (node: T): number => {
    const at = low.length
    order.set(node, at)
    low.push(at)
    found.push(false)
    stack.push(node)
    const next = successors(node)
    if (next === true) found[at] = true
    else {
      for (const child of next) {
        // Settled: a node that reaches a marked node is answered, and so is
        // every node still above it on the stack, since each reaches it. The
        // children left unentered stay unmemoized for a later walk to settle.
        if (found[at]) break
        const hit = memo.get(child)
        if (hit !== undefined) {
          if (hit) found[at] = true
          continue
        }
        const seen = order.get(child)
        if (seen !== undefined) {
          // Unmemoized but entered: still on the stack, so in this node's
          // component. Its answer reaches the component's first node by the
          // tree edges, not through here.
          if (seen < low[at]!) low[at] = seen
          continue
        }
        const k = visit(child)
        if (low[k]! < low[at]!) low[at] = low[k]!
        if (found[k]) found[at] = true
      }
    }
    if (low[at] === at) {
      const answer = found[at]!
      let member: T
      do {
        member = stack.pop()!
        memo.set(member, answer)
      } while (member !== node)
    }
    return at
  }
  return found[visit(root)]!
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
 * Does any rule of `ruleMap` reach a direct `node(..., build)`, reading each
 * reference as the map binds it? In a merged map a base piece's thunk still
 * reaches the rule an override replaced, and that rule's builder is not in the
 * encoded artifact.
 */
export function hasDirectBuilders(ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>): boolean {
  const targets = ruleMapTargets(ruleMap)
  return ruleMap.some(([, rule]) => hasDirectBuildDef(rule, undefined, targets))
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
        // A `prior.X` placeholder is a hole too: the composition fills it by name.
        const hole = p as unknown as { _ruleName?: string; _priorOf?: string }
        if (hole._ruleName !== undefined || hole._priorOf !== undefined) externalRefs.add(p)
        return
      }
      scanExternal(resolved)
      return
    }
    for (const child of childrenOf(def)) scanExternal(child)
  }
  for (const [, rule] of ruleMap) scanExternal(rule)
  return {
    hasDirectBuilders: hasDirectBuilders(ruleMap),
    isRecognitionOnly: !hasSemanticReduction(ruleMap.map(([, rule]) => rule), externalRefs),
  }
}
