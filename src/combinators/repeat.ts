import type { Combinator, ParseContext, ParseOk, ParseResult, ParserMeta } from '../types.ts'
import { advanceTrivia, commitTriviaScan, needsDeferredTriviaCommit, needsTriviaRollback, rollbackTrivia, saveTriviaMark, scanTriviaCompact } from './trivia-skip.ts'
import { matchesEmpty, startsFirstSet } from './first-set.ts'
import { deriveExpected } from './expect.ts'
import { matchesAt, orSentinel, recoverScan, captureError } from '../recovery/scan.ts'
import { demoteCapturedToRaw } from '../cst/capture-buffer.ts'
import { scalarOf, type ScalarParser } from './scalar.ts'

/**
 * Parse one repetition item at `cur`, first skipping (and, in capture mode,
 * recording) any leading trivia — so a repeating combinator consumes the trivia
 * between items uniformly, the way advancing the index always should. Trivia is
 * committed *before* the item so rawChildren order stays [item, trivia, item];
 * if the item then fails or makes no progress the trivia is rolled back and the
 * loop stops (the trivia is trailing and belongs to the enclosing context).
 *
 * Returns the successful child result, the underlying failure (so oneOrMore
 * can propagate a first-item failure), or 'stop'.
 *
 * `mandatory` marks an item `min` REQUIRES rather than one the greedy loop is
 * merely trying. Both stops below — the EOF early-out and the zero-width stop —
 * are TERMINATION DEVICES for an unbounded loop whose only source of progress is
 * the item; that pressure does not exist for a prefix of exactly `min` items,
 * which is finite by construction. A required item is therefore attempted at its
 * position whatever is there, exactly as the first one already is (:203) — the
 * trivia skip, which is real structure and not a stop, still applies to both.
 */
function repItem<T>(
  combinator: Combinator<T>,
  input: string,
  cur: number,
  ctx: ParseContext,
  guardable: boolean,
  mandatory: boolean,
  rollbackNeeded: boolean,
): ParseOk<T> | { fail: ParseResult<T>; failPos: number } | 'stop' {
  const mark = rollbackNeeded ? saveTriviaMark(ctx) : undefined
  let pos = cur
  if (ctx.trivia) {
    if (needsDeferredTriviaCommit(ctx)) {
      pos = commitTriviaScan(scanTriviaCompact(input, cur, ctx))
    } else {
      pos = advanceTrivia(input, cur, ctx)
    }
  }
  // Nothing but trivia left: don't speculatively parse an item at EOF (it would
  // fail and could trigger an item's expect()/error side-effects). The trivia
  // is trailing — roll it back for the enclosing context and stop. SPECULATIVE
  // is the operative word: a `mandatory` item is not speculative, so it is
  // attempted at EOF like the first item is, and a NULLABLE one matches there.
  if (pos >= input.length && !mandatory) {
    if (mark !== undefined) rollbackTrivia(ctx, mark)
    return 'stop'
  }
  // First-set fast-path (mirrors emitMany's codegen guard): a body that can't match
  // empty and whose first set can't start at `pos` can ONLY fail this iteration, so
  // stop before the (composite) body's setup-then-fail. This is behaviour-identical
  // in strict mode — a swallowed body failure is discarded either way, and a
  // zero-width/leaf miss reaches the same loop stop. Skipped under a completions
  // probe or tolerant recovery, where a swallowed failure still feeds the probe /
  // triggers resync (matching the codegen guard's `!ctx.recovery` gate).
  if (guardable && ctx._probe === undefined && !ctx._tolerant && !startsFirstSet(combinator, input, pos)) {
    if (mark !== undefined) rollbackTrivia(ctx, mark)
    return 'stop'
  }
  const result = combinator.parse(input, pos, ctx)
  if (!result.ok) {
    if (mark !== undefined) rollbackTrivia(ctx, mark)
    if (result.committed) return { fail: result, failPos: pos }
    // Surface the POST-trivia position where the element actually failed. The
    // tolerant recovery guard must check the sync token there — not at `cur`,
    // which sits before any leading trivia — so trailing trivia before the sync
    // isn't mistaken for junk and swallowed into a spurious ParseError.
    return { fail: result, failPos: pos }
  }
  // Zero-width item: it cannot make progress, so the greedy loop stops without
  // taking it — a TERMINATION device, not a semantic filter (the same rule the
  // table driver holds to `viaRepItem`). A `mandatory` item is counted whatever
  // its width: `min` counts ITEMS, and `x*` over a nullable `x` derives the empty
  // string with any number of them, so a `{ min: n }` prefix takes the n-item
  // derivation. It cannot spin — the prefix is exactly `n` long.
  if (result.span.end === pos && !mandatory) {
    if (mark !== undefined) rollbackTrivia(ctx, mark)
    return 'stop'
  }
  return result
}

export type RepeatOptions = {
  /**
   * Minimum number of ITEMS. Default `0`.
   *
   * `min >= 1` is not a validation nicety — it is what makes the combinator
   * NON-NULLABLE. A nullable arm matches at every position, which disables its
   * `choice`'s first-char dispatch by parseman's own first-set rule; a `min >= 1`
   * repeat keeps the item's first-set, so an arm led by it still gates.
   */
  min?: number
  /** Maximum number of ITEMS. Default: unbounded. Never affects nullability. */
  max?: number
}

/** Shared `min`/`max` validation — a bad bound is an authoring error, not a parse
 *  outcome, so it throws at CONSTRUCTION where the stack points at the grammar. */
function resolveBounds(what: string, opts: { min?: number; max?: number }): { min: number; max: number } {
  const min = opts.min ?? 0
  const max = opts.max ?? Infinity
  const bad = (msg: string): never => { throw new RangeError(`parseman: ${what} ${msg}`) }
  if (!Number.isInteger(min) || min < 0) bad(`min must be a non-negative integer (got ${String(opts.min)})`)
  if (max !== Infinity && (!Number.isInteger(max) || max < 1)) bad(`max must be a positive integer (got ${String(opts.max)})`)
  if (max < min) bad(`max (${max}) is less than min (${min}) — the combinator could never succeed`)
  return { min, max }
}

function repeatScalarTail<T>(
  combinator: Combinator<T>, child: ScalarParser, input: string, cur: number,
  ctx: ParseContext, guardable: boolean, values: T[] | undefined, remaining: number,
): number {
  while (cur < input.length && remaining > 0) {
    let itemPos = cur
    if (ctx.trivia) itemPos = advanceTrivia(input, cur, ctx)
    if (itemPos >= input.length) break
    if (guardable && !startsFirstSet(combinator, input, itemPos)) break
    const end = child(input, itemPos, ctx)
    if (end <= itemPos) break
    if (values !== undefined) values.push(ctx._sv as T)
    cur = end
    remaining--
  }
  ctx._sv = values
  return cur
}

/**
 * Repetition: `item*` by default, bounded by `{ min, max }` (both count ITEMS).
 *
 *   many(g.Decl)                       // zero or more — NULLABLE
 *   many(g.Decl, { min: 1 })           // one or more  — same as oneOrMore(g.Decl)
 *   many(g.HexDigit, { min: 3, max: 8 })
 *
 * `oneOrMore(x)` is kept as the sugar for the common `{ min: 1 }` case.
 */
export function many<T>(combinator: Combinator<T>, opts: RepeatOptions = {}): Combinator<T[]> {
  const { min, max } = resolveBounds('many()', opts)
  // `min >= 1` routes to the SAME implementation `oneOrMore` has always used, so
  // `many(x, { min: 1 })` and `oneOrMore(x)` are the identical combinator — not
  // merely equivalent-looking. (They differ from the min-0 loop in one real way:
  // the mandatory items parse at `pos` with no leading-trivia skip, which is the
  // enclosing context's job.)
  if (min >= 1) return atLeast(combinator, min, max)
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  const def: { tag: 'many'; parser: Combinator<unknown>; min: 0; max?: number; valueUnused?: boolean } =
    { tag: 'many', parser: combinator as Combinator<unknown>, min: 0, ...(max === Infinity ? {} : { max }) }
  let expected: string[] | undefined
  // A non-nullable body can be first-set-gated per loop iteration (see repItem).
  const guardable = combinator._meta.firstSet.kind !== 'any' && !matchesEmpty(combinator)
  const scalarChild = scalarOf(combinator)
  const parseScalar = (input: string, pos: number, ctx: ParseContext): number =>
    repeatScalarTail(combinator, scalarChild, input, pos, ctx, guardable, def.valueUnused ? undefined : [], max)

  return {
    _tag: 'many',
    _meta: meta,
    _def: def,
    _parseScalar: parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      // When the aggregate is never observed (markUnusedValues), skip the array:
      // items still parse and self-capture into the enclosing node's children.
      const values: T[] | undefined = def.valueUnused ? undefined : []
      const rollbackNeeded = needsTriviaRollback(ctx)
      let cur = pos
      let count = 0
      while (cur < input.length) {
        if (count >= max) break
        const item = repItem(combinator, input, cur, ctx, guardable, false, rollbackNeeded)
        if (item === 'stop') break
        if ('fail' in item) {
          if (!item.fail.ok && item.fail.committed) return item.fail
          // Cold path: only reached on an element failure. Strict mode ⇒ `break`.
          // Tolerant ⇒ resync to the sync sentinel the enclosing sequence inferred
          // and published as ctx._sync (the grammar carries no recovery config). No
          // sync available ⇒ nothing to skip to → break.
          const sync = ctx._tolerant ? ctx._sync : undefined
          if (sync === undefined) break
          // Sync token at the POST-trivia failure position ⇒ clean list end (the
          // trailing trivia belongs to the enclosing context), not junk. Checking
          // `item.failPos` (past leading trivia), not `cur`, keeps trivia out of
          // both the break decision and the recovered error span.
          if (matchesAt(sync, input, item.failPos, ctx)) break
          expected ??= deriveExpected(combinator)
          const { error, end } = recoverScan(input, item.failPos, ctx, sync, expected)
          if (values !== undefined) values.push(error as unknown as T)
          captureError(ctx, error)
          count++
          cur = end
          continue
        }
        if (values !== undefined) values.push(item.value)
        count++
        cur = item.span.end
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return { ok: true, value: (values ?? undefined) as T[], span: { start: pos, end: cur } }
    },
  }
}

/**
 * Sugar for the commonest bound: `many(combinator, { min: 1 })` — the identical
 * combinator, not merely an equivalent one.
 */
export function oneOrMore<T>(combinator: Combinator<T>, opts: RepeatOptions = {}): Combinator<T[]> {
  return many(combinator, { ...opts, min: opts.min ?? 1 })
}

/**
 * `min >= 1` repetition: `min` MANDATORY items (whose failure propagates) then a
 * greedy loop up to `max`. The tag stays `oneOrMore` — every downstream switch
 * keys on it for "non-nullable repeat" — and `min` carries the real count.
 */
function atLeast<T>(combinator: Combinator<T>, min: number, max: number): Combinator<T[]> {
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  const def: { tag: 'oneOrMore'; parser: Combinator<unknown>; min: number; max?: number; valueUnused?: boolean } =
    { tag: 'oneOrMore', parser: combinator as Combinator<unknown>, min, ...(max === Infinity ? {} : { max }) }
  let expected: string[] | undefined
  // A non-nullable body can be first-set-gated per loop iteration (see repItem).
  const guardable = combinator._meta.firstSet.kind !== 'any' && !matchesEmpty(combinator)
  const scalarChild = scalarOf(combinator)
  const parseScalar = (input: string, pos: number, ctx: ParseContext): number => {
    let cur = scalarChild(input, pos, ctx)
    if (cur < 0) return cur
    const values: T[] | undefined = def.valueUnused ? undefined : [ctx._sv as T]
    for (let count = 1; count < min; count++) {
      let itemPos = cur
      if (ctx.trivia) itemPos = advanceTrivia(input, cur, ctx)
      cur = scalarChild(input, itemPos, ctx)
      if (cur < 0) return cur
      if (values !== undefined) values.push(ctx._sv as T)
    }
    return repeatScalarTail(combinator, scalarChild, input, cur, ctx, guardable, values, max - min)
  }

  return {
    _tag: 'oneOrMore',
    _meta: meta,
    _def: def,
    _parseScalar: parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      // First item is mandatory (parsed at pos directly — leading trivia is the
      // enclosing context's responsibility); subsequent items skip leading trivia.
      const first = combinator.parse(input, pos, ctx)
      if (!first.ok) return first
      // Aggregate skipped when never observed (see `many`).
      const values: T[] | undefined = def.valueUnused ? undefined : [first.value]
      const rollbackNeeded = needsTriviaRollback(ctx)
      let cur = first.span.end
      let count = 1
      // Mandatory items 2..min (only entered for min > 1) — each failure propagates,
      // exactly like the first. They go through repItem so the trivia BETWEEN items
      // is consumed the same way the loop consumes it, but `mandatory` holds off its
      // two loop-termination stops: a required item is attempted at its position
      // whatever is there, and counts whatever its width.
      while (count < min) {
        const item = repItem(combinator, input, cur, ctx, guardable, true, rollbackNeeded)
        if (item === 'stop' || 'fail' in item) {
          if (item !== 'stop' && !item.fail.ok && item.fail.committed) return item.fail
          // Anchored at `cur` — the furthest position the repeat reached — not at
          // its start. `many(regex(/x/), { min: 3 })` over "xx" consumed both x's
          // and got stuck at 2 wanting a third; reporting offset 0 points the
          // caret at input that matched. Same rule as `sepBy`'s `failAt`, and the
          // compiled emitter already anchored here — this side was the outlier.
          expected ??= deriveExpected(combinator)
          return { ok: false, expected: expected.length > 0 ? expected : [combinator._tag], span: { start: cur, end: cur } }
        }
        if (values !== undefined) values.push(item.value)
        cur = item.span.end
        count++
      }
      while (cur < input.length) {
        if (count >= max) break
        const item = repItem(combinator, input, cur, ctx, guardable, false, rollbackNeeded)
        if (item === 'stop') break
        if ('fail' in item) {
          if (!item.fail.ok && item.fail.committed) return item.fail
          // Cold path (element failure). Strict: break. Tolerant: resync — see many().
          const sync = ctx._tolerant ? ctx._sync : undefined
          if (sync === undefined) break
          if (matchesAt(sync, input, item.failPos, ctx)) break
          expected ??= deriveExpected(combinator)
          const { error, end } = recoverScan(input, item.failPos, ctx, sync, expected)
          if (values !== undefined) values.push(error as unknown as T)
          captureError(ctx, error)
          count++
          cur = end
          continue
        }
        if (values !== undefined) values.push(item.value)
        count++
        cur = item.span.end
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return { ok: true, value: (values ?? undefined) as T[], span: { start: pos, end: cur } }
    },
  }
}

export function optional<T>(combinator: Combinator<T>): Combinator<T | null> {
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  const firstSetSkippable = !matchesEmpty(combinator)
  const scalarChild = scalarOf(combinator)
  const parseScalar = (input: string, pos: number, ctx: ParseContext): number => {
    if (firstSetSkippable && !startsFirstSet(combinator, input, pos)) {
      ctx._sv = null
      return pos
    }
    const end = scalarChild(input, pos, ctx)
    if (end >= 0) return end
    ctx._sv = null
    return pos
  }

  return {
    _tag: 'optional',
    _meta: meta,
    _def: { tag: 'optional', parser: combinator as Combinator<unknown> },
    _parseScalar: parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T | null> {
      if (firstSetSkippable && ctx._probe === undefined && !startsFirstSet(combinator, input, pos)) {
        return { ok: true, value: null, span: { start: pos, end: pos } }
      }
      const mark = saveTriviaMark(ctx)
      const result = combinator.parse(input, pos, ctx)
      if (result.ok) return result as ParseResult<T>
      // Inner failed → roll back any CST leaves/trivia it captured before giving up.
      rollbackTrivia(ctx, mark)
      if (result.committed) return result
      return { ok: true, value: null, span: { start: pos, end: pos } }
    },
  }
}

/**
 * Non-empty separated list — `oneOrMore`'s relationship to `many`, for separated
 * lists. `oneOrMoreSep(item, sep)` is exactly `sepBy(item, sep, { min: 1 })`.
 *
 *   oneOrMoreSep(g.Selector, literal(','))   // a selector list is never empty
 *
 * REACH FOR THIS, NOT `sepBy`, for any list that cannot actually be empty —
 * selector lists, value lists, media-query preludes, keyframe selectors. `sepBy`'s
 * min-0 default matches the EMPTY STRING, which makes it nullable, and a nullable
 * arm disables its `choice`'s first-char dispatch by parseman's own first-set
 * rule. This form is non-nullable and keeps the item's first-set, so an arm led by
 * it still gates.
 */
export function oneOrMoreSep<T, S>(combinator: Combinator<T>, separator: Combinator<S> | KeptSeparator<S>, opts: SepByOptions = {}): Combinator<T[]> {
  return sepBy(combinator, separator, { ...opts, min: opts.min ?? 1 })
}

/** How a separator with NO item after it is treated. */
export type TrailingSeparator =
  /**
   * DEFAULT, and what `sepBy` has always done: the trailing separator is NOT
   * consumed — the list ends before it and the enclosing grammar sees it. (It is
   * not an error here; "forbid" means the list refuses to own it.)
   */
  | 'forbid'
  /** Consume a trailing separator when present (`a, b,` → 2 items, comma eaten). */
  | 'allow'

export type SepByOptions = RepeatOptions & {
  /** What to do with a separator that has no item after it. Default `'forbid'`. */
  trailing?: TrailingSeparator
}

/** A separator the author asked to keep in `children`. Produced by `keepSeparator`. */
export type KeptSeparator<S> = { readonly _keepSeparator: Combinator<S> }

/**
 * Keep this list's separators in `children`, interleaved with the items.
 *
 * A list contributes its ITEMS and nothing else — that is the default and it is
 * not negotiable, because a `children` array whose arity depends on a detail of
 * the separator is the thing that made this defect invisible. But a combinator
 * may collapse only what its CONSTRUCTION makes recoverable, and that is exactly
 * the line this helper draws:
 *
 *   sepBy(g.Value, literal(','))                  // ',' is fixed here — recoverable, drop it
 *   sepBy(g.Track, keepSeparator(SLASH_OR_COMMA)) // could be '/' OR ',' — NOT recoverable, keep it
 *
 * Wrap the separator when it could have matched more than one thing: a `choice`,
 * a regex with alternation or a quantifier, a rule reference. In CSS the
 * separator carries meaning — `grid-area: 1 / 2` and `font: 12px/1.5` do not mean
 * what `1, 2` means — and dropping it destroys information that exists nowhere
 * else in the tree.
 *
 * The wrap is read at CONSTRUCTION, not per parse, and it is deliberately applied
 * to the separator rather than passed as an option: the call site then STATES its
 * own children arity, which is the failure being fixed. `keepSeparator` in the
 * source is the only documentation that reaches an author who never reads docs.
 */
export function keepSeparator<S>(separator: Combinator<S>): KeptSeparator<S> {
  return { _keepSeparator: separator }
}

function unwrapSeparator<S>(separator: Combinator<S> | KeptSeparator<S>): { sep: Combinator<S>; keep: boolean } {
  return '_keepSeparator' in separator
    ? { sep: separator._keepSeparator, keep: true }
    : { sep: separator, keep: false }
}

/**
 * Separated list: `(item (sep item)*)?` by default — note that it MATCHES THE
 * EMPTY STRING, which makes it nullable and therefore un-gateable as a choice arm.
 * For a list that cannot be empty reach for `oneOrMoreSep`, or pass `{ min: 1 }`.
 *
 *   sepBy(g.Value, literal(','))                  // may be empty — NULLABLE
 *   oneOrMoreSep(g.Selector, literal(','))        // non-empty — gates as a choice arm
 *   sepBy(g.Decl, literal(';'), { trailing: 'allow' })
 *
 * `min`/`max` count ITEMS, not separators.
 */
export function sepBy<T, S>(
  combinator: Combinator<T>,
  separatorArg: Combinator<S> | KeptSeparator<S>,
  opts: SepByOptions = {},
): Combinator<T[]> {
  const { sep: separator, keep: keepSeparators } = unwrapSeparator(separatorArg)
  const { min, max } = resolveBounds('sepBy()', opts)
  const trailing = opts.trailing ?? 'forbid'
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline || separator._meta.canMatchNewline,
    isTrivia: false,
  }
  let expected: string[] | undefined
  /**
   * A list-level failure is anchored at the FURTHEST position the list reached,
   * and reports what would have allowed it to CONTINUE there — never at the
   * list's own start.
   *
   * Anchoring at the start throws away everything the parse learned: for
   * `sepBy(item, ',', { min: 3 })` over `"a,b"` the list consumed `a,b` perfectly
   * and got stuck at offset 3 wanting a third item, so a failure reported at 0
   * points the caret at a token that parsed fine. It also mislocates
   * `completionsAt`, which asks what may appear AT a cursor — the answer belongs
   * at the stuck position, not at the list's start.
   *
   * BOTH engines must follow this rule; it drifted three separate ways across
   * this option surface, and `test/parity/repeat-options-parity.test.ts` is what
   * now holds them together. The empty-set fallback mirrors codegen's
   * `deriveExpectedArr`, so the two payloads are identical.
   */
  const failAt = (at: number): ParseResult<T[]> => {
    expected ??= deriveExpected(combinator)
    return { ok: false, expected: expected.length > 0 ? expected : [combinator._tag], span: { start: at, end: at } }
  }
  const scalarExpected = deriveExpected(combinator)
  const scalarChild = scalarOf(combinator)
  const scalarSeparator = scalarOf(separator)
  const parseScalar = (input: string, pos: number, ctx: ParseContext): number => {
    let cur = scalarChild(input, pos, ctx)
    if (cur < 0) {
      if (min >= 1) {
        ctx._fx = scalarExpected.length > 0 ? scalarExpected : [combinator._tag]
        return ~pos
      }
      ctx._sv = []
      return pos
    }
    const values = [ctx._sv as T]
    while (values.length < max && (cur < input.length || values.length < min)) {
      const beforeSeparator = cur
      let separatorPos = cur
      if (ctx.trivia) separatorPos = advanceTrivia(input, cur, ctx)
      const separatorEnd = scalarSeparator(input, separatorPos, ctx)
      if (separatorEnd < 0) break
      let itemPos = separatorEnd
      if (ctx.trivia) itemPos = advanceTrivia(input, itemPos, ctx)
      const itemEnd = scalarChild(input, itemPos, ctx)
      if (itemEnd < 0) {
        cur = trailing === 'allow' ? separatorEnd : beforeSeparator
        break
      }
      values.push(ctx._sv as T)
      cur = itemEnd
    }
    if (values.length < min) {
      ctx._fx = scalarExpected.length > 0 ? scalarExpected : [combinator._tag]
      return ~cur
    }
    ctx._sv = values
    return cur
  }

  return {
    _tag: 'sepBy',
    _meta: meta,
    _def: {
      tag: 'sepBy', parser: combinator as Combinator<unknown>, separator: separator as Combinator<unknown>, min,
      ...(max === Infinity ? {} : { max }),
      ...(trailing === 'forbid' ? {} : { trailing }),
      // Carried into the IR so the COMPILED engine demotes exactly where the
      // interpreter does. The two engines have drifted three separate ways across
      // this option surface already; parity is held by test/parity, not by hope.
      ...(keepSeparators ? { keepSeparators: true } : {}),
    },
    _parseScalar: keepSeparators ? undefined : parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      const first = combinator.parse(input, pos, ctx)
      const values: T[] = []
      let cur: number
      if (first.ok) {
        values.push(first.value)
        cur = first.span.end
      } else {
        if (first.committed) return first
        // Cold path. Strict: an empty/absent first element is a legal empty list
        // for `sepBy`, and a FAILURE for `sepBy1` (min 1 — that is the whole point).
        // Tolerant: if the first element is JUNK (a terminator is inferable and we
        // are not already sitting on it) recover it and enter the loop; otherwise
        // it is a genuine empty list.
        const term = ctx._tolerant ? ctx._sync : undefined
        if (term === undefined || matchesAt(term, input, pos, ctx)) {
          // `min >= 1` — nothing was consumed, so the furthest position IS `pos`.
          // The compiled form swallows the first element's sub-parse (it is
          // discarded on the min-0 path), so it cannot reproduce the inner
          // failure's exact payload; both sides report this same derived set.
          if (min >= 1) return failAt(pos)
          return { ok: true, value: [], span: { start: pos, end: pos } }
        }
        expected ??= deriveExpected(combinator)
        const rec = recoverScan(input, pos, ctx, orSentinel(separator, term), expected)
        values.push(rec.error as unknown as T)
        captureError(ctx, rec.error)
        cur = rec.end
      }
      // `|| values.length < min` — the separated twin of `repItem`'s `mandatory`
      // (1c5b2e8). `cur < input.length` is a TERMINATION device for the greedy
      // tail, and that pressure does not exist for a prefix of exactly `min`
      // items, which is finite by construction: each iteration that succeeds
      // pushes one, so the disjunct can hold at most `min` times. Stopping on it
      // made a REQUIRED item unreachable at EOF, so `sepBy(x, s, { min: n })` over
      // a nullable `x` AND a nullable `s` — where the n-item derivation of the
      // empty string genuinely exists — failed instead of taking it.
      //
      // A non-nullable separator still fails the list here rather than padding it:
      // n items need n-1 separators, so there is no derivation to take, and the
      // iteration below breaks on the separator exactly as it always did.
      // Vacuous for `min <= 1`, which the first element already satisfies.
      while (cur < input.length || values.length < min) {
        if (values.length >= max) break
        // One mark for the whole iteration (separator + following item): if the
        // item fails, the trailing separator must be rolled back with it, or its
        // captured leaves leak past the end of the list.
        const loopMark = saveTriviaMark(ctx)
        let sepPos = cur
        if (ctx.trivia) {
          if (needsDeferredTriviaCommit(ctx)) {
            sepPos = commitTriviaScan(scanTriviaCompact(input, cur, ctx))
          } else {
            sepPos = advanceTrivia(input, cur, ctx)
          }
        }
        const sep = separator.parse(input, sepPos, ctx)
        if (!sep.ok) {
          rollbackTrivia(ctx, loopMark)
          if (sep.committed) return sep
          break
        }
        // A LIST CONTRIBUTES ITS ITEMS AND NOTHING ELSE. The separator matched, so
        // it is consumed and it is recorded in `rawChildren` — but it is not an
        // item, so it does not belong in the structural `children` array. Demote it
        // using the mark this iteration already took; no extra allocation, one
        // guarded truncation, and only when CST capture is live at all.
        if (!keepSeparators) demoteCapturedToRaw(ctx, loopMark.leaves)
        // Mark taken AFTER the separator: `trailing` keeps the separator but must
        // still unwind the trivia + leaves captured past it.
        const sepMark = trailing === 'forbid' ? undefined : saveTriviaMark(ctx)
        let nextPos = sep.span.end
        if (ctx.trivia) {
          if (needsDeferredTriviaCommit(ctx)) {
            nextPos = commitTriviaScan(scanTriviaCompact(input, sep.span.end, ctx))
          } else {
            nextPos = advanceTrivia(input, sep.span.end, ctx)
          }
        }
        const next = combinator.parse(input, nextPos, ctx)
        if (!next.ok) {
          if (next.committed) return next
          // Cold path. Strict: roll back the trailing separator + break. Tolerant:
          // the separator we just consumed is real, so resync the bad element after
          // it. If a terminator is inferable and already present at nextPos, the
          // separator was a trailing one (e.g. `a;}`) → roll it back and stop.
          //
          // RECOVERY IS TESTED FIRST, and is ORTHOGONAL to `trailing`. This block
          // used to lead with the `sepMark !== undefined` branch — but sepMark is
          // non-undefined for EVERY 'allow' list, so that branch always won and the
          // resync below became unreachable the moment a grammar opted into a
          // trailing separator. `{a,,b}` recovered under the default 'forbid' and
          // hard-failed under 'allow', which is not a policy anyone would choose:
          // permitting a trailing comma has nothing to do with whether a tolerant
          // parse may resynchronize. (The compiled `failItem` already ordered it
          // this way — the engines disagreed because of this.)
          //
          // Junk after a REAL separator is recovered whatever `trailing` says, and
          // no rollback happens on that path: both the separator and the recovered
          // error element belong to the list.
          const term = ctx._tolerant ? ctx._sync : undefined
          if (term !== undefined && !matchesAt(term, input, nextPos, ctx)) {
            expected ??= deriveExpected(combinator)
            const rec = recoverScan(input, nextPos, ctx, orSentinel(separator, term), expected)
            values.push(rec.error as unknown as T)
            captureError(ctx, rec.error)
            cur = rec.end
            continue
          }
          if (sepMark !== undefined) {
            // 'allow': the separator we just consumed IS part of the list — a
            // genuine trailing one, since no resync applied above.
            rollbackTrivia(ctx, sepMark)
            cur = sep.span.end
            break
          }
          rollbackTrivia(ctx, loopMark)
          break
        }
        values.push(next.value)
        cur = next.span.end
      }
      // Too few items: the list is stuck at `cur` wanting another ITEM.
      if (values.length < min) return failAt(cur)
      return { ok: true, value: values, span: { start: pos, end: cur } }
    },
  }
}
