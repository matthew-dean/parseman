import type { ParseContext } from '../types.ts'
import { failAt } from '../combinators/probe.ts'
import type { LexBodyRecognizer } from './lex-body.ts'
import type { LexProgramSpec, ResolvedClass } from './program.ts'

/** A selected composite lexical body. Failure state is already published. */
export type LexProgramRunner = (input: string, pos: number, ctx: ParseContext) => number

export function lexProgramDigest(words: readonly number[]): number {
  let hash = 0x811C9DC5
  for (const word of words) {
    hash ^= word | 0
    hash = Math.imul(hash, 0x01000193)
  }
  return hash | 0
}

function classHas(cls: ResolvedClass, code: number): boolean {
  if (code < 0) return false
  if (code < 128) return cls.ascii[code] === 1
  for (let i = 0; i < cls.hi.length; i += 2) {
    if (code >= cls.hi[i]! && code <= cls.hi[i + 1]!) return true
  }
  return false
}

/** Decode one fixed selected-body tuple. There is no lexical opcode loop on
 * the parse path: each supported tuple becomes one scalar closure here. */
export function buildLexProgramRunner(
  spec: LexProgramSpec,
  matchers: readonly LexBodyRecognizer[],
  classes: readonly ResolvedClass[],
  expected: readonly (readonly string[])[],
): LexProgramRunner {
  if ((spec[0] !== 0 && spec[0] !== 1)
    || (spec[0] === 0 && spec.length !== 12)
    || (spec[0] === 1 && spec.length !== 11)) {
    throw new TypeError('table lexical program has an invalid fixed body width')
  }
  if (spec[1] !== lexProgramDigest(spec.slice(2))) {
    throw new TypeError('table lexical program semantic digest is inconsistent')
  }
  if (spec[0] === 1) {
    const g00 = matchers[spec[2]], g01 = matchers[spec[3]]
    const g02 = matchers[spec[4]], g03 = matchers[spec[5]]
    const guard0Fx = expected[spec[6]]
    const g1 = matchers[spec[7]], guard1Fx = expected[spec[8]]
    const terminal = matchers[spec[9]], terminalFx = expected[spec[10]]
    if (g00 === undefined || g01 === undefined || g02 === undefined || g03 === undefined
      || guard0Fx === undefined || g1 === undefined || guard1Fx === undefined
      || terminal === undefined || terminalFx === undefined) {
      throw new TypeError('table lexical program references an invalid pool entry')
    }
    return (input, pos, ctx) => {
      ctx._fc = false
      if (g00(input, pos) >= 0 || g01(input, pos) >= 0
        || g02(input, pos) >= 0 || g03(input, pos) >= 0) {
        ctx._fe = pos
        ctx._fx = guard0Fx as string[]
        return -1
      }
      ctx._fc = false
      if (g1(input, pos) >= 0) {
        ctx._fe = pos
        ctx._fx = guard1Fx as string[]
        return -1
      }
      ctx._fc = false
      const result = terminal(input, pos)
      if (result < 0) {
        ctx._fe = pos
        ctx._fx = terminalFx as string[]
        if (ctx._probe !== undefined) failAt(ctx, ctx._fx, pos)
        return -1
      }
      return result / 2
    }
  }
  const cls = classes[spec[2]]
  const choiceFx = expected[spec[3]]
  const m0 = matchers[spec[4]], x0 = expected[spec[5]]
  const m1 = matchers[spec[6]], x1 = expected[spec[7]]
  const m2 = matchers[spec[8]], x2 = expected[spec[9]]
  const m3 = matchers[spec[10]], x3 = expected[spec[11]]
  if (cls === undefined || choiceFx === undefined
    || m0 === undefined || x0 === undefined || m1 === undefined || x1 === undefined
    || m2 === undefined || x2 === undefined || m3 === undefined || x3 === undefined) {
    throw new TypeError('table lexical program references an invalid pool entry')
  }

  return (input, pos, ctx) => {
    const lead = pos < input.length ? input.codePointAt(pos)! : -1
    if (!classHas(cls, lead)) {
      ctx._fe = pos
      ctx._fx = choiceFx.slice()
      return -1
    }
    let acc: string[] | undefined
    const failed = (fx: readonly string[]): void => {
      ctx._fe = pos
      ctx._fx = fx as string[]
      if (ctx._probe !== undefined) failAt(ctx, ctx._fx, pos)
      if (acc === undefined) acc = fx.slice()
      else acc.push(...fx)
    }
    ctx._fc = false
    let result = m0(input, pos)
    if (result >= 0) return result / 2
    failed(x0)
    ctx._fc = false
    result = m1(input, pos)
    if (result >= 0) return result / 2
    failed(x1)
    ctx._fc = false
    result = m2(input, pos)
    if (result >= 0) return result / 2
    failed(x2)
    ctx._fc = false
    result = m3(input, pos)
    if (result >= 0) return result / 2
    failed(x3)
    ctx._fe = pos
    ctx._fx = acc ?? choiceFx as string[]
    return -1
  }
}
