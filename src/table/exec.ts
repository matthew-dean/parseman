import type { Combinator, FieldMap, FirstSet, ParseContext, ParseResult, ParserDef } from '../types.ts'
import { balanced, scanTo } from '../combinators/scanTo.ts'
import { buildFieldMap } from '../compiler/fields.ts'
import { asciiFoldKey, matchesDispatchMatcher } from '../combinators/dispatch.ts'
import { projectChild, unwrapChild } from '../combinators/node.ts'
import { asciiFoldEq } from '../combinators/literal.ts'
import { cstOutputHost } from '../compiler/build-arity.ts'
import { consumeTrivia } from '../combinators/trivia-skip.ts'
import type { DispatchMatcherKind } from '../types.ts'
import { advanceTrivia, needsDeferredTriviaCommit, rollbackTrivia, rollbackTriviaAt, saveTriviaMark, scanTrivia, type FastTriviaScanner } from '../combinators/trivia-skip.ts'
import {
  beginCstNodeCapture, cstCaptureActive, cstLeavesLen, cstRawLen, cstTlLen,
  demoteCapturedToRaw, endCstNodeCapture, pushCstChild, pushCstLeaf,
  rollbackCstCaptureAt,
} from '../cst/capture-buffer.ts'
import {
  OP_CHOICE, OP_EMPTY, OP_GATE, OP_LEAF, OP_LIT, OP_NODE, OP_NOT, OP_OPT,
  OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX, OP_SEQ, OP_SEQV, OP_XFORM,
  OP_LIT_TRACK, OP_RX_TRACK, OP_NODE_TRACK, OP_SCOPE, OP_SCOPE_CAP, OP_EXPECT, OP_SEQX, OP_SCAN,
  OP_FIELD, OP_DISPATCH, OP_ROUTED, OP_LIT_CI, OP_LIT_CI_TRACK, OP_TOKEN, OP_WITHCTX, OP_GUARD,
  OP_GREEDY, OP_REJECT,
} from './ops.ts'
import { stampRuleMap } from './stamp.ts'
import {
  expandCompact, resolveTable,
  type CompactProgram, type ResolvedClass, type ResolvedDispatch, type ResolvedDispatchSpec,
  type SubtreeRef, type TableProgram, type TableRule,
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

/**
 * DIAGNOSTIC ROW COUNTER — off unless `PM_TABLE_COUNT=1` at process start.
 *
 * Read ONCE, at module load, into a module const, so this is not the per-parse
 * option branch G5 forbids: with the variable false the whole thing folds away
 * after tier-up. It exists because "too many rows" and "each row too slow" are
 * different defects with the same symptom, and only a count separates them.
 * No timing run in this repo may set it — see `bench/jess/table-rows.ts`.
 */
export const tableCounters: {
  rows: number
  byOp: Int32Array
  /** Distinct reducer/host functions actually reaching each shared call site. */
  sites: Map<string, Set<unknown>>
  /**
   * SPECULATION AT UNGATED CHOICES. `encode.ts:368-376` gives a choice its
   * first-char dispatch only when NO arm is nullable, ALL arms are pairwise
   * disjoint and ALL map to a char class; any one failure ungates every arm of
   * the site, which then runs the linear loop below. Codegen has no such
   * all-or-nothing rule — `emitFirstMatch` guards each arm on its OWN first set
   * — so these counts are work the table does and the compiled engine does not.
   *
   * `ungatedEntries` is arms entered there; `ungatedFails` is those that then
   * failed, which is pure waste by construction: a failing arm consumed nothing
   * the winning arm will not scan again.
   */
  ungatedEntries: number
  ungatedFails: number
  /** Rows executed INSIDE failed ungated arms — the subtree each wasted entry drags. */
  ungatedFailRows: number
  gatedEntries: number
  /** Arm entries DECLINED by the per-arm class gate — the work this change removes. */
  armGateSkips: number
} = { rows: 0, byOp: new Int32Array(64), sites: new Map(), ungatedEntries: 0, ungatedFails: 0, ungatedFailRows: 0, gatedEntries: 0, armGateSkips: 0 }

const COUNT = process.env.PM_TABLE_COUNT === '1'

function siteFn(site: string, fn: unknown): void {
  let s = tableCounters.sites.get(site)
  if (s === undefined) { s = new Set(); tableCounters.sites.set(site, s) }
  s.add(fn)
}

export function resetTableCounters(): void {
  tableCounters.rows = 0
  tableCounters.byOp = new Int32Array(64)
  tableCounters.sites = new Map()
  tableCounters.ungatedEntries = 0
  tableCounters.ungatedFails = 0
  tableCounters.ungatedFailRows = 0
  tableCounters.gatedEntries = 0
  tableCounters.armGateSkips = 0
}

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

/**
 * Did something inside CUT?
 *
 * Read through a call so TypeScript does not narrow `_fc` to `false` from the
 * assignment that precedes each speculative attempt — `exec` mutates it and the
 * checker cannot see that.
 */
function committed(c: ParseContext): boolean {
  return c._fc === true
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
  /** Per-parse reset of the trivia leaf swap. See `begin` in `makeDriver`. */
  begin: (ctx: ParseContext) => void
  /** Ambient `scanSkip` sets, rebuilt from `prog.scanSkip`, indexed as encoded. */
  scanSkip: readonly (readonly Combinator<unknown>[])[]
}

function makeDriver(
  code: Int32Array,
  k: readonly unknown[],
  fns: readonly unknown[],
  cc: readonly ResolvedClass[],
  fx: readonly (readonly string[])[],
  disp: readonly ResolvedDispatch[],
  dsp: readonly ResolvedDispatchSpec[],
  trivia: readonly unknown[],
  triviaScan: readonly (FastTriviaScanner | null)[],
  triviaLabelled: readonly boolean[],
  prog: TableProgram,
): Driver {
  /** Shared end-position out-parameter (`_pfEnd` in emitted code). */
  let END = 0

  /**
   * THE INSTALLED TRIVIA LEAF — G5's *"some swaps on rules or sub-rules
   * (leafs)"*, which is the half of that sentence the driver had not honoured.
   *
   * `SCAN` is the SPECIALISED scanner for the trivia currently in scope, chosen
   * once at `OP_SCOPE` from `triviaScan` and null when no swap is legal. The
   * generic path it replaces called `advanceTrivia` per sequence term, and that
   * function re-derived the scanner through a WeakMap and re-tested the same
   * options on every call — for json that was 22.0% of the table's time against
   * codegen's 6.1% for the identical work.
   *
   * `FAST` is the one condition that is a property of the PARSE rather than of
   * the scope (`ctx.trackLines`, fixed by `run()` at entry), so it is read once
   * per parse in the entry wrapper and folded into `SCAN` at each scope. Nothing
   * on the term path consults the table or an option.
   */
  let SCAN: FastTriviaScanner | null = null
  let FAST = false
  /**
   * Is this parse's host a CST-output host? `ctx.build` is fixed by `run()` before
   * the entry is called, so this is a PER-PARSE constant that `OP_NODE` was
   * re-deriving on every node. Decided once in `begin`.
   */
  let HOSTCST = false

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
  /**
   * Skip trivia at `cur`, through the INSTALLED leaf when one is installed.
   *
   * The guard is the exact condition under which the generic functions take
   * their own fast branch, restated over context fields so it costs loads rather
   * than a call:
   *
   *   - `advanceTrivia` (no deferred commit) runs `fast(input, cur)` whenever a
   *     scanner exists and `trackLines` is off — folded into `SCAN` already.
   *   - `scanTrivia` (deferred commit) runs it and returns a NO-OP commit when
   *     `_triviaLog` is unset and nothing is capturing trivia into a CST buffer.
   *     `_rootTriviaLog` is deliberately absent from this test: root rows are
   *     only ever written on the LABELLED scan path (see `OP_SCOPE`), and a
   *     labelled trivia never gets a `SCAN` installed.
   *
   * Anything outside that falls through to the shared implementations unchanged,
   * so recording, labels and line tracking keep exactly one implementation.
   */
  function skipTrivia(input: string, cur: number, ctx: ParseContext): number {
    const s = SCAN
    if (s !== null
      && ctx._triviaLog === undefined
      && !(ctx.captureTrivia === true && (ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined))) {
      return s(input, cur)
    }
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
    if (COUNT) { tableCounters.rows++; tableCounters.byOp[code[ip]!]!++ }
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
      case OP_LIT_CI:
      case OP_LIT_CI_TRACK: {
        const s = k[code[ip + 1]!] as string
        const e = pos + s.length
        // Yields the INPUT's casing (literal.ts:86), not the literal's — a node
        // built from this carries the source text, and normalising it here would
        // silently rewrite the user's CSS.
        const matched = input.slice(pos, e)
        if (asciiFoldEq(matched, s)) {
          if (cstCaptureActive(ctx)) pushLeaf(ctx, matched, pos, e)
          if (code[ip] === OP_LIT_CI_TRACK) trackLines(ctx, input, e)
          END = e
          return matched
        }
        ctx._fe = pos; ctx._fx = fx[code[ip + 2]!] as string[]
        return FAIL
      }
      case OP_EMPTY:
        END = pos
        return ''

      case OP_GUARD: {
        if ((fns[code[ip + 1]!] as (s: unknown) => boolean)(ctx.state)) {
          END = pos
          return null
        }
        ctx._fe = pos; ctx._fx = fx[code[ip + 2]!] as string[]
        return FAIL
      }

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

      case OP_TOKEN: {
        // Mirrors src/combinators/token.ts:21-65 exactly, including that
        // `_triviaLog`/`_rootTriviaLog` are DELETED rather than set undefined
        // and restored by presence, and that the leaf is pushed only when the
        // caller was capturing BEFORE the sinks were cleared.
        const sTrivia = ctx.trivia, sKinds = ctx.triviaKindLabels
        const sBuf = ctx._cstBuf, sChildren = ctx._cstChildren, sLeaves = ctx._cstLeaves
        const sRaw = ctx._cstRawChildren, sTl = ctx._cstTriviaLog
        const sOuterTl = ctx._triviaLog, sRootTl = ctx._rootTriviaLog
        const wasCapturing = cstCaptureActive(ctx)

        const sScan = SCAN
        SCAN = null
        ctx.trivia = undefined
        ctx.triviaKindLabels = undefined
        ctx._cstBuf = undefined
        ctx._cstChildren = undefined
        ctx._cstLeaves = undefined
        ctx._cstRawChildren = undefined
        ctx._cstTriviaLog = undefined
        ctx._triviaLog = undefined
        ctx._rootTriviaLog = undefined

        let v: unknown
        try {
          v = exec(code[ip + 1]!, input, pos, ctx)
        } finally {
          SCAN = sScan
          ctx.trivia = sTrivia
          ctx.triviaKindLabels = sKinds
          ctx._cstBuf = sBuf
          ctx._cstChildren = sChildren
          ctx._cstLeaves = sLeaves
          ctx._cstRawChildren = sRaw
          ctx._cstTriviaLog = sTl
          ctx._triviaLog = sOuterTl
          ctx._rootTriviaLog = sRootTl
        }
        if (v === FAIL) return FAIL
        const end = END
        const value = input.slice(pos, end)
        if (wasCapturing) pushCstLeaf(ctx, { _tag: 'leaf', value, span: { start: pos, end } })
        END = end
        return value
      }

      case OP_SCAN: {
        const c = scans[code[ip + 1]!]!
        const r = c.parse(input, pos, ctx)
        if (!r.ok) {
          ctx._fe = r.span.start
          ctx._fx = (r.expected ?? EMPTY_FX) as string[]
          return FAIL
        }
        END = r.span.end
        return r.value
      }

      case OP_WITHCTX: {
        const saved = ctx.state
        ctx.state = k[code[ip + 1]!]
        try { return exec(code[ip + 2]!, input, pos, ctx) }
        finally { ctx.state = saved }
      }

      case OP_SCOPE:
      case OP_SCOPE_CAP: {
        const ki = code[ip + 1]!
        const saved = ctx.trivia
        const savedLabels = ctx.triviaKindLabels
        const scopeTrivia = ki < 0 ? undefined : (trivia[ki] as ParseContext['trivia'])
        const savedScan = SCAN
        // THE SWAP. Chosen from table data at scope entry, never per term. A
        // labelled trivia is excluded here rather than tested later: `scanTrivia`
        // suppresses its own fast path when labels are present, so a swap there
        // would drop the labelled records silently.
        SCAN = FAST && ki >= 0 && !triviaLabelled[ki]! ? triviaScan[ki]! : null
        ctx.trivia = scopeTrivia
        // A scope installs its trivia's KIND LABELS too. Root-trivia rows are
        // only ever written on the labelled scan path (trivia-skip.ts:212) — the
        // unlabelled fast scanner returns before any root logging and does not
        // even test `_rootTriviaLog` — so a scope that sets trivia without its
        // labels captures NOTHING at the root, silently.
        ctx.triviaKindLabels = scopeTrivia?._meta.triviaKindLabels
        // SCOPE_CAP additionally turns capture ON for the child. It is an OR with
        // whatever the enclosing context already asked for (`grammar.ts:129`), so
        // the RESTORE puts the saved value back rather than writing `false` — an
        // inner scope must not switch an outer capture off.
        const savedCap = ctx.captureTrivia
        if (code[ip] === OP_SCOPE_CAP) ctx.captureTrivia = true
        const v = exec(code[ip + 2]!, input, pos, ctx)
        ctx.captureTrivia = savedCap
        ctx.trivia = saved
        ctx.triviaKindLabels = savedLabels
        SCAN = savedScan
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
            // SCALAR MARKS — `saveTriviaMark` allocated TWICE per term (its own
            // seven-field object plus the five-field CST mark it delegates to).
            const need = rollbackNeeded(ctx)
            const mRaw = need ? cstRawLen(ctx) : 0
            const mTl = need ? cstTlLen(ctx) : 0
            const mLv = need ? cstLeavesLen(ctx) : 0
            const mFl = need ? ctx._fields?.length ?? 0 : 0
            const mEr = need ? ctx._errors?.length ?? 0 : 0
            const mLog = need ? ctx._triviaLog?.length ?? 0 : 0
            const mRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
            const scanEnd = skipTrivia(input, cur, ctx)
            const v = exec(child, input, scanEnd, ctx)
            if (v === FAIL) return FAIL
            if (END > scanEnd) cur = END
            else if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
            if (values !== undefined) values.push(v)
            continue
          }
          // TERMINAL FAST PATH. Terminals are the majority of executed
          // instructions, and reaching one through `exec` costs a JS call frame
          // plus a switch dispatch that the emitted code does not pay. Running
          // LIT/RX in place removes both. The duplication is in the DRIVER,
          // which ships once for every grammar — the cost this design trades on.
          const cop = code[child]
          // The two inline terminals below execute a ROW without going through
          // `exec`, so the counter has to see them or the row count understates
          // exactly where the driver already won.
          if (COUNT && (cop === OP_LIT || cop === OP_RX)) { tableCounters.rows++; tableCounters.byOp[cop]!++ }
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
          if (COUNT) siteFn('SEQX fn()', fn)
          return fn(values, { start: pos, end: cur })
        }
        return values
      }

      case OP_CHOICE: {
        const d = code[ip + 1]!
        const base = ip + 4
        const choiceFx = fx[code[ip + 3]!] as string[]
        // Report the union, at the choice's own position, on every exit that
        // fails — matching both engines and, more importantly, never handing a
        // user an empty expected set.
        const failChoice = (): typeof FAIL => {
          ctx._fe = pos
          ctx._fx = choiceFx
          return FAIL
        }
        const table = disp[d]!
        const c = lead(input, pos)
        if (table.exclusive) {
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
            ctx._fc = false
            if (COUNT) tableCounters.gatedEntries++
            const v = exec(code[base + arm]!, input, pos, ctx)
            if (v !== FAIL) return v
            // THE CUT. `dispatch()` is the library's one true cut: once its
            // selector matched, a failing branch must fail the whole choice
            // rather than let a later arm re-recognise the same text. The flag
            // was being SET by OP_DISPATCH and read by nobody, so the table
            // accepted input both shipped engines reject.
            if (committed(ctx)) return FAIL
          }
          const open = table.open
          if (open.length === 0) return failChoice()
          // SCALAR MARKS. `saveCstMark` allocated a five-field object per choice
          // attempt; the compiled engine keeps the same five numbers in locals and
          // allocates nothing. Same values, same rollback, no garbage.
          const need = rollbackNeeded(ctx)
          const mRaw = need ? cstRawLen(ctx) : 0
          const mTl = need ? cstTlLen(ctx) : 0
          const mLv = need ? cstLeavesLen(ctx) : 0
          const mFl = need ? ctx._fields?.length ?? 0 : 0
          const mEr = need ? ctx._errors?.length ?? 0 : 0
          if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
          for (let i = 0; i < open.length; i++) {
            ctx._fc = false
            const v = exec(code[base + open[i]!]!, input, pos, ctx)
            if (v !== FAIL) return v
            if (committed(ctx)) return FAIL
            if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
          }
          return failChoice()
        }
        // THE PER-ARM GATE. Arms in source order, each skipped when its own
        // class excludes the char at `pos`. Order is untouched, so this is not a
        // reordering: it only declines to enter arms that provably cannot match.
        // A `null` class means nullable or unmappable, and those are always
        // entered.
        const n = code[ip + 2]!
        const armCls = table.armCls
        const need = rollbackNeeded(ctx)
        const mRaw = need ? cstRawLen(ctx) : 0
        const mTl = need ? cstTlLen(ctx) : 0
        const mLv = need ? cstLeavesLen(ctx) : 0
        const mFl = need ? ctx._fields?.length ?? 0 : 0
        const mEr = need ? ctx._errors?.length ?? 0 : 0
        for (let i = 0; i < n; i++) {
          const cls = armCls[i]
          if (cls !== undefined && cls !== null && !classHas(cls, c)) {
            if (COUNT) tableCounters.armGateSkips++
            continue
          }
          ctx._fc = false
          if (COUNT) tableCounters.ungatedEntries++
          const rows0 = COUNT ? tableCounters.rows : 0
          const v = exec(code[base + i]!, input, pos, ctx)
          if (v !== FAIL) return v
          if (COUNT) { tableCounters.ungatedFails++; tableCounters.ungatedFailRows += tableCounters.rows - rows0 }
          if (committed(ctx)) return FAIL
          if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
        }
        return failChoice()
      }

      case OP_GREEDY: {
        // The mark is taken BEFORE the super arm runs: the classified path
        // unwinds the regex's leaf and lets the credited literal arm push its
        // own, so exactly one leaf survives — same text, same span.
        const need = rollbackNeeded(ctx)
        const mRaw = need ? cstRawLen(ctx) : 0
        const mTl = need ? cstTlLen(ctx) : 0
        const mLv = need ? cstLeavesLen(ctx) : 0
        const mFl = need ? ctx._fields?.length ?? 0 : 0
        const mEr = need ? ctx._errors?.length ?? 0 : 0
        const sup = exec(code[ip + 1]!, input, pos, ctx)
        // choice.ts:126 — the super arm's failure is returned VERBATIM, so `_fe`
        // and `_fx` are left exactly as it set them.
        if (sup === FAIL) return FAIL
        const end = END
        const word = input.slice(pos, end)
        const n = code[ip + 2]!
        for (let i = 0; i < n; i++) {
          if (k[code[ip + 3 + 2 * i]!] !== word) continue
          if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
          // Cannot fail: `word` IS this arm's case-sensitive literal at `pos`.
          return exec(code[ip + 4 + 2 * i]!, input, pos, ctx)
        }
        END = end
        return sup
      }

      case OP_REJECT: {
        const v = exec(code[ip + 1]!, input, pos, ctx)
        if (v === FAIL) return FAIL
        const end = END
        const n = code[ip + 2]!
        for (let i = 0; i < n; i++) {
          const o = code[ip + 4 + 2 * i]!
          const fires = code[ip + 3 + 2 * i]! === 0
            ? input.startsWith(k[o] as string, end)
            : classHas(cc[o]!, lead(input, end))
          if (!fires) continue
          // choice.ts:161-164 is a `continue`, not a failure: the arm is treated
          // as never entered, so a cut it raised must not survive to cut the
          // choice. The choice does the capture-sink rollback, as for any arm.
          ctx._fc = false
          return FAIL
        }
        END = end
        return v
      }

      case OP_OPT: {
        const need = rollbackNeeded(ctx)
        const mRaw = need ? cstRawLen(ctx) : 0
        const mTl = need ? cstTlLen(ctx) : 0
        const mLv = need ? cstLeavesLen(ctx) : 0
        const mFl = need ? ctx._fields?.length ?? 0 : 0
        const mEr = need ? ctx._errors?.length ?? 0 : 0
        ctx._fc = false
        const v = exec(code[ip + 1]!, input, pos, ctx)
        if (v === FAIL) {
          // repeat.ts:277 — `optional()` propagates a committed failure rather
          // than reporting "absent".
          if (committed(ctx)) return FAIL
          if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
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
        // BIT 0 WAS WRITTEN AND NEVER READ. `sepBy({ trailing: 'allow' })` keeps
        // a separator that is not followed by an item, so `a,b,` consumes to 4;
        // ignoring the bit stopped at 3 while both shipped engines went to 4.
        const trailingAllowed = (code[ip + 5]! & 1) !== 0
        const out: unknown[] | undefined = code[ip] === OP_REP ? [] : undefined
        const hasTrivia = ctx.trivia !== undefined
        const needMark = rollbackNeeded(ctx)
        // WHO OWNS THE TRIVIA IN FRONT OF THE FIRST ITEM. Only `many()` — the
        // min-0, separator-less repeat — runs its first item through `repItem`
        // and therefore skips leading trivia (src/combinators/repeat.ts:130-137).
        // `oneOrMore`/`atLeast` (:203) and `sepBy` (:412) both parse the first
        // item AT `pos`, because leading trivia there is the ENCLOSING context's
        // responsibility. `many` is the only OP_REP with no separator and min 0,
        // so the shape identifies itself and no extra flag is needed.
        const skipBeforeFirst = sep < 0 && min === 0
        let cur = pos
        let count = 0
        for (;;) {
          if (max >= 0 && count >= max) break
          // A SEPARATED list is bounded by its SEPARATOR, so it stops at EOF at the
          // LOOP HEAD — `while (cur < input.length)` at repeat.ts's sepBy loop. The
          // `repItem` early-out below sits after the separator, a different
          // position, and standing in for this one dropped the item following a
          // final separator. Held to `count >= min`: a list still short of `min`
          // must attempt the separator so its failure sets the expected set, which
          // is the only thing an under-`min` list has to report.
          if (sep >= 0 && count > 0 && count >= min && cur >= input.length) break
          // One mark pair for the whole loop when a rollback is even possible,
          // refreshed per iteration rather than reallocated.
          // SCALAR MARKS. This loop took TWO allocations per item (a CST mark and
          // a trivia mark, the latter allocating a second one internally) — the
          // per-item allocation an earlier lane hunted on json and could not
          // replicate, because json builds almost no nodes and so never sets
          // `_cstBuf`, which is what makes `needMark` true for a whole parse.
          const mRaw = needMark ? cstRawLen(ctx) : 0
          const mTl = needMark ? cstTlLen(ctx) : 0
          const mLv = needMark ? cstLeavesLen(ctx) : 0
          const mFl = needMark ? ctx._fields?.length ?? 0 : 0
          const mEr = needMark ? ctx._errors?.length ?? 0 : 0
          const mLog = needMark ? ctx._triviaLog?.length ?? 0 : 0
          const mRoot = needMark ? ctx._rootTriviaLog?.length ?? 0 : 0
          let itemStart = cur
          let sepEnd = -1
          // WHICH ITEMS `repItem` ACTUALLY PARSES — the scope of every rule below
          // that was copied from it. `many` runs ALL its items through `repItem`;
          // `oneOrMore`/`atLeast` parse the mandatory first at `pos` themselves
          // (repeat.ts:203) and `sepBy` parses BOTH its first item (:412) and
          // every post-separator item (:481) itself, so a separated list never
          // reaches `repItem` at all. The trivia branch below already encodes this
          // (its `else if` is unreachable for `sep >= 0`); the two guards after it
          // did not, and applied `repItem`'s rules to items that never run it.
          //
          // `count >= min` extends that to ALL of `atLeast`'s mandatory items, not
          // just its first: items 2..min go through `repItem` (repeat.ts:213) but as
          // MANDATORY, which holds off both of its loop-termination stops. Without
          // it a `{ min: 2 }` repeat over a NULLABLE item stopped on the required
          // second item and then failed `count < min` — never satisfiable at all,
          // where the compiled engine yields the n-item derivation. `min === 0`
          // makes the clause vacuous, so `many()` is untouched.
          const viaRepItem = sep < 0 && count >= min && (count > 0 || skipBeforeFirst)
          if (sep >= 0 && count > 0) {
            // separator, with trivia on BOTH sides — mirrors repeat.ts's sepBy loop
            const leavesBefore = cstLeavesLen(ctx)
            let sp = cur
            if (hasTrivia) sp = skipTrivia(input, sp, ctx)
            ctx._fc = false
            const sv = exec(sep, input, sp, ctx)
            if (sv === FAIL) {
              if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              if (committed(ctx)) return FAIL
              break
            }
            // Demote the separator out of `children`, exactly where the
            // interpreter does it (src/combinators/repeat.ts, sepBy loop).
            if (!keepSeparators) demoteCapturedToRaw(ctx, leavesBefore)
            sepEnd = END
            itemStart = hasTrivia ? skipTrivia(input, END, ctx) : END
          } else if (hasTrivia && (count > 0 || skipBeforeFirst)) {
            // Trivia precedes every item a `repItem` loop parses, the first of a
            // `many()` included — skipping it only for later items dropped
            // exactly one trivia-log entry per repetition, invisible in the
            // parse and visible in a node's `triviaLog`. It does NOT precede the
            // mandatory first item of `oneOrMore`/`sepBy`; see `skipBeforeFirst`.
            itemStart = skipTrivia(input, itemStart, ctx)
          }
          // Nothing but trivia left: don't speculatively parse an item at EOF.
          // This is `repItem`'s early-out, so it applies only where `repItem`
          // runs — never to a mandatory first item, which both other engines
          // attempt at `pos` whatever is there.
          if (itemStart >= input.length && viaRepItem) {
            if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
            // A trailing separator at EOF is the COMMON case for
            // `trailing: 'allow'` (`a,b,`), and this early-out ran before the
            // item was ever attempted — so handling it only on the item-failure
            // path left the separator unconsumed.
            if (trailingAllowed && sepEnd >= 0) cur = sepEnd
            break
          }
          ctx._fc = false
          const v = exec(child, input, itemStart, ctx)
          if (v === FAIL) {
            if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
            // repeat.ts:141/215/233 — a committed item failure fails the WHOLE
            // repetition. Breaking here is what let `many(dispatch(...))` return
            // ok:true with a silently truncated document.
            if (committed(ctx)) return FAIL
            // `trailing: 'allow'` keeps a separator that no item followed.
            if (trailingAllowed && sepEnd >= 0) cur = sepEnd
            break
          }
          if (END === itemStart && viaRepItem) {
            // Zero-width item: `repItem`'s stop, and a TERMINATION device, not a
            // semantic filter — a `many` loop whose only source of progress is the
            // item itself spins forever without it. That pressure does not exist
            // for a mandatory item (parsed once) or for a separated list (the
            // SEPARATOR advances the loop), and both shipped engines accordingly
            // take a zero-width item there: `sepBy(nullable, ',')` over `",a"` is
            // `["", "a"]`. Applying the stop to them made the table return `[]`
            // having consumed NOTHING, silently dropping real input.
            if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
            break
          }
          if (out !== undefined) out.push(v)
          cur = END
          count++
        }
        if (count < min) {
          // A list that ends under `min` is stuck at `cur` wanting another ITEM,
          // and reports what would have let it CONTINUE there — `failAt` in
          // repeat.ts and `deriveExpectedArr([def.parser])` in codegen's
          // emitSepBy both say the ITEM. Left alone, `_fx` still holds whatever
          // sub-parse failed last, which for a separated list is the SEPARATOR.
          // The index is present only when the encoder could not rule that out
          // (flags bit 2, `min >= 2`); at `min === 1` being under `min` means the
          // FIRST item failed and set the item's own set already.
          if ((code[ip + 5]! & 4) !== 0) { ctx._fe = cur; ctx._fx = fx[code[ip + 6]!] as string[] }
          return FAIL
        }
        END = cur
        return out
      }

      case OP_XFORM: {
        const v = exec(code[ip + 2]!, input, pos, ctx)
        if (v === FAIL) return FAIL
        const fn = fns[code[ip + 1]!] as (value: unknown, span: { start: number; end: number }) => unknown
        if (COUNT) siteFn('XFORM fn()', fn)
        return fn(v, { start: pos, end: END })
      }

      case OP_LEAF: {
        // Mirrors src/combinators/token.ts:89-127. `leaf()` is a CAPTURE
        // BOUNDARY: it suppresses the interior's own CST captures and exposes
        // exactly ONE leaf carrying the reducer's value. Running the interior
        // with the parent's sinks still live leaked every interior terminal
        // into the parent's `children`, which moved arity in the enclosing
        // reducer with no error of its own.
        //
        // It differs from `token()` deliberately: trivia POLICY is untouched
        // (`ctx.trivia`, `ctx.triviaKindLabels`), and `_rootTriviaLog` stays
        // live so root-source trivia inside the leaf remains visible.
        const sBuf = ctx._cstBuf, sChildren = ctx._cstChildren, sLeaves = ctx._cstLeaves
        const sRaw = ctx._cstRawChildren, sTl = ctx._cstTriviaLog
        const sOuterTl = ctx._triviaLog
        const wasCapturing = cstCaptureActive(ctx)

        ctx._cstBuf = undefined
        ctx._cstChildren = undefined
        ctx._cstLeaves = undefined
        ctx._cstRawChildren = undefined
        ctx._cstTriviaLog = undefined
        ctx._triviaLog = undefined

        let v: unknown
        try {
          v = exec(code[ip + 2]!, input, pos, ctx)
        } finally {
          ctx._cstBuf = sBuf
          ctx._cstChildren = sChildren
          ctx._cstLeaves = sLeaves
          ctx._cstRawChildren = sRaw
          ctx._cstTriviaLog = sTl
          ctx._triviaLog = sOuterTl
        }
        if (v === FAIL) return FAIL
        const end = END
        const fn = fns[code[ip + 1]!] as (value: unknown, span: { start: number; end: number }) => unknown
        if (COUNT) siteFn('LEAF fn()', fn)
        const out = fn(v, { start: pos, end })
        if (wasCapturing) pushCstLeaf(ctx, { _tag: 'leaf', value: out, span: { start: pos, end } })
        END = end
        return out
      }

      case OP_NODE:
      case OP_NODE_TRACK: {
        const flags = code[ip + 3]!
        // `cstOutput` is a RUNTIME fact, not an encode-time one: it depends on
        // the host handed to this parse. Under a CST host the direct builder is
        // BYPASSED, so capture must widen regardless of what the reducer's arity
        // said — the encode-time flags under-approximate here by construction.
        const host = ctx.build
        const hostCst = HOSTCST
        const saved = beginCstNodeCapture(ctx)
        const savedFields = ctx._fields
        ctx._fields = (flags & 16) !== 0 || hostCst ? [] : undefined
        if ((flags & 4) === 0 && !hostCst) ctx.captureTrivia = false
        const v = exec(code[ip + 2]!, input, pos, ctx)
        if (v !== FAIL && (flags & 128) !== 0 && ctx.trivia !== undefined) END = consumeTrivia(input, END, ctx)
        const fieldMap: FieldMap | undefined = (flags & 16) !== 0 || hostCst ? buildFieldMap(ctx._fields) : undefined
        ctx._fields = savedFields
        const cap = endCstNodeCapture(ctx, saved)
        if (v === FAIL) return FAIL
        const end = END
        const span = code[ip] === OP_NODE_TRACK ? spanLines(ctx, pos, end) : { start: pos, end }
        const st = (flags & 8) !== 0 && ctx.state !== undefined
          ? Object.assign({}, ctx.state as Record<string, unknown>)
          : undefined
        const type = k[code[ip + 5]!] as string
        const tagIdx = code[ip + 6]!
        const tags = tagIdx < 0 ? undefined : k[tagIdx] as readonly string[]

        const kids = cap.children
        const proj = code[ip + 4]!
        const buildIdx = code[ip + 1]!
        // A direct builder that never declared `state` still owes the HOST its
        // snapshot — node.ts builds it here, on a branch the eval path never takes.
        //
        // It is built INLINE AT THE HOST CALL, not before the branch and not
        // through a helper closure — either would be an allocation per node.
        // Computed eagerly it was an `Object.assign` clone per node, on every AST
        // parse of a grammar that uses `ctx.state` at all, thrown away unread: the
        // two host branches below are the only readers and neither runs on the AST
        // path with a direct builder.
        let nd: unknown
        if ((flags & 64) !== 0 && kids.length === 1) {
          nd = unwrapChild(kids[0])
        } else if ((flags & 32) !== 0 && kids.length === 1) {
          nd = kids[0]
        } else if (
          // HOST COLLAPSE. Applies wherever the node's VALUE comes from the host,
          // which is any node under a CST host — NOT only builder-less ones.
          // Gating on `!build` alone made `cstBuildHost({ collapse })` a silent
          // no-op for every grammar whose rules carry reducers (node.ts says so
          // in as many words). jess turns this on for `NamedColor`.
          (hostCst || (buildIdx < 0 && proj < 0))
          && host?._parsemanCstCollapse !== undefined
          && kids.length === 1
          && cap.rawChildren.length === 1
          && host._parsemanCstCollapse(type, kids[0], kids, cap.rawChildren)
        ) {
          nd = kids[0]
        } else if (proj >= 0) {
          nd = hostCst && host !== undefined
            ? host(type, kids, fieldMap, span, cap.rawChildren, cap.triviaLog, (flags & 8) !== 0 ? st : ctx.state !== undefined ? Object.assign({}, ctx.state as Record<string, unknown>) : undefined, tags)
            : projectChild(kids, proj, type)
        } else if (buildIdx >= 0) {
          if (hostCst && host !== undefined) {
            // A direct builder is bypassed under a CST host: the host must never
            // receive an arbitrary AST object as a child of a CST node.
            nd = host(type, kids, fieldMap, span, cap.rawChildren, cap.triviaLog, (flags & 8) !== 0 ? st : ctx.state !== undefined ? Object.assign({}, ctx.state as Record<string, unknown>) : undefined, tags)
          } else {
            const build = fns[buildIdx] as (
              children: readonly unknown[], fields: FieldMap | undefined, span: { start: number; end: number },
              rawChildren: readonly unknown[], triviaLog: readonly number[], state: unknown,
            ) => unknown
            if (COUNT) siteFn('NODE build()', build)
            nd = build(kids, fieldMap, span, cap.rawChildren, (flags & 4) !== 0 || hostCst ? cap.triviaLog : EMPTY_TL, st)
          }
        } else if (host !== undefined) {
          // Structural node: the host owns the value.
          nd = host(type, kids, fieldMap, span, cap.rawChildren, cap.triviaLog, st, tags)
        } else {
          nd = { _tag: 'node', type, span, state: st ?? null, children: kids }
        }
        pushCstChild(ctx, nd, rawEntry(nd, input, pos, end))
        END = end
        return nd
      }

      case OP_NOT: {
        const need = rollbackNeeded(ctx)
        const mRaw = need ? cstRawLen(ctx) : 0
        const mTl = need ? cstTlLen(ctx) : 0
        const mLv = need ? cstLeavesLen(ctx) : 0
        const mFl = need ? ctx._fields?.length ?? 0 : 0
        const mEr = need ? ctx._errors?.length ?? 0 : 0
        const v = exec(code[ip + 1]!, input, pos, ctx)
        if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
        if (v === FAIL) { END = pos; return null }
        ctx._fe = pos
        return FAIL
      }

      case OP_PEEK: {
        const need = rollbackNeeded(ctx)
        const mRaw = need ? cstRawLen(ctx) : 0
        const mTl = need ? cstTlLen(ctx) : 0
        const mLv = need ? cstLeavesLen(ctx) : 0
        const mFl = need ? ctx._fields?.length ?? 0 : 0
        const mEr = need ? ctx._errors?.length ?? 0 : 0
        const v = exec(code[ip + 1]!, input, pos, ctx)
        if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
        if (v === FAIL) return FAIL
        END = pos
        return null
      }

      default:
        throw new Error(`table driver: unknown opcode ${String(code[ip])} at ${ip}`)
    }
  }

  /**
   * A table SUBTREE, presented as a combinator.
   *
   * `scanTo()` and `balanced()` are rebuilt from their specs with the SHARED
   * constructors rather than re-implemented here, and those constructors take
   * COMBINATORS — a sentinel, a skipper list. This is the adapter: it runs the
   * subtree through this same driver and returns the combinator protocol's
   * `ParseResult`. Nothing else in the table crosses that boundary, and the cost
   * is one result object per scan probe, which the interpreter pays too.
   *
   * `_def` is deliberately opaque (`unknown`), so `matchesEmpty` answers `true`
   * and `firstSetOf` returns the carried set — the SAFE directions: a nullable
   * answer only costs a `many`/`choice` optimization, it never changes what is
   * accepted. The sentinel is the one exception: a `literal()` sentinel keeps its
   * def, because `scanTo` derives its expected set from exactly that
   * (`src/combinators/scanTo.ts:168`) and reporting `"sentinel"` where the
   * interpreter reports `"{"` is a real divergence.
   */
  function subtreeComb(r: SubtreeRef, def?: ParserDef): Combinator<unknown> {
    const ip = r[0]
    return {
      _tag: 'tableSubtree',
      _meta: { firstSet: refFirstSet(r[1]), canMatchNewline: true, isTrivia: false },
      _def: def ?? { tag: 'unknown' } as unknown as ParserDef,
      parse(input: string, pos: number, ctx: ParseContext): ParseResult<unknown> {
        const v = exec(ip, input, pos, ctx)
        if (v === FAIL) {
          const fe = ctx._fe
          const at = fe === undefined || fe < 0 ? pos : fe
          return { ok: false, expected: (ctx._fx ?? EMPTY_FX) as string[], span: { start: at, end: at } }
        }
        return { ok: true, value: v, span: { start: pos, end: END } }
      },
    }
  }

  /** The first set a `SubtreeRef` carries: −1 is `any`, −2 is `empty`. */
  function refFirstSet(cls: number): FirstSet {
    if (cls === -2) return { kind: 'empty' }
    if (cls < 0) return { kind: 'any' }
    const spec = prog.cc[cls] ?? ''
    const ranges: Array<{ lo: number; hi: number }> = []
    for (let i = 0; i < spec.length; i += 2) ranges.push({ lo: spec.charCodeAt(i), hi: spec.charCodeAt(i + 1) })
    return { kind: 'ranges', ranges }
  }

  /**
   * The scan pool: one real `scanTo()` / `balanced()` per spec.
   *
   * Built ONCE per resolved table, like the trivia pool, so a scan costs no
   * construction per parse. Rebuilding through the constructors is what keeps
   * `balanced`'s ambient re-resolution, its `expect()`-based recovery, its
   * `strict` failure and its one-leaf `token()` wrapper — none of which is
   * reconstructible from a driver-side re-implementation without a second copy to
   * drift.
   */
  const scans: readonly Combinator<unknown>[] = (prog.scans ?? []).map(s => {
    const skip = s.skip.map(r => subtreeComb(r))
    const raw = (s.flags & 1) !== 0
    if (s.kind === 1) {
      return balanced(s.open!, s.close!, { skip, raw, strict: (s.flags & 4) !== 0 }) as Combinator<unknown>
    }
    const sentDef: ParserDef | undefined = typeof s.sent === 'string'
      ? { tag: 'literal', value: s.sent, caseInsensitive: false } as unknown as ParserDef
      : undefined
    return scanTo(subtreeComb(s.sentinel!, sentDef), { skip, raw, orEOF: (s.flags & 2) !== 0 }) as Combinator<unknown>
  })

  const scanSkip: readonly (readonly Combinator<unknown>[])[] =
    (prog.scanSkip ?? []).map(set => set.map(r => subtreeComb(r)))

  /**
   * ONCE PER PARSE. `trackLines` is fixed by `run()` before the entry is called,
   * and it is the only leg of the swap's legality that is a property of the
   * PARSE rather than of the scope — so it is decided here and never re-asked on
   * the term path. `SCAN` starts null: a rule reached before any scope has no
   * installed trivia, and a stale one from a previous parse on a reused `ctx`
   * would skip trivia this grammar never declared.
   */
  function begin(ctx: ParseContext): void {
    FAST = ctx.trackLines !== true
    SCAN = null
    const host = ctx.build
    HOSTCST = host !== undefined && cstOutputHost(host)
  }

  return { exec, end: () => END, begin, scanSkip }
}

/**
 * Turn a program into the rule map a compiled artifact exports.
 *
 * The entries have the SAME signature as codegen rule functions, so `run()`,
 * the linker's public wrappers and every consumer are unchanged.
 */
export function tableRules(
  source: TableProgram | CompactProgram,
  /**
   * MEASUREMENT CONTROL, not a feature. `leafSwap: false` hands the driver a
   * `triviaScan` of all nulls, so `SCAN` is never installed and every skip takes
   * the shared generic functions — the exact pre-swap behaviour, from the SAME
   * driver code, differing only in TABLE DATA. That is what makes an in-process
   * A/B of the swap possible on a machine where cross-run comparison is not, and
   * it is G5-legal for the same reason `lines` is: it is read once, at rule-map
   * construction, and the parse path never sees an option.
   */
  opts: { leafSwap?: boolean } = {},
): Record<string, TableRule> {
  const prog = expandCompact(source)
  const t = resolveTable(prog)
  const scan = opts.leafSwap === false ? t.triviaScan.map(() => null) : t.triviaScan
  const d = makeDriver(t.code, t.k, t.fns, t.cc, t.fx, t.disp, t.dsp, t.trivia, scan, t.triviaLabelled, prog)
  const names = Object.keys(prog.rules)
  const entries = names.map(n => prog.rules[n]!)
  let last: unknown
  return stampRuleMap(prog, {
    runRule: (ri, input, pos, ctx) => {
      d.begin(ctx)
      const v = d.exec(entries[ri]!, input, pos, ctx)
      if (v === FAIL) return -1
      last = v
      return d.end()
    },
    lastValue: () => last,
    // Chosen PER RULE, from `scanSkipOf`: `run()` reads the ENTRY rule's own
    // `_meta.grammarScanSkip` (grammar.ts:203), and installing one program-wide
    // set instead gave a `composeLeaf` piece's rules a skip list the interpreter
    // never gives them — a divergence that is invisible, because the parse
    // succeeds having skipped over a delimiter it should have stopped at.
    scanSkipFor: ri => d.scanSkip[prog.scanSkipOf?.[ri] ?? -1],
  })
}
