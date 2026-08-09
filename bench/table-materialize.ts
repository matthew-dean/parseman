/**
 * THE MATERIALISING VARIANT — a ceiling probe, not a product.
 *
 * WHICH ENGINES THIS BINDS. `execRules()` (`src/table/exec.ts`) is the REFERENCE
 * bytecode interpreter and is NOT what ships; `compose()`
 * (`src/compiler/linker.ts`) is the shipped ASSEMBLER. No source-lowering
 * "codegen" engine appears here — the source lowering was DELETED in `37c57b5`.
 *
 * The question this exists to answer: the reference interpreter is 2.2x-3.3x
 * slower than the assembler, and one live explanation is that `src/table/exec.ts` is an
 * INTERPRETER — it reads `code[ip]`, switches on it, and loads every operand out
 * of an `Int32Array`, once per row, on every parse. If that dispatch is the
 * cost, then building the same table into a tree of CLOSURES once at load, and
 * calling them directly, should recover most of the gap.
 *
 * So this compiles the SAME `TableProgram` — same encoder, same rows, same
 * reducers, same fusion and the same SEQ terminal fast path — into one closure
 * per row. What changes, and the ONLY thing that changes:
 *
 *   removed   the `code[ip]` read, the 28-case switch, and every operand load
 *             (`k[code[ip+1]]`, `fx[code[ip+2]]`, …). Operands become closure
 *             captures, resolved once.
 *   added     an indirect call through a closure variable per row, where the
 *             driver made a DIRECT call to the single `exec` function.
 *
 * That second line is why this is a measurement and not a refactor: `exec` is
 * one function, so `exec(child, …)` is a monomorphic direct call, while
 * `child(input, pos, ctx)` in a materialised `seq` is one call site reached by
 * every seq child in the grammar — megamorphic by construction. The dispatch
 * does not disappear; it MOVES, from a switch to an inline cache. Whether that
 * is a win is exactly what has to be measured, and the answer is not obvious.
 *
 * SCOPE: the opcodes `example/json` actually uses — SCOPE, XFORM, LIT, RX, SEQX,
 * OPT, REP, CHOICE. It throws on anything else rather than approximating it.
 * json is the right testbed because it reproduces the full penalty (the shipped
 * A/B measures ~2.6x on it), and a ceiling measured on a grammar that reproduces
 * the effect is a real ceiling. What it does NOT cover is `OP_NODE`, and that
 * matters for reading the result: node building funnels every one of a grammar's
 * builders through ONE `build(...)` call site, and materialising does not fix
 * that — a closure-tree `node` closure has one shared body too. So this number
 * is the ceiling for removing ROW DISPATCH, and no part of it is a claim about
 * the megamorphic reducer sites.
 *
 * Usage: `node bench/table-materialize.ts`
 */
import os from 'node:os'
import type { Combinator, ParseContext, ParseResult } from '../src/types.ts'
import { compose } from '../src/compiler/linker.ts'
import { encodeTable } from '../src/table/encode.ts'
import { execRules } from '../src/table/exec.ts'
import { resolveTable, type TableProgram } from '../src/table/program.ts'
import { run } from '../src/functional/run.ts'
import { advanceTrivia, needsDeferredTriviaCommit, rollbackTrivia, saveTriviaMark, scanTrivia } from '../src/combinators/trivia-skip.ts'
import { cstCaptureActive, pushCstLeaf, rollbackCstCapture, saveCstMark, type CstRollbackMark } from '../src/cst/capture-buffer.ts'
import {
  OP_CHOICE, OP_LIT, OP_OPT, OP_REP, OP_REPV, OP_RX, OP_SCOPE, OP_SCOPE_PLAIN, OP_SEQX, OP_XFORM,
} from '../src/table/ops.ts'
import { jsonRules, jsonWs } from './table-grammars.ts'
import { LARGE_JSON, MEDIUM_JSON, SMALL_JSON } from './fixtures.ts'
import { PARSEMAN_VERSION } from '../src/version.ts'
import { interleave, median, pairedMedianRatio, pairedMinRatio, pairedWins, sign, type Case, type Contest, type Measurement } from './ab-harness.ts'

const FAIL: unique symbol = Symbol('pm.fail')
const EMPTY_FX: string[] = []

type Fn = (input: string, pos: number, ctx: ParseContext) => unknown

/**
 * Build the closure tree for a resolved table.
 *
 * Shares the driver's protocol exactly — a module-scoped sentinel for failure
 * and one shared end slot — so the two differ in dispatch and in nothing else.
 */
function materialize(prog: TableProgram, opts: { specializeTerminals?: boolean } = {}): { rules: Record<string, Fn>; end: () => number } {
  const spec = opts.specializeTerminals === true
  const t = resolveTable(prog)
  const code = t.code, k = t.k, fns = t.fns, fx = t.fx, disp = t.disp, trivia = t.trivia
  let END = 0

  const memo = new Map<number, Fn>()
  const building = new Set<number>()

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
   * Read `_fc` through a call, for the reason `exec.ts:98` gives: every reader
   * writes `false` immediately before the call it guards, so TypeScript narrows
   * the type to `false` and the comparison looks dead. It is not — the callee
   * mutates it, and the checker cannot see that.
   */
  function committed(c: ParseContext): boolean {
    return c._fc === true
  }

  function lead(input: string, pos: number): number {
    if (pos >= input.length) return -1
    const c = input.charCodeAt(pos)
    if (c < 0xd800 || c > 0xdbff) return c
    return input.codePointAt(pos) ?? c
  }

  /**
   * A grammar is recursive, so `build(ip)` can re-enter an ip it is still
   * building. The forwarder resolves through the memo on FIRST CALL and then
   * calls the real closure — one extra indirection on a back edge, paid once per
   * traversal of that edge, which is what any closure-tree design has to do.
   */
  function build(ip: number): Fn {
    const done = memo.get(ip)
    if (done !== undefined) return done
    if (building.has(ip)) {
      const fwd: Fn = (input, pos, ctx) => memo.get(ip)!(input, pos, ctx)
      return fwd
    }
    building.add(ip)
    const f = compile(ip)
    building.delete(ip)
    memo.set(ip, f)
    return f
  }

  function compile(ip: number): Fn {
    const op = code[ip]!
    switch (op) {
      case OP_LIT: {
        const s = k[code[ip + 1]!] as string
        const len = s.length
        const exp = fx[code[ip + 2]!] as string[]
        // TERMINAL SPECIALISATION — the thing codegen does that an opcode cannot.
        // `emitLit` (codegen.ts:1392,1408) unrolls a short literal into
        // `input.charCodeAt(pos) === 123`; `OP_LIT` calls `input.startsWith(s,
        // pos)`, a generic string method with a receiver check and a length
        // guard, because the literal is an OPERAND and the opcode has to work for
        // every literal. A materialising build knows the literal, so it can pick
        // the specialised closure — and this is `swaps on … leafs` in G5's own
        // words, done at load rather than at build.
        if (spec && len === 1) {
          const c0 = s.charCodeAt(0)
          return (input, pos, ctx) => {
            if (input.charCodeAt(pos) === c0) {
              const e = pos + 1
              if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: s, span: { start: pos, end: e } })
              END = e
              return s
            }
            ctx._fe = pos; ctx._fx = exp
            return FAIL
          }
        }
        if (spec && len === 2) {
          const c0 = s.charCodeAt(0), c1 = s.charCodeAt(1)
          return (input, pos, ctx) => {
            if (input.charCodeAt(pos) === c0 && input.charCodeAt(pos + 1) === c1) {
              const e = pos + 2
              if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: s, span: { start: pos, end: e } })
              END = e
              return s
            }
            ctx._fe = pos; ctx._fx = exp
            return FAIL
          }
        }
        return (input, pos, ctx) => {
          if (input.startsWith(s, pos)) {
            const e = pos + len
            if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: s, span: { start: pos, end: e } })
            END = e
            return s
          }
          ctx._fe = pos; ctx._fx = exp
          return FAIL
        }
      }
      case OP_RX: {
        const re = k[code[ip + 1]!] as RegExp
        const exp = fx[code[ip + 2]!] as string[]
        return (input, pos, ctx) => {
          re.lastIndex = pos
          const m = re.exec(input)
          if (m !== null) {
            const v = m[0]
            const e = pos + v.length
            if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: v, span: { start: pos, end: e } })
            END = e
            return v
          }
          ctx._fe = pos; ctx._fx = exp
          return FAIL
        }
      }
      case OP_SCOPE:
      case OP_SCOPE_PLAIN: {
        const ki = code[ip + 1]!
        const scopeTrivia = ki < 0 ? undefined : (trivia[ki] as ParseContext['trivia'])
        const labels = scopeTrivia?._meta.triviaKindLabels
        const body = build(code[ip + 2]!)
        return (input, pos, ctx) => {
          const saved = ctx.trivia, savedLabels = ctx.triviaKindLabels
          ctx.trivia = scopeTrivia
          ctx.triviaKindLabels = labels
          const v = body(input, pos, ctx)
          ctx.trivia = saved
          ctx.triviaKindLabels = savedLabels
          return v
        }
      }
      case OP_XFORM: {
        const fn = fns[code[ip + 1]!] as (value: unknown, span: { start: number; end: number }) => unknown
        const body = build(code[ip + 2]!)
        return (input, pos, ctx) => {
          const v = body(input, pos, ctx)
          if (v === FAIL) return FAIL
          return fn(v, { start: pos, end: END })
        }
      }
      case OP_SEQX: {
        const reducer = code[ip + 1]!
        const projection = reducer < 0 ? ~reducer : -1
        const fn = projection < 0
          ? fns[reducer] as (value: unknown, span: { start: number; end: number }) => unknown
          : undefined
        const n = code[ip + 2]!
        // The driver's SEQ terminal fast path, materialised: a LIT/RX child runs
        // IN PLACE rather than through a call. Dropping it here would measure a
        // missing optimisation instead of the dispatch change.
        const kids: Fn[] = []
        const kind: number[] = []
        const lits: string[] = []
        /** Precomputed lead code for kind-3 children; resolving it per item would
         *  put back exactly the operand load specialisation exists to remove. */
        const code0: number[] = []
        const res: Array<RegExp | null> = []
        const exps: string[][] = []
        for (let i = 0; i < n; i++) {
          const c = code[ip + 3 + i]!
          const cop = code[c]
          if (cop === OP_LIT || cop === OP_RX) {
            // kind 3 is the specialised single-char literal; see OP_LIT above.
            const isLit1 = cop === OP_LIT && spec && (k[code[c + 1]!] as string).length === 1
            kind.push(isLit1 ? 3 : cop === OP_LIT ? 1 : 2)
            const litText = cop === OP_LIT ? k[code[c + 1]!] as string : ''
            lits.push(litText)
            code0.push(litText === '' ? -1 : litText.charCodeAt(0))
            res.push(cop === OP_RX ? k[code[c + 1]!] as RegExp : null)
            exps.push(fx[code[c + 2]!] as string[])
            kids.push(null as unknown as Fn)
          } else {
            kind.push(0); lits.push(''); code0.push(-1); res.push(null); exps.push(EMPTY_FX)
            kids.push(build(c))
          }
        }
        return (input, pos, ctx) => {
          const values: unknown[] = []
          let cur = pos
          for (let i = 0; i < n; i++) {
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
              const kk = kind[i]!
              let v: unknown
              if (kk === 3) {
                const lit = lits[i]!
                if (input.charCodeAt(scanEnd) !== code0[i]!) { ctx._fe = scanEnd; ctx._fx = exps[i]!; return FAIL }
                END = scanEnd + 1
                if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: lit, span: { start: scanEnd, end: END } })
                v = lit
              } else if (kk === 1) {
                const lit = lits[i]!
                if (!input.startsWith(lit, scanEnd)) { ctx._fe = scanEnd; ctx._fx = exps[i]!; return FAIL }
                END = scanEnd + lit.length
                if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: lit, span: { start: scanEnd, end: END } })
                v = lit
              } else if (kk === 2) {
                const re = res[i]!
                re.lastIndex = scanEnd
                const m = re.exec(input)
                if (m === null) { ctx._fe = scanEnd; ctx._fx = exps[i]!; return FAIL }
                END = scanEnd + m[0].length
                if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: m[0], span: { start: scanEnd, end: END } })
                v = m[0]
              } else {
                v = kids[i]!(input, scanEnd, ctx)
                if (v === FAIL) return FAIL
              }
              if (END > scanEnd) cur = END
              else if (mark !== null) rollbackTrivia(ctx, mark)
              values.push(v)
              continue
            }
            const kk = kind[i]!
            if (kk === 3) {
              if (input.charCodeAt(cur) !== code0[i]!) { ctx._fe = cur; ctx._fx = exps[i]!; return FAIL }
              const lit = lits[i]!
              const e = cur + 1
              if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: lit, span: { start: cur, end: e } })
              values.push(lit); cur = e; continue
            }
            if (kk === 1) {
              const lit = lits[i]!
              if (!input.startsWith(lit, cur)) { ctx._fe = cur; ctx._fx = exps[i]!; return FAIL }
              const e = cur + lit.length
              if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: lit, span: { start: cur, end: e } })
              values.push(lit); cur = e; continue
            }
            if (kk === 2) {
              const re = res[i]!
              re.lastIndex = cur
              const m = re.exec(input)
              if (m === null) { ctx._fe = cur; ctx._fx = exps[i]!; return FAIL }
              const mv = m[0]
              const e = cur + mv.length
              if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: mv, span: { start: cur, end: e } })
              values.push(mv); cur = e; continue
            }
            const v = kids[i]!(input, cur, ctx)
            if (v === FAIL) return FAIL
            values.push(v)
            cur = END
          }
          END = cur
          return projection >= 0 ? values[projection] : fn!(values, { start: pos, end: cur })
        }
      }
      case OP_OPT: {
        const body = build(code[ip + 1]!)
        return (input, pos, ctx) => {
          const mark: CstRollbackMark | null = rollbackNeeded(ctx) ? saveCstMark(ctx) : null
          ctx._fc = false
          const v = body(input, pos, ctx)
          if (v === FAIL) {
            if (committed(ctx)) return FAIL
            if (mark !== null) rollbackCstCapture(ctx, mark)
            END = pos
            return null
          }
          return v
        }
      }
      case OP_CHOICE: {
        const d = code[ip + 1]!
        const n = code[ip + 2]!
        const choiceFx = fx[code[ip + 3]!] as string[]
        const arms: Fn[] = []
        for (let i = 0; i < n; i++) arms.push(build(code[ip + 4 + i]!))
        const table = d >= 0 ? disp[d]! : null
        return (input, pos, ctx) => {
          if (table !== null) {
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
              ctx._fc = false
              const v = arms[arm]!(input, pos, ctx)
              if (v !== FAIL) return v
              if (committed(ctx)) return FAIL
            }
            const open = table.open
            if (open.length === 0) { ctx._fe = pos; ctx._fx = choiceFx; return FAIL }
            const mark: CstRollbackMark | null = rollbackNeeded(ctx) ? saveCstMark(ctx) : null
            if (mark !== null) rollbackCstCapture(ctx, mark)
            for (let i = 0; i < open.length; i++) {
              ctx._fc = false
              const v = arms[open[i]!]!(input, pos, ctx)
              if (v !== FAIL) return v
              if (committed(ctx)) return FAIL
              if (mark !== null) rollbackCstCapture(ctx, mark)
            }
            ctx._fe = pos; ctx._fx = choiceFx
            return FAIL
          }
          const mark: CstRollbackMark | null = rollbackNeeded(ctx) ? saveCstMark(ctx) : null
          for (let i = 0; i < n; i++) {
            ctx._fc = false
            const v = arms[i]!(input, pos, ctx)
            if (v !== FAIL) return v
            if (committed(ctx)) return FAIL
            if (mark !== null) rollbackCstCapture(ctx, mark)
          }
          ctx._fe = pos; ctx._fx = choiceFx
          return FAIL
        }
      }
      case OP_REP:
      case OP_REPV: {
        const child = build(code[ip + 1]!)
        const min = code[ip + 2]!
        const max = code[ip + 3]!
        const sepIp = code[ip + 4]!
        const sep = sepIp >= 0 ? build(sepIp) : null
        const trailingAllowed = (code[ip + 5]! & 1) !== 0
        const collects = op === OP_REP
        const skipBeforeFirst = sepIp < 0 && min === 0
        return (input, pos, ctx) => {
          const out: unknown[] | undefined = collects ? [] : undefined
          const hasTrivia = ctx.trivia !== undefined
          const needMark = rollbackNeeded(ctx)
          let cur = pos
          let count = 0
          for (;;) {
            if (max >= 0 && count >= max) break
            const cmark = needMark ? saveCstMark(ctx) : null
            const tmark = needMark ? saveTriviaMark(ctx) : null
            let itemStart = cur
            let sepEnd = -1
            if (sep !== null && count > 0) {
              let sp = cur
              if (hasTrivia) sp = skipTrivia(input, sp, ctx)
              ctx._fc = false
              const sv = sep(input, sp, ctx)
              if (sv === FAIL) {
                if (tmark !== null) rollbackTrivia(ctx, tmark)
                if (cmark !== null) rollbackCstCapture(ctx, cmark)
                if (committed(ctx)) return FAIL
                break
              }
              sepEnd = END
              itemStart = hasTrivia ? skipTrivia(input, END, ctx) : END
            } else if (hasTrivia && (count > 0 || skipBeforeFirst)) {
              itemStart = skipTrivia(input, itemStart, ctx)
            }
            if (itemStart >= input.length && (count > 0 || skipBeforeFirst)) {
              if (tmark !== null) rollbackTrivia(ctx, tmark)
              if (cmark !== null) rollbackCstCapture(ctx, cmark)
              if (trailingAllowed && sepEnd >= 0) cur = sepEnd
              break
            }
            ctx._fc = false
            const v = child(input, itemStart, ctx)
            if (v === FAIL) {
              if (tmark !== null) rollbackTrivia(ctx, tmark)
              if (cmark !== null) rollbackCstCapture(ctx, cmark)
              if (committed(ctx)) return FAIL
              if (trailingAllowed && sepEnd >= 0) cur = sepEnd
              break
            }
            if (END === itemStart) {
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
      }
      default:
        throw new Error(`materialize: opcode ${String(op)} at ${ip} is out of this probe's scope`)
    }
  }

  function skipTrivia(input: string, cur: number, ctx: ParseContext): number {
    if (needsDeferredTriviaCommit(ctx)) {
      const scan = scanTrivia(input, cur, ctx)
      scan.commit()
      return scan.end
    }
    return advanceTrivia(input, cur, ctx)
  }

  const rules: Record<string, Fn> = {}
  for (const name of Object.keys(prog.rules)) rules[name] = build(prog.rules[name]!)
  return { rules, end: () => END }
}

/** Wrap a materialised rule in the same `ParseResult` protocol `run()` expects. */
function entryOf(m: ReturnType<typeof materialize>, name: string): (input: string, pos: number, ctx: ParseContext) => ParseResult<unknown> {
  const f = m.rules[name]!
  return (input, pos, ctx) => {
    ctx._fe = -1
    ctx._fx = EMPTY_FX
    ctx._fc = false
    const v = f(input, pos, ctx)
    if (v === FAIL) {
      const fe = ctx._fe
      const at = fe === undefined || fe < 0 ? pos : fe
      return { ok: false, expected: (ctx._fx ?? EMPTY_FX) as string[], span: { start: at, end: at } }
    }
    return { ok: true, value: v, span: { start: pos, end: m.end() } }
  }
}

/* ── the A/B ─────────────────────────────────────────────────────────────── */

const M: Measurement = { targetSampleMs: 20, warmup: 4, timed: 7, rounds: 10, runs: 2 }

const INPUTS: Array<[string, string]> = [
  ['json/small', SMALL_JSON],
  ['json/medium', MEDIUM_JSON],
  ['json/large', LARGE_JSON],
]

type Entry = Parameters<typeof run>[0]

function makeCases(entry: Entry, tag: string): Case[] {
  return INPUTS.map(([id, text]) => ({
    id,
    detail: `${tag} ${text.length} B`,
    parse: () => run(entry, text, { trivia: jsonWs as Entry }).value,
    run: (reps: number) => { for (let i = 0; i < reps; i++) run(entry, text, { trivia: jsonWs as Entry }) },
  }))
}

function calibrateReps(cases: readonly Case[]): Map<string, number> {
  const reps = new Map<string, number>()
  for (const c of cases) {
    for (let k = 0; k < 5; k++) c.parse()
    const ts: number[] = []
    for (let k = 0; k < 9; k++) {
      const t0 = performance.now()
      c.parse()
      ts.push(performance.now() - t0)
    }
    reps.set(c.id, Math.max(1, Math.round(M.targetSampleMs / Math.max(median(ts), 0.01))))
  }
  return reps
}

function main(): void {
  const map = jsonRules as unknown as Record<string, Combinator<unknown>>
  console.log(`parseman ${PARSEMAN_VERSION}   ${process.cwd()}   node ${process.version}`)
  console.log(`  loadavg at start ${os.loadavg().map(n => n.toFixed(1)).join(' ')}`)

  const prog = encodeTable(map)
  const compiledA = (compose([map as never]) as unknown as Record<string, Entry>).Value!
  const compiledB = (compose([map as never]) as unknown as Record<string, Entry>).Value!
  const table = execRules(prog).Value! as unknown as Entry
  const mat = entryOf(materialize(prog), 'Value') as unknown as Entry
  const matSpec = entryOf(materialize(prog, { specializeTerminals: true }), 'Value') as unknown as Entry

  // SAME-PARSE PRECONDITION. A timing comparison between two different parses is
  // not a comparison, and a materialiser that silently drops a case would read
  // as a large win.
  for (const [id, text] of INPUTS) {
    const a = JSON.stringify(run(compiledA, text, { trivia: jsonWs as Entry }).value)
    const t = JSON.stringify(run(table, text, { trivia: jsonWs as Entry }).value)
    const m = JSON.stringify(run(mat, text, { trivia: jsonWs as Entry }).value)
    const ms = JSON.stringify(run(matSpec, text, { trivia: jsonWs as Entry }).value)
    if (a !== t || a !== m || a !== ms) {
      console.error(`ABORT: ${id} — paths disagree (assembled/exec/materialised); timings would be meaningless.`)
      process.exit(1)
    }
  }
  console.log('  same-parse precondition: OK on all cases (assembled = exec = materialised)')

  const reps = calibrateReps(makeCases(compiledA, 'cal'))

  const contests: Contest[] = [
    { label: 'CONTROL: assembled -> assembled', a: makeCases(compiledA, 'compiled'), b: makeCases(compiledB, 'compiled') },
    { label: 'A: assembled (shipped) -> exec (reference)', a: makeCases(compiledA, 'compiled'), b: makeCases(table, 'table') },
    { label: 'B: assembled -> materialised (THE CEILING)', a: makeCases(compiledA, 'compiled'), b: makeCases(mat, 'mat') },
    { label: 'C: exec (reference) -> materialised (what dispatch removal buys)', a: makeCases(table, 'table'), b: makeCases(mat, 'mat') },
    { label: 'D: assembled -> materialised + SPECIALISED TERMINALS', a: makeCases(compiledA, 'compiled'), b: makeCases(matSpec, 'mat+') },
    { label: 'E: materialised -> materialised + SPECIALISED TERMINALS', a: makeCases(mat, 'mat'), b: makeCases(matSpec, 'mat+') },
  ]

  const out = interleave(contests, reps, M)

  console.log('')
  for (const c of contests) {
    const s = out.get(c.label)!
    console.log(c.label)
    for (const [id] of INPUTS) {
      const a = s.get(`ref|${id}`)!
      const b = s.get(`head|${id}`)!
      const dMed = (pairedMedianRatio(a, b) - 1) * 100
      const dMin = (pairedMinRatio(s, `ref|${id}`, `head|${id}`) - 1) * 100
      const wins = pairedWins(a, b)
      console.log(`  ${id.padEnd(12)} median ${sign(dMed).padStart(8)}   min ${sign(dMin).padStart(8)}   B-wins ${wins}/${b.length}`)
    }
  }
  console.log('')
  console.log(`  loadavg at end   ${os.loadavg().map(n => n.toFixed(1)).join(' ')}`)
  console.log('  Read every row against the CONTROL: it is two instances of the same path, so its')
  console.log('  delta is this run\'s noise floor. Row C is the answer — how much of row A\'s gap')
  console.log('  removing per-row dispatch actually recovers.')
}

main()
