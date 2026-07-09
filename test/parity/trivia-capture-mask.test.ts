import { describe, it, expect } from 'vitest'
import {
  sequence, many, regex, trivia, label, parser, node, compile,
  oneOrMore, choice, triviaKindMask, run,
} from '../../src/index.ts'
import type { ParseContext } from '../../src/types.ts'

// Labeled ws + block-comment trivia (CSS `rw` shape): kind 0 = whitespace, 1 = comment.
function labeledRw() {
  return trivia(oneOrMore(choice(
    label('whitespace', regex(/[ \t\n\r\f]+/)),
    label('blockComment', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)),
  )))
}
const KIND_LABELS = ['whitespace', 'blockComment'] as const
const WS = 0
const COMMENT = 1

/** A node that surfaces its per-node CST triviaLog (the 5th build arg) as `tl`. */
function grammar(captureTriviaKinds?: readonly string[]) {
  const rw = labeledRw()
  const inner = node(
    'Root',
    sequence(regex(/a/), many(regex(/b/))),
    (_children, _fields, _span, _raw, triviaLog) => ({ tl: [...triviaLog] as number[] }),
  )
  return parser(
    { trivia: rw, captureTrivia: true, ...(captureTriviaKinds ? { captureTriviaKinds } : {}) },
    inner,
  )
}

// 'a' then ws+comment+ws between the two 'b's and after 'a'.
const INPUT = 'a /*x*/ b  /*y*/ b'

/** Per-node triviaLog kinds (every 4th number in [start,end,insertIdx,kind]) from a Root value. */
function kindsOf(value: unknown): number[] {
  const tl = (value as { tl: number[] }).tl
  const ks: number[] = []
  for (let i = 3; i < tl.length; i += 4) ks.push(tl[i]!)
  return ks
}

function runInterp(mask: number | undefined): number[] {
  const g = grammar()
  const ctx: ParseContext = { trackLines: false }
  if (mask !== undefined) ctx._triviaCaptureMask = mask
  const r = g.parse(INPUT, 0, ctx)
  expect(r.ok).toBe(true)
  return kindsOf((r as { value: unknown }).value)
}

function runCompiled(mask: number | undefined): number[] {
  const compiled = compile(grammar())
  const ctx: ParseContext = { trackLines: false }
  if (mask !== undefined) ctx._triviaCaptureMask = mask
  const r = compiled.parseWithContext(INPUT, ctx, 0)
  expect(r.ok).toBe(true)
  return kindsOf((r as { value: unknown }).value)
}

describe('per-node trivia capture kind-filter (_triviaCaptureMask)', () => {
  it('no mask → captures every kind (unchanged behaviour), interpreter == compiled', () => {
    const i = runInterp(undefined)
    const c = runCompiled(undefined)
    expect(i).toEqual([WS, COMMENT, WS, WS, COMMENT, WS])
    expect(c).toEqual(i)
  })

  it('comment-only mask → whitespace skipped from the per-node log, interpreter == compiled', () => {
    const mask = triviaKindMask(KIND_LABELS, ['blockComment'])
    expect(mask).toBe(1 << COMMENT)
    const i = runInterp(mask)
    const c = runCompiled(mask)
    expect(i).toEqual([COMMENT, COMMENT])
    expect(c).toEqual(i)
  })

  it('whitespace-only mask → comments skipped, interpreter == compiled', () => {
    const mask = triviaKindMask(KIND_LABELS, ['whitespace'])
    const i = runInterp(mask)
    const c = runCompiled(mask)
    expect(i).toEqual([WS, WS, WS, WS])
    expect(c).toEqual(i)
  })

  it('empty mask (0) → nothing captured per node, interpreter == compiled', () => {
    const i = runInterp(0)
    const c = runCompiled(0)
    expect(i).toEqual([])
    expect(c).toEqual(i)
  })

  it('the global _triviaLog stays complete even when the per-node log is filtered', () => {
    // run() always builds the global log; the mask must not touch it.
    const compiled = compile(grammar())
    const res = run(
      (input, pos, ctx) => compiled.parseWithContext(input, ctx, pos),
      INPUT,
      { triviaCaptureMask: triviaKindMask(KIND_LABELS, ['blockComment'])! },
    )
    // 6 trivia chunks total (ws,comment,ws,ws,comment,ws) × 3 numbers each = 18.
    expect(res.triviaLog.length).toBe(18)
    const globalKinds: number[] = []
    for (let i = 2; i < res.triviaLog.length; i += 3) globalKinds.push(res.triviaLog[i]!)
    expect(globalKinds).toEqual([WS, COMMENT, WS, WS, COMMENT, WS])
  })

  it('captureTriviaKinds parser() option wires the mask (interpreter)', () => {
    const g = grammar(['blockComment'])
    const r = g.parse(INPUT, 0, { trackLines: false })
    expect(r.ok).toBe(true)
    expect(kindsOf((r as { value: unknown }).value)).toEqual([COMMENT, COMMENT])
  })

  it('per-node-type mask via _parsemanTriviaKinds host hook — interpreter == compiled', () => {
    // Two nested structural node types under one build host: Outer wants comments
    // only, Inner wants whitespace only. Proves the mask is per-type and restored.
    const rw = labeledRw()
    const inner = node('Inner', sequence(regex(/x/), many(regex(/y/))), undefined)
    const outer = node('Outer', sequence(inner, many(inner)), undefined)
    const g = parser({ trivia: rw, captureTrivia: true }, outer)
    const kindsByType = new Map<string, number[]>()
    const host = Object.assign(
      (type: string, _c: unknown, _f: unknown, _s: unknown, _r: unknown, triviaLog: readonly number[]) => {
        const ks: number[] = []
        for (let k = 3; k < triviaLog.length; k += 4) ks.push(triviaLog[k]!)
        const prev = kindsByType.get(type) ?? []
        kindsByType.set(type, [...prev, ...ks])
        return { _tag: 'node', type, span: { start: 0, end: 0 }, children: [] }
      },
      {
        _parsemanCaptureTrivia: (t: string) => t === 'Outer' || t === 'Inner',
        _parsemanTriviaKinds: (t: string) =>
          t === 'Outer' ? triviaKindMask(KIND_LABELS, ['blockComment'])
          : t === 'Inner' ? triviaKindMask(KIND_LABELS, ['whitespace'])
          : undefined,
      },
    )
    // ws sits inside each Inner (x␣y); the comment sits in Outer's between-inner gap.
    const input2 = 'x y /*c*/ x y'
    const interpKinds = () => { kindsByType.clear(); g.parse(input2, 0, { trackLines: false, build: host as never }); return new Map(kindsByType) }
    const iRes = interpKinds()
    // Inner captured only whitespace; Outer only the comment.
    expect((iRes.get('Inner') ?? []).every(k => k === WS)).toBe(true)
    expect(iRes.get('Outer')).toEqual([COMMENT])

    const compiled = compile(g)
    kindsByType.clear()
    compiled.parseWithContext(input2, { trackLines: false, build: host as never }, 0)
    const cRes = new Map(kindsByType)
    expect(cRes.get('Inner')).toEqual(iRes.get('Inner'))
    expect(cRes.get('Outer')).toEqual(iRes.get('Outer'))
  })

  it('captureTriviaKinds resolves INHERITED trivia labels (trivia not re-declared here)', () => {
    // Outer parser owns the labeled trivia; an inner parser sets captureTriviaKinds
    // WITHOUT re-declaring trivia. The mask must resolve from the inherited labels,
    // not silently no-op. (Regression: PR #18 review — inherited-trivia case.)
    const rw = labeledRw()
    const inner = node(
      'Root',
      sequence(regex(/a/), many(regex(/b/))),
      (_c, _f, _s, _r, triviaLog) => ({ tl: [...triviaLog] as number[] }),
    )
    const innerP = parser({ captureTrivia: true, captureTriviaKinds: ['blockComment'] }, inner)
    const outerP = parser({ trivia: rw }, innerP)
    const r = outerP.parse(INPUT, 0, { trackLines: false })
    expect(r.ok).toBe(true)
    expect(kindsOf((r as { value: unknown }).value)).toEqual([COMMENT, COMMENT])
  })

  it('triviaKindMask ignores unknown names and returns undefined without labels', () => {
    expect(triviaKindMask(KIND_LABELS, ['nope'])).toBe(0)
    expect(triviaKindMask(KIND_LABELS, ['whitespace', 'nope'])).toBe(1 << WS)
    expect(triviaKindMask(undefined, ['blockComment'])).toBeUndefined()
  })
})
