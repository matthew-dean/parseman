import type { Combinator, FailedChoice, FirstSet, ParseContext, ParseError, ParseResult, RecoveryHelpers } from '../types.ts'
import { cstCaptureActive, pushCstChild, rollbackCstCapture, saveCstMark } from '../cst/capture-buffer.ts'
import { rangesHaveLead } from '../lead-ranges.ts'
import { annotateSpanFromLineContext, recordLineRangeFromContext } from '../line-index.ts'
import { PlainSpan } from '../cst/plain.js'
import { createDetachedParseContext } from '../parse-context.ts'
import type { ResolvedClass } from '../table/program.ts'

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
 * may read that trivia), or at the separator a dropped trailing separator gives back
 * (what follows the list can start with the list's own separator).
 */
export function listMayEndAt(
  sync: Combinator<unknown>,
  input: string,
  ctx: ParseContext,
  itemStart: number,
  sepStart: number,
): boolean {
  if (matchesAt(sync, input, itemStart, ctx)) return true
  if (sepStart >= 0 && matchesAt(sync, input, sepStart, ctx)) return true
  const gap = ctx.trivia?.parse(input, itemStart, createDetachedParseContext(false, ctx.state))
  const next = gap?.ok === true ? gap.span.end : itemStart
  // No first set names the end of input, and an empty list may stop there. After a
  // separator it can't: the item the separator promised is missing.
  return (sepStart < 0 && next >= input.length) || (next !== itemStart && matchesAt(sync, input, next, ctx))
}

/** Is there nothing but trivia left to read? */
export function inputEndsAt(input: string, pos: number, ctx: ParseContext): boolean {
  if (pos >= input.length) return true
  const gap = ctx.trivia?.parse(input, pos, createDetachedParseContext(false, ctx.state))
  return gap?.ok === true && gap.span.end >= input.length
}

/** What a tolerant parse didn't read: an error, so stopping early is never a silent success. */
export function unreadError(input: string, from: number, expected: string[]): ParseError {
  return { _tag: 'parseError', span: new PlainSpan(from, input.length), expected }
}

const committed = (ctx: ParseContext): boolean => ctx._fc === true
const reached = (probe: NonNullable<ParseContext['_probe']>): number => probe.best?.span.start ?? -1

/** Is this run measuring how far an arm reads? See `furthestArm`. */
function measuring(ctx: ParseContext): boolean {
  return ctx._probe?.offset === Infinity
}

/**
 * Has this choice already failed strictly at `pos`, in the same trivia scope and state?
 * The same text fails the same way, so a tolerant parse doesn't work it out again; without
 * this, overlapping arms re-read a failing nested region once per arm per level. A failure
 * first met outside a measurement doesn't know how far it read, so a measurement works it
 * out once more: each choice runs at most twice at a position.
 */
export function failedBefore(ctx: ParseContext, site: number, pos: number): FailedChoice | undefined {
  const failed = ctx._failed?.get(pos * 4194304 + site)
  if (failed === undefined || failed.trivia !== ctx.trivia || !sameState(failed.state, ctx.state)) return undefined
  if (!measuring(ctx)) return failed
  if (failed.far === undefined) return undefined
  measuredMiss(ctx, failed.far)
  return failed
}

/** State is copied on write, so equal fields are equal state, whichever copy holds them. */
function sameState(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false
  return true
}

/**
 * What a failed choice expected, once each: each arm reports the arms below it, so across
 * overlapping levels the raw list grows by a factor of the arms per level.
 */
export function noteFailed(ctx: ParseContext, site: number, pos: number, at: number | undefined, expected: unknown): void {
  const far = measuring(ctx) ? ctx._probe?.best?.span.start : undefined
  ;(ctx._failed ??= new Map()).set(pos * 4194304 + site, { trivia: ctx.trivia, state: ctx.state, at, expected, committed: committed(ctx), far })
}

/** Run a choice's arms as a strict parse would, once for each position: see `failedBefore`. */
function strictOnce<V>(
  site: number,
  plain: (input: string, pos: number, ctx: ParseContext) => V,
  fail: V,
  input: string,
  pos: number,
  ctx: ParseContext,
): V {
  const failed = failedBefore(ctx, site, pos)
  if (failed !== undefined) {
    ctx._fe = failed.at
    ctx._fx = failed.expected as string[] | undefined
    if (failed.committed) ctx._fc = true
    return fail
  }
  const v = plain(input, pos, ctx)
  if (v === fail) {
    if (ctx._fx !== undefined) ctx._fx = [...new Set(ctx._fx)]
    measuredMiss(ctx, pos)
    noteFailed(ctx, site, pos, ctx._fe, ctx._fx)
  }
  return v
}

type ArmClasses = readonly (ResolvedClass | null | undefined)[]

/**
 * A choice under recovery, with `plain` the choice as a strict parse runs it. Where more
 * than one arm could start, the arms answer as a strict parse would. If none does, this
 * text is damage, for the arm that read the furthest to recover in, unless the input has
 * ended: there is nothing left to recover, and a list or optional around the choice may
 * simply stop.
 */
export function overlappingChoice<V>(
  site: number,
  plain: (input: string, pos: number, ctx: ParseContext) => V,
  armCls: ArmClasses,
  gates: readonly (((state: unknown) => boolean) | undefined)[],
  arms: readonly ((input: string, pos: number, ctx: ParseContext) => V)[],
  fail: V,
  classHas: (cls: ResolvedClass, c: number) => boolean,
  input: string,
  pos: number,
  ctx: ParseContext,
): V {
  if (ctx._tolerant !== true) return strictOnce(site, plain, fail, input, pos, ctx)
  const c = pos < input.length ? input.codePointAt(pos)! : -1
  let open = 0
  for (let i = 0; i < armCls.length; i++) {
    const cls = armCls[i] ?? null
    if ((cls === null || classHas(cls, c)) && gates[i]?.(ctx.state) !== false) open++
  }
  if (open < 2) return plain(input, pos, ctx)
  ctx._tolerant = undefined
  const v = strictOnce(site, plain, fail, input, pos, ctx)
  ctx._tolerant = true
  if (v !== fail || inputEndsAt(input, pos, ctx)) return v
  const arm = REC.furthest(ctx, arms.length, i => {
    const cls = armCls[i] ?? null
    if (cls !== null && !classHas(cls, c)) return -1
    ctx._fc = false
    const r = arms[i]!(input, pos, ctx)
    return r !== fail ? pos : committed(ctx) ? Infinity : ctx._fe ?? pos
  })
  ctx._fc = false
  return arms[arm]!(input, pos, ctx)
}

/** While measuring, a choice that read nothing past `pos` still read that far. */
export function measuredMiss(ctx: ParseContext, pos: number): void {
  const probe = ctx._probe
  if (probe?.offset === Infinity && pos > reached(probe)) probe.best = { ok: false, expected: [], span: { start: pos, end: pos } }
}

/**
 * No arm of a choice answers, so this text is damage, and only the arm that read the
 * furthest gets to recover. `attempt` runs arm `i` strictly and says where it failed, or
 * −1 when the arm can't start here. A failure's own position isn't how far the arm read: a
 * nested choice reports where it began and a list swallows its item's failure, so the
 * completions probe's terminal sites measure it instead. On a tie the first arm wins. It
 * is the one place a parse reads text again: only on damage, and once per failed choice.
 */
export function furthestArm(ctx: ParseContext, n: number, attempt: (i: number) => number): number {
  const split = ctx._columnsSplit
  const outer = ctx._probe
  const probe: NonNullable<ParseContext['_probe']> = { offset: Infinity, best: null }
  let best = -1
  let bestAt = -1
  ctx._tolerant = undefined
  ctx._probe = probe
  const log = ctx._triviaLog?.length
  const rootLog = ctx._rootTriviaLog?.length
  for (let i = 0; i < n; i++) {
    const mark = saveCstMark(ctx)
    probe.best = null
    const r = attempt(i)
    const at = r < 0 ? r : Math.max(r, reached(probe))
    rollbackCstCapture(ctx, mark)
    if (ctx._triviaLog !== undefined) ctx._triviaLog.length = log ?? 0
    if (ctx._rootTriviaLog !== undefined) ctx._rootTriviaLog.length = rootLog ?? 0
    ctx._columnsSplit = split
    if (at > bestAt) { bestAt = at; best = i }
  }
  ctx._tolerant = true
  ctx._probe = outer
  return best
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
export const REC: RecoveryHelpers = { scan: recoverScan, at: matchesAt, or: orSentinel, sentinel: firstSetSentinel, capture: captureError, furthest: furthestArm, overlap: overlappingChoice, measuredMiss, failedBefore, noteFailed }
