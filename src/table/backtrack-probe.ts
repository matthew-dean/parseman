/**
 * THE BACKTRACKING PROBE, for the two table engines.
 *
 * "Parseman never backtracks" is checkable only if backtracking is counted. This
 * module counts it without touching either engine: it rewrites a COPY of a program
 * so that every terminal row reports what it consumed, and runs that copy on the
 * closure engine — or, in tests and benches, on the emitted engine from a
 * build-time module (`bench/emitted-assembly.ts`); nothing here builds code from
 * source. A program that is not rewritten carries no
 * probe row, so an ordinary parse pays nothing for this — no branch, no field, no
 * assembly key. That is the whole reason it is a program rewrite and not a `RunCfg`
 * bit: a bit would still be a second assembly every engine has to know about.
 *
 * WHAT IS COUNTED, per parse (`BacktrackCounts`):
 *
 *   - rewinds: a terminal consumed input starting BELOW the end of the previous
 *     consumed terminal — the parse went backwards, because a failed arm, an
 *     `attempt()`, an `optional()` or a choice restored the position;
 *   - bytesReread: of those terminals' bytes, the ones below the furthest byte
 *     already consumed;
 *   - lookaheads / lookaheadBytes: `not()`/`peek()` evaluations, and the bytes
 *     terminals matched inside them;
 *   - regexLookarounds / regexLookaroundBytes: runs of a regex terminal whose
 *     pattern holds a lookaround, and how far past its match a successful one
 *     depended on the input.
 *
 * A terminal is a row that reads input itself: `LIT`, `RX`, `LIT_CI`, `LEX_BODY`,
 * `LEX_PROGRAM`, `SCAN`, `LIVE` and their line-tracking twins. Trivia between
 * terms is not a terminal and is not counted, and neither is the work inside one
 * terminal: a lexical body or a scan is one read. A `token()` is the terminals it
 * holds. `routed()` reads nothing: the `dispatch()` selector consumed the token.
 *
 * HOW, row by row. A terminal `T` in a parent's slot becomes `XFORM(report, T)`,
 * which hands the recorder `T`'s span and returns `T`'s value unchanged. A
 * lookahead needs to know it is one, so `not(c)` becomes
 *
 *     ARMGATE(enter, XFORM(exit, NOT(XFORM(exit, c))))
 *
 * whose `exit` runs once whether `c` matches or not, and `peek(c)` becomes `NOT`
 * of that. A regex with a lookaround becomes `ARMGATE(attempt, XFORM(match, RX))`.
 * No gadget is a sequence: a sequence skips trivia between its terms, which would
 * move where the rewritten row ends.
 *
 * A scan reads its stop and skip subtrees as part of one read, and those may be
 * rows the grammar shares. The rewrite gives the scan pool its own copy of them,
 * left as it was, so the scan reports once, as the terminal it is.
 *
 * Every row there is one both engines already run. A rewritten parse must return
 * what the plain one returns; `backtrackProbe` checks that on every input.
 */
import {
  OP_ARMGATE, OP_GREEDY, OP_LEX_BODY, OP_LEX_PROGRAM, OP_LIT, OP_LIT_CI, OP_LIT_CI_TRACK,
  OP_LIT_TRACK, OP_LIVE, OP_NOT, OP_PEEK, OP_RX, OP_RX_TRACK, OP_SCAN, OP_XFORM,
} from './ops.ts'
import { childSlotOffsets, childSlots } from './child-slots.ts'
import {
  assemblyExtraIps, expandCompact, type CompactProgram, type SubtreeRef, type TableProgram,
} from './program.ts'
import type { RunCfg } from './assemble.ts'

export type BacktrackCounts = {
  rewinds: number
  bytesReread: number
  lookaheads: number
  lookaheadBytes: number
  regexLookarounds: number
  regexLookaroundBytes: number
}

const LOOKAROUND = /(?<!\\)\(\?<?[=!]/

/** Does this pattern read input it does not consume? */
export function hasLookaround(re: RegExp): boolean {
  return LOOKAROUND.test(re.source)
}

/**
 * How far past `end` a regex match at `start` depended on the input: the shortest
 * extension of the input past `end` under which the match still ends at `end`.
 * A lower bound for a negative lookaround, which is decided by what does NOT
 * follow and so can hold on a shorter input than it read.
 */
function lookaroundExtent(re: RegExp, input: string, start: number, end: number): number {
  const probe = new RegExp(re.source, re.flags.includes('y') ? re.flags : `${re.flags}y`)
  const same = (n: number): boolean => {
    probe.lastIndex = start
    return probe.test(input.slice(0, end + n)) && probe.lastIndex === end
  }
  let lo = 0
  let hi = input.length - end
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (same(mid)) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * The counters one probed parse writes. Shared by both table engines and the
 * interpreter probe, so all three count by the same rule.
 */
export class BacktrackRecorder {
  input = ''
  private counts: BacktrackCounts = zeroCounts()
  private look = 0
  private opaque = 0
  private last = 0
  private furthest = 0

  begin(input: string): void {
    this.input = input
    this.counts = zeroCounts()
    this.look = 0
    this.opaque = 0
    this.last = 0
    this.furthest = 0
  }

  /** The counts for the parse `begin` opened. Throws if a region was left open. */
  end(): BacktrackCounts {
    if (this.look !== 0 || this.opaque !== 0) {
      throw new Error(`backtrack probe: unbalanced region (lookahead ${this.look}, opaque ${this.opaque})`)
    }
    return this.counts
  }

  consume(start: number, end: number): void {
    if (this.opaque > 0 || end <= start) return
    const c = this.counts
    if (this.look > 0) { c.lookaheadBytes += end - start; return }
    if (start < this.last) c.rewinds++
    if (start < this.furthest) c.bytesReread += Math.min(end, this.furthest) - start
    this.last = end
    if (end > this.furthest) this.furthest = end
  }

  enterLookahead(): void {
    if (this.opaque === 0) this.counts.lookaheads++
    this.look++
  }

  exitLookahead(): void { this.look-- }

  regexAttempt(): void {
    if (this.opaque === 0) this.counts.regexLookarounds++
  }

  regexMatch(re: RegExp, start: number, end: number): void {
    if (this.opaque === 0) this.counts.regexLookaroundBytes += lookaroundExtent(re, this.input, start, end)
    this.consume(start, end)
  }

  /** A read whose inner steps are not the grammar's (the interpreter's scans). */
  enterOpaque(): void { this.opaque++ }
  exitOpaque(): void { this.opaque-- }
}

export function zeroCounts(): BacktrackCounts {
  return { rewinds: 0, bytesReread: 0, lookaheads: 0, lookaheadBytes: 0, regexLookarounds: 0, regexLookaroundBytes: 0 }
}

type Span = { readonly start: number; readonly end: number }

/** Every row start reachable from `roots`, ascending, closed by `code.length`. */
function rowStarts(code: ArrayLike<number>, roots: Iterable<number>): number[] {
  const seen = new Set<number>()
  const stack = [...roots]
  const kids: number[] = []
  while (stack.length > 0) {
    const ip = stack.pop()!
    if (seen.has(ip)) continue
    seen.add(ip)
    kids.length = 0
    childSlots(code, ip, kids)
    for (const c of kids) stack.push(c)
  }
  return [...seen, code.length].sort((a, b) => a - b)
}

/** A copy of `source` whose terminals and lookaheads report to `rec`. */
export function probeProgram(source: TableProgram | CompactProgram, rec: BacktrackRecorder): TableProgram {
  const prog = expandCompact(source)
  const code = [...prog.code]
  const fns: unknown[] = [...prog.fns]
  const fx: (readonly string[])[] = [...prog.fx, []]
  const noFx = fx.length - 1
  const row = (...words: number[]): number => {
    const ip = code.length
    code.push(...words)
    return ip
  }
  const fn = (f: unknown): number => fns.push(f) - 1
  const slots: number[] = []

  // A scan's subtrees run as part of ONE read, and may be rows the grammar also
  // reaches. They get their own uninstrumented copy, so the rewrite below never
  // reaches them through a row it shares with the grammar.
  const extraIps = assemblyExtraIps(prog)
  const starts = rowStarts(prog.code, [...Object.values(prog.rules), ...extraIps])
  const copies = new Map<number, number>()
  function copyOf(ip: number): number {
    const hit = copies.get(ip)
    if (hit !== undefined) return hit
    slots.length = 0
    childSlotOffsets(prog.code, ip, slots)
    if (slots.length === 0) { copies.set(ip, ip); return ip }
    // Rows are laid out end to end, so a row runs to the next row that starts.
    const next = starts[starts.findIndex(s => s > ip)]!
    const at = code.length
    copies.set(ip, at)
    for (let i = ip; i < next; i++) code.push(prog.code[i]!)
    const own = slots.map(s => s - ip)
    for (const o of own) code[at + o] = copyOf(prog.code[ip + o]!)
    return at
  }
  const ref = (r: SubtreeRef): SubtreeRef => [copyOf(r[0]), r[1]]
  const scans = prog.scans?.map(s => ({
    ...s,
    skip: s.skip.map(ref),
    ...(s.sentinel === undefined ? {} : { sentinel: ref(s.sentinel) }),
    ...(s.recoverAt === undefined ? {} : { recoverAt: ref(s.recoverAt) }),
    ...(s.stopAt === undefined ? {} : { stopAt: ref(s.stopAt) }),
    ...(s.prefix === undefined ? {} : { prefix: ref(s.prefix) }),
    ...(s.body === undefined ? {} : { body: ref(s.body) }),
    ...(s.first === undefined ? {} : { first: ref(s.first) }),
    ...(s.lazy === undefined ? {} : { lazy: ref(s.lazy) }),
  }))
  const scanSkip = prog.scanSkip?.map(set => set.map(ref))

  const report = fn((v: unknown, span: Span) => { rec.consume(span.start, span.end); return v })
  const lookIn = fn(() => { rec.enterLookahead(); return true })
  const lookOut = fn((v: unknown) => { rec.exitLookahead(); return v })
  const regexTry = fn(() => { rec.regexAttempt(); return true })

  // `exit` runs once on each outcome: inside the NOT when the child matched (the
  // NOT then fails), outside it when the NOT holds — including when its lead
  // gate holds without running the child.
  const lookahead = (child: number, fxi: number): number => row(OP_ARMGATE, lookIn,
    row(OP_XFORM, lookOut, row(OP_NOT, row(OP_XFORM, lookOut, replacement(child) ?? child), fxi)), noFx)

  const replaced = new Map<number, number>()
  function replacement(c: number): number | undefined {
    const hit = replaced.get(c)
    if (hit !== undefined) return hit
    let r: number | undefined
    switch (code[c]) {
      case OP_LIT: case OP_LIT_TRACK: case OP_LIT_CI: case OP_LIT_CI_TRACK:
      case OP_LEX_BODY: case OP_LEX_PROGRAM: case OP_SCAN: case OP_LIVE:
        r = row(OP_XFORM, report, c)
        break
      case OP_RX: case OP_RX_TRACK: {
        const re = prog.k[code[c + 1]!] as RegExp
        r = hasLookaround(re)
          ? row(OP_ARMGATE, regexTry,
            row(OP_XFORM, fn((v: unknown, span: Span) => { rec.regexMatch(re, span.start, span.end); return v }), c), noFx)
          : row(OP_XFORM, report, c)
        break
      }
      case OP_NOT:
        r = lookahead(code[c + 1]!, code[c + 2]!)
        break
      case OP_PEEK:
        r = row(OP_NOT, lookahead(code[c + 1]!, code[c + 2]!), code[c + 2]!)
        break
    }
    if (r !== undefined) replaced.set(c, r)
    return r
  }

  const rules: Record<string, number> = {}
  const stack: number[] = []
  for (const [name, ip] of Object.entries(prog.rules)) {
    rules[name] = replacement(ip) ?? ip
    stack.push(ip)
  }
  const seen = new Set<number>()
  while (stack.length > 0) {
    const ip = stack.pop()!
    if (seen.has(ip)) continue
    seen.add(ip)
    slots.length = 0
    if (!childSlotOffsets(code, ip, slots)) throw new Error(`backtrack probe: unknown opcode ${String(code[ip])} at ${ip}`)
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!
      const c = code[s]!
      stack.push(c)
      // A keyword classifier re-runs the literal arm its super arm already read;
      // that is classification, not a failed alternative, so only the super arm
      // reports. Its arms are linked, never decoded, so leaving them is exact.
      if (code[ip] === OP_GREEDY && i > 0) continue
      const r = replacement(c)
      if (r !== undefined) code[s] = r
    }
  }

  // A fresh object, not a spread: a spread would carry the source program's
  // compiler-only caches, which describe its rows, not these.
  const out = Object.fromEntries(Object.entries(prog)) as unknown as TableProgram
  return {
    ...out, code, fns, fx, rules, asm: [],
    ...(scans === undefined ? {} : { scans }),
    ...(scanSkip === undefined ? {} : { scanSkip }),
  }
}

/** The option set a probe runs a program under: a plain parse of its host mode. */
export function probeCfg(prog: TableProgram): RunCfg {
  return { hostCst: prog.hostMode === 'cst', trackLines: prog.lines === 1, tolerant: false, coverage: false, probe: false }
}
