import type { ParseContext, ParseResult } from '../types.ts'
import { advanceTrivia, needsDeferredTriviaCommit, rollbackTrivia, saveTriviaMark, scanTrivia } from '../combinators/trivia-skip.ts'
import {
  beginCstNodeCapture, cstCaptureActive, endCstNodeCapture, pushCstChild,
  pushCstLeaf, rollbackCstCapture, saveCstMark, type CstRollbackMark,
} from '../cst/capture-buffer.ts'
import {
  OP_CHOICE, OP_EMPTY, OP_GATE, OP_LEAF, OP_LIT, OP_NODE, OP_NOT, OP_OPT,
  OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX, OP_SEQ, OP_SEQV, OP_XFORM,
  OP_LIT_TRACK, OP_RX_TRACK, OP_NODE_TRACK, OP_SCOPE, OP_EXPECT,
} from './ops.ts'
import {
  expandCompact, resolveTable,
  type CompactProgram, type ResolvedClass, type ResolvedDispatch, type TableProgram, type TableRule,
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

      case OP_SCOPE: {
        const ki = code[ip + 1]!
        const saved = ctx.trivia
        ctx.trivia = ki < 0 ? undefined : (k[ki] as ParseContext['trivia'])
        const v = exec(code[ip + 2]!, input, pos, ctx)
        ctx.trivia = saved
        return v
      }

      case OP_SEQ:
      case OP_SEQV: {
        const n = code[ip + 1]!
        const values: unknown[] | undefined = code[ip] === OP_SEQ ? [] : undefined
        let cur = pos
        for (let i = 0; i < n; i++) {
          const child = code[ip + 2 + i]!
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
            let sp = cur
            if (hasTrivia) sp = skipTrivia(input, sp, ctx)
            const sv = exec(sep, input, sp, ctx)
            if (sv === FAIL) {
              if (tmark !== null) rollbackTrivia(ctx, tmark)
              if (cmark !== null) rollbackCstCapture(ctx, cmark)
              break
            }
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
        // `flags` bit 2 = the builder reads `triviaLog`. Decided by
        // `src/table/encode.ts` from the reducer's arity — the SAME analysis
        // codegen runs — and baked into the row, so the driver reads a bit
        // rather than re-deriving anything.
        const flags = code[ip + 3]!
        const saved = beginCstNodeCapture(ctx)
        if ((flags & 4) === 0) ctx.captureTrivia = false
        const v = exec(code[ip + 2]!, input, pos, ctx)
        const cap = endCstNodeCapture(ctx, saved)
        if (v === FAIL) return FAIL
        const end = END
        const build = fns[code[ip + 1]!] as (
          children: readonly unknown[], fields: undefined, span: { start: number; end: number },
          rawChildren: readonly unknown[], triviaLog: readonly number[], state: unknown,
        ) => unknown
        const st = (flags & 8) !== 0 && ctx.state !== undefined
          ? Object.assign({}, ctx.state as Record<string, unknown>)
          : undefined
        const nd = build(
          cap.children, undefined,
          code[ip] === OP_NODE_TRACK ? spanLines(ctx, pos, end) : { start: pos, end },
          cap.rawChildren, (flags & 4) !== 0 ? cap.triviaLog : EMPTY_TL, st,
        )
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
export function tableRulesBaseline(source: TableProgram | CompactProgram): Record<string, TableRule> {
  const prog = expandCompact(source)
  const t = resolveTable(prog)
  const d = makeDriver(t.code, t.k, t.fns, t.cc, t.fx, t.disp)
  const out: Record<string, TableRule> = {}
  // Chosen ONCE, from table data, at rule-map construction. Not a per-parse
  // branch on an option: a plain table never has this wrapper at all.
  const lines = prog.lines === 1
  for (const name of Object.keys(prog.rules)) {
    const entry = prog.rules[name]!
    out[name] = (input: string, pos: number, ctx: ParseContext): ParseResult<unknown> => {
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
