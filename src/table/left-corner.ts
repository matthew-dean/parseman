/**
 * LEFT-CORNER LEAD MASKS — PROTOTYPE (perf/left-corner-routing, step 1).
 *
 * The characters a table row can START with: the first character of anything it
 * could consume, or of a zero-width match that still records something (a
 * `leaf(peek(x))`). Derived from the rows themselves, from facts the encoder
 * already laid down: a `GATE` row's class, a literal's first character, a
 * regex's first set (`firstSetFromRegex`), and `rowNullable` for how far a
 * sequence's lead reaches. `null` means "unknown": the caller must assume the row
 * can start anywhere.
 *
 * Index 128 of a mask stands for every non-ASCII code point.
 */
import {
  OP_CHOICE, OP_EMPTY, OP_FIELD, OP_GATE, OP_LABEL, OP_LEAF, OP_LIT, OP_LIT_CI, OP_LIT_CI_TRACK,
  OP_LIT_TRACK, OP_NODE, OP_NODE_TRACK, OP_NOT, OP_OPT, OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX,
  OP_RX_TRACK, OP_SCOPE, OP_SCOPE_CAP, OP_SCOPE_PLAIN, OP_SEQ, OP_SEQV, OP_SEQX, OP_SOURCE_LEAF,
  OP_WITHCTX, OP_XFORM,
} from './ops.ts'
import { rowNullable } from './hold-gap.ts'
import { firstSetFromRegex } from '../regex/first-set.ts'
import type { ResolvedClass } from './program.ts'

export type LeadMask = Uint8Array

const HI = 128

export function maskOfClass(cls: ResolvedClass): LeadMask {
  const m = new Uint8Array(129)
  m.set(cls.ascii)
  if (cls.hi.length > 0) m[HI] = 1
  return m
}

export function maskOfRanges(ranges: readonly { lo: number; hi: number }[]): LeadMask {
  const m = new Uint8Array(129)
  for (const { lo, hi } of ranges) {
    for (let c = lo; c <= Math.min(hi, 127); c++) m[c] = 1
    if (hi >= 128) m[HI] = 1
  }
  return m
}

function orInto(a: LeadMask, b: LeadMask): void {
  for (let i = 0; i < 129; i++) if (b[i] === 1) a[i] = 1
}

function foldCase(m: LeadMask): void {
  for (let c = 65; c <= 90; c++) if (m[c] === 1 || m[c + 32] === 1) { m[c] = 1; m[c + 32] = 1 }
}

export function maskHas(m: LeadMask, c: number): boolean {
  if (c < 0) return false
  return m[c < 128 ? c : HI] === 1
}

/** Lead masks for one table, memoised per row. */
export function leadMasks(
  code: ArrayLike<number>, k: readonly unknown[], cc: readonly ResolvedClass[],
): (ip: number) => LeadMask | null {
  const memo = new Map<number, LeadMask | null>()
  const nullable = new Map<number, boolean>()
  const IN_FLIGHT = null
  function of(ip: number): LeadMask | null {
    if (memo.has(ip)) return memo.get(ip)!
    memo.set(ip, IN_FLIGHT)
    const m = compute(ip)
    memo.set(ip, m)
    return m
  }
  function compute(ip: number): LeadMask | null {
    const op = code[ip]
    switch (op) {
      case OP_GATE: return maskOfClass(cc[code[ip + 1]!]!)
      case OP_LIT: case OP_LIT_TRACK: case OP_LIT_CI: case OP_LIT_CI_TRACK: {
        const s = k[code[ip + 1]!]
        if (typeof s !== 'string' || s.length === 0) return null
        const c = s.codePointAt(0)!
        const m = new Uint8Array(129)
        m[c < 128 ? c : HI] = 1
        if (op === OP_LIT_CI || op === OP_LIT_CI_TRACK) foldCase(m)
        return m
      }
      case OP_RX: case OP_RX_TRACK: {
        const re = k[code[ip + 1]!]
        if (!(re instanceof RegExp)) return null
        const fs = firstSetFromRegex(re.source).firstSet
        if (fs.kind === 'empty') return new Uint8Array(129)
        if (fs.kind !== 'ranges') return null
        const m = maskOfRanges(fs.ranges)
        if (re.flags.includes('i')) foldCase(m)
        return m
      }
      case OP_EMPTY: case OP_NOT: return new Uint8Array(129)
      case OP_OPT: case OP_PEEK: case OP_RULE: case OP_LABEL: return of(code[ip + 1]!)
      case OP_REP: case OP_REPV: return of(code[ip + 1]!)
      case OP_NODE: case OP_NODE_TRACK: case OP_SCOPE: case OP_SCOPE_CAP: case OP_SCOPE_PLAIN:
      case OP_WITHCTX: case OP_FIELD: case OP_LEAF: case OP_SOURCE_LEAF: case OP_XFORM:
        return of(code[ip + 2]!)
      case OP_SEQ: case OP_SEQV: case OP_SEQX: {
        const base = op === OP_SEQX ? ip + 3 : ip + 2
        const n = code[op === OP_SEQX ? ip + 2 : ip + 1]!
        const m = new Uint8Array(129)
        for (let i = 0; i < n; i++) {
          const t = code[base + i]!
          const tm = of(t)
          if (tm === null) return null
          orInto(m, tm)
          if (!rowNullable(code, k, t, nullable)) return m
        }
        return m
      }
      case OP_CHOICE: {
        const n = code[ip + 2]!
        const m = new Uint8Array(129)
        for (let i = 0; i < n; i++) {
          const am = of(code[ip + 4 + i]!)
          if (am === null) return null
          orInto(m, am)
        }
        return m
      }
      default: return null
    }
  }
  return of
}
