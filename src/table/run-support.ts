/**
 * Assembly helpers that touch NO assembly state.
 *
 * They lived inside `assemble()`'s closure, where they captured nothing but were
 * re-created per assembly. The emitted engine (`emit-assembly.ts`) needs the
 * same three answers and must not carry a second copy of them — a second copy of
 * `rawEntry` is how a CST leaf's span drifts between two engines that are gated
 * against each other precisely so it cannot. Hoisted here so both engines call
 * ONE definition.
 *
 * Nothing here reads configuration: `spanLines` reads `ctx._lineStarts`, which
 * is per-parse STATE that the line-tracking assembly populates, and `rawEntry`
 * reads only its arguments.
 */
import type { ParseContext } from '../types.ts'
import { popCstChild, pushCstChild } from '../cst/capture-buffer.ts'
import { failedBefore, furthestArm, noteFailed } from '../recovery/scan.ts'
import { classHas, type ResolvedClass } from './program.ts'
import { committed } from './stamp.ts'
import { PlainLeaf, PlainLineSpan, PlainSpan } from '../cst/plain.js'

export type Span = { start: number; end: number }
export type LineSpan = Span & {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

/** Binary search of `ctx._lineStarts` — `[line, column]`, both 1-based. */
export function lineCol(ctx: ParseContext, offset: number): [number, number] {
  const starts = ctx._lineStarts ?? [0]
  let lo = 0, hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return [lo + 1, offset - starts[lo]! + 1]
}

export function spanLines(ctx: ParseContext, start: number, end: number): LineSpan {
  const s = lineCol(ctx, start), e = lineCol(ctx, end)
  return new PlainLineSpan(start, end, s[0], s[1], e[0], e[1])
}

/**
 * The RAW child entry a node publishes beside its projected value.
 *
 * An already-shaped node/leaf/parseError passes through; anything else is
 * wrapped as a leaf over the source text it spanned.
 */
export function rawEntry(v: unknown, input: string, s: number, e: number): unknown {
  if (typeof v === 'object' && v !== null) {
    const tg = (v as { _tag?: string })._tag
    if (tg === 'node' || tg === 'leaf' || tg === 'parseError') return v
  }
  return new PlainLeaf(typeof v === 'string' ? v : (typeof v === 'object' && v !== null ? input.slice(s, e) : ''), new PlainSpan(s, e))
}

/** `input`'s code point at `pos`, or −1 at EOF. Surrogate-pair aware. */
export function lead(input: string, pos: number): number {
  if (pos >= input.length) return -1
  const c = input.charCodeAt(pos)
  if (c < 0xd800 || c > 0xdbff) return c
  return input.codePointAt(pos) ?? c
}

type ArmClasses = readonly (ResolvedClass | null | undefined)[]
type ArmGate = (state: unknown) => boolean

/** Could more than one of a choice's arms start on this code point? */
function armsOverlap(armCls: ArmClasses, gates: readonly (ArmGate | undefined)[], c: number, ctx: ParseContext): boolean {
  let open = 0
  for (let i = 0; i < armCls.length; i++) {
    const cls = armCls[i] ?? null
    if ((cls === null || classHas(cls, c)) && gates[i]?.(ctx.state) !== false) open++
  }
  return open > 1
}

function strictChoice<V>(
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
    noteFailed(ctx, site, pos, ctx._fe, ctx._fx)
  }
  return v
}

/**
 * A choice under recovery, with `plain` the choice as a strict parse runs it. Where more
 * than one arm could start, the arms answer as a strict parse would, and only if none does
 * is this text damage, for the arm that read the furthest to recover in.
 */
export function overlappingChoice<V>(
  site: number,
  plain: (input: string, pos: number, ctx: ParseContext) => V,
  armCls: ArmClasses,
  gates: readonly (ArmGate | undefined)[],
  arms: readonly ((input: string, pos: number, ctx: ParseContext) => V)[],
  fail: V,
  input: string,
  pos: number,
  ctx: ParseContext,
): V {
  if (ctx._tolerant !== true) return strictChoice(site, plain, fail, input, pos, ctx)
  const c = lead(input, pos)
  if (!armsOverlap(armCls, gates, c, ctx)) return plain(input, pos, ctx)
  ctx._tolerant = undefined
  const v = strictChoice(site, plain, fail, input, pos, ctx)
  ctx._tolerant = true
  if (v !== fail) return v
  const arm = furthestArm(ctx, arms.length, i => {
    const cls = armCls[i] ?? null
    if (cls !== null && !classHas(cls, c)) return -1
    ctx._fc = false
    const r = arms[i]!(input, pos, ctx)
    return r !== fail ? pos : committed(ctx) ? Infinity : ctx._fe ?? pos
  })
  ctx._fc = false
  return arms[arm]!(input, pos, ctx)
}

const EMPTY_KIDS: readonly unknown[] = Object.freeze([])
const EMPTY_TRIVIA: readonly number[] = Object.freeze([])

type CollapseBuild = (
  children: readonly unknown[], fields: undefined, span: { start: number; end: number },
  rawChildren: readonly unknown[], triviaLog: readonly number[], state: undefined,
) => unknown

/**
 * A PASS-THROUGH COLLAPSE whose one child built `undefined` (`site-labels.ts`
 * `passCollapse`).
 *
 * A collapse over a single node is that node: the node publishes its value into
 * the collector the collapse's parent opened, exactly where the collapse would
 * have published it, over the same span. So both engines run the body with no
 * frame of the collapse's own and hand its value up. The one value a frame would
 * have treated differently is `undefined`, which a frame does not count as a
 * child: the collapse then builds from no children. This is that case — take the
 * child's publication back and publish the build instead, as the frame would
 * have. The caller has already set `EC.e`.
 */
export function collapseEmpty(
  ctx: ParseContext, build: CollapseBuild, input: string, pos: number, end: number, readsRaw: boolean,
): unknown {
  const collected = ctx._cstBuf !== undefined || ctx._cstChildren !== undefined
  if (collected) popCstChild(ctx)
  // A frame keeps the raw entry of the child it does not count, for a reducer
  // that reads `rawChildren`.
  const raw = readsRaw ? [rawEntry(undefined, input, pos, end)] : EMPTY_KIDS
  const nd = build(EMPTY_KIDS, undefined, new PlainSpan(pos, end), raw, EMPTY_TRIVIA, undefined)
  if (collected) pushCstChild(ctx, nd, ctx._cstBuf?.noRaw === true ? undefined : rawEntry(nd, input, pos, end))
  return nd
}
