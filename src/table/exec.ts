import type { FieldMap, ParseContext, ParseResult } from '../types.ts'
import { buildFieldMap } from '../compiler/fields.ts'
import { asciiFoldKey, matchesDispatchMatcher } from '../combinators/dispatch.ts'
import { projectChild, unwrapChild } from '../combinators/node.ts'
import { consumeTrivia } from '../combinators/trivia-skip.ts'
import type { DispatchMatcherKind } from '../types.ts'
import { advanceTrivia, needsDeferredTriviaCommit, rollbackTrivia, saveTriviaMark, scanTrivia } from '../combinators/trivia-skip.ts'
import {
  beginCstNodeCapture, cstCaptureActive, cstLeavesLen, demoteCapturedToRaw,
  endCstNodeCapture, pushCstChild, pushCstLeaf, rollbackCstCapture, saveCstMark,
  type CstRollbackMark,
} from '../cst/capture-buffer.ts'
import {
  OP_CHOICE, OP_EMPTY, OP_GATE, OP_LEAF, OP_LIT, OP_NODE, OP_NOT, OP_OPT,
  OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX, OP_SEQ, OP_SEQV, OP_XFORM,
  OP_LIT_TRACK, OP_RX_TRACK, OP_NODE_TRACK, OP_SCOPE, OP_EXPECT, OP_SEQX, OP_CALL,
  OP_FIELD, OP_DISPATCH, OP_ROUTED,
} from './ops.ts'
import {
  expandCompact, resolveTable,
  type CompactProgram, type ResolvedClass, type ResolvedDispatch, type ResolvedDispatchSpec,
  type TableProgram, type TableRule,
} from './program.ts'

/**
 * THE SHARED DRIVER.
 *
 * One recognizer for every grammar, every rule and every variant — the thing
 * codegen emits once PER RULE, and which therefore sets the per-rule byte floor.
 * It uses the same zero-allocation protocol the emitted code uses (a sentinel
 * for failure plus a shared end-position slot), so what it adds over open-coded
 * recognition is the opcode read and the switch, not an allocation.
 *
 * The driver is instantiated ONCE PER RESOLVED TABLE, closing over that table's
 * arrays. Instruction operands are then reads of context slots rather than
 * property loads through an object, and — the point of G5 — an option can never
 * be consulted here: two settings pairs are two tables, not two code paths.
 */

/** Failure sentinel — identity-compared, never inspected. */
const FAIL: unique symbol = Symbol('pm.fail')

const EMPTY_TL: readonly number[] = Object.freeze([])
const EMPTY_FX: string[] = []
const ROUTED_FX: string[] = ['routed()']
/** `matchesDispatchMatcher` only reads `kind`/`value`/`flags`; this fills the
 *  shape's remaining required fields without constructing a real arm. */
const DUMMY = { _tag: 'never', _meta: { firstSet: { kind: 'any' as const }, canMatchNewline: false, isTrivia: false }, _def: { tag: 'unknown' as const }, parse: () => { throw new Error('unreachable') } }

type Leaf = { _tag: 'leaf'; value: string; span: { start: number; end: number } }

function rawEntry(v: unknown, input: string, s: number, e: number): unknown {
  if (typeof v === 'object' && v !== null) {
    const t = (v as { _tag?: string })._tag
    if (t === 'node' || t === 'leaf' || t === 'parseError') return v
  }
  return { _tag: 'leaf', value: typeof v === 'string' ? v : (typeof v === 'object' && v !== null ? input.slice(s, e) : ''), span: { start: s, end: e } }
}

/** Same semantics as codegen's `LINE_TRACK_DECL` (`src/compiler/codegen.ts:248`). */
function trackLines(ctx: ParseContext, input: string, end: number): void {
  const from = ctx._lineScannedTo ?? 0
  if (end <= from) return
  const starts = ctx._lineStarts
  if (starts === undefined) return
  for (let i = from; i < end; i++) if (input.charCodeAt(i) === 10) starts.push(i + 1)
  ctx._lineScannedTo = end
}

/** Same semantics as codegen's `LINE_SPAN_DECL` (`src/compiler/codegen.ts:251`). */
function lineCol(ctx: ParseContext, offset: number): [number, number] {
  const starts = ctx._lineStarts ?? [0]
  let lo = 0, hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return [lo + 1, offset - starts[lo]! + 1]
}

function spanLines(ctx: ParseContext, start: number, end: number): { start: number; end: number; startLine: number; startColumn: number; endLine: number; endColumn: number } {
  const s = lineCol(ctx, start), e = lineCol(ctx, end)
  return { start, end, startLine: s[0], startColumn: s[1], endLine: e[0], endColumn: e[1] }
}

function classHas(cls: ResolvedClass, code: number): boolean {
  if (code < 0) return false
  if (code < 128) return cls.ascii[code] === 1
  const hi = cls.hi
  for (let i = 0; i < hi.length; i += 2) if (code >= hi[i]! && code <= hi[i + 1]!) return true
  return false
}

type Driver = {
  exec: (ip: number, input: string, pos: number, ctx: ParseContext) => unknown
  end: () => number
}

function makeDriver(
  code: Int32Array,
  k: readonly unknown[],
  fns: readonly unknown[],
  cc: readonly ResolvedClass[],
  fx: readonly (readonly string[])[],
  disp: readonly ResolvedDispatch[],
  dsp: readonly ResolvedDispatchSpec[],
): Driver {
  /** Shared end-position out-parameter (`_pfEnd` in emitted code). */
  let END = 0

  /**
   * Capture goes through the runtime's own buffer (`src/cst/capture-buffer.ts`),
   * not a hand-rolled copy: it is already the shared mechanism the interpreter
   * uses, and a second implementation of it is precisely the duplication G5 is
   * about removing.
   */
  function pushLeaf(ctx: ParseContext, value: string, s: number, e: number): void {
    const lf: Leaf = { _tag: 'leaf', value, span: { start: s, end: e } }
    pushCstLeaf(ctx, lf)
  }

  /**
   * Is there anything a failed branch could need to UNRECORD?
   *
   * `saveCstMark` allocates a 5-field object and `saveTriviaMark` allocates that
   * plus a 7-field one; `rollbackTrivia` allocates a third to call through. In
   * the driver those sat in the repetition and choice loops, so a parse
   * allocated three-to-four objects PER ITEM that codegen never allocates (it
   * emits scalar locals). That is a per-item cost, which is what the widening
   * gap with input size was: +82% small, +275% large.
   *
   * When every sink either rollback touches is absent, nothing was recorded,
   * so nothing needs unrecording and the mark need not exist. A grammar with no
   * `node()` and no trivia log — json, csv — never allocates one.
   */
  function rollbackNeeded(ctx: ParseContext): boolean {
    return ctx._cstBuf !== undefined
      || ctx._cstLeaves !== undefined
      || ctx._cstRawChildren !== undefined
      || ctx._cstTriviaLog !== undefined
      || ctx._fields !== undefined
      || ctx._errors !== undefined
      || ctx._triviaLog !== undefined
      || ctx._rootTriviaLog !== undefined
  }

  /**
   * The lead character at `pos`, as the first-set tables index it.
   *
   * `charCodeAt` is the hot read; only a high surrogate needs the code-point
   * decode, so that branch is paid on astral input and nowhere else.
   */
  function skipTrivia(input: string, cur: number, ctx: ParseContext): number {
    if (needsDeferredTriviaCommit(ctx)) {
      const scan = scanTrivia(input, cur, ctx)
      scan.commit()
      return scan.end
    }
    return advanceTrivia(input, cur, ctx)
  }

  function lead(input: string, pos: number): number {
    if (pos >= input.length) return -1
    const c = input.charCodeAt(pos)
    if (c < 0xd800 || c > 0xdbff) return c
    return input.codePointAt(pos) ?? c
  }

  function exec(ip: number, input: string, pos: number, ctx: ParseContext): unknown {
    switch (code[ip]) {
      case OP_LIT: {
        const s = k[code[ip + 1]!] as string
        if (input.startsWith(s, pos)) {
          const e = pos + s.length
          if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
          END = e
          return s
        }
        ctx._fe = pos; ctx._fx = fx[code[ip + 2]!] as string[]
        return FAIL
      }
      case OP_RX: {
        const re = k[code[ip + 1]!] as RegExp
        re.lastIndex = pos
        const m = re.exec(input)
        if (m !== null) {
          const v = m[0]
          const e = pos + v.length
          if (cstCaptureActive(ctx)) pushLeaf(ctx, v, pos, e)
          END = e
          return v
        }
        ctx._fe = pos; ctx._fx = fx[code[ip + 2]!] as string[]
        return FAIL
      }
      case OP_LIT_TRACK: {
        const s = k[code[ip + 1]!] as string
        if (input.startsWith(s, pos)) {
          const e = pos + s.length
          if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
          trackLines(ctx, input, e)
          END = e
          return s
        }
        ctx._fe = pos; ctx._fx = fx[code[ip + 2]!] as string[]
        return FAIL
      }
      case OP_RX_TRACK: {
        const re = k[code[ip + 1]!] as RegExp
        re.lastIndex = pos
        const m = re.exec(input)
        if (m !== null) {
          const v = m[0]
          const e = pos + v.length
          if (cstCaptureActive(ctx)) pushLeaf(ctx, v, pos, e)
          trackLines(ctx, input, e)
          END = e
          return v
        }
        ctx._fe = pos; ctx._fx = fx[code[ip + 2]!] as string[]
        return FAIL
      }
      case OP_EMPTY:
        END = pos
        return ''

      case OP_GATE: {
        if (!classHas(cc[code[ip + 1]!]!, lead(input, pos))) {
          ctx._fe = pos; ctx._fx = fx[code[ip + 3]!] as string[]
          return FAIL
        }
        return exec(code[ip + 2]!, input, pos, ctx)
      }
      case OP_RULE:
        return exec(code[ip + 1]!, input, pos, ctx)

      case OP_EXPECT: {
        const v = exec(code[ip + 1]!, input, pos, ctx)
        if (v !== FAIL) return v
        // Mirrors src/combinators/expect.ts:135-150 — succeed at zero width with
        // a ParseError value, and record it in the flat sink when present.
        const span = { start: pos, end: pos }
        const err = { _tag: 'parseError' as const, span, expected: fx[code[ip + 2]!] as string[] }
        ctx._errors?.push(err)
        END = pos
        return err
      }

      case OP_ROUTED: {
        // Mirrors src/combinators/dispatch.ts `routed()`.
        const item = ctx._routed
        if (item === undefined || pos !== item.span.start) {
          const fb = code[ip + 1]!
          if (fb >= 0) return exec(fb, input, pos, ctx)
          ctx._fe = pos; ctx._fx = ROUTED_FX
          return FAIL
        }
        if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: item.value, span: item.span })
        END = item.span.end
        return item.value
      }

      case OP_DISPATCH: {
        // The selector runs ONCE; its value picks the arm. Resolution order is
        // exact key -> ASCII-folded key -> matchers in declaration order ->
        // otherwise, mirroring src/combinators/dispatch.ts:325.
        const spec = dsp[code[ip + 2]!]!
        const armBase = ip + 6
        const selectorMark = saveTriviaMark(ctx)
        const selVal = exec(code[ip + 1]!, input, pos, ctx)
        if (selVal === FAIL) return FAIL
        const selEnd = END
        const key = selVal as string

        let arm = spec.byKey.get(key)
        if (arm === undefined && spec.byFold.size > 0) arm = spec.byFold.get(asciiFoldKey(key))
        if (arm === undefined) {
          for (let i = 0; i < spec.match.length; i++) {
            const m = spec.match[i]!
            const kind: DispatchMatcherKind = m[0] === 0 ? 'startsWith' : m[0] === 1 ? 'endsWith' : 'matches'
            if (matchesDispatchMatcher(key, { kind, value: m[1], flags: m[2] === '' ? undefined : m[2], parser: DUMMY, caseInsensitive: false })) {
              arm = m[3]
              break
            }
          }
        }

        let target: number
        let usesRouted: boolean
        if (arm === undefined) {
          const other = code[ip + 3]!
          if (other < 0) {
            // No branch and no fallback: fail AT THE SELECTOR'S END, not at pos.
            ctx._fe = selEnd
            ctx._fx = spec.expected as string[]
            return FAIL
          }
          target = other
          usesRouted = code[ip + 4]! === 1
        } else {
          target = code[armBase + arm]!
          usesRouted = spec.routed[arm] === 1
        }

        const savedRouted = ctx._routed
        let mark = saveTriviaMark(ctx)
        if (usesRouted) {
          rollbackTrivia(ctx, selectorMark)
          mark = saveTriviaMark(ctx)
          ctx._routed = { value: key, span: { start: pos, end: selEnd } }
        }
        const v = exec(target, input, usesRouted ? pos : selEnd, ctx)
        if (usesRouted) ctx._routed = savedRouted
        if (v === FAIL) {
          rollbackTrivia(ctx, mark)
          // The interpreter marks a failed dispatch branch COMMITTED: the
          // selector already matched, so an enclosing choice must not treat this
          // as "try the next arm".
          ctx._fc = true
          return FAIL
        }
        // END already holds the branch's end — dispatch's span runs from `pos`
        // to there, which is what the caller reads.
        return [key, v]
      }

      case OP_FIELD: {
        const v = exec(code[ip + 2]!, input, pos, ctx)
        if (v === FAIL) return FAIL
        // Conditional on a live sink, exactly as src/combinators/map.ts has it:
        // a `field()` outside any field-reading node costs nothing.
        ctx._fields?.push({ name: k[code[ip + 1]!] as string, value: v, span: { start: pos, end: END } })
        return v
      }

      case OP_CALL: {
        const c = k[code[ip + 1]!] as { parse: (i: string, p: number, x: ParseContext) => { ok: boolean; value?: unknown; span: { start: number; end: number }; expected?: readonly string[] } }
        const r = c.parse(input, pos, ctx)
        if (!r.ok) {
          ctx._fe = r.span.start
          ctx._fx = (r.expected ?? EMPTY_FX) as string[]
          return FAIL
        }
        END = r.span.end
        return r.value
      }

      case OP_SCOPE: {
        const ki = code[ip + 1]!
        const saved = ctx.trivia
        ctx.trivia = ki < 0 ? undefined : (k[ki] as ParseContext['trivia'])
        const v = exec(code[ip + 2]!, input, pos, ctx)
        ctx.trivia = saved
        return v
      }

      case OP_SEQ:
      case OP_SEQV:
      case OP_SEQX: {
        const fused = code[ip] === OP_SEQX
        const base = fused ? ip + 3 : ip + 2
        const n = code[fused ? ip + 2 : ip + 1]!
        const values: unknown[] | undefined = code[ip] === OP_SEQV ? undefined : []
        let cur = pos
        for (let i = 0; i < n; i++) {
          const child = code[base + i]!
          if (i > 0 && ctx.trivia !== undefined) {
            const mark = rollbackNeeded(ctx) ? saveTriviaMark(ctx) : null
            let scanEnd: number
            if (needsDeferredTriviaCommit(ctx)) {
              const scan = scanTrivia(input, cur, ctx)
              scan.commit()
              scanEnd = scan.end
            } else {
              scanEnd = advanceTrivia(input, cur, ctx)
            }
            const v = exec(child, input, scanEnd, ctx)
            if (v === FAIL) return FAIL
            if (END > scanEnd) cur = END
            else if (mark !== null) rollbackTrivia(ctx, mark)
            if (values !== undefined) values.push(v)
            continue
          }
          // TERMINAL FAST PATH. Terminals are the majority of executed
          // instructions, and reaching one through `exec` costs a JS call frame
          // plus a switch dispatch that the emitted code does not pay. Running
          // LIT/RX in place removes both. The duplication is in the DRIVER,
          // which ships once for every grammar — the cost this design trades on.
          const cop = code[child]
          if (cop === OP_LIT) {
            const lit = k[code[child + 1]!] as string
            if (!input.startsWith(lit, cur)) {
              ctx._fe = cur; ctx._fx = fx[code[child + 2]!] as string[]
              return FAIL
            }
            const e = cur + lit.length
            if (cstCaptureActive(ctx)) pushLeaf(ctx, lit, cur, e)
            if (values !== undefined) values.push(lit)
            cur = e
            continue
          }
          if (cop === OP_RX) {
            const re = k[code[child + 1]!] as RegExp
            re.lastIndex = cur
            const m = re.exec(input)
            if (m === null) {
              ctx._fe = cur; ctx._fx = fx[code[child + 2]!] as string[]
              return FAIL
            }
            const mv = m[0]
            const e = cur + mv.length
            if (cstCaptureActive(ctx)) pushLeaf(ctx, mv, cur, e)
            if (values !== undefined) values.push(mv)
            cur = e
            continue
          }
          const v = exec(child, input, cur, ctx)
          if (v === FAIL) return FAIL
          if (values !== undefined) values.push(v)
          cur = END
        }
        END = cur
        if (fused) {
          const fn = fns[code[ip + 1]!] as (value: unknown, span: { start: number; end: number }) => unknown
          return fn(values, { start: pos, end: cur })
        }
        return values
      }

      case OP_CHOICE: {
        const d = code[ip + 1]!
        const base = ip + 3
        if (d >= 0) {
          const table = disp[d]!
          const c = lead(input, pos)
          let arm = -1
          if (c >= 0 && c < 128) {
            const a = table.ascii[c]!
            if (a !== 0) arm = a - 1
          } else if (c >= 128) {
            const hi = table.hi
            for (let i = 0; i < hi.length; i += 3) {
              if (c >= hi[i]! && c <= hi[i + 1]!) { arm = hi[i + 2]!; break }
            }
          }
          if (arm >= 0) {
            const v = exec(code[base + arm]!, input, pos, ctx)
            if (v !== FAIL) return v
          }
          const open = table.open
          if (open.length === 0) return FAIL
          const mark: CstRollbackMark | null = rollbackNeeded(ctx) ? saveCstMark(ctx) : null
          if (mark !== null) rollbackCstCapture(ctx, mark)
          for (let i = 0; i < open.length; i++) {
            const v = exec(code[base + open[i]!]!, input, pos, ctx)
            if (v !== FAIL) return v
            if (mark !== null) rollbackCstCapture(ctx, mark)
          }
          return FAIL
        }
        const n = code[ip + 2]!
        const mark: CstRollbackMark | null = rollbackNeeded(ctx) ? saveCstMark(ctx) : null
        for (let i = 0; i < n; i++) {
          const v = exec(code[base + i]!, input, pos, ctx)
          if (v !== FAIL) return v
          if (mark !== null) rollbackCstCapture(ctx, mark)
        }
        return FAIL
      }

      case OP_OPT: {
        const mark: CstRollbackMark | null = rollbackNeeded(ctx) ? saveCstMark(ctx) : null
        const v = exec(code[ip + 1]!, input, pos, ctx)
        if (v === FAIL) {
          if (mark !== null) rollbackCstCapture(ctx, mark)
          END = pos
          // NULL, not undefined. `optional()` yields `null` on no-match
          // (src/combinators/repeat.ts:269,277) and grammars TEST for it:
          // examples/lang's `call` reducer is `if (args === null) return callee`,
          // so `undefined` there turned a bare identifier into a call node with
          // `args: undefined`. The parse succeeded and only the tree moved.
          return null
        }
        return v
      }

      case OP_REP:
      case OP_REPV: {
        const child = code[ip + 1]!
        const min = code[ip + 2]!
        const max = code[ip + 3]!
        const sep = code[ip + 4]!
        // bit 1 of the flags word: the author opted into keeping separators in
        // `children`. Absent, a list contributes its ITEMS and nothing else.
        const keepSeparators = (code[ip + 5]! & 2) !== 0
        const out: unknown[] | undefined = code[ip] === OP_REP ? [] : undefined
        const hasTrivia = ctx.trivia !== undefined
        const needMark = rollbackNeeded(ctx)
        let cur = pos
        let count = 0
        for (;;) {
          if (max >= 0 && count >= max) break
          // One mark pair for the whole loop when a rollback is even possible,
          // refreshed per iteration rather than reallocated.
          const cmark = needMark ? saveCstMark(ctx) : null
          const tmark = needMark ? saveTriviaMark(ctx) : null
          let itemStart = cur
          if (sep >= 0 && count > 0) {
            // separator, with trivia on BOTH sides — mirrors repeat.ts's sepBy loop
            const leavesBefore = cstLeavesLen(ctx)
            let sp = cur
            if (hasTrivia) sp = skipTrivia(input, sp, ctx)
            const sv = exec(sep, input, sp, ctx)
            if (sv === FAIL) {
              if (tmark !== null) rollbackTrivia(ctx, tmark)
              if (cmark !== null) rollbackCstCapture(ctx, cmark)
              break
            }
            // Demote the separator out of `children`, exactly where the
            // interpreter does it (src/combinators/repeat.ts, sepBy loop).
            if (!keepSeparators) demoteCapturedToRaw(ctx, leavesBefore)
            itemStart = hasTrivia ? skipTrivia(input, END, ctx) : END
          } else if (hasTrivia) {
            // Trivia precedes EVERY item, the first included: `repItem` in
            // repeat.ts does this, and skipping it only for later items dropped
            // exactly one trivia-log entry per repetition — invisible in the
            // parse, visible in a node's `triviaLog`.
            itemStart = skipTrivia(input, itemStart, ctx)
          }
          // Nothing but trivia left: don't speculatively parse an item at EOF.
          if (itemStart >= input.length) {
            if (tmark !== null) rollbackTrivia(ctx, tmark)
            if (cmark !== null) rollbackCstCapture(ctx, cmark)
            break
          }
          const v = exec(child, input, itemStart, ctx)
          if (v === FAIL) {
            if (tmark !== null) rollbackTrivia(ctx, tmark)
            if (cmark !== null) rollbackCstCapture(ctx, cmark)
            break
          }
          if (END === itemStart) {
            // Zero-width item: it cannot make progress, so stop without taking it.
            if (tmark !== null) rollbackTrivia(ctx, tmark)
            if (cmark !== null) rollbackCstCapture(ctx, cmark)
            break
          }
          if (out !== undefined) out.push(v)
          cur = END
          count++
        }
        if (count < min) return FAIL
        END = cur
        return out
      }

      case OP_XFORM: {
        const v = exec(code[ip + 2]!, input, pos, ctx)
        if (v === FAIL) return FAIL
        const fn = fns[code[ip + 1]!] as (value: unknown, span: { start: number; end: number }) => unknown
        return fn(v, { start: pos, end: END })
      }

      case OP_LEAF: {
        const v = exec(code[ip + 2]!, input, pos, ctx)
        if (v === FAIL) return FAIL
        const end = END
        const fn = fns[code[ip + 1]!] as (value: unknown, span: { start: number; end: number }) => unknown
        const out = fn(v, { start: pos, end })
        END = end
        return out
      }

      case OP_NODE:
      case OP_NODE_TRACK: {
        const flags = code[ip + 3]!
        const saved = beginCstNodeCapture(ctx)
        const savedFields = ctx._fields
        ctx._fields = (flags & 16) !== 0 ? [] : undefined
        if ((flags & 4) === 0) ctx.captureTrivia = false
        const v = exec(code[ip + 2]!, input, pos, ctx)
        // `trailingTrivia` runs INSIDE the capture scope, before the node's log is
        // closed, so the run lands in THIS node rather than the parent's. That is
        // the order src/combinators/node.ts uses and it is observable.
        if (v !== FAIL && (flags & 128) !== 0 && ctx.trivia !== undefined) END = consumeTrivia(input, END, ctx)
        const fieldMap: FieldMap | undefined = (flags & 16) !== 0 ? buildFieldMap(ctx._fields) : undefined
        ctx._fields = savedFields
        const cap = endCstNodeCapture(ctx, saved)
        if (v === FAIL) return FAIL
        const end = END
        const span = code[ip] === OP_NODE_TRACK ? spanLines(ctx, pos, end) : { start: pos, end }
        const st = (flags & 8) !== 0 && ctx.state !== undefined
          ? Object.assign({}, ctx.state as Record<string, unknown>)
          : undefined

        // RESULT SELECTION, in the interpreter's order (node.ts): unwrap, then
        // collapse, then project, then the builder. `unwrap`/`collapse` apply
        // ONLY at exactly one captured child — zero or two-plus fall through to
        // the builder, which is why the arity test is here and not at encode time.
        const kids = cap.children
        const proj = code[ip + 4]!
        let nd: unknown
        if ((flags & 64) !== 0 && kids.length === 1) {
          nd = unwrapChild(kids[0])
        } else if ((flags & 32) !== 0 && kids.length === 1) {
          nd = kids[0]
        } else if (proj >= 0) {
          nd = projectChild(kids, proj, k[code[ip + 5]!] as string)
        } else if (code[ip + 1]! >= 0) {
          const build = fns[code[ip + 1]!] as (
            children: readonly unknown[], fields: FieldMap | undefined, span: { start: number; end: number },
            rawChildren: readonly unknown[], triviaLog: readonly number[], state: unknown,
          ) => unknown
          nd = build(kids, fieldMap, span, cap.rawChildren, (flags & 4) !== 0 ? cap.triviaLog : EMPTY_TL, st)
        } else {
          // A `collapse`/`unwrap` node that captured zero or two-plus children
          // has no selection to make and no builder to call. The interpreter
          // falls through to the DEFAULT CST node here (node.ts, the `ctx.build`
          // host being absent), and so does this. Getting it wrong would only
          // show on the arity the collapse does not cover, which is exactly the
          // input a hand-picked test case misses.
          nd = { _tag: 'node', type: k[code[ip + 5]!] as string, span, state: st ?? null, children: kids }
        }
        pushCstChild(ctx, nd, rawEntry(nd, input, pos, end))
        END = end
        return nd
      }

      case OP_NOT: {
        const mark: CstRollbackMark | null = rollbackNeeded(ctx) ? saveCstMark(ctx) : null
        const v = exec(code[ip + 1]!, input, pos, ctx)
        if (mark !== null) rollbackCstCapture(ctx, mark)
        if (v === FAIL) { END = pos; return null }
        ctx._fe = pos
        return FAIL
      }

      case OP_PEEK: {
        const mark: CstRollbackMark | null = rollbackNeeded(ctx) ? saveCstMark(ctx) : null
        const v = exec(code[ip + 1]!, input, pos, ctx)
        if (mark !== null) rollbackCstCapture(ctx, mark)
        if (v === FAIL) return FAIL
        END = pos
        return null
      }

      default:
        throw new Error(`table driver: unknown opcode ${String(code[ip])} at ${ip}`)
    }
  }

  return { exec, end: () => END }
}

/**
 * Turn a program into the rule map a compiled artifact exports.
 *
 * The entries have the SAME signature as codegen rule functions, so `run()`,
 * the linker's public wrappers and every consumer are unchanged.
 */
export function tableRules(source: TableProgram | CompactProgram): Record<string, TableRule> {
  const prog = expandCompact(source)
  const t = resolveTable(prog)
  const d = makeDriver(t.code, t.k, t.fns, t.cc, t.fx, t.disp, t.dsp)
  const out: Record<string, TableRule> = {}
  // Chosen ONCE, from table data, at rule-map construction. Not a per-parse
  // branch on an option: a plain table never has this wrapper at all.
  const lines = prog.lines === 1
  for (const name of Object.keys(prog.rules)) {
    const entry = prog.rules[name]!
    out[name] = (input: string, pos: number, ctx: ParseContext): ParseResult<unknown> => {
      // FAIL CLOSED on the two runtime options this driver has no path for.
      // Both are silent divergences otherwise, not errors: a `ctx.build` host is
      // supposed to REPLACE the node's own builder (that is what `hostMode:'cst'`
      // means in the compiled engine), and this driver always calls the builder;
      // root-trivia capture needs a `_rootTriviaLog` this driver never writes.
      // Neither is detectable at encode time — they arrive with the parse.
      if (ctx.build !== undefined) {
        throw new Error('parseman/table: a ctx.build host is not supported by the table driver yet — the node builder would run instead of the host, silently. Use the compiled path for host-mode parses.')
      }
      if (ctx._rootTriviaLog !== undefined) {
        throw new Error('parseman/table: run({ rootTrivia }) is not supported by the table driver yet — no root trivia would be captured, silently.')
      }
      ctx._fe = -1
      ctx._fx = EMPTY_FX
      if (lines && ctx._lineStarts === undefined) { ctx._lineStarts = [0]; ctx._lineScannedTo = 0 }
      const v = d.exec(entry, input, pos, ctx)
      if (v === FAIL) {
        const fe = ctx._fe
        const at = fe === undefined || fe < 0 ? pos : fe
        return { ok: false, expected: (ctx._fx ?? EMPTY_FX) as string[], span: { start: at, end: at } }
      }
      return { ok: true, value: v, span: { start: pos, end: d.end() } }
    }
  }
  return out
}
