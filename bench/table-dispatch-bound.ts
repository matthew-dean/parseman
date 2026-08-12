/**
 * THE BOUND, MEASURED — what a switch-over-a-tape costs against bound closures.
 *
 * This is not the parser. It is the DISPATCH SHELL of the parser, isolated: the
 * same tree of ~500k nodes (the row count `bench/jess/g5-rows.ts` measures for
 * `benchmark.less`), walked two ways, doing byte-identical leaf work.
 *
 *   tape     `switch (code[ip])` over an `Int32Array`, operands decoded from
 *            `code[ip+n]`, plus the per-row config reads the driver does today
 *            (`ctx._triviaLog`, `ctx._fields`, `ctx.build`, `ctx.trackLines` …).
 *   closure  the same tree lowered ONCE to closures with operands captured as
 *            `const`s and the config decisions already resolved by selection.
 *
 * The leaf work is identical and deliberately trivial, so the delta is dispatch
 * and decode and nothing else. That makes this an UPPER BOUND on what removing
 * them can return — real opcode bodies do more work, so the share is smaller in
 * the parser than here — and a LOWER bound on nothing. It is reported as such.
 *
 * Both sides are built from the same spec in the same process and interleaved by
 * `bench/ab-harness.ts`, because separate launches on this hardware do not
 * compare (see that file's header).
 *
 * Usage: `node --import tsx/esm bench/table-dispatch-bound.ts`
 */
import os from 'node:os'
import { interleave, median, type Case, type Contest, type Measurement } from './ab-harness.ts'

const M: Measurement = { targetSampleMs: 40, warmup: 3, timed: 5, rounds: 8, runs: 2 }

/** Opcodes, mirroring the driver's shape: a handful of hot ones among many. */
const T_LIT = 1, T_SEQ = 2, T_CHOICE = 3, T_REP = 4, T_NODE = 5

/** A per-parse context with the config fields the driver reads on every row. */
type Ctx = {
  pos: number
  trackLines: boolean
  build: unknown
  _triviaLog: unknown
  _rootTriviaLog: unknown
  _fields: unknown
  _errors: unknown
  _cstBuf: unknown
  _cstLeaves: unknown
  _cstRawChildren: unknown
  _cstTriviaLog: unknown
  sink: number
}

function ctx(): Ctx {
  return {
    pos: 0, trackLines: false, build: undefined,
    _triviaLog: undefined, _rootTriviaLog: undefined, _fields: undefined,
    _errors: undefined, _cstBuf: undefined, _cstLeaves: undefined,
    _cstRawChildren: undefined, _cstTriviaLog: undefined, sink: 0,
  }
}

/**
 * The SPEC both sides are built from — a tree, not a tape, so neither encoding
 * is privileged. Shaped like a grammar: sequences of choices of repetitions of
 * literals, wrapped in nodes.
 */
type Spec =
  | { op: typeof T_LIT; n: number }
  | { op: typeof T_SEQ; kids: Spec[] }
  | { op: typeof T_CHOICE; kids: Spec[] }
  | { op: typeof T_REP; kid: Spec; count: number }
  | { op: typeof T_NODE; kid: Spec; tag: number }

/** Deterministic pseudo-random so both sides walk an identical tree. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
}

function buildSpec(depth: number, r: () => number): Spec {
  if (depth <= 0) return { op: T_LIT, n: (r() * 64) | 0 }
  const pick = r()
  if (pick < 0.30) return { op: T_SEQ, kids: [buildSpec(depth - 1, r), buildSpec(depth - 1, r), buildSpec(depth - 1, r)] }
  if (pick < 0.55) return { op: T_CHOICE, kids: [buildSpec(depth - 1, r), buildSpec(depth - 1, r)] }
  if (pick < 0.78) return { op: T_REP, kid: buildSpec(depth - 1, r), count: 2 + ((r() * 3) | 0) }
  return { op: T_NODE, kid: buildSpec(depth - 1, r), tag: (r() * 16) | 0 }
}

function countNodes(s: Spec): number {
  switch (s.op) {
    case T_LIT: return 1
    case T_SEQ: case T_CHOICE: return 1 + s.kids.reduce((a, k) => a + countNodes(k), 0)
    case T_REP: return 1 + s.count * countNodes(s.kid)
    case T_NODE: return 1 + countNodes(s.kid)
  }
}

/* ── side A: the tape ────────────────────────────────────────────────────── */

function encode(s: Spec): Int32Array {
  const out: number[] = []
  const emit = (spec: Spec): number => {
    switch (spec.op) {
      case T_LIT: { const at = out.length; out.push(T_LIT, spec.n); return at }
      case T_SEQ: case T_CHOICE: {
        const kids = spec.kids.map(emit)
        const at = out.length
        out.push(spec.op, kids.length, ...kids)
        return at
      }
      case T_REP: { const k = emit(spec.kid); const at = out.length; out.push(T_REP, k, spec.count); return at }
      case T_NODE: { const k = emit(spec.kid); const at = out.length; out.push(T_NODE, k, spec.tag); return at }
    }
  }
  const root = emit(s)
  out.push(0, root)
  return Int32Array.from(out)
}

function tapeRunner(code: Int32Array): (c: Ctx) => number {
  const root = code[code.length - 1]!
  function exec(ip: number, c: Ctx): number {
    switch (code[ip]) {
      case T_LIT: {
        const n = code[ip + 1]!
        // The per-row config reads the driver does today.
        if (c._triviaLog !== undefined) c.sink++
        if (c.trackLines) c.sink++
        c.pos += n & 1
        return n
      }
      case T_SEQ: {
        const n = code[ip + 1]!
        let acc = 0
        for (let i = 0; i < n; i++) {
          if (c._fields !== undefined) c.sink++
          acc += exec(code[ip + 2 + i]!, c)
        }
        return acc
      }
      case T_CHOICE: {
        const n = code[ip + 1]!
        for (let i = 0; i < n; i++) {
          if (c._errors !== undefined) c.sink++
          const v = exec(code[ip + 2 + i]!, c)
          if ((v & 3) !== 3 || i === n - 1) return v
        }
        return 0
      }
      case T_REP: {
        const kid = code[ip + 1]!, count = code[ip + 2]!
        let acc = 0
        for (let i = 0; i < count; i++) {
          if (c._cstBuf !== undefined || c._cstLeaves !== undefined) c.sink++
          acc += exec(kid, c)
        }
        return acc
      }
      case T_NODE: {
        const kid = code[ip + 1]!, tag = code[ip + 2]!
        if (c._cstRawChildren !== undefined || c._cstTriviaLog !== undefined) c.sink++
        const v = exec(kid, c)
        if (c.build !== undefined) c.sink++
        if (c._rootTriviaLog !== undefined) c.sink++
        return v + tag
      }
      default: return 0
    }
  }
  return (c: Ctx) => exec(root, c)
}

/* ── side B: bound closures ──────────────────────────────────────────────── */

type Piece = (c: Ctx) => number

/**
 * ASSEMBLY. One walk, operands captured as `const`s, and the CONFIG decisions
 * made HERE by selection: `cfg.triviaLog` picks between two literal pieces
 * rather than being tested inside one. No piece body reads a config field.
 */
type Cfg = { triviaLog: boolean; trackLines: boolean; fields: boolean; errors: boolean; cst: boolean; build: boolean; rootTrivia: boolean }

function assemble(s: Spec, cfg: Cfg): Piece {
  switch (s.op) {
    case T_LIT: {
      const n = s.n, bump = n & 1
      // Four pieces; the option set reaches ONE. The others are never allocated.
      if (cfg.triviaLog && cfg.trackLines) return (c) => { c.sink += 2; c.pos += bump; return n }
      if (cfg.triviaLog) return (c) => { c.sink++; c.pos += bump; return n }
      if (cfg.trackLines) return (c) => { c.sink++; c.pos += bump; return n }
      return (c) => { c.pos += bump; return n }
    }
    case T_SEQ: {
      const kids = s.kids.map(k => assemble(k, cfg))
      if (kids.length === 3) {
        const a = kids[0]!, b = kids[1]!, d = kids[2]!
        if (cfg.fields) return (c) => { c.sink += 3; return a(c) + b(c) + d(c) }
        return (c) => a(c) + b(c) + d(c)
      }
      if (cfg.fields) return (c) => { let acc = 0; for (let i = 0; i < kids.length; i++) { c.sink++; acc += kids[i]!(c) } return acc }
      return (c) => { let acc = 0; for (let i = 0; i < kids.length; i++) acc += kids[i]!(c); return acc }
    }
    case T_CHOICE: {
      const kids = s.kids.map(k => assemble(k, cfg))
      const a = kids[0]!, b = kids[1]!
      if (kids.length === 2) {
        if (cfg.errors) return (c) => { c.sink++; const v = a(c); if ((v & 3) !== 3) return v; c.sink++; return b(c) }
        return (c) => { const v = a(c); if ((v & 3) !== 3) return v; return b(c) }
      }
      return (c) => { for (let i = 0; i < kids.length; i++) { const v = kids[i]!(c); if ((v & 3) !== 3 || i === kids.length - 1) return v } return 0 }
    }
    case T_REP: {
      const kid = assemble(s.kid, cfg), count = s.count
      if (cfg.cst) return (c) => { let acc = 0; for (let i = 0; i < count; i++) { c.sink++; acc += kid(c) } return acc }
      return (c) => { let acc = 0; for (let i = 0; i < count; i++) acc += kid(c); return acc }
    }
    case T_NODE: {
      const kid = assemble(s.kid, cfg), tag = s.tag
      const extra = (cfg.cst ? 1 : 0) + (cfg.build ? 1 : 0) + (cfg.rootTrivia ? 1 : 0)
      if (extra === 0) return (c) => kid(c) + tag
      return (c) => { c.sink += extra; return kid(c) + tag }
    }
  }
}

/* ── the contest ─────────────────────────────────────────────────────────── */

/** The AST-path option set: everything off, as `benchmark.less` runs it. */
const CFG: Cfg = { triviaLog: false, trackLines: false, fields: false, errors: false, cst: false, build: false, rootTrivia: false }

const spec = buildSpec(12, rng(0xC0FFEE))
const nodes = countNodes(spec)
const code = encode(spec)

const tapeA = tapeRunner(code)
const tapeB = tapeRunner(encode(spec))
const closA = assemble(spec, CFG)
const closB = assemble(spec, CFG)

// PROVE BOTH SIDES DO THE SAME WORK. The cheapest way for a side to look fast
// is to stop doing work; this is `assertSameParse`'s job, restated here.
{
  const ca = ctx(), cb = ctx()
  const ra = tapeA(ca), rb = closA(cb)
  if (ra !== rb || ca.sink !== cb.sink || ca.pos !== cb.pos) {
    throw new Error(`sides disagree: tape ${ra}/${ca.sink}/${ca.pos} vs closure ${rb}/${cb.sink}/${cb.pos}`)
  }
}

// ASSEMBLY COST, for the record — paid once, not the metric.
const tAsm0 = performance.now()
for (let i = 0; i < 20; i++) assemble(spec, CFG)
const asmMs = (performance.now() - tAsm0) / 20

function cases(fn: (c: Ctx) => number, tag: string): Case[] {
  const c = ctx()
  return [{
    id: 'tree',
    detail: `${tag} ${nodes} nodes`,
    parse: () => { c.sink = 0; c.pos = 0; return fn(c) },
    run: (reps: number) => { for (let i = 0; i < reps; i++) { c.sink = 0; c.pos = 0; fn(c) } },
  }]
}

const c0 = cases(tapeA, 'cal')[0]!
for (let i = 0; i < 5; i++) c0.parse()
const ts: number[] = []
for (let i = 0; i < 7; i++) { const t = performance.now(); c0.parse(); ts.push(performance.now() - t) }
const perParse = Math.max(median(ts), 0.001)
const reps = new Map([['tree', Math.max(1, Math.round(M.targetSampleMs / perParse))]])

const contests: Contest[] = [
  { label: 'CONTROL: tape    -> tape', a: cases(tapeA, 'tape'), b: cases(tapeB, 'tape') },
  { label: 'BOUND:   tape    -> closure', a: cases(tapeA, 'tape'), b: cases(closA, 'closure') },
  { label: 'CONTROL: closure -> closure', a: cases(closA, 'closure'), b: cases(closB, 'closure') },
]

console.log(`node ${process.version}   cpus ${os.cpus().length}   loadavg ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
console.log(`tree ${nodes} nodes (benchmark.less executes 497,360 driver rows)   tape ${code.length} words`)
console.log(`one walk: tape ${perParse.toFixed(3)} ms   assembly ${asmMs.toFixed(3)} ms (once per process, NOT the metric)`)
console.log('')

const out = interleave(contests, reps, M)
for (const k of contests) {
  const s = out.get(k.label)!
  const a = s.get('ref|tree')!, b = s.get('head|tree')!
  const dMed = (median(b) / median(a) - 1) * 100
  const dMin = (Math.min(...b) / Math.min(...a) - 1) * 100
  let wins = 0
  for (let n = 0; n < b.length; n++) if (b[n]! < a[n]!) wins++
  console.log(
    `  ${k.label.padEnd(30)} median ${(dMed >= 0 ? '+' : '') + dMed.toFixed(1)}%   min ${(dMin >= 0 ? '+' : '') + dMin.toFixed(1)}%`
    + `   B-wins ${wins}/${b.length}   (${median(a).toFixed(2)} -> ${median(b).toFixed(2)} ms per ${reps.get('tree')} walks)`,
  )
}
console.log('')
console.log('  The BOUND row is an UPPER bound on what removing dispatch+decode returns:')
console.log('  the leaf work here is trivial, so dispatch is a larger share than in the parser.')
console.log('  Read it against BOTH control rows — either one is this run\'s noise floor.')
