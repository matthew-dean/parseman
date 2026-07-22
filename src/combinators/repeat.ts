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

export function many<T>(combinator: Combinator<T>): Combinator<T[]> {
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  const def: { tag: 'many'; parser: Combinator<unknown>; min: 0; valueUnused?: boolean } =
    { tag: 'many', parser: combinator as Combinator<unknown>, min: 0 }
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
      while (cur < input.length) {
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
          cur = end
          continue
        }
        if (values !== undefined) values.push(item.value)
        cur = item.end
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return { ok: true, value: (values ?? undefined) as T[], span: { start: pos, end: cur } }
    },
  }
}

export function oneOrMore<T>(combinator: Combinator<T>): Combinator<T[]> {
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  const def: { tag: 'oneOrMore'; parser: Combinator<unknown>; min: 1; valueUnused?: boolean } =
    { tag: 'oneOrMore', parser: combinator as Combinator<unknown>, min: 1 }
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
      while (cur < input.length) {
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
          cur = end
          continue
        }
        if (values !== undefined) values.push(item.value)
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

export function sepBy<T, S>(combinator: Combinator<T>, separator: Combinator<S>): Combinator<T[]> {
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline || separator._meta.canMatchNewline,
    isTrivia: false,
  }
  let expected: string[] | undefined

  return {
    _tag: 'sepBy',
    _meta: meta,
    _def: { tag: 'sepBy', parser: combinator as Combinator<unknown>, separator: separator as Combinator<unknown> },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      const first = combinator.parse(input, pos, ctx)
      const values: T[] = []
      let cur: number
      if (first.ok) {
        values.push(first.value)
        cur = first.span.end
      } else {
        // Cold path. Strict: an empty/absent first element is a legal empty list.
        // Tolerant: if the first element is JUNK (a terminator is inferable and we
        // are not already sitting on it) recover it and enter the loop; otherwise
        // it is a genuine empty list.
        const term = ctx._tolerant ? ctx._sync : undefined
        if (term === undefined || matchesAt(term, input, pos, ctx)) {
          return { ok: true, value: [], span: { start: pos, end: pos } }
        }
        expected ??= deriveExpected(combinator)
        const rec = recoverScan(input, pos, ctx, orSentinel(separator, term), expected)
        values.push(rec.error as unknown as T)
        captureError(ctx, rec.error)
        cur = rec.end
      }
      while (cur < input.length) {
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
      return { ok: true, value: values, span: { start: pos, end: cur } }
    },
  }
}
