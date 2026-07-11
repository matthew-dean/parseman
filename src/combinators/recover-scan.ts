import type { Combinator, FirstSet, ParseContext, ParseError, ParseResult } from '../types.ts'

/**
 * Run `sentinel` at `pos` as PURE lookahead: succeed/fail only, with every
 * side-effecting sink suppressed (CST leaves/children/trivia, the trivia log,
 * the recovery error sink, and the completions probe). A recovery scan probes the
 * sentinel at many positions and must not capture leaves, log trivia, or pollute
 * `completionsAt`'s furthest-failure set as a byproduct of looking ahead.
 */
function probeAt(sentinel: Combinator<unknown>, input: string, pos: number, ctx: ParseContext): boolean {
  const s = {
    _probe: ctx._probe, _errors: ctx._errors,
    _cstLeaves: ctx._cstLeaves, _cstChildren: ctx._cstChildren, _cstRawChildren: ctx._cstRawChildren,
    _cstTriviaLog: ctx._cstTriviaLog, _triviaLog: ctx._triviaLog, _fields: ctx._fields, _cstBuf: ctx._cstBuf,
  }
  ctx._probe = undefined; ctx._errors = undefined
  ctx._cstLeaves = undefined; ctx._cstChildren = undefined; ctx._cstRawChildren = undefined
  ctx._cstTriviaLog = undefined; ctx._triviaLog = undefined; ctx._fields = undefined; ctx._cstBuf = undefined
  try {
    return sentinel.parse(input, pos, ctx).ok
  } finally {
    ctx._probe = s._probe; ctx._errors = s._errors
    ctx._cstLeaves = s._cstLeaves; ctx._cstChildren = s._cstChildren; ctx._cstRawChildren = s._cstRawChildren
    ctx._cstTriviaLog = s._cstTriviaLog; ctx._triviaLog = s._triviaLog; ctx._fields = s._fields; ctx._cstBuf = s._cstBuf
  }
}

/**
 * Combine two recovery sentinels into one that matches when either does — used by
 * tolerant `sepBy` to resync to its own separator OR the enclosing delimiter. Cold
 * path only; a bare wrapper so we don't pull `choice()` (and its analysis) in.
 */
export function orSentinel(
  a: Combinator<unknown>,
  b: Combinator<unknown> | undefined,
): Combinator<unknown> {
  if (b === undefined) return a
  return {
    _tag: 'orSentinel',
    _meta: { firstSet: { kind: 'any' }, canMatchNewline: false, isTrivia: false },
    _def: { tag: 'unknown' },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<unknown> {
      const ra = a.parse(input, pos, ctx)
      if (ra.ok) return ra
      return b.parse(input, pos, ctx)
    },
  }
}

/**
 * A lightweight zero-width sentinel that "matches" (succeeds, consuming nothing)
 * when the input code point at `pos` starts the given first set. Used by layer C:
 * an enclosing `sequence` builds one from its remaining terms' first set and
 * publishes it as `ctx._sync` so a nested list can resync to the enclosing
 * delimiter with no author annotation. Returns `null` when the first set is `any`
 * or `empty` (no usable local inference).
 */
export function firstSetSentinel(fs: FirstSet): Combinator<null> | null {
  if (fs.kind !== 'ranges' || fs.ranges.length === 0) return null
  const ranges = fs.ranges
  return {
    _tag: 'firstSetSentinel',
    _meta: { firstSet: fs, canMatchNewline: false, isTrivia: false },
    _def: { tag: 'unknown' },
    parse(input: string, pos: number): ParseResult<null> {
      const code = pos < input.length ? input.codePointAt(pos) : undefined
      if (code !== undefined) {
        for (const r of ranges) {
          if (code >= r.lo && code <= r.hi) return { ok: true, value: null, span: { start: pos, end: pos } }
        }
      }
      return { ok: false, expected: [], span: { start: pos, end: pos } }
    },
  }
}

/**
 * Cold-path recovery scan shared by tolerant `many()` / `sepBy()` (layered C+B
 * recovery). Scans forward from `from` until `sync` matches (or EOF) — probing the
 * sentinel as pure lookahead — emits a {@link ParseError} spanning the skipped
 * range, and pushes it to `ctx._errors`. The sync token is NOT consumed; the
 * caller's loop resumes from `end`. Only ever reached after an element has failed,
 * so it is entirely off the hot path.
 *
 * The caller owns the loop guard: `sepBy` progress is driven by its separator (a
 * zero-width error for a missing element is fine); `many` checks `matchesAt(sync)`
 * itself and breaks when sitting on the terminator, so a zero-width failure can
 * never spin.
 */
export function recoverScan(
  input: string,
  from: number,
  ctx: ParseContext,
  sync: Combinator<unknown>,
  expected: string[],
): { error: ParseError; end: number } {
  let scanPos = from
  while (scanPos < input.length && !probeAt(sync, input, scanPos, ctx)) scanPos++
  const error: ParseError = { _tag: 'parseError', span: { start: from, end: scanPos }, expected }
  ctx._errors?.push(error)
  return { error, end: scanPos }
}

/**
 * Does `sentinel` match at `pos` (pure lookahead)? Used by the tolerant list loops
 * to detect "we are sitting on the sync/terminator token" without consuming it or
 * capturing anything.
 */
export function matchesAt(
  sentinel: Combinator<unknown>,
  input: string,
  pos: number,
  ctx: ParseContext,
): boolean {
  return probeAt(sentinel, input, pos, ctx)
}

/** True when `value` is a recovery {@link ParseError} node. */
export function isParseError(value: unknown): value is ParseError {
  return typeof value === 'object' && value !== null && (value as ParseError)._tag === 'parseError'
}
