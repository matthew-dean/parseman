import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { advanceTrivia, needsDeferredTriviaCommit, rollbackTrivia, saveTriviaMark, scanTrivia } from './trivia-skip.ts'
import { matchesEmpty, startsFirstSet } from './first-set.ts'
import { deriveExpected } from './expect.ts'
import { matchesAt, orSentinel, recoverScan, captureError } from '../recovery/scan.ts'

/**
 * Parse one repetition item at `cur`, first skipping (and, in capture mode,
 * recording) any leading trivia — so a repeating combinator consumes the trivia
 * between items uniformly, the way advancing the index always should. Trivia is
 * committed *before* the item so rawChildren order stays [item, trivia, item];
 * if the item then fails or makes no progress the trivia is rolled back and the
 * loop stops (the trivia is trailing and belongs to the enclosing context).
 *
 * Returns the item value + end position, the underlying failure (so oneOrMore
 * can propagate a first-item failure), or 'stop'.
 */
function repItem<T>(
  combinator: Combinator<T>,
  input: string,
  cur: number,
  ctx: ParseContext,
  guardable: boolean,
): { value: T; end: number } | { fail: ParseResult<T>; failPos: number } | 'stop' {
  const mark = saveTriviaMark(ctx)
  let pos = cur
  if (ctx.trivia) {
    if (needsDeferredTriviaCommit(ctx)) {
      const scan = scanTrivia(input, cur, ctx)
      scan.commit()
      pos = scan.end
    } else {
      pos = advanceTrivia(input, cur, ctx)
    }
  }
  // Nothing but trivia left: don't speculatively parse an item at EOF (it would
  // fail and could trigger an item's expect()/error side-effects). The trivia
  // is trailing — roll it back for the enclosing context and stop.
  if (pos >= input.length) {
    rollbackTrivia(ctx, mark)
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
    rollbackTrivia(ctx, mark)
    return 'stop'
  }
  const result = combinator.parse(input, pos, ctx)
  if (!result.ok) {
    rollbackTrivia(ctx, mark)
    // Surface the POST-trivia position where the element actually failed. The
    // tolerant recovery guard must check the sync token there — not at `cur`,
    // which sits before any leading trivia — so trailing trivia before the sync
    // isn't mistaken for junk and swallowed into a spurious ParseError.
    return { fail: result, failPos: pos }
  }
  if (result.span.end === pos) {
    rollbackTrivia(ctx, mark)
    return 'stop'
  }
  return { value: result.value, end: result.span.end }
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

  return {
    _tag: 'many',
    _meta: meta,
    _def: def,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      // When the aggregate is never observed (markUnusedValues), skip the array:
      // items still parse and self-capture into the enclosing node's children.
      const values: T[] | undefined = def.valueUnused ? undefined : []
      let cur = pos
      let count = 0
      while (cur < input.length) {
        if (count >= max) break
        const item = repItem(combinator, input, cur, ctx, guardable)
        if (item === 'stop') break
        if ('fail' in item) {
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
        cur = item.end
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

  return {
    _tag: 'oneOrMore',
    _meta: meta,
    _def: def,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      // First item is mandatory (parsed at pos directly — leading trivia is the
      // enclosing context's responsibility); subsequent items skip leading trivia.
      const first = combinator.parse(input, pos, ctx)
      if (!first.ok) return first
      // Aggregate skipped when never observed (see `many`).
      const values: T[] | undefined = def.valueUnused ? undefined : [first.value]
      let cur = first.span.end
      let count = 1
      // Mandatory items 2..min (only entered for min > 1) — each failure propagates,
      // exactly like the first. They go through repItem so the trivia BETWEEN items
      // is consumed the same way the loop consumes it.
      while (count < min) {
        const item = repItem(combinator, input, cur, ctx, guardable)
        if (item === 'stop' || 'fail' in item) {
          expected ??= deriveExpected(combinator)
          return { ok: false, expected: expected.length > 0 ? expected : [combinator._tag], span: { start: pos, end: pos } }
        }
        if (values !== undefined) values.push(item.value)
        cur = item.end
        count++
      }
      while (cur < input.length) {
        if (count >= max) break
        const item = repItem(combinator, input, cur, ctx, guardable)
        if (item === 'stop') break
        if ('fail' in item) {
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
        cur = item.end
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

  return {
    _tag: 'optional',
    _meta: meta,
    _def: { tag: 'optional', parser: combinator as Combinator<unknown> },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T | null> {
      if (firstSetSkippable && ctx._probe === undefined && !startsFirstSet(combinator, input, pos)) {
        return { ok: true, value: null, span: { start: pos, end: pos } }
      }
      const mark = saveTriviaMark(ctx)
      const result = combinator.parse(input, pos, ctx)
      if (result.ok) return result as ParseResult<T>
      // Inner failed → roll back any CST leaves/trivia it captured before giving up.
      rollbackTrivia(ctx, mark)
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
export function oneOrMoreSep<T, S>(combinator: Combinator<T>, separator: Combinator<S>, opts: SepByOptions = {}): Combinator<T[]> {
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
  /** Every item MUST be followed by a separator (`a; b;`). An empty list is vacuously fine. */
  | 'require'

export type SepByOptions = RepeatOptions & {
  /** What to do with a separator that has no item after it. Default `'forbid'`. */
  trailing?: TrailingSeparator
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
export function sepBy<T, S>(combinator: Combinator<T>, separator: Combinator<S>, opts: SepByOptions = {}): Combinator<T[]> {
  const { min, max } = resolveBounds('sepBy()', opts)
  const trailing = opts.trailing ?? 'forbid'
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline || separator._meta.canMatchNewline,
    isTrivia: false,
  }
  let expected: string[] | undefined
  const failMin = (pos: number): ParseResult<T[]> => {
    expected ??= deriveExpected(combinator)
    // Same empty-set fallback codegen's `deriveExpectedArr` applies, so the
    // interpreted and compiled failures carry the same payload.
    return { ok: false, expected: expected.length > 0 ? expected : [combinator._tag], span: { start: pos, end: pos } }
  }

  return {
    _tag: 'sepBy',
    _meta: meta,
    _def: {
      tag: 'sepBy', parser: combinator as Combinator<unknown>, separator: separator as Combinator<unknown>, min,
      ...(max === Infinity ? {} : { max }),
      ...(trailing === 'forbid' ? {} : { trailing }),
    },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      const first = combinator.parse(input, pos, ctx)
      const values: T[] = []
      let cur: number
      if (first.ok) {
        values.push(first.value)
        cur = first.span.end
      } else {
        // Cold path. Strict: an empty/absent first element is a legal empty list
        // for `sepBy`, and a FAILURE for `sepBy1` (min 1 — that is the whole point).
        // Tolerant: if the first element is JUNK (a terminator is inferable and we
        // are not already sitting on it) recover it and enter the loop; otherwise
        // it is a genuine empty list.
        const term = ctx._tolerant ? ctx._sync : undefined
        if (term === undefined || matchesAt(term, input, pos, ctx)) {
          // `min >= 1` — report the item's DERIVED expected at the list's own start.
          // The compiled form swallows the first element's sub-parse (it is
          // discarded on the min-0 path), so it cannot reproduce the inner
          // failure's exact payload; both sides report this same derived set.
          if (min >= 1) return failMin(pos)
          return { ok: true, value: [], span: { start: pos, end: pos } }
        }
        expected ??= deriveExpected(combinator)
        const rec = recoverScan(input, pos, ctx, orSentinel(separator, term), expected)
        values.push(rec.error as unknown as T)
        captureError(ctx, rec.error)
        cur = rec.end
      }
      // Set when a separator was consumed with no item after it (`trailing`).
      let sawTrailing = false
      while (cur < input.length) {
        if (values.length >= max) break
        // One mark for the whole iteration (separator + following item): if the
        // item fails, the trailing separator must be rolled back with it, or its
        // captured leaves leak past the end of the list.
        const loopMark = saveTriviaMark(ctx)
        let sepPos = cur
        if (ctx.trivia) {
          if (needsDeferredTriviaCommit(ctx)) {
            const scan = scanTrivia(input, cur, ctx)
            scan.commit()
            sepPos = scan.end
          } else {
            sepPos = advanceTrivia(input, cur, ctx)
          }
        }
        const sep = separator.parse(input, sepPos, ctx)
        if (!sep.ok) {
          rollbackTrivia(ctx, loopMark)
          break
        }
        // Mark taken AFTER the separator: `trailing` keeps the separator but must
        // still unwind the trivia + leaves captured past it.
        const sepMark = trailing === 'forbid' ? undefined : saveTriviaMark(ctx)
        let nextPos = sep.span.end
        if (ctx.trivia) {
          if (needsDeferredTriviaCommit(ctx)) {
            const scan = scanTrivia(input, sep.span.end, ctx)
            scan.commit()
            nextPos = scan.end
          } else {
            nextPos = advanceTrivia(input, sep.span.end, ctx)
          }
        }
        const next = combinator.parse(input, nextPos, ctx)
        if (!next.ok) {
          // Cold path. Strict: roll back the trailing separator + break. Tolerant:
          // the separator we just consumed is real, so resync the bad element after
          // it. If a terminator is inferable and already present at nextPos, the
          // separator was a trailing one (e.g. `a;}`) → roll it back and stop.
          if (sepMark !== undefined) {
            // 'allow' / 'require': the separator we just consumed IS part of the list.
            rollbackTrivia(ctx, sepMark)
            cur = sep.span.end
            sawTrailing = true
            break
          }
          const term = ctx._tolerant ? ctx._sync : undefined
          if (term !== undefined && !matchesAt(term, input, nextPos, ctx)) {
            expected ??= deriveExpected(combinator)
            const rec = recoverScan(input, nextPos, ctx, orSentinel(separator, term), expected)
            values.push(rec.error as unknown as T)
            captureError(ctx, rec.error)
            cur = rec.end
            continue
          }
          rollbackTrivia(ctx, loopMark)
          break
        }
        values.push(next.value)
        cur = next.span.end
      }
      if (values.length < min) return failMin(pos)
      // 'require': a non-empty list must END with a separator. An empty list has no
      // item to follow, so it is vacuously satisfied.
      if (trailing === 'require' && values.length > 0 && !sawTrailing) return failMin(pos)
      return { ok: true, value: values, span: { start: pos, end: cur } }
    },
  }
}
