/**
 * THE ASSEMBLER — the table, LINKED into closures instead of interpreted.
 *
 * This is ledger row G5 as stated: *"build the grammar reference at run start,
 * making the swaps on rules / sub-rules (leaves) at that point, then run with NO
 * logic branching for that option input"*. `exec.ts` builds the same table and
 * then interprets it: one `switch (code[ip])` over 29 opcodes, executed ONCE PER
 * ROW — 497,360 rows for `benchmark.less` (`bench/jess/g5-rows.ts`) — each
 * re-reading its opcode and re-decoding its operands from the `Int32Array`, and
 * re-testing the same per-parse options. That is the per-node branching the
 * design exists to remove.
 *
 * ## The shape
 *
 * Assembly walks the reachable table ONCE and lowers each site to a PIECE: a
 * closure with its operands already captured as `const`s and its children bound
 * as DIRECT references to their own pieces. At parse time there is no opcode
 * read, no operand decode and no switch — a piece is called, and it calls the
 * pieces it holds.
 *
 * The numbers that make this obviously the right trade, measured not assumed:
 *
 *   2,241  distinct reachable sites in the less table (`bench/jess/g5-sites.ts`)
 * 497,360  rows executed for one parse of `benchmark.less`
 *
 * Pieces are GRAMMAR-sized; rows are INPUT-sized. Assembly allocates ~2.2k
 * closures once per process and removes a dispatch plus an operand decode from
 * ~497k executions — a 222x ratio. Assembly cost is paid once and is not the
 * metric; it is measured anyway (`bench/jess/g5-assemble.ts`).
 *
 * ## Why this is not "just tuning the switch"
 *
 * A 29-case switch on an `Int32Array` load is a jump table whose successor V8
 * cannot know. The interpreter loop is ONE basic block with 29 merge edges, so
 * TurboFan cannot specialise any arm against its caller and every operand stays
 * an untyped load. Measured on this branch: `exec` reaches TURBOFAN and is
 * deoptimised back to MAGLEV repeatedly — 100 deopt events in a 20-parse run.
 * The design was not paying dispatch overhead, it was opting its whole hot path
 * out of the optimising compiler.
 *
 * A piece is created once and its call sites see one shape, so they stay
 * monomorphic and TurboFan can inline them. That is the structural win, and it is
 * why the target is codegen's number rather than a fraction of the gap.
 *
 * ## Why this keeps the artifact small
 *
 * The pieces ship ONCE, here, shared by every grammar and every variant. What a
 * bundle carries is still the table — DATA. Codegen's 2.10 MB is recognition
 * machinery inlined bespoke per rule; this stays at the table's 0.56 MB because
 * the machinery is one copy in the runtime and the variation lives in the
 * ASSEMBLY, not in duplicated piece bodies.
 *
 * ## Options are consumed by SELECTION, not by testing
 *
 * The piece set is a SUPERSET; an option set reaches a subset of it. Assembly
 * walks from the entry rule and instantiates only what it touches, so a piece an
 * option excludes is never allocated, never linked and costs zero at run — not a
 * cheap branch, zero. Where a decision is knowable from the option set
 * (`hostCst` below), assembly picks the piece rather than emitting one that
 * tests. `scripts/check-invariants.mjs` enforces that no piece body reads a
 * config field; see `CONFIG_FIELDS` there.
 *
 * Semantics are `exec.ts`'s, case for case. That file remains the reference and
 * the three-way identity sweep gates this against it.
 */
import type { Combinator, FieldMap, FirstSet, ParseContext, ParseResult, ParserDef } from '../types.ts'
import { balanced, scanTo } from '../combinators/scanTo.ts'
import { buildFieldMap } from '../compiler/fields.ts'
import { asciiFoldKey, matchesDispatchMatcher } from '../combinators/dispatch.ts'
import { projectChild, unwrapChild } from '../combinators/node.ts'
import { asciiFoldEq } from '../combinators/literal.ts'
import { cstOutputHost } from '../compiler/build-arity.ts'
import { consumeTrivia } from '../combinators/trivia-skip.ts'
import type { DispatchMatcherKind } from '../types.ts'
import {
  advanceTrivia, needsDeferredTriviaCommit, rollbackTrivia, rollbackTriviaAt,
  saveTriviaMark, scanTrivia, type FastTriviaScanner,
} from '../combinators/trivia-skip.ts'
import {
  beginCstNodeCapture, cstCaptureActive, cstLeavesLen, cstRawLen, cstTlLen,
  demoteCapturedToRaw, endCstNodeCapture, pushCstChild, pushCstLeaf,
  rollbackCstCaptureAt,
} from '../cst/capture-buffer.ts'
import {
  OP_CHOICE, OP_EMPTY, OP_GATE, OP_LEAF, OP_LIT, OP_NODE, OP_NOT, OP_OPT,
  OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX, OP_SEQ, OP_SEQV, OP_XFORM,
  OP_LIT_TRACK, OP_RX_TRACK, OP_NODE_TRACK, OP_SCOPE, OP_EXPECT, OP_SEQX, OP_SCAN,
  OP_FIELD, OP_DISPATCH, OP_ROUTED, OP_LIT_CI, OP_LIT_CI_TRACK, OP_TOKEN,
} from './ops.ts'
import {
  classHas, expandCompact, resolveTable,
  type CompactProgram, type ResolvedClass, type ResolvedTable,
  type SubtreeRef, type TableProgram, type TableRule,
} from './program.ts'
import { stampRuleMap } from './stamp.ts'

/** Failure sentinel — identity-compared, never inspected. Mirrors `exec.ts`. */
const FAIL: unique symbol = Symbol('pm.fail')

const EMPTY_TL: readonly number[] = Object.freeze([])
const EMPTY_FX: string[] = []
const ROUTED_FX: string[] = ['routed()']
/** `matchesDispatchMatcher` only reads `kind`/`value`/`flags`. Mirrors `exec.ts`. */
const DUMMY = {
  _tag: 'never',
  _meta: { firstSet: { kind: 'any' as const }, canMatchNewline: false, isTrivia: false },
  _def: { tag: 'unknown' as const },
  parse: () => { throw new Error('unreachable') },
}

type Leaf = { _tag: 'leaf'; value: string; span: { start: number; end: number } }

/**
 * THE PIECE SIGNATURE — uniform, narrow, and the same for every one of the 29
 * lowerings.
 *
 * Three arguments and one return, so every call site in the assembled graph sees
 * one shape and stays monomorphic. A wider or varying signature (an out-param
 * object, a per-op return shape) reintroduces the polymorphism this design
 * exists to remove, and it would show up as exactly the megamorphic call sites
 * `exec`'s switch already was.
 *
 * The end position travels in the assembly-scope `END` slot, as it does in
 * `exec.ts` and in codegen's `_pfEnd`, rather than in the return value — a
 * `{ value, end }` pair would be an allocation per row.
 */
type Piece = (input: string, pos: number, ctx: ParseContext) => unknown

/**
 * The option set an assembly is specialised for.
 *
 * These are the facts `run()` fixes BEFORE the entry is called and that never
 * change during a parse, so they are resolved by choosing a piece rather than by
 * a test inside one. Anything that varies DURING a parse (position, the capture
 * sinks a `node()` opens and closes, the error sink's contents) is runtime and
 * stays where it is.
 */
export type RunCfg = {
  /** Is this parse's host a CST-output host? Fixes `OP_NODE`'s whole shape. */
  readonly hostCst: boolean
  /** `ctx.trackLines` — decides whether the trivia leaf swap is legal at all. */
  readonly trackLines: boolean
}

/** The cfg key an assembly is cached under. Two bits, so at most four assemblies. */
function cfgKey(c: RunCfg): number {
  return (c.hostCst ? 1 : 0) | (c.trackLines ? 2 : 0)
}

export type Assembly = {
  /** One entry piece per rule name, already linked. */
  readonly pieces: Readonly<Record<string, Piece>>
  readonly end: () => number
  /**
   * Per-parse reset. What `exec.ts`'s `begin` DECIDED here (`trackLines`, the
   * host mode) is exactly what assembly resolved, so all that is left is
   * clearing the installed scanner and latching the host value.
   */
  readonly begin: (ctx: ParseContext) => void
  readonly scanSkip: readonly (readonly Combinator<unknown>[])[]
  /**
   * The sites this option set actually REACHED. A strict subset of the table's
   * reachable set whenever an option excludes anything, and the assertion
   * `test/unit/table-assemble-subset.test.ts` makes on that.
   */
  readonly reached: ReadonlySet<number>
}

/**
 * Link one resolved table, for one option set, into a graph of closures.
 *
 * ONE walk. Each site is lowered at most once and memoised by its code offset,
 * so a subtree shared by two parents is one piece with two references to it.
 */
export function assemble(t: ResolvedTable, prog: TableProgram, cfg: RunCfg): Assembly {
  const { code, k, fns, cc, fx, disp, dsp, trivia, triviaLabelled } = t
  // The leaf swap is only legal when line tracking is off, and that is a property
  // of the OPTION SET — so it is decided HERE, once, and the scope pieces below
  // are chosen accordingly. `exec.ts` re-tested `FAST` at every scope entry.
  const triviaScan = t.triviaScan
  const swapLegal = !cfg.trackLines
  const hostCst = cfg.hostCst

  /** Shared end-position out-parameter (`_pfEnd` in emitted code). */
  let END = 0
  /**
   * The INSTALLED trivia scanner for the scope currently running.
   *
   * Still a slot rather than a capture because `OP_SCOPE` and `OP_TOKEN` change
   * it DURING a parse — it is runtime state, not configuration. What assembly
   * removed is the per-scope re-test of `FAST` and `triviaLabelled`: which
   * scanner a scope installs is now a `const` in that scope's piece.
   */
  let SCAN: FastTriviaScanner | null = null

  const memo = new Map<number, Piece>()
  const reached = new Set<number>()

  function pushLeaf(ctx: ParseContext, value: string, s: number, e: number): void {
    const lf: Leaf = { _tag: 'leaf', value, span: { start: s, end: e } }
    pushCstLeaf(ctx, lf)
  }

  /** Mirrors `exec.ts`'s `rollbackNeeded` — a runtime question about live sinks. */
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

  /**
   * The value the last `nextTerm` produced.
   *
   * A second out-parameter slot beside `END`, for the same reason `END` is one:
   * a `{ value, end }` pair would be an allocation per sequence TERM, which is
   * the single most executed thing in any grammar here.
   */
  let TERMV: unknown

  /**
   * THE HOST, read ONCE PER PARSE.
   *
   * `ctx.build` is fixed by `run()` before the entry is called and cannot change
   * during a parse, so it is configuration — but unlike `hostCst` it is a VALUE
   * assembly cannot bake in, because two parses with the same option set can
   * carry two different host functions. So it is hoisted to the boundary instead:
   * `begin` reads it once, and the node piece reads this slot rather than going
   * back to `ctx` on each of the 145,512 nodes `benchmark.less` builds.
   *
   * INV-6 in `scripts/check-invariants.mjs` is what caught this: the first
   * version of the node piece opened with `const host = ctx.build`, which is a
   * per-parse config read on the hottest non-terminal in the grammar.
   */
  let HOST: ParseContext['build']

  /**
   * A NON-FIRST sequence term: skip the installed trivia, run the child, and
   * unrecord that trivia if the child matched nothing.
   *
   * Returns the new cursor, or −1 on failure; the term's value lands in `TERMV`.
   * Split out of the loop because the FIRST term of a sequence never has trivia
   * before it — that is a property of the POSITION, known at assembly, so the
   * unrolled pieces call the first child directly and only reach here from term
   * two onward.
   *
   * Small and monomorphic on purpose: every unrolled sequence piece calls this
   * one function, so its call sites stay single-shape and TurboFan can inline it
   * into them.
   */
  function nextTerm(child: Piece, input: string, cur: number, ctx: ParseContext): number {
    if (ctx.trivia === undefined) {
      const v = child(input, cur, ctx)
      if (v === FAIL) return -1
      TERMV = v
      return END
    }
    // SCALAR MARKS — no per-term mark object, as `exec.ts` established.
    const need = rollbackNeeded(ctx)
    const mRaw = need ? cstRawLen(ctx) : 0
    const mTl = need ? cstTlLen(ctx) : 0
    const mLv = need ? cstLeavesLen(ctx) : 0
    const mFl = need ? ctx._fields?.length ?? 0 : 0
    const mEr = need ? ctx._errors?.length ?? 0 : 0
    const mLog = need ? ctx._triviaLog?.length ?? 0 : 0
    const mRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
    const scanEnd = skipTrivia(input, cur, ctx)
    const v = child(input, scanEnd, ctx)
    if (v === FAIL) return -1
    TERMV = v
    if (END > scanEnd) return END
    // The term matched nothing, so the trivia in front of it was never consumed
    // by anything — unrecord it and leave the cursor where it was.
    if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
    return cur
  }

  function lead(input: string, pos: number): number {
    if (pos >= input.length) return -1
    const c = input.charCodeAt(pos)
    if (c < 0xd800 || c > 0xdbff) return c
    return input.codePointAt(pos) ?? c
  }

  function committed(c: ParseContext): boolean {
    return c._fc === true
  }

  function trackLinesInto(ctx: ParseContext, input: string, end: number): void {
    const from = ctx._lineScannedTo ?? 0
    if (end <= from) return
    const starts = ctx._lineStarts
    if (starts === undefined) return
    for (let i = from; i < end; i++) if (input.charCodeAt(i) === 10) starts.push(i + 1)
    ctx._lineScannedTo = end
  }

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

  function rawEntry(v: unknown, input: string, s: number, e: number): unknown {
    if (typeof v === 'object' && v !== null) {
      const tg = (v as { _tag?: string })._tag
      if (tg === 'node' || tg === 'leaf' || tg === 'parseError') return v
    }
    return { _tag: 'leaf', value: typeof v === 'string' ? v : (typeof v === 'object' && v !== null ? input.slice(s, e) : ''), span: { start: s, end: e } }
  }

  /* ── the link step ──────────────────────────────────────────────────────── */

  /**
   * Lower one site, memoised.
   *
   * CYCLES. The encoder emits children before parents, so the only back-edges are
   * the `OP_RULE` trampolines it patches for recursion (`encode.ts:228-241`). A
   * site already in flight gets a STUB that forwards through a slot patched when
   * the real piece exists, so recursive rules still hold direct references and
   * nothing falls back to an index lookup. The stub costs one call, only on a
   * genuine back-edge — 4 reachable `OP_RULE` sites in the less table.
   */
  const inFlight = new Map<number, { fwd: Piece; set: (p: Piece) => void }>()

  function link(ip: number): Piece {
    const done = memo.get(ip)
    if (done !== undefined) return done
    const flight = inFlight.get(ip)
    if (flight !== undefined) return flight.fwd

    let target: Piece | undefined
    const fwd: Piece = (input, pos, ctx) => target!(input, pos, ctx)
    const holder = { fwd, set: (p: Piece) => { target = p } }
    inFlight.set(ip, holder)

    const piece = lower(ip)

    inFlight.delete(ip)
    holder.set(piece)
    memo.set(ip, piece)
    reached.add(ip)
    return piece
  }

  function lower(ip: number): Piece {
    const op = code[ip]
    switch (op) {
      /* ── terminals ───────────────────────────────────────────────────────── */

      case OP_LIT: {
        const s = k[code[ip + 1]!] as string
        const len = s.length
        const xf = fx[code[ip + 2]!] as string[]
        return (input, pos, ctx) => {
          if (input.startsWith(s, pos)) {
            const e = pos + len
            if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
            END = e
            return s
          }
          ctx._fe = pos; ctx._fx = xf
          return FAIL
        }
      }

      case OP_LIT_TRACK: {
        const s = k[code[ip + 1]!] as string
        const len = s.length
        const xf = fx[code[ip + 2]!] as string[]
        return (input, pos, ctx) => {
          if (input.startsWith(s, pos)) {
            const e = pos + len
            if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
            trackLinesInto(ctx, input, e)
            END = e
            return s
          }
          ctx._fe = pos; ctx._fx = xf
          return FAIL
        }
      }

      case OP_RX: {
        const re = k[code[ip + 1]!] as RegExp
        const xf = fx[code[ip + 2]!] as string[]
        return (input, pos, ctx) => {
          re.lastIndex = pos
          const m = re.exec(input)
          if (m !== null) {
            const v = m[0]
            const e = pos + v.length
            if (cstCaptureActive(ctx)) pushLeaf(ctx, v, pos, e)
            END = e
            return v
          }
          ctx._fe = pos; ctx._fx = xf
          return FAIL
        }
      }

      case OP_RX_TRACK: {
        const re = k[code[ip + 1]!] as RegExp
        const xf = fx[code[ip + 2]!] as string[]
        return (input, pos, ctx) => {
          re.lastIndex = pos
          const m = re.exec(input)
          if (m !== null) {
            const v = m[0]
            const e = pos + v.length
            if (cstCaptureActive(ctx)) pushLeaf(ctx, v, pos, e)
            trackLinesInto(ctx, input, e)
            END = e
            return v
          }
          ctx._fe = pos; ctx._fx = xf
          return FAIL
        }
      }

      case OP_LIT_CI:
      case OP_LIT_CI_TRACK: {
        const s = k[code[ip + 1]!] as string
        const len = s.length
        const xf = fx[code[ip + 2]!] as string[]
        // The track/no-track choice was a per-row `code[ip] === OP_LIT_CI_TRACK`
        // re-read in `exec.ts`. It is a property of the ROW, so it is resolved here.
        if (op === OP_LIT_CI_TRACK) {
          return (input, pos, ctx) => {
            const e = pos + len
            const matched = input.slice(pos, e)
            if (asciiFoldEq(matched, s)) {
              if (cstCaptureActive(ctx)) pushLeaf(ctx, matched, pos, e)
              trackLinesInto(ctx, input, e)
              END = e
              return matched
            }
            ctx._fe = pos; ctx._fx = xf
            return FAIL
          }
        }
        return (input, pos, ctx) => {
          const e = pos + len
          // Yields the INPUT's casing (`literal.ts:86`), not the literal's.
          const matched = input.slice(pos, e)
          if (asciiFoldEq(matched, s)) {
            if (cstCaptureActive(ctx)) pushLeaf(ctx, matched, pos, e)
            END = e
            return matched
          }
          ctx._fe = pos; ctx._fx = xf
          return FAIL
        }
      }

      case OP_EMPTY:
        return (_input, pos) => { END = pos; return '' }

      /* ── transparent / structural ────────────────────────────────────────── */

      case OP_GATE: {
        const cls = cc[code[ip + 1]!]!
        const xf = fx[code[ip + 3]!] as string[]
        const child = link(code[ip + 2]!)
        return (input, pos, ctx) => {
          if (!classHas(cls, lead(input, pos))) {
            ctx._fe = pos; ctx._fx = xf
            return FAIL
          }
          return child(input, pos, ctx)
        }
      }

      case OP_RULE:
        // Pure indirection in the tape; in the assembled graph the parent simply
        // holds the target's piece. The trampoline row disappears entirely — this
        // is the only place a back-edge can occur, and `link` handles it.
        return link(code[ip + 1]!)

      case OP_EXPECT: {
        const child = link(code[ip + 1]!)
        const xf = fx[code[ip + 2]!] as string[]
        return (input, pos, ctx) => {
          const v = child(input, pos, ctx)
          if (v !== FAIL) return v
          const span = { start: pos, end: pos }
          const err = { _tag: 'parseError' as const, span, expected: xf }
          ctx._errors?.push(err)
          END = pos
          return err
        }
      }

      case OP_FIELD: {
        const name = k[code[ip + 1]!] as string
        const child = link(code[ip + 2]!)
        return (input, pos, ctx) => {
          const v = child(input, pos, ctx)
          if (v === FAIL) return FAIL
          ctx._fields?.push({ name, value: v, span: { start: pos, end: END } })
          return v
        }
      }

      case OP_XFORM: {
        const fn = fns[code[ip + 1]!] as (value: unknown, span: { start: number; end: number }) => unknown
        const child = link(code[ip + 2]!)
        return (input, pos, ctx) => {
          const v = child(input, pos, ctx)
          if (v === FAIL) return FAIL
          return fn(v, { start: pos, end: END })
        }
      }

      case OP_SCAN: {
        // The scan POOL is built from subtrees, so it is linked after the graph
        // it references — a scan piece cannot capture its combinator at lowering
        // time without a cycle. It binds on first execution instead: one null
        // check, on 3 sites reached 6 times per parse of `benchmark.less`.
        const si = code[ip + 1]!
        let bound: Combinator<unknown> | undefined
        return (input, pos, ctx) => {
          const c = bound ?? (bound = scans[si]!)
          const r = c.parse(input, pos, ctx)
          if (!r.ok) {
            ctx._fe = r.span.start
            ctx._fx = (r.expected ?? EMPTY_FX) as string[]
            return FAIL
          }
          END = r.span.end
          return r.value
        }
      }

      case OP_SCOPE: {
        const ki = code[ip + 1]!
        const scopeTrivia = ki < 0 ? undefined : (trivia[ki] as ParseContext['trivia'])
        const scopeLabels = scopeTrivia?._meta.triviaKindLabels
        // THE SWAP, RESOLVED AT ASSEMBLY. `exec.ts` computed
        // `FAST && ki >= 0 && !triviaLabelled[ki]` on every scope entry; `FAST` is
        // `!trackLines`, an option, and the other two are table data. All three are
        // known here, so the scope piece holds the scanner it installs as a `const`.
        const scanFor: FastTriviaScanner | null =
          swapLegal && ki >= 0 && !triviaLabelled[ki]! ? triviaScan[ki]! : null
        const child = link(code[ip + 2]!)
        return (input, pos, ctx) => {
          const saved = ctx.trivia
          const savedLabels = ctx.triviaKindLabels
          const savedScan = SCAN
          SCAN = scanFor
          ctx.trivia = scopeTrivia
          ctx.triviaKindLabels = scopeLabels
          const v = child(input, pos, ctx)
          ctx.trivia = saved
          ctx.triviaKindLabels = savedLabels
          SCAN = savedScan
          return v
        }
      }

      case OP_ROUTED: {
        const fb = code[ip + 1]!
        const fallback = fb >= 0 ? link(fb) : undefined
        return (input, pos, ctx) => {
          const item = ctx._routed
          if (item === undefined || pos !== item.span.start) {
            if (fallback !== undefined) return fallback(input, pos, ctx)
            ctx._fe = pos; ctx._fx = ROUTED_FX
            return FAIL
          }
          if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: item.value, span: item.span })
          END = item.span.end
          return item.value
        }
      }

      /* ── zero-width ──────────────────────────────────────────────────────── */

      case OP_NOT: {
        const child = link(code[ip + 1]!)
        return (input, pos, ctx) => {
          const need = rollbackNeeded(ctx)
          const mRaw = need ? cstRawLen(ctx) : 0
          const mTl = need ? cstTlLen(ctx) : 0
          const mLv = need ? cstLeavesLen(ctx) : 0
          const mFl = need ? ctx._fields?.length ?? 0 : 0
          const mEr = need ? ctx._errors?.length ?? 0 : 0
          const v = child(input, pos, ctx)
          if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
          if (v === FAIL) { END = pos; return null }
          ctx._fe = pos
          return FAIL
        }
      }

      case OP_PEEK: {
        const child = link(code[ip + 1]!)
        return (input, pos, ctx) => {
          const need = rollbackNeeded(ctx)
          const mRaw = need ? cstRawLen(ctx) : 0
          const mTl = need ? cstTlLen(ctx) : 0
          const mLv = need ? cstLeavesLen(ctx) : 0
          const mFl = need ? ctx._fields?.length ?? 0 : 0
          const mEr = need ? ctx._errors?.length ?? 0 : 0
          const v = child(input, pos, ctx)
          if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
          if (v === FAIL) return FAIL
          END = pos
          return null
        }
      }

      case OP_OPT: {
        const child = link(code[ip + 1]!)
        return (input, pos, ctx) => {
          const need = rollbackNeeded(ctx)
          const mRaw = need ? cstRawLen(ctx) : 0
          const mTl = need ? cstTlLen(ctx) : 0
          const mLv = need ? cstLeavesLen(ctx) : 0
          const mFl = need ? ctx._fields?.length ?? 0 : 0
          const mEr = need ? ctx._errors?.length ?? 0 : 0
          ctx._fc = false
          const v = child(input, pos, ctx)
          if (v === FAIL) {
            if (committed(ctx)) return FAIL
            if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
            END = pos
            // NULL, not undefined — `repeat.ts:269,277`, and grammars TEST for it.
            return null
          }
          return v
        }
      }

      /* ── boundaries ──────────────────────────────────────────────────────── */

      case OP_TOKEN: {
        const child = link(code[ip + 1]!)
        return (input, pos, ctx) => {
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
            v = child(input, pos, ctx)
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
      }

      case OP_LEAF: {
        const fn = fns[code[ip + 1]!] as (value: unknown, span: { start: number; end: number }) => unknown
        const child = link(code[ip + 2]!)
        return (input, pos, ctx) => {
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
            v = child(input, pos, ctx)
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
          const out = fn(v, { start: pos, end })
          if (wasCapturing) pushCstLeaf(ctx, { _tag: 'leaf', value: out, span: { start: pos, end } })
          END = end
          return out
        }
      }

      /* ── sequences ───────────────────────────────────────────────────────── */

      case OP_SEQ:
      case OP_SEQV:
      case OP_SEQX: {
        const fused = op === OP_SEQX
        const base = fused ? ip + 3 : ip + 2
        const n = code[fused ? ip + 2 : ip + 1]!
        // Children bound as a plain array of DIRECT references, laid out once.
        const kids: Piece[] = new Array<Piece>(n)
        for (let i = 0; i < n; i++) kids[i] = link(code[base + i]!)
        const wantValues = op !== OP_SEQV
        const fn = fused
          ? fns[code[ip + 1]!] as (value: unknown, span: { start: number; end: number }) => unknown
          : undefined

        /**
         * The generic term loop, for arities the unrolled pieces below do not
         * cover.
         *
         * `exec.ts` open-coded a LIT/RX fast path here to dodge "a JS call frame
         * plus a switch dispatch". Half of that cost is gone by construction — a
         * piece has no switch — and the other half is what TurboFan removes by
         * INLINING a small monomorphic child. Re-emitting the terminal bodies
         * would instead grow this function past the inlining budget, which is the
         * defect being fixed, so they are not re-emitted.
         */
        const runTerms = (input: string, pos: number, ctx: ParseContext, values: unknown[] | undefined): number => {
          const v0 = kids[0]!(input, pos, ctx)
          if (v0 === FAIL) return -1
          if (values !== undefined) values.push(v0)
          let cur = END
          for (let i = 1; i < n; i++) {
            cur = nextTerm(kids[i]!, input, cur, ctx)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
          }
          return cur
        }

        /**
         * ARITY-SPECIALISED PIECES — the "pre-made, fully-formed" half of the
         * design, at the shape that dominates every grammar here.
         *
         * A sequence's ARITY is table data, so the loop over it is work assembly
         * can finish. Unrolling removes, per term: the counter, the bounds-checked
         * `kids[i]` load, and the `i > 0` test that decides whether trivia
         * precedes the term — the FIRST term never has trivia before it, and that
         * was being re-decided 166,842 times per parse for `SEQV` alone.
         *
         * The value array is built as a LITERAL of the right size rather than
         * grown by `push`, so a 2- or 3-term sequence allocates once at its final
         * capacity instead of reallocating as it fills.
         *
         * Arity 1-3 covers the overwhelming majority; above that the general loop
         * runs, so there is no arity this fails to lower.
         */
        if (n === 1) {
          const k0 = kids[0]!
          if (fused) {
            return (input, pos, ctx) => {
              const v = k0(input, pos, ctx)
              if (v === FAIL) return FAIL
              return fn!([v], { start: pos, end: END })
            }
          }
          if (wantValues) {
            return (input, pos, ctx) => {
              const v = k0(input, pos, ctx)
              if (v === FAIL) return FAIL
              return [v]
            }
          }
          return (input, pos, ctx) => {
            const v = k0(input, pos, ctx)
            if (v === FAIL) return FAIL
            return undefined
          }
        }

        if (n === 2) {
          const k0 = kids[0]!, k1 = kids[1]!
          if (fused) {
            return (input, pos, ctx) => {
              const v0 = k0(input, pos, ctx)
              if (v0 === FAIL) return FAIL
              const cur = nextTerm(k1, input, END, ctx)
              if (cur < 0) return FAIL
              END = cur
              return fn!([v0, TERMV], { start: pos, end: cur })
            }
          }
          if (wantValues) {
            return (input, pos, ctx) => {
              const v0 = k0(input, pos, ctx)
              if (v0 === FAIL) return FAIL
              const cur = nextTerm(k1, input, END, ctx)
              if (cur < 0) return FAIL
              END = cur
              return [v0, TERMV]
            }
          }
          return (input, pos, ctx) => {
            const v0 = k0(input, pos, ctx)
            if (v0 === FAIL) return FAIL
            const cur = nextTerm(k1, input, END, ctx)
            if (cur < 0) return FAIL
            END = cur
            return undefined
          }
        }

        if (n === 3) {
          const k0 = kids[0]!, k1 = kids[1]!, k2 = kids[2]!
          if (fused) {
            return (input, pos, ctx) => {
              const v0 = k0(input, pos, ctx)
              if (v0 === FAIL) return FAIL
              let cur = nextTerm(k1, input, END, ctx)
              if (cur < 0) return FAIL
              const v1 = TERMV
              cur = nextTerm(k2, input, cur, ctx)
              if (cur < 0) return FAIL
              END = cur
              return fn!([v0, v1, TERMV], { start: pos, end: cur })
            }
          }
          if (wantValues) {
            return (input, pos, ctx) => {
              const v0 = k0(input, pos, ctx)
              if (v0 === FAIL) return FAIL
              let cur = nextTerm(k1, input, END, ctx)
              if (cur < 0) return FAIL
              const v1 = TERMV
              cur = nextTerm(k2, input, cur, ctx)
              if (cur < 0) return FAIL
              END = cur
              return [v0, v1, TERMV]
            }
          }
          return (input, pos, ctx) => {
            const v0 = k0(input, pos, ctx)
            if (v0 === FAIL) return FAIL
            let cur = nextTerm(k1, input, END, ctx)
            if (cur < 0) return FAIL
            cur = nextTerm(k2, input, cur, ctx)
            if (cur < 0) return FAIL
            END = cur
            return undefined
          }
        }

        if (fused) {
          return (input, pos, ctx) => {
            const values: unknown[] = []
            const cur = runTerms(input, pos, ctx, values)
            if (cur < 0) return FAIL
            END = cur
            return fn!(values, { start: pos, end: cur })
          }
        }
        if (wantValues) {
          return (input, pos, ctx) => {
            const values: unknown[] = []
            const cur = runTerms(input, pos, ctx, values)
            if (cur < 0) return FAIL
            END = cur
            return values
          }
        }
        return (input, pos, ctx) => {
          const cur = runTerms(input, pos, ctx, undefined)
          if (cur < 0) return FAIL
          END = cur
          return undefined
        }
      }

      /* ── choice ──────────────────────────────────────────────────────────── */

      case OP_CHOICE: {
        const table = disp[code[ip + 1]!]!
        const n = code[ip + 2]!
        const choiceFx = fx[code[ip + 3]!] as string[]
        const base = ip + 4
        const arms: Piece[] = new Array<Piece>(n)
        for (let i = 0; i < n; i++) arms[i] = link(code[base + i]!)

        // THE TWO CHOICE SHAPES ARE TWO PIECES. `exec.ts` tested `table.exclusive`
        // on every choice execution; it is table data, so it selects here.
        if (table.exclusive) {
          const ascii = table.ascii
          const hi = table.hi
          const open = table.open
          const openArms: Piece[] = open.map(i => arms[i]!)
          return (input, pos, ctx) => {
            const c = lead(input, pos)
            let arm = -1
            if (c >= 0 && c < 128) {
              const a = ascii[c]!
              if (a !== 0) arm = a - 1
            } else if (c >= 128) {
              for (let i = 0; i < hi.length; i += 3) {
                if (c >= hi[i]! && c <= hi[i + 1]!) { arm = hi[i + 2]!; break }
              }
            }
            if (arm >= 0) {
              ctx._fc = false
              const v = arms[arm]!(input, pos, ctx)
              if (v !== FAIL) return v
              // THE CUT — a committed failure fails the whole choice.
              if (committed(ctx)) return FAIL
            }
            if (openArms.length === 0) { ctx._fe = pos; ctx._fx = choiceFx; return FAIL }
            const need = rollbackNeeded(ctx)
            const mRaw = need ? cstRawLen(ctx) : 0
            const mTl = need ? cstTlLen(ctx) : 0
            const mLv = need ? cstLeavesLen(ctx) : 0
            const mFl = need ? ctx._fields?.length ?? 0 : 0
            const mEr = need ? ctx._errors?.length ?? 0 : 0
            if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
            for (let i = 0; i < openArms.length; i++) {
              ctx._fc = false
              const v = openArms[i]!(input, pos, ctx)
              if (v !== FAIL) return v
              if (committed(ctx)) return FAIL
              if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
            }
            ctx._fe = pos; ctx._fx = choiceFx
            return FAIL
          }
        }

        // THE PER-ARM GATE. Arms in source order, each skipped when its own class
        // excludes the char at `pos`. `null` means nullable or unmappable, and
        // those arms are always entered.
        const armCls = table.armCls
        const gates: (ResolvedClass | null)[] = new Array<ResolvedClass | null>(n)
        for (let i = 0; i < n; i++) gates[i] = armCls[i] ?? null

        /**
         * THE GATE, PRECOMPUTED. One `Uint32Array` load replaces `n` class tests.
         *
         * `exec.ts` asked, per arm per execution, "does this arm's class hold the
         * char at `pos`" — `n` calls into `classHas`, each a bounds check plus a
         * `Uint8Array` load, on 136,760 choice executions per parse of
         * `benchmark.less`. Every one of those answers is a function of the
         * CHARACTER and the TABLE, both of which are known here, so the whole
         * question is answered once at assembly: `cand[c]` is the bitmask of arms
         * that could match `c`, and the loop visits only set bits, IN ORDER, so
         * the source ordering the gate exists to preserve is preserved exactly.
         *
         * Slot 128 is EOF (`lead` returns −1): `classHas` rejects a negative code,
         * so only the always-enter arms are candidates there. Code points ≥ 128
         * keep the per-arm loop — the ranges make a table the wrong shape and
         * astral input is not the hot path.
         *
         * Bounded at 32 arms because the mask is one word. Above that the general
         * loop runs, which is the same code the ≥ 128 path takes, so there is no
         * second implementation to drift.
         */
        const maskable = n <= 32
        let cand: Uint32Array | undefined
        if (maskable) {
          const m = new Uint32Array(129)
          for (let i = 0; i < n; i++) {
            const cls = gates[i]!
            const bit = 1 << i
            if (cls === null) {
              for (let c = 0; c < 129; c++) m[c]! |= bit
              continue
            }
            for (let c = 0; c < 128; c++) if (cls.ascii[c] === 1) m[c]! |= bit
          }
          cand = m
        }

        if (cand !== undefined) {
          const mask = cand
          return (input, pos, ctx) => {
            const c = lead(input, pos)
            const need = rollbackNeeded(ctx)
            const mRaw = need ? cstRawLen(ctx) : 0
            const mTl = need ? cstTlLen(ctx) : 0
            const mLv = need ? cstLeavesLen(ctx) : 0
            const mFl = need ? ctx._fields?.length ?? 0 : 0
            const mEr = need ? ctx._errors?.length ?? 0 : 0
            if (c < 128) {
              // `c` is −1 at EOF, which indexes slot 128 — the always-enter arms.
              let bits = mask[c < 0 ? 128 : c]!
              while (bits !== 0) {
                const i = 31 - Math.clz32(bits & -bits)
                bits &= bits - 1
                ctx._fc = false
                const v = arms[i]!(input, pos, ctx)
                if (v !== FAIL) return v
                if (committed(ctx)) return FAIL
                if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
              }
              ctx._fe = pos; ctx._fx = choiceFx
              return FAIL
            }
            for (let i = 0; i < n; i++) {
              const cls = gates[i]!
              if (cls !== null && !classHas(cls, c)) continue
              ctx._fc = false
              const v = arms[i]!(input, pos, ctx)
              if (v !== FAIL) return v
              if (committed(ctx)) return FAIL
              if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
            }
            ctx._fe = pos; ctx._fx = choiceFx
            return FAIL
          }
        }

        return (input, pos, ctx) => {
          const c = lead(input, pos)
          const need = rollbackNeeded(ctx)
          const mRaw = need ? cstRawLen(ctx) : 0
          const mTl = need ? cstTlLen(ctx) : 0
          const mLv = need ? cstLeavesLen(ctx) : 0
          const mFl = need ? ctx._fields?.length ?? 0 : 0
          const mEr = need ? ctx._errors?.length ?? 0 : 0
          for (let i = 0; i < n; i++) {
            const cls = gates[i]!
            if (cls !== null && !classHas(cls, c)) continue
            ctx._fc = false
            const v = arms[i]!(input, pos, ctx)
            if (v !== FAIL) return v
            if (committed(ctx)) return FAIL
            if (need) rollbackCstCaptureAt(ctx, mRaw, mTl, mLv, mFl, mEr)
          }
          ctx._fe = pos; ctx._fx = choiceFx
          return FAIL
        }
      }

      /* ── repetition ──────────────────────────────────────────────────────── */

      case OP_REP:
      case OP_REPV: {
        const child = link(code[ip + 1]!)
        const min = code[ip + 2]!
        const max = code[ip + 3]!
        const sepIp = code[ip + 4]!
        const sep = sepIp >= 0 ? link(sepIp) : undefined
        const flags = code[ip + 5]!
        const keepSeparators = (flags & 2) !== 0
        const trailingAllowed = (flags & 1) !== 0
        const reportItem = (flags & 4) !== 0
        const itemFx = reportItem ? fx[code[ip + 6]!] as string[] : EMPTY_FX
        const collect = op === OP_REP
        // `many()` — the min-0, separator-less repeat — is the only shape that runs
        // its FIRST item through `repItem` and so skips leading trivia. The shape
        // identifies itself, and it is table data, so it is decided here.
        const skipBeforeFirst = sepIp < 0 && min === 0

        return (input, pos, ctx) => {
          const out: unknown[] | undefined = collect ? [] : undefined
          const hasTrivia = ctx.trivia !== undefined
          const needMark = rollbackNeeded(ctx)
          let cur = pos
          let count = 0
          for (;;) {
            if (max >= 0 && count >= max) break
            // A separated list is bounded by its SEPARATOR, so it stops at EOF at
            // the LOOP HEAD. Held to `count >= min` so an under-`min` list still
            // attempts the separator and reports its expected set.
            if (sep !== undefined && count > 0 && count >= min && cur >= input.length) break
            const mRaw = needMark ? cstRawLen(ctx) : 0
            const mTl = needMark ? cstTlLen(ctx) : 0
            const mLv = needMark ? cstLeavesLen(ctx) : 0
            const mFl = needMark ? ctx._fields?.length ?? 0 : 0
            const mEr = needMark ? ctx._errors?.length ?? 0 : 0
            const mLog = needMark ? ctx._triviaLog?.length ?? 0 : 0
            const mRoot = needMark ? ctx._rootTriviaLog?.length ?? 0 : 0
            let itemStart = cur
            let sepEnd = -1
            const viaRepItem = sep === undefined && count >= min && (count > 0 || skipBeforeFirst)
            if (sep !== undefined && count > 0) {
              const leavesBefore = cstLeavesLen(ctx)
              let sp = cur
              if (hasTrivia) sp = skipTrivia(input, sp, ctx)
              ctx._fc = false
              const sv = sep(input, sp, ctx)
              if (sv === FAIL) {
                if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
                if (committed(ctx)) return FAIL
                break
              }
              if (!keepSeparators) demoteCapturedToRaw(ctx, leavesBefore)
              sepEnd = END
              itemStart = hasTrivia ? skipTrivia(input, END, ctx) : END
            } else if (hasTrivia && (count > 0 || skipBeforeFirst)) {
              itemStart = skipTrivia(input, itemStart, ctx)
            }
            if (itemStart >= input.length && viaRepItem) {
              if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              if (trailingAllowed && sepEnd >= 0) cur = sepEnd
              break
            }
            ctx._fc = false
            const v = child(input, itemStart, ctx)
            if (v === FAIL) {
              if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              if (committed(ctx)) return FAIL
              if (trailingAllowed && sepEnd >= 0) cur = sepEnd
              break
            }
            if (END === itemStart && viaRepItem) {
              // Zero-width item: `repItem`'s TERMINATION device, not a semantic
              // filter — and it applies only where `repItem` runs.
              if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              break
            }
            if (out !== undefined) out.push(v)
            cur = END
            count++
          }
          if (count < min) {
            if (reportItem) { ctx._fe = cur; ctx._fx = itemFx }
            return FAIL
          }
          END = cur
          return out
        }
      }

      /* ── dispatch ────────────────────────────────────────────────────────── */

      case OP_DISPATCH: {
        const spec = dsp[code[ip + 2]!]!
        const selector = link(code[ip + 1]!)
        const otherIp = code[ip + 3]!
        const other = otherIp >= 0 ? link(otherIp) : undefined
        const otherRouted = code[ip + 4]! === 1
        const n = code[ip + 5]!
        const armBase = ip + 6
        const arms: Piece[] = new Array<Piece>(n)
        for (let i = 0; i < n; i++) arms[i] = link(code[armBase + i]!)
        const byKey = spec.byKey
        const byFold = spec.byFold
        const hasFold = spec.byFold.size > 0
        const match = spec.match
        const routed = spec.routed
        const expected = spec.expected as string[]

        return (input, pos, ctx) => {
          const selectorMark = saveTriviaMark(ctx)
          const selVal = selector(input, pos, ctx)
          if (selVal === FAIL) return FAIL
          const selEnd = END
          const key = selVal as string

          let arm = byKey.get(key)
          if (arm === undefined && hasFold) arm = byFold.get(asciiFoldKey(key))
          if (arm === undefined) {
            for (let i = 0; i < match.length; i++) {
              const m = match[i]!
              const kind: DispatchMatcherKind = m[0] === 0 ? 'startsWith' : m[0] === 1 ? 'endsWith' : 'matches'
              if (matchesDispatchMatcher(key, { kind, value: m[1], flags: m[2] === '' ? undefined : m[2], parser: DUMMY, caseInsensitive: false })) {
                arm = m[3]
                break
              }
            }
          }

          let target: Piece
          let usesRouted: boolean
          if (arm === undefined) {
            if (other === undefined) {
              // No branch and no fallback: fail AT THE SELECTOR'S END.
              ctx._fe = selEnd
              ctx._fx = expected
              return FAIL
            }
            target = other
            usesRouted = otherRouted
          } else {
            target = arms[arm]!
            usesRouted = routed[arm] === 1
          }

          const savedRouted = ctx._routed
          let mark = saveTriviaMark(ctx)
          if (usesRouted) {
            rollbackTrivia(ctx, selectorMark)
            mark = saveTriviaMark(ctx)
            ctx._routed = { value: key, span: { start: pos, end: selEnd } }
          }
          const v = target(input, usesRouted ? pos : selEnd, ctx)
          if (usesRouted) ctx._routed = savedRouted
          if (v === FAIL) {
            rollbackTrivia(ctx, mark)
            // A failed dispatch branch is COMMITTED: the selector already matched.
            ctx._fc = true
            return FAIL
          }
          return [key, v]
        }
      }

      /* ── node ────────────────────────────────────────────────────────────── */

      case OP_NODE:
      case OP_NODE_TRACK: {
        const flags = code[ip + 3]!
        const child = link(code[ip + 2]!)
        const proj = code[ip + 4]!
        const buildIdx = code[ip + 1]!
        const type = k[code[ip + 5]!] as string
        const tagIdx = code[ip + 6]!
        const tags = tagIdx < 0 ? undefined : k[tagIdx] as readonly string[]
        const tracked = op === OP_NODE_TRACK
        const readsTrivia = (flags & 4) !== 0
        const readsState = (flags & 8) !== 0
        const hasFields = (flags & 16) !== 0
        const collapse = (flags & 32) !== 0
        const unwrap = (flags & 64) !== 0
        const trailingTrivia = (flags & 128) !== 0
        // HOST MODE IS AN OPTION, and it decided five separate runtime ternaries
        // in `exec.ts`'s node case — the single most-executed non-terminal at
        // 145,512 executions per parse of `benchmark.less`. `cstOutputHost(ctx.build)`
        // is fixed by `run()` before the entry is called, so it selects the piece.
        const wantFields = hasFields || hostCst
        const captureWide = readsTrivia || hostCst
        const build = buildIdx >= 0
          ? fns[buildIdx] as (
            children: readonly unknown[], fields: FieldMap | undefined, span: { start: number; end: number },
            rawChildren: readonly unknown[], triviaLog: readonly number[], state: unknown,
          ) => unknown
          : undefined

        return (input, pos, ctx) => {
          const host = HOST
          const saved = beginCstNodeCapture(ctx)
          const savedFields = ctx._fields
          ctx._fields = wantFields ? [] : undefined
          if (!captureWide) ctx.captureTrivia = false
          const v = child(input, pos, ctx)
          if (v !== FAIL && trailingTrivia && ctx.trivia !== undefined) END = consumeTrivia(input, END, ctx)
          const fieldMap: FieldMap | undefined = wantFields ? buildFieldMap(ctx._fields) : undefined
          ctx._fields = savedFields
          const cap = endCstNodeCapture(ctx, saved)
          if (v === FAIL) return FAIL
          const end = END
          const span = tracked ? spanLines(ctx, pos, end) : { start: pos, end }
          const st = readsState && ctx.state !== undefined
            ? Object.assign({}, ctx.state as Record<string, unknown>)
            : undefined

          const kids = cap.children
          let nd: unknown
          if (unwrap && kids.length === 1) {
            nd = unwrapChild(kids[0])
          } else if (collapse && kids.length === 1) {
            nd = kids[0]
          } else if (
            // HOST COLLAPSE — applies wherever the node's VALUE comes from the
            // host, which is any node under a CST host, not only builder-less ones.
            (hostCst || (build === undefined && proj < 0))
            && host?._parsemanCstCollapse !== undefined
            && kids.length === 1
            && cap.rawChildren.length === 1
            && host._parsemanCstCollapse(type, kids[0], kids, cap.rawChildren)
          ) {
            nd = kids[0]
          } else if (proj >= 0) {
            nd = hostCst && host !== undefined
              ? host(type, kids, fieldMap, span, cap.rawChildren, cap.triviaLog, readsState ? st : ctx.state !== undefined ? Object.assign({}, ctx.state as Record<string, unknown>) : undefined, tags)
              : projectChild(kids, proj, type)
          } else if (build !== undefined) {
            if (hostCst && host !== undefined) {
              // A direct builder is bypassed under a CST host.
              nd = host(type, kids, fieldMap, span, cap.rawChildren, cap.triviaLog, readsState ? st : ctx.state !== undefined ? Object.assign({}, ctx.state as Record<string, unknown>) : undefined, tags)
            } else {
              nd = build(kids, fieldMap, span, cap.rawChildren, captureWide ? cap.triviaLog : EMPTY_TL, st)
            }
          } else if (host !== undefined) {
            nd = host(type, kids, fieldMap, span, cap.rawChildren, cap.triviaLog, st, tags)
          } else {
            nd = { _tag: 'node', type, span, state: st ?? null, children: kids }
          }
          pushCstChild(ctx, nd, rawEntry(nd, input, pos, end))
          END = end
          return nd
        }
      }

      default:
        throw new Error(`table assembler: unknown opcode ${String(op)} at ${ip}`)
    }
  }

  /* ── scans, built once per assembly exactly as `exec.ts` builds them ─────── */

  function subtreeComb(r: SubtreeRef, def?: ParserDef): Combinator<unknown> {
    const piece = link(r[0])
    return {
      _tag: 'tableSubtree',
      _meta: { firstSet: refFirstSet(r[1]), canMatchNewline: true, isTrivia: false },
      _def: def ?? { tag: 'unknown' } as unknown as ParserDef,
      parse(input: string, pos: number, ctx: ParseContext): ParseResult<unknown> {
        const v = piece(input, pos, ctx)
        if (v === FAIL) {
          const fe = ctx._fe
          const at = fe === undefined || fe < 0 ? pos : fe
          return { ok: false, expected: (ctx._fx ?? EMPTY_FX) as string[], span: { start: at, end: at } }
        }
        return { ok: true, value: v, span: { start: pos, end: END } }
      },
    }
  }

  function refFirstSet(cls: number): FirstSet {
    if (cls === -2) return { kind: 'empty' }
    if (cls < 0) return { kind: 'any' }
    const spec = prog.cc[cls] ?? ''
    const ranges: Array<{ lo: number; hi: number }> = []
    for (let i = 0; i < spec.length; i += 2) ranges.push({ lo: spec.charCodeAt(i), hi: spec.charCodeAt(i + 1) })
    return { kind: 'ranges', ranges }
  }

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

  /* ── link the rules ──────────────────────────────────────────────────────── */

  const pieces: Record<string, Piece> = {}
  for (const [name, entryIp] of Object.entries(prog.rules)) pieces[name] = link(entryIp)

  /**
   * PER PARSE. `SCAN` starts null — a rule reached before any scope has no
   * installed trivia, and a stale one from a previous parse on a reused `ctx`
   * would skip trivia this grammar never declared.
   *
   * `FAST` and `HOSTCST` are gone: both were options, and both are now baked into
   * which pieces this assembly holds. What is left is the one piece of
   * configuration that is a per-parse VALUE rather than a per-parse FACT — the
   * host itself — and it is read here, once, instead of per node.
   */
  function begin(ctx: ParseContext): void {
    SCAN = null
    HOST = ctx.build
  }

  return { pieces, end: () => END, begin, scanSkip, reached }
}

/**
 * Assemblies for one resolved table, one per option set, built on demand.
 *
 * The option set is not known when the rule map is created — `ctx.build` and
 * `ctx.trackLines` arrive with the parse — so the entry computes the two-bit key
 * and takes the assembly for it, building it the first time that combination is
 * seen. That is the "assembled at run start" half of G5: at most four assemblies
 * per table per process, each holding ONLY the pieces its options reach.
 */
export class AssemblyCache {
  private readonly t: ResolvedTable
  private readonly prog: TableProgram
  private readonly byCfg: Array<Assembly | undefined> = [undefined, undefined, undefined, undefined]

  constructor(prog: TableProgram) {
    this.prog = prog
    this.t = resolveTable(prog)
  }

  for(cfg: RunCfg): Assembly {
    const key = cfgKey(cfg)
    const hit = this.byCfg[key]
    if (hit !== undefined) return hit
    const made = assemble(this.t, this.prog, cfg)
    this.byCfg[key] = made
    return made
  }

  /**
   * The assembly for the option set this `ctx` implies.
   *
   * THE ONLY CONFIG READ ON THE RUN PATH, and it happens once per parse at the
   * boundary rather than once per row. It allocates nothing: the key is computed
   * inline and the `RunCfg` object is built only on the miss that builds an
   * assembly, which is at most four times per table per process.
   */
  forCtx(ctx: ParseContext): Assembly {
    const host = ctx.build
    const hostCst = host !== undefined && cstOutputHost(host)
    const trackLines = ctx.trackLines === true
    const key = (hostCst ? 1 : 0) | (trackLines ? 2 : 0)
    const hit = this.byCfg[key]
    if (hit !== undefined) return hit
    const made = assemble(this.t, this.prog, { hostCst, trackLines })
    this.byCfg[key] = made
    return made
  }
}

/**
 * The ASSEMBLED rule map — the same artifact contract as `tableRules`, run
 * through linked closures instead of the bytecode interpreter.
 *
 * The two config reads that remain are HERE, at the boundary, once per parse:
 * `AssemblyCache.cfgOf` turns the `ctx` into a two-bit option set and takes the
 * assembly built for it. Everything past that point is pieces, and no piece body
 * reads an option — `scripts/check-invariants.mjs` asserts it.
 */
export function assembledRules(source: TableProgram | CompactProgram): Record<string, TableRule> {
  const prog = expandCompact(source)
  const cache = new AssemblyCache(prog)
  const names = Object.keys(prog.rules)
  const skipOf = prog.scanSkipOf
  let last: unknown
  /** The assembly the CURRENT parse selected; `scanSkipFor` runs before it. */
  let live: Assembly | undefined
  return stampRuleMap(prog, {
    runRule: (ri, input, pos, ctx) => {
      const a = cache.forCtx(ctx)
      live = a
      a.begin(ctx)
      const v = a.pieces[names[ri]!]!(input, pos, ctx)
      if (v === FAIL) return -1
      last = v
      return a.end()
    },
    lastValue: () => last,
    // `scanSkipFor` runs BEFORE `runRule` on the first parse, so it selects the
    // assembly itself rather than reading a `live` that is not set yet. The
    // lookup is memoised, so this is a array index after the first parse.
    scanSkipFor: (ri, ctx) => (live ?? cache.forCtx(ctx)).scanSkip[skipOf?.[ri] ?? -1],
  })
}
