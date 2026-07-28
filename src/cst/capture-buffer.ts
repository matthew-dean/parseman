import type { ParseContext, Span } from '../types.ts'
import { annotateSpanFromLineContext } from '../compiler/line-index.ts'

/** Lazy per-node capture state — arrays materialized on first push. */
export type CstCaptureBuf = {
  single?: unknown | undefined
  ch?: unknown[] | undefined
  rawSingle?: unknown | undefined
  raw?: unknown[] | undefined
  tl?: number[] | undefined
}

const EMPTY: unknown[] = []
const EMPTY_TL: number[] = []

export function cstCaptureActive(ctx: ParseContext): boolean {
  return ctx._cstBuf !== undefined || ctx._cstLeaves !== undefined
}

export type CstNodeCaptureSaved = {
  ch: ParseContext['_cstChildren']
  lv: ParseContext['_cstLeaves']
  raw: ParseContext['_cstRawChildren']
  tl: ParseContext['_cstTriviaLog']
  cap: boolean | undefined
  buf: CstCaptureBuf | undefined
}

export function beginCstNodeCapture(ctx: ParseContext): CstNodeCaptureSaved {
  const saved: CstNodeCaptureSaved = {
    ch: ctx._cstChildren,
    lv: ctx._cstLeaves,
    raw: ctx._cstRawChildren,
    tl: ctx._cstTriviaLog,
    cap: ctx.captureTrivia,
    buf: ctx._cstBuf,
  }
  ctx._cstBuf = {}
  ctx._cstChildren = undefined
  ctx._cstLeaves = undefined
  ctx._cstRawChildren = undefined
  ctx._cstTriviaLog = undefined
  ctx.captureTrivia = true
  return saved
}

export function finishCstBuf(buf: CstCaptureBuf | undefined): {
  children: unknown[]
  rawChildren: unknown[]
  triviaLog: number[]
} {
  if (!buf) return { children: EMPTY, rawChildren: EMPTY, triviaLog: EMPTY_TL }
  const children = buf.ch ?? (buf.single !== undefined ? [buf.single] : EMPTY)
  const rawChildren = buf.raw ?? (buf.rawSingle !== undefined ? [buf.rawSingle] : EMPTY)
  const triviaLog = buf.tl ?? EMPTY_TL
  return { children, rawChildren, triviaLog }
}

export function endCstNodeCapture(
  ctx: ParseContext,
  saved: CstNodeCaptureSaved,
): { children: unknown[]; rawChildren: unknown[]; triviaLog: number[] } {
  const materialized = finishCstBuf(ctx._cstBuf)
  ctx._cstBuf = saved.buf
  ctx._cstChildren = saved.ch
  ctx._cstLeaves = saved.lv
  ctx._cstRawChildren = saved.raw
  ctx._cstTriviaLog = saved.tl
  ctx.captureTrivia = saved.cap
  return materialized
}

export function pushCstLeaf(ctx: ParseContext, leaf: unknown): void {
  if (!ctx.trackLines) {
    pushCstChild(ctx, leaf, leaf)
    return
  }
  const annotated = leaf && typeof leaf === 'object' && (leaf as { span?: unknown }).span
    ? { ...(leaf as Record<string, unknown>), span: annotateSpanFromLineContext((leaf as { span: Span }).span, ctx) }
    : leaf
  pushCstChild(ctx, annotated, annotated)
}

/** Record a built sub-node into the active collector (children vs rawChildren may differ). */
export function pushCstChild(ctx: ParseContext, built: unknown, rawEntry: unknown): void {
  const b = ctx._cstBuf
  if (b) {
    if (b.ch) b.ch.push(built)
    else if (b.single !== undefined) { b.ch = [b.single, built]; b.single = undefined }
    else b.single = built

    if (b.raw) b.raw.push(rawEntry)
    else if (b.rawSingle !== undefined) { b.raw = [b.rawSingle, rawEntry]; b.rawSingle = undefined }
    else b.rawSingle = rawEntry
    return
  }
  if (ctx._cstChildren) ctx._cstChildren.push(built)
  else if (ctx._cstLeaves) ctx._cstLeaves.push(built)
  if (ctx._cstRawChildren) ctx._cstRawChildren.push(rawEntry)
}

export function cstRawLen(ctx: ParseContext): number {
  const b = ctx._cstBuf
  if (b) {
    if (b.raw) return b.raw.length
    return b.rawSingle !== undefined ? 1 : 0
  }
  return ctx._cstRawChildren?.length ?? 0
}

export function cstLeavesLen(ctx: ParseContext): number {
  const b = ctx._cstBuf
  if (b) {
    if (b.ch) return b.ch.length
    return b.single !== undefined ? 1 : 0
  }
  return ctx._cstLeaves?.length ?? 0
}

export function cstTlLen(ctx: ParseContext): number {
  const b = ctx._cstBuf
  if (b) return b.tl?.length ?? 0
  return ctx._cstTriviaLog?.length ?? 0
}

export type CstRollbackMark = { raw: number; tlog: number; leaves: number; fields: number; errors: number }

export function saveCstMark(ctx: ParseContext): CstRollbackMark {
  return {
    raw: cstRawLen(ctx),
    tlog: cstTlLen(ctx),
    leaves: cstLeavesLen(ctx),
    fields: ctx._fields?.length ?? 0,
    // Speculative rollback must truncate the flat recovery-error sink in lockstep
    // with the CST leaves: a branch that recovered (pushing a ParseError to
    // ctx._errors AND embedding it as a CST child via captureError) then failed
    // must remove BOTH, or the flat error survives as a GHOST that a tree walk
    // can't see (flat run().errors would disagree with the embedded set).
    errors: ctx._errors?.length ?? 0,
  }
}

function rollbackBufList(
  b: CstCaptureBuf,
  keyMulti: 'ch' | 'raw',
  keySingle: 'single' | 'rawSingle',
  len: number,
): void {
  const arr = b[keyMulti]
  if (arr) {
    if (len === 0) b[keyMulti] = undefined
    else if (len === 1) { b[keySingle] = arr[0]; b[keyMulti] = undefined }
    // Guarded like every other truncation — see rollbackCstCapture. This is the
    // buffered node-capture path, so it is reached only by the INTERPRETER (the
    // compiled engine inlines its own capture and never calls here), and it is
    // where the redundant-store rate is highest: over a backtracking fixture
    // this branch ran 32,800 times and 31,198 of those — 95% — restored a
    // length that had not moved.
    else if (arr.length !== len) arr.length = len
    return
  }
  if (len === 0) b[keySingle] = undefined
}

export function rollbackCstCapture(ctx: ParseContext, mark: CstRollbackMark): void {
  // Truncate the flat recovery-error sink alongside the CST, so a rolled-back
  // speculative branch leaves no ghost error (see saveCstMark). Guarded on a
  // present sink + a defined mark (rollbackTrivia forwards the same field).
  //
  // Each truncation is guarded on `length !== mark`, mirroring the compiled
  // engine (codegen.ts `captureRestoreBody`). Assigning `array.length` runs V8's
  // length setter — a backing-store trim decision — and costs the same when the
  // value is unchanged, which is the overwhelmingly common case here: a
  // speculative branch that captured nothing still pays for every store. The
  // compare is an in-object load. Both engines must carry the guard or the
  // interpreted path silently keeps the cost the compiled path shed.
  if (ctx._errors && mark.errors !== undefined && ctx._errors.length !== mark.errors) ctx._errors.length = mark.errors
  const b = ctx._cstBuf
  if (b) {
    rollbackBufList(b, 'raw', 'rawSingle', mark.raw)
    rollbackBufList(b, 'ch', 'single', mark.leaves)
    if (b.tl) {
      if (mark.tlog === 0) b.tl = undefined
      else if (b.tl.length !== mark.tlog) b.tl.length = mark.tlog
    }
    if (ctx._fields && ctx._fields.length !== mark.fields) ctx._fields.length = mark.fields
    return
  }
  if (ctx._cstRawChildren && ctx._cstRawChildren.length !== mark.raw) ctx._cstRawChildren.length = mark.raw
  if (ctx._cstTriviaLog && ctx._cstTriviaLog.length !== mark.tlog) ctx._cstTriviaLog.length = mark.tlog
  if (ctx._cstLeaves && ctx._cstLeaves.length !== mark.leaves) ctx._cstLeaves.length = mark.leaves
  if (ctx._fields && ctx._fields.length !== mark.fields) ctx._fields.length = mark.fields
}

export function pushCstTriviaEntry(
  ctx: ParseContext,
  start: number,
  end: number,
  kindIndex?: number,
): void {
  const insertIdx = cstRawLen(ctx)
  const b = ctx._cstBuf
  const withKind = ctx.triviaKindLabels !== undefined && kindIndex !== undefined
  if (b) {
    if (!b.tl) {
      b.tl = withKind ? [start, end, insertIdx, kindIndex] : [start, end, insertIdx]
    } else if (withKind) {
      b.tl.push(start, end, insertIdx, kindIndex)
    } else {
      b.tl.push(start, end, insertIdx)
    }
    return
  }
  if (ctx._cstTriviaLog) {
    if (withKind) ctx._cstTriviaLog.push(start, end, insertIdx, kindIndex)
    else ctx._cstTriviaLog.push(start, end, insertIdx)
  }
}

export function pushTriviaLogEntry(
  ctx: ParseContext,
  start: number,
  end: number,
  kindIndex?: number,
): void {
  if (!ctx._triviaLog) return
  if (ctx.triviaKindLabels !== undefined && kindIndex !== undefined) {
    ctx._triviaLog.push(start, end, kindIndex)
  } else {
    ctx._triviaLog.push(start, end)
  }
}

export function cstDeferredTriviaActive(ctx: ParseContext): boolean {
  return ctx._triviaLog !== undefined || ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined
}
