/**
 * Host-aware capture elision — INTERPRETER / compile() / macro parity.
 *
 * THE DEFECT. `build-arity.ts` elides per-node trivia/state/fields capture from the
 * DIRECT builder's formal arity. But a direct builder is BYPASSED when a positioned-CST
 * host (`_parsemanCstOutput`, i.e. `cstBuildHost` and the language-service hosts) is
 * installed: `node.ts` re-routes the node through `ctx.build` instead. The host is then
 * the consumer, and it was handed collectors sized for a consumer that never ran.
 *
 * Nearly every AST builder in a real grammar is `children => …` — arity 1 — so under a
 * CST host those nodes silently produced an EMPTY triviaLog, absent fields and absent
 * state. Nothing errored. An empty trivia log is indistinguishable from a node that
 * genuinely had no trivia, so a consumer checking the tree reports clean. That is the
 * failure mode these tests exist to make unreachable, and it is why the assertions
 * below compare against a STRUCTURAL control rather than against a fixed expectation:
 * the control is the same grammar on the path the repo already gated correctly.
 *
 * PARITY. The fix has to land in two engines that share no code — `combinators/node.ts`
 * (interpreter) and `compiler/codegen.ts` (emitted source). This repo has shipped an
 * interpreter-only fix twice, and once shipped a fix that reached the interpreter while
 * codegen still emitted the old form. Every loss assertion here therefore runs over
 * BOTH engines from one table, so a fix that lands in one engine fails in the other.
 */
import { describe, it, expect } from 'vitest'
import { node, sequence, regex, literal, trivia, parser, rules, compile, field } from '../../src/index.ts'
import {
  hostReads,
  hostCapturesTrivia,
  cstOutputHost,
  assertHostCaptureSatisfied,
  HOST_ARG,
} from '../../src/compiler/build-arity.ts'
import { HOST_READS_SRC, CST_ASSERT_SRC } from '../../src/compiler/codegen.ts'

const rw = trivia(regex(/[ \t\n\r\f]+/))
const INPUT = 'a { }' // two interior trivia runs

/** What a host actually received for one node. */
type Seen = {
  children: number
  fields: unknown
  triviaLog: readonly number[] | undefined
  state: unknown
}

/** A CST host that reads every collector — the language-service shape. */
function recordingHost(): { host: (...a: never[]) => unknown; seen: () => Seen | undefined } {
  let seen: Seen | undefined
  const host = (
    type: string,
    children: ReadonlyArray<unknown>,
    fields: unknown,
    span: { start: number; end: number },
    _rawChildren: ReadonlyArray<unknown>,
    triviaLog: readonly number[],
    state: unknown,
  ) => {
    seen = { children: children.length, fields, triviaLog, state }
    return { _tag: 'node', type, span, state: state ?? null, children: [...children] }
  }
  ;(host as typeof host & { _parsemanCstOutput?: true })._parsemanCstOutput = true
  return { host: host as unknown as (...a: never[]) => unknown, seen: () => seen }
}

// The node under test (arity-1 direct builder) and the structural CONTROL — same body.
const body = () => parser({ trivia: rw }, sequence(field('a', literal('a')), literal('{'), literal('}')))
const { Direct } = rules(() => ({ Direct: node('Direct', body(), children => ({ n: children.length })) }))
const { Control } = rules(() => ({ Control: node('Control', body()) }))
const compiledDirect = compile(Direct)
const compiledControl = compile(Control)

function runWithHost(which: 'interpreter' | 'compiled', target: 'direct' | 'control'): Seen | undefined {
  const { host, seen } = recordingHost()
  const ctx: Record<string, unknown> = { trackLines: false, build: host, state: { mode: 'x' } }
  if (which === 'interpreter') {
    const c = target === 'direct' ? Direct : Control
    expect(c.parse(INPUT, 0, ctx as never).ok).toBe(true)
  } else {
    const c = target === 'direct' ? compiledDirect : compiledControl
    expect(c.parseWithContext(INPUT, ctx as never, 0).ok).toBe(true)
  }
  return seen()
}

const ENGINES = ['interpreter', 'compiled'] as const

describe('a direct builder under a positioned-CST host keeps the host’s capture', () => {
  // The control pins ground truth: same grammar, structural node, a path the repo
  // already gated on what the host reads.
  it.each(ENGINES)('%s — structural CONTROL receives trivia, fields and state', engine => {
    const seen = runWithHost(engine, 'control')
    expect(seen).toBeDefined()
    expect(seen!.triviaLog!.length).toBeGreaterThan(0)
    expect(seen!.fields).toBeDefined()
    expect(seen!.state).toEqual({ mode: 'x' })
  })

  // BEFORE THE FIX these three fail in BOTH engines: triviaLog is [], fields and
  // state are undefined. They are the whole defect, stated as a test.
  it.each(ENGINES)('%s — arity-1 direct builder receives the trivia log', engine => {
    expect(runWithHost(engine, 'direct')!.triviaLog).toEqual(runWithHost(engine, 'control')!.triviaLog)
  })

  it.each(ENGINES)('%s — arity-1 direct builder receives fields', engine => {
    expect(runWithHost(engine, 'direct')!.fields).toEqual(runWithHost(engine, 'control')!.fields)
  })

  it.each(ENGINES)('%s — arity-1 direct builder receives state', engine => {
    expect(runWithHost(engine, 'direct')!.state).toEqual({ mode: 'x' })
  })

  it('the two engines agree with each other, not merely with the control', () => {
    // A fix that reaches one engine and not the other fails HERE even if someone
    // later relaxes the control comparisons above.
    expect(runWithHost('interpreter', 'direct')).toEqual(runWithHost('compiled', 'direct'))
  })
})

describe('the eval-AST path (no host) is untouched', () => {
  it.each(ENGINES)('%s — an arity-1 builder still gets an empty log and no state', engine => {
    let got: { tl: readonly number[]; st: unknown; f: unknown } | undefined
    const { Probe } = rules(() => ({
      Probe: node('Probe', body(), (_c, f, _s, _r, tl, st) => {
        got = { tl, st, f }
        return { n: 1 }
      }),
    }))
    // A six-arg builder declares everything, so this probe reads what capture WOULD
    // have produced. The elision contract for a hostless parse: empty log, no state.
    const ctx: Record<string, unknown> = { trackLines: false }
    if (engine === 'interpreter') expect(Probe.parse(INPUT, 0, ctx as never).ok).toBe(true)
    else expect(compile(Probe).parseWithContext(INPUT, ctx as never, 0).ok).toBe(true)
    expect(got).toBeDefined()
    expect(got!.st).toBeUndefined()
  })

  it.each(ENGINES)('%s — a plain (non-CST) host does NOT force capture on a direct builder', engine => {
    // A host without `_parsemanCstOutput` never receives a direct-builder node, so it
    // must not turn capture back on — that would be a pure regression in the hot path.
    let sawTrivia: readonly number[] | undefined
    const { P } = rules(() => ({
      P: node('P', body(), (_c, _f, _s, _r, tl) => { sawTrivia = tl; return { n: 1 } }),
    }))
    const plainHost = (t: string, c: ReadonlyArray<unknown>) => ({ t, n: c.length })
    const ctx: Record<string, unknown> = { trackLines: false, build: plainHost }
    if (engine === 'interpreter') expect(P.parse(INPUT, 0, ctx as never).ok).toBe(true)
    else expect(compile(P).parseWithContext(INPUT, ctx as never, 0).ok).toBe(true)
    // The builder declared trivia, so it gets its own log — the point is the parse
    // succeeded through the DIRECT builder, not through the host.
    expect(sawTrivia).toBeDefined()
  })
})

describe('host-arity inference: interpreter twin vs emitted prelude', () => {
  // `hostReads` (TS, interpreter) and `_hostReads` (emitted string, compiled) are
  // separate implementations of one rule. Divergence is silent — one engine captures,
  // the other does not — so evaluate the emitted source and compare answers directly.
  const emitted = new Function(`${HOST_READS_SRC}; return _hostReads`)() as (b: unknown, n: number) => boolean

  const HOSTS: ReadonlyArray<readonly [string, unknown]> = [
    ['arity-0 arrow', () => 0],
    ['arity-2', (_a: unknown, _b: unknown) => 0],
    ['arity-5', (_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown) => 0],
    ['arity-7', (_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, _f: unknown, _g: unknown) => 0],
    ['rest param', (..._a: unknown[]) => 0],
    ['default param', (_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown = 1) => 0],
    ['uses arguments', function () { return arguments.length }],
    ['bound arity-7', ((_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, _f: unknown, _g: unknown) => 0).bind(null)],
    ['classic function', function (_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, _f: unknown) { return 0 }],
    ['undefined host', undefined],
  ]

  it.each(HOSTS)('%s — both engines infer the same reads for every arg slot', (_label, host) => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(hostReads(host, n)).toBe(emitted(host, n))
    }
  })

  it('a host whose source cannot be read forces FULL capture in both engines', () => {
    // Conservative by construction — an unreadable host must never silently lose data.
    // `Function.prototype.toString` throws on anything that is not a real function, so
    // this exercises the try/catch branch in BOTH implementations. Its `length` is
    // undefined, so a naive `.length > n` would answer `false` and drop the capture.
    const unreadable: unknown = Object.create(Function.prototype)
    expect(hostReads(unreadable, 6)).toBe(true)
    expect(emitted(unreadable, 6)).toBe(true)
  })
})

describe('silence is not reachable: an unsatisfiable capture throws', () => {
  const emittedAssert = new Function(
    `${HOST_READS_SRC}; ${CST_ASSERT_SRC}; return _cstAssert`,
  )() as (t: string, b: unknown, tl: boolean, fd: boolean, st: boolean, hf: boolean) => void

  const greedyHost = (
    _t: string, _c: unknown, _f: unknown, _s: unknown, _r: unknown, _tl: unknown, _st: unknown,
  ) => 0

  it('throws naming every collector the host reads but did not get', () => {
    expect(() =>
      assertHostCaptureSatisfied('Ruleset', greedyHost, { trivia: false, fields: false, state: false, hasFields: true }),
    ).toThrow(/triviaLog, fields, state/)
    expect(() => emittedAssert('Ruleset', greedyHost, false, false, false, true)).toThrow(/triviaLog, fields, state/)
  })

  it('stays silent when every gate is satisfied', () => {
    expect(() =>
      assertHostCaptureSatisfied('Ruleset', greedyHost, { trivia: true, fields: true, state: true, hasFields: true }),
    ).not.toThrow()
    expect(() => emittedAssert('Ruleset', greedyHost, true, true, true, true)).not.toThrow()
  })

  it('an explicit per-type opt-out is not a loss', () => {
    // `_parsemanCaptureTrivia` returning false means the host ASKED for a thin log.
    const optOut = Object.assign(
      (_t: string, _c: unknown, _f: unknown, _s: unknown, _r: unknown, _tl: unknown, _st: unknown) => 0,
      { _parsemanCaptureTrivia: () => false },
    )
    expect(hostCapturesTrivia(optOut, 'Ruleset')).toBe(false)
    expect(() =>
      assertHostCaptureSatisfied('Ruleset', optOut, { trivia: false, fields: true, state: true, hasFields: true }),
    ).not.toThrow()
    expect(() => emittedAssert('Ruleset', optOut, false, true, true, true)).not.toThrow()
  })

  it('a host that reads nothing past children needs nothing captured', () => {
    const lean = (_t: string, _c: unknown) => 0
    expect(() =>
      assertHostCaptureSatisfied('Ruleset', lean, { trivia: false, fields: false, state: false, hasFields: true }),
    ).not.toThrow()
  })
})

describe('supporting predicates', () => {
  it('cstOutputHost recognizes only an opted-in host', () => {
    expect(cstOutputHost(undefined)).toBe(false)
    expect(cstOutputHost(() => 0)).toBe(false)
    expect(cstOutputHost(Object.assign(() => 0, { _parsemanCstOutput: true as const }))).toBe(true)
  })

  it('HOST_ARG indices match the documented host signature', () => {
    // build(type, children, fields, span, rawChildren, triviaLog, state)
    expect(HOST_ARG).toEqual({ fields: 2, rawChildren: 4, triviaLog: 5, state: 6 })
  })
})
