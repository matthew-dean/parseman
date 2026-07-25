/**
 * Interpreter capture under a positioned-CST host, and its parity with `hostMode: 'cst'`.
 *
 * THE DEFECT. Per-node capture is elided from the DIRECT builder's formal arity. But a
 * direct builder is BYPASSED when a positioned-CST host (`_parsemanCstOutput` —
 * `cstBuildHost` and the language-service hosts) is installed: `node.ts` re-routes the
 * node through `ctx.build`. The host is then the consumer, and it was handed collectors
 * sized for a consumer that never ran.
 *
 * Nearly every AST builder is `children => …`, arity 1, so under a CST host those nodes
 * produced an EMPTY triviaLog and absent fields and state. Nothing errored — and an empty
 * trivia log is indistinguishable from a node that genuinely had none, which is why it
 * stayed invisible.
 *
 * 0.40.0 settled this for the COMPILED engine at build time (`hostMode: 'cst'`), where it
 * costs nothing. The interpreter has no compile step, so it re-decides per parse. These
 * tests pin that the two engines agree — the compiled side is compiled for `'cst'`, which
 * is now how you ask for a positioned CST — because a fix that reaches one engine and not
 * the other is this repo's established failure mode.
 *
 * Assertions compare against a STRUCTURAL control: the same grammar on the path that was
 * always gated correctly. That is what makes them evidence rather than a guess about what
 * the numbers should be.
 */
import { describe, it, expect } from 'vitest'
import { node, sequence, regex, literal, trivia, parser, rules, compile, field } from '../../src/index.ts'
import { cstOutputHost } from '../../src/compiler/build-arity.ts'

const rw = trivia(regex(/[ \t\n\r\f]+/))
const INPUT = 'a { }' // two interior trivia runs

type Seen = {
  children: number
  fields: unknown
  triviaLog: readonly number[] | undefined
  state: unknown
}

/** A positioned-CST host that reads every collector — the language-service shape. */
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

const body = () => parser({ trivia: rw }, sequence(field('a', literal('a')), literal('{'), literal('}')))
const { Direct } = rules(() => ({ Direct: node('Direct', body(), children => ({ n: children.length })) }))
const { Control } = rules(() => ({ Control: node('Control', body()) }))
const compiledDirect = compile(Direct, undefined, { hostMode: 'cst' })
const compiledControl = compile(Control, undefined, { hostMode: 'cst' })

function run(which: 'interpreter' | 'compiled', target: 'direct' | 'control'): Seen | undefined {
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
  it.each(ENGINES)('%s — structural CONTROL receives trivia, fields and state', engine => {
    const seen = run(engine, 'control')
    expect(seen).toBeDefined()
    expect(seen!.triviaLog!.length).toBeGreaterThan(0)
    expect(seen!.fields).toBeDefined()
    expect(seen!.state).toEqual({ mode: 'x' })
  })

  // BEFORE the fix these fail on the INTERPRETER: triviaLog is [], fields and state are
  // undefined. They are the whole defect, stated as a test.
  it.each(ENGINES)('%s — arity-1 direct builder receives the trivia log', engine => {
    expect(run(engine, 'direct')!.triviaLog).toEqual(run(engine, 'control')!.triviaLog)
  })

  it.each(ENGINES)('%s — arity-1 direct builder receives fields', engine => {
    expect(run(engine, 'direct')!.fields).toEqual(run(engine, 'control')!.fields)
  })

  it.each(ENGINES)('%s — arity-1 direct builder receives state', engine => {
    expect(run(engine, 'direct')!.state).toEqual({ mode: 'x' })
  })

  it('the two engines agree with each other, not merely with the control', () => {
    // A fix that reaches one engine and not the other fails HERE even if someone later
    // relaxes the comparisons above.
    expect(run('interpreter', 'direct')).toEqual(run('compiled', 'direct'))
  })
})

describe('the eval-AST path is untouched', () => {
  it('a plain (non-CST) host does not force capture on a direct builder', () => {
    // A host without `_parsemanCstOutput` never receives a direct-builder node, so it
    // must not turn capture back on — that would be a pure hot-path regression.
    let sawTrivia: readonly number[] | undefined
    const { P } = rules(() => ({
      P: node('P', body(), (_c, _f, _s, _r, tl) => { sawTrivia = tl; return { n: 1 } }),
    }))
    const plainHost = (t: string, c: ReadonlyArray<unknown>) => ({ t, n: c.length })
    expect(P.parse(INPUT, 0, { trackLines: false, build: plainHost } as never).ok).toBe(true)
    expect(sawTrivia).toBeDefined()
  })

  it('with no host at all, an arity-1 builder still gets no state', () => {
    let sawState: unknown = 'unset'
    const { P } = rules(() => ({
      P: node('P', body(), (_c, _f, _s, _r, _tl, st) => { sawState = st; return { n: 1 } }),
    }))
    expect(P.parse(INPUT, 0, { trackLines: false } as never).ok).toBe(true)
    expect(sawState).toBeUndefined()
  })
})

describe('cstOutputHost', () => {
  it('recognizes only an opted-in host', () => {
    expect(cstOutputHost(undefined)).toBe(false)
    expect(cstOutputHost(() => 0)).toBe(false)
    expect(cstOutputHost(Object.assign(() => 0, { _parsemanCstOutput: true as const }))).toBe(true)
  })
})
