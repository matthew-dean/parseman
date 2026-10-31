import type { Combinator, ParseContext } from '../types.ts'
import { failAt } from '../combinators/probe.ts'
import { lead } from './run-support.ts'
import type { LexBodyRecognizer } from './lex-body.ts'
import type { LexProgramSpec, ResolvedClass } from './program.ts'

/** A selected composite lexical body. Failure state is already published.
 * `scan` is present only for the balanced shell and indexes the canonical
 * driver-owned scan pool; it is not another recognizer implementation. */
export type LexProgramRunner = {
  (input: string, pos: number, ctx: ParseContext, scan?: Combinator<unknown>): number
  readonly scan?: number
}

export const LEX_NODE_TERMINAL = 0
export const LEX_NODE_SEQUENCE2 = 1
export const LEX_NODE_SEQUENCE3 = 2
export const LEX_NODE_SEQUENCE4 = 3
export const LEX_NODE_SEQUENCE5 = 4
/**
 * `[op, armCount, exclusive, choiceFx, (armClass, armFx) × armCount]`: any arity,
 * no padding. `exclusive` is the character choice's one-arm dispatch decision.
 */
export const LEX_NODE_CHOICE = 5
export const LEX_NODE_NOT = 8
export const LEX_NODE_OPTIONAL = 9
/** `[op, min, max]` after the item: a separator-less repeat, `max` −1 unbounded. */
export const LEX_NODE_REPEAT = 10

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

type PureLexRunner = (input: string, pos: number) => number
type BuiltLexNode = { readonly match: PureLexRunner; readonly run: LexProgramRunner }
const committed = (ctx: ParseContext): boolean => ctx._fc === true

function trackLexLines(ctx: ParseContext, input: string, end: number): void {
  let at = ctx._lineScannedTo ?? 0
  const starts = ctx._lineStarts
  if (starts === undefined || end <= at) return
  while (at < end) {
    if (input.charCodeAt(at) === 10) starts.push(at + 1)
    at++
  }
  ctx._lineScannedTo = end
}

function terminalNode(
  matcher: LexBodyRecognizer,
  failure: readonly string[],
  tracksLines: boolean,
): BuiltLexNode {
  return {
    match: (input, pos) => {
      const result = matcher(input, pos)
      return result < 0 ? -1 : result / 2
    },
    run: (input, pos, ctx) => {
      const result = matcher(input, pos)
      if (result < 0) {
        ctx._fe = pos
        ctx._fx = failure as string[]
        if (ctx._probe !== undefined) failAt(ctx, ctx._fx, pos)
        return -1
      }
      const end = result / 2
      if (tracksLines) trackLexLines(ctx, input, end)
      return end
    },
  }
}

// Each sequence captures its parts' runners as scalars: a part is reached by a
// direct call, not a property read, and no arity nests another sequence.
function sequence2(a: BuiltLexNode, b: BuiltLexNode): BuiltLexNode {
  const am = a.match, bm = b.match, ar = a.run, br = b.run
  return {
    match: (input, pos) => {
      const e0 = am(input, pos)
      return e0 < 0 ? -1 : bm(input, e0)
    },
    run: (input, pos, ctx) => {
      const e0 = ar(input, pos, ctx)
      if (e0 < 0) return -1
      ctx._fc = false
      return br(input, e0, ctx)
    },
  }
}

function sequence3(a: BuiltLexNode, b: BuiltLexNode, c: BuiltLexNode): BuiltLexNode {
  const am = a.match, bm = b.match, cm = c.match, ar = a.run, br = b.run, cr = c.run
  return {
    match: (input, pos) => {
      const e0 = am(input, pos)
      if (e0 < 0) return -1
      const e1 = bm(input, e0)
      return e1 < 0 ? -1 : cm(input, e1)
    },
    run: (input, pos, ctx) => {
      const e0 = ar(input, pos, ctx)
      if (e0 < 0) return -1
      ctx._fc = false
      const e1 = br(input, e0, ctx)
      if (e1 < 0) return -1
      ctx._fc = false
      return cr(input, e1, ctx)
    },
  }
}

function sequence4(a: BuiltLexNode, b: BuiltLexNode, c: BuiltLexNode, d: BuiltLexNode): BuiltLexNode {
  const am = a.match, bm = b.match, cm = c.match, dm = d.match
  const ar = a.run, br = b.run, cr = c.run, dr = d.run
  return {
    match: (input, pos) => {
      const e0 = am(input, pos)
      if (e0 < 0) return -1
      const e1 = bm(input, e0)
      if (e1 < 0) return -1
      const e2 = cm(input, e1)
      return e2 < 0 ? -1 : dm(input, e2)
    },
    run: (input, pos, ctx) => {
      const e0 = ar(input, pos, ctx)
      if (e0 < 0) return -1
      ctx._fc = false
      const e1 = br(input, e0, ctx)
      if (e1 < 0) return -1
      ctx._fc = false
      const e2 = cr(input, e1, ctx)
      if (e2 < 0) return -1
      ctx._fc = false
      return dr(input, e2, ctx)
    },
  }
}

function sequence5(
  a: BuiltLexNode, b: BuiltLexNode, c: BuiltLexNode, d: BuiltLexNode, e: BuiltLexNode,
): BuiltLexNode {
  const am = a.match, bm = b.match, cm = c.match, dm = d.match, em = e.match
  const ar = a.run, br = b.run, cr = c.run, dr = d.run, er = e.run
  return {
    match: (input, pos) => {
      const e0 = am(input, pos)
      if (e0 < 0) return -1
      const e1 = bm(input, e0)
      if (e1 < 0) return -1
      const e2 = cm(input, e1)
      if (e2 < 0) return -1
      const e3 = dm(input, e2)
      return e3 < 0 ? -1 : em(input, e3)
    },
    run: (input, pos, ctx) => {
      const e0 = ar(input, pos, ctx)
      if (e0 < 0) return -1
      ctx._fc = false
      const e1 = br(input, e0, ctx)
      if (e1 < 0) return -1
      ctx._fc = false
      const e2 = cr(input, e1, ctx)
      if (e2 < 0) return -1
      ctx._fc = false
      const e3 = dr(input, e2, ctx)
      if (e3 < 0) return -1
      ctx._fc = false
      return er(input, e3, ctx)
    },
  }
}

type ChoiceTail = (
  input: string, pos: number, ctx: ParseContext, lead: number,
  acc: string[] | undefined, best: number,
) => number

function appendExpected(acc: string[] | undefined, values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined || values.length === 0) return acc
  if (acc === undefined) return values.slice()
  acc.push(...values)
  return acc
}

function choiceNode(
  arms: readonly BuiltLexNode[],
  classes: readonly (ResolvedClass | undefined)[],
  armExpected: readonly (readonly string[])[],
  choiceExpected: readonly string[],
): BuiltLexNode {
  let matchTail: PureLexRunner = () => -1
  for (let i = arms.length - 1; i >= 0; i--) {
    const armMatch = arms[i]!.match, next = matchTail
    matchTail = (input, pos) => {
      const end = armMatch(input, pos)
      return end < 0 ? next(input, pos) : end
    }
  }
  let tail: ChoiceTail = (_input, pos, ctx, _lead, acc) => {
    ctx._fe = pos
    ctx._fx = acc ?? choiceExpected as string[]
    return -1
  }
  for (let i = arms.length - 1; i >= 0; i--) {
    const armRun = arms[i]!.run, cls = classes[i], staticExpected = armExpected[i]!, next = tail
    tail = (input, pos, ctx, lead, acc, best) => {
      if (cls !== undefined && !classHas(cls, lead)) {
        return next(
          input, pos, ctx, lead,
          best === pos ? appendExpected(acc, staticExpected) : acc,
          best,
        )
      }
      ctx._fc = false
      const end = armRun(input, pos, ctx)
      if (end >= 0) return end
      const at = ctx._fe ?? pos
      if (at > best) { best = at; acc = undefined }
      const nextAcc = at === best ? appendExpected(acc, ctx._fx) : acc
      if (committed(ctx)) {
        if (nextAcc !== undefined) ctx._fx = nextAcc
        return -1
      }
      return next(input, pos, ctx, lead, nextAcc, best)
    }
  }
  return {
    match: matchTail,
    run: (input, pos, ctx) => tail(
      input, pos, ctx, pos < input.length ? input.codePointAt(pos)! : -1, undefined, pos,
    ),
  }
}

/**
 * A choice whose arms' classes are disjoint, as the character choice's exclusive
 * dispatch: the arm the lead selects runs alone, its failure is the choice's at
 * the choice's position, and a lead no arm claims reports the arms' openers. The
 * selected index reaches its arm through a fixed chain, never an array.
 */
function exclusiveChoiceNode(
  arms: readonly BuiltLexNode[],
  classes: readonly ResolvedClass[],
  choiceFx: readonly string[],
): BuiltLexNode {
  const ascii = new Int32Array(128).fill(-1)
  const hi: number[] = []
  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i]!
    for (let c = 0; c < 128; c++) if (cls.ascii[c] === 1) ascii[c] = i
    for (let r = 0; r < cls.hi.length; r += 2) hi.push(cls.hi[r]!, cls.hi[r + 1]!, i)
  }
  const select = (code: number): number => {
    if (code < 0) return -1
    if (code < 128) return ascii[code]!
    for (let r = 0; r < hi.length; r += 3) if (code >= hi[r]! && code <= hi[r + 1]!) return hi[r + 2]!
    return -1
  }
  let matchArm: (arm: number, input: string, pos: number) => number = () => -1
  let selectRun: (arm: number, input: string, pos: number, ctx: ParseContext) => number = () => -1
  for (let i = arms.length - 1; i >= 0; i--) {
    const armMatch = arms[i]!.match, armRun = arms[i]!.run, nextMatch = matchArm, nextRun = selectRun
    matchArm = (selected, input, pos) => selected === i ? armMatch(input, pos) : nextMatch(selected, input, pos)
    selectRun = (selected, input, pos, ctx) => selected === i ? armRun(input, pos, ctx) : nextRun(selected, input, pos, ctx)
  }
  const runArm: LexProgramRunner = (input, pos, ctx) => {
    const arm = select(lead(input, pos))
    if (arm >= 0) {
      ctx._fc = false
      const end = selectRun(arm, input, pos, ctx)
      if (end >= 0) return end
      if (committed(ctx)) return -1
      const failed = ctx._fx
      if (failed !== undefined && failed.length > 0) { ctx._fe = pos; return -1 }
    }
    ctx._fe = pos
    ctx._fx = choiceFx as string[]
    return -1
  }
  return {
    match: (input, pos) => {
      const arm = select(lead(input, pos))
      return arm < 0 ? -1 : matchArm(arm, input, pos)
    },
    run: runArm,
  }
}

function notNode(body: BuiltLexNode, failure: readonly string[]): BuiltLexNode {
  const bodyMatch = body.match
  return {
    match: (input, pos) => bodyMatch(input, pos) < 0 ? pos : -1,
    run: (input, pos, ctx) => {
      if (bodyMatch(input, pos) < 0) return pos
      ctx._fe = pos
      ctx._fx = failure as string[]
      return -1
    },
  }
}

function optionalNode(body: BuiltLexNode): BuiltLexNode {
  const bodyMatch = body.match, bodyRun = body.run
  return {
    match: (input, pos) => {
      const end = bodyMatch(input, pos)
      return end < 0 ? pos : end
    },
    run: (input, pos, ctx) => {
      ctx._fc = false
      const end = bodyRun(input, pos, ctx)
      return end < 0 && !committed(ctx) ? pos : end
    },
  }
}

/**
 * The table's separator-less `OP_REP` under `token()`: no trivia, no separator,
 * nothing to roll back. Only an optional item stops at end of input or on a
 * zero-width match (`repItem`); a failed item ends the loop with its own
 * failure published, and a committed one fails the repeat.
 */
function repeatNode(item: BuiltLexNode, min: number, max: number): BuiltLexNode {
  const itemMatch = item.match, itemRun = item.run
  return {
    match: (input, pos) => {
      let cur = pos
      let count = 0
      for (;;) {
        if (max >= 0 && count >= max) break
        const optional = count >= min && (count > 0 || min === 0)
        if (optional && cur >= input.length) break
        const end = itemMatch(input, cur)
        if (end < 0 || (optional && end === cur)) break
        cur = end
        count++
      }
      return count < min ? -1 : cur
    },
    run: (input, pos, ctx) => {
      let cur = pos
      let count = 0
      for (;;) {
        if (max >= 0 && count >= max) break
        const optional = count >= min && (count > 0 || min === 0)
        if (optional && cur >= input.length) break
        ctx._fc = false
        const end = itemRun(input, cur, ctx)
        if (end < 0) {
          if (committed(ctx)) return -1
          break
        }
        if (optional && end === cur) break
        cur = end
        count++
      }
      return count < min ? -1 : cur
    },
  }
}

function fixedTreeRunner(
  words: readonly number[],
  matchers: readonly LexBodyRecognizer[],
  classes: readonly ResolvedClass[],
  expected: readonly (readonly string[])[],
): LexProgramRunner {
  const stack: BuiltLexNode[] = []
  const pop = (): BuiltLexNode => {
    const value = stack.pop()
    if (value === undefined) throw new TypeError('table lexical tree has an incomplete fixed body')
    return value
  }
  for (let at = 0; at < words.length;) {
    const op = words[at++]!
    if (op === LEX_NODE_TERMINAL) {
      const matcher = matchers[words[at++]!], failure = expected[words[at++]!]
      const tracks = words[at++]
      if (matcher === undefined || failure === undefined || (tracks !== 0 && tracks !== 1)) {
        throw new TypeError('table lexical tree terminal references an invalid pool entry')
      }
      stack.push(terminalNode(matcher, failure, tracks === 1))
      continue
    }
    if (op >= LEX_NODE_SEQUENCE2 && op <= LEX_NODE_SEQUENCE5) {
      const count = op - LEX_NODE_SEQUENCE2 + 2
      const nodes = Array.from({ length: count }, pop).reverse()
      if (count === 2) stack.push(sequence2(nodes[0]!, nodes[1]!))
      else if (count === 3) stack.push(sequence3(nodes[0]!, nodes[1]!, nodes[2]!))
      else if (count === 4) stack.push(sequence4(nodes[0]!, nodes[1]!, nodes[2]!, nodes[3]!))
      else stack.push(sequence5(nodes[0]!, nodes[1]!, nodes[2]!, nodes[3]!, nodes[4]!))
      continue
    }
    if (op === LEX_NODE_CHOICE) {
      const count = words[at++]!
      const exclusive = words[at++]!
      if (exclusive !== 0 && exclusive !== 1) throw new TypeError('table lexical tree choice has an invalid dispatch mode')
      const choiceFx = expected[words[at++]!]
      if (!Number.isInteger(count) || count < 2 || count > stack.length) {
        throw new TypeError('table lexical tree choice has an invalid arm count')
      }
      if (choiceFx === undefined) throw new TypeError('table lexical tree choice has an invalid expected set')
      const armClasses: Array<ResolvedClass | undefined> = []
      const armFx: Array<readonly string[]> = []
      for (let i = 0; i < count; i++) {
        const cls = words[at++]!, fx = expected[words[at++]!]
        if (cls < -1 || (cls >= 0 && classes[cls] === undefined) || fx === undefined) {
          throw new TypeError('table lexical tree choice references an invalid pool entry')
        }
        armClasses.push(cls < 0 ? undefined : classes[cls])
        armFx.push(fx)
      }
      const arms = Array.from({ length: count }, pop).reverse()
      stack.push(exclusive === 1
        ? exclusiveChoiceNode(arms, armClasses as ResolvedClass[], choiceFx)
        : choiceNode(arms, armClasses, armFx, choiceFx))
      continue
    }
    if (op === LEX_NODE_NOT) {
      const failure = expected[words[at++]!]
      if (failure === undefined) throw new TypeError('table lexical tree assertion has an invalid expected set')
      stack.push(notNode(pop(), failure))
      continue
    }
    if (op === LEX_NODE_OPTIONAL) { stack.push(optionalNode(pop())); continue }
    if (op === LEX_NODE_REPEAT) {
      const min = words[at++]!, max = words[at++]!
      if (!Number.isInteger(min) || min < 0 || !Number.isInteger(max) || (max >= 0 && max < min)) {
        throw new TypeError('table lexical tree repeat has invalid bounds')
      }
      stack.push(repeatNode(pop(), min, max))
      continue
    }
    throw new TypeError('table lexical tree has an unknown fixed body')
  }
  if (stack.length !== 1) throw new TypeError('table lexical tree does not resolve to one root body')
  return stack[0]!.run
}

/** Decode one fixed selected-body tuple. There is no lexical opcode loop on
 * the parse path: each supported tuple becomes one scalar closure here. */
export function buildLexProgramRunner(
  spec: LexProgramSpec,
  matchers: readonly LexBodyRecognizer[],
  classes: readonly ResolvedClass[],
  expected: readonly (readonly string[])[],
): LexProgramRunner {
  if ((spec[0] !== 0 && spec[0] !== 1 && spec[0] !== 2 && spec[0] !== 3)
    || (spec[0] === 0 && spec.length !== 13)
    || (spec[0] === 1 && spec.length !== 12)
    || (spec[0] === 2 && spec.length < 6)
    || (spec[0] === 3 && spec.length !== 3)) {
    throw new TypeError('table lexical program has an invalid fixed body width')
  }
  if (spec[1] !== lexProgramDigest(spec.slice(2))) {
    throw new TypeError('table lexical program semantic digest is inconsistent')
  }
  if (spec[0] === 3) {
    if (!Number.isInteger(spec[2]) || spec[2] < 0) {
      throw new TypeError('table balanced lexical program has an invalid scan reference')
    }
    const run: LexProgramRunner = (_input, _pos, ctx, scan) => {
      if (scan === undefined) throw new TypeError('table balanced lexical program lost its scan body')
      const result = scan.parse(_input, _pos, ctx)
      if (!result.ok) {
        ctx._fe = result.span.start
        ctx._fx = (result.expected ?? []) as string[]
        return -1
      }
      return result.span.end
    }
    return Object.assign(run, { scan: spec[2] })
  }
  if (spec[0] === 2) return fixedTreeRunner(spec.slice(2), matchers, classes, expected)
  if (spec[0] === 1) {
    const g00 = matchers[spec[2]], g01 = matchers[spec[3]]
    const g02 = matchers[spec[4]], g03 = matchers[spec[5]]
    const guard0Fx = expected[spec[6]]
    const g1 = matchers[spec[7]], guard1Fx = expected[spec[8]]
    const terminal = matchers[spec[9]], terminalFx = expected[spec[10]]
    const tracks = spec[11]
    if (g00 === undefined || g01 === undefined || g02 === undefined || g03 === undefined
      || guard0Fx === undefined || g1 === undefined || guard1Fx === undefined
      || terminal === undefined || terminalFx === undefined || (tracks !== 0 && tracks !== 1)) {
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
      const end = result / 2
      if (tracks === 1) trackLexLines(ctx, input, end)
      return end
    }
  }
  const cls = classes[spec[2]]
  const choiceFx = expected[spec[3]]
  const m0 = matchers[spec[4]], x0 = expected[spec[5]]
  const m1 = matchers[spec[6]], x1 = expected[spec[7]]
  const m2 = matchers[spec[8]], x2 = expected[spec[9]]
  const m3 = matchers[spec[10]], x3 = expected[spec[11]]
  const tracks = spec[12]
  if (cls === undefined || choiceFx === undefined
    || m0 === undefined || x0 === undefined || m1 === undefined || x1 === undefined
    || m2 === undefined || x2 === undefined || m3 === undefined || x3 === undefined
    || (tracks !== 0 && tracks !== 1)) {
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
    const success = (result: number): number => {
      const end = result / 2
      if (tracks === 1) trackLexLines(ctx, input, end)
      return end
    }
    let result = m0(input, pos)
    if (result >= 0) return success(result)
    failed(x0)
    ctx._fc = false
    result = m1(input, pos)
    if (result >= 0) return success(result)
    failed(x1)
    ctx._fc = false
    result = m2(input, pos)
    if (result >= 0) return success(result)
    failed(x2)
    ctx._fc = false
    result = m3(input, pos)
    if (result >= 0) return success(result)
    failed(x3)
    ctx._fe = pos
    ctx._fx = acc ?? choiceFx as string[]
    return -1
  }
}
