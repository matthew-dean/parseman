import type { Combinator, FirstSet, ParseContext, ParseError, ParseResult, RecoveryHelpers } from '../types.ts'
import { cstCaptureActive, pushCstChild } from '../cst/capture-buffer.ts'
import { rangesHaveLead } from '../lead-ranges.ts'
import { annotateSpanFromLineContext, recordLineRangeFromContext } from '../line-index.ts'
import { PlainSpan } from '../cst/plain.js'

/**
 * Recovery MECHANISM — sync-source-agnostic. These primitives implement "scan
 * forward to a sync token and emit a ParseError" and "is the sync token here?".
 * They are deliberately independent of WHERE the sync sentinel comes from: the
 * grammar never carries recovery config. Sync points are inferred automatically
 * from grammar structure (see `infer.ts`) and may be overridden externally by the
 * language service via `ctx._listSync`. This is the salvaged core of the old
 * `combinators/recover-scan.ts`.
 */

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
    _cstTriviaLog: ctx._cstTriviaLog, _triviaLog: ctx._triviaLog, _rootTriviaLog: ctx._rootTriviaLog, _fields: ctx._fields, _cstBuf: ctx._cstBuf,
    _tolerant: ctx._tolerant, _sync: ctx._sync,
  }
  ctx._probe = undefined; ctx._errors = undefined
  ctx._cstLeaves = undefined; ctx._cstChildren = undefined; ctx._cstRawChildren = undefined
  ctx._cstTriviaLog = undefined; ctx._triviaLog = undefined; ctx._rootTriviaLog = undefined; ctx._fields = undefined; ctx._cstBuf = undefined
  // A sentinel is pure lookahead: it must not itself enter tolerant recovery (nor
  // read a stale outer `_sync`). Otherwise a sentinel that composes many/sepBy would
  // run recovery on every probed position — wasted work, and it could resync to the
  // enclosing list's sync token. Cleared here and restored in `finally`.
  ctx._tolerant = undefined; ctx._sync = undefined
  try {
    return sentinel.parse(input, pos, ctx).ok
  } finally {
    ctx._probe = s._probe; ctx._errors = s._errors
    ctx._cstLeaves = s._cstLeaves; ctx._cstChildren = s._cstChildren; ctx._cstRawChildren = s._cstRawChildren
    ctx._cstTriviaLog = s._cstTriviaLog; ctx._triviaLog = s._triviaLog; ctx._rootTriviaLog = s._rootTriviaLog; ctx._fields = s._fields; ctx._cstBuf = s._cstBuf
    ctx._tolerant = s._tolerant; ctx._sync = s._sync
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
  if (b === undefined || b === a) return a
  if (b === ANY_SYNC) return ANY_SYNC
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
 * when the input code point at `pos` starts the given first set. Sync inference
 * builds one from a list's follow set so a nested list can resync to the enclosing
 * delimiter with no grammar annotation. Returns `null` when the first set is `any`
 * or `empty` (no usable inference).
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
        if (rangesHaveLead(ranges, code)) return { ok: true, value: null, span: { start: pos, end: pos } }
      }
      return { ok: false, expected: [], span: { start: pos, end: pos } }
    },
  }
}

/**
 * The sync point where any character might come next: it matches everywhere, so a list
 * under it ends cleanly at a failed element and calls nothing junk.
 */
export const ANY_SYNC: Combinator<null> = {
  _tag: 'anySync',
  _meta: { firstSet: { kind: 'any' }, canMatchNewline: false, isTrivia: false },
  _def: { tag: 'unknown' },
  parse: (_input: string, pos: number): ParseResult<null> => ({ ok: true, value: null, span: { start: pos, end: pos } }),
}

/**
 * A sequence term's encoded follow slot: a class alone when a later term has to read,
 * `followAndInherited(class)` when later terms can all match nothing, `FOLLOW_INHERIT` when
 * no terms come later, and `FOLLOW_ANY` when a later term's first set is unknown.
 */
export const FOLLOW_INHERIT = -1
export const FOLLOW_ANY = -2
export const followAndInherited = (cls: number): number => -3 - cls

/** The sync point a sequence publishes before a term, from that term's encoded slot. */
export function followSync(
  slot: number,
  sentinelFor: (cls: number) => Combinator<unknown> | undefined,
  inherited: Combinator<unknown> | undefined,
): Combinator<unknown> | undefined {
  if (slot >= 0) return sentinelFor(slot) ?? inherited
  if (slot === FOLLOW_INHERIT) return inherited
  if (slot === FOLLOW_ANY) return ANY_SYNC
  const own = sentinelFor(-3 - slot)
  return own === undefined ? inherited : orSentinel(own, inherited)
}

/**
 * Can this list end here? A failed item only proves the list ended when the sync point
 * matches where the item started, before the trivia skipped to reach it (a follow term
 * may read that trivia), or at the separator a dropped trailing separator gives back.
 */
export function listMayEndAt(
  sync: Combinator<unknown>,
  input: string,
  ctx: ParseContext,
  itemStart: number,
  cur: number,
  sepStart: number,
): boolean {
  return matchesAt(sync, input, itemStart, ctx)
    || (cur !== itemStart && matchesAt(sync, input, cur, ctx))
    || (sepStart >= 0 && sepStart !== cur && matchesAt(sync, input, sepStart, ctx))
}

/**
 * Cold-path recovery scan shared by tolerant `many()` / `sepBy()`. Scans forward
 * from `from` until `sync` matches (or EOF) — probing the sentinel as pure
 * lookahead — emits a {@link ParseError} spanning the skipped range, and pushes it
 * to `ctx._errors`. The sync token is NOT consumed; the caller's loop resumes from
 * `end`. Only ever reached after an element has failed, so entirely off the hot path.
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
  const span = new PlainSpan(from, scanPos)
  if (ctx.trackLines) recordLineRangeFromContext(ctx, input, from, scanPos)
  const error: ParseError = { _tag: 'parseError', span: ctx.trackLines ? annotateSpanFromLineContext(span, ctx) : span, expected }
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

/**
 * Embed a recovered error as a `parseError` CST child at the recovery point, so the
 * error lives IN the tree (rides reused subtrees across incremental edits; a tree
 * walk finds every diagnostic) — not only in the flat `ctx._errors` side-channel.
 * No-op when CST capture is off (value/AST mode). Both the interpreter list loops
 * and the compiled recovery branches call this (the latter via `_ctx._rec.capture`),
 * so the embedded node is identical on both paths.
 */
export function captureError(ctx: ParseContext, error: ParseError): void {
  if (cstCaptureActive(ctx)) pushCstChild(ctx, error, error)
}

/**
 * The recovery-helper bundle handed to a tolerant parse via `ctx._rec`. A COMPILED
 * grammar can't import these, so the driver (`run`, `parseDoc`) injects them; the
 * interpreter list loops read the same bundle, guaranteeing byte-identical recovery
 * across paths. Shared here so every driver installs the exact same instance.
 */
export const REC: RecoveryHelpers = { scan: recoverScan, at: matchesAt, or: orSentinel, sentinel: firstSetSentinel, capture: captureError }
