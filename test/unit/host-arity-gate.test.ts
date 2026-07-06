/**
 * Structural `node()` gates cstTriviaLog + state capture on what the injected
 * `_ctx.build` host reads, inferred from its arity at parse time. `Function.length`
 * under-counts with rest/default params (and can't see through a bound fn), so the
 * `_hostReads` helper is CONSERVATIVE: a rest/default param or an `arguments`
 * reference forces full capture. These tests pin that safety — a spread/default
 * host must never silently lose the trivia it reads — plus the transparency of the
 * fast (arity-4) path.
 *
 * The gate's decision is memoized on the parse ctx as `_pmCapTL` (capture trivia?)
 * and `_pmCapST` (clone state?), which we read back to assert the decision, plus a
 * functional check that a rest host actually receives a live (non-frozen) trivia
 * array rather than the frozen `_EMPTY_TL` sentinel used when capture is elided.
 */
import { describe, it, expect } from 'vitest'
import { node, regex, sequence, literal, trivia, parser, rules, compile } from '../../src/index.ts'

const rw = trivia(regex(/[ \t\n\r\f]+/))
const { Doc } = rules(() => ({
  Doc: node('Doc', parser({ trivia: rw }, sequence(literal('a'), literal('{'), literal('}')))),
}))
const compiled = compile(Doc)
const INPUT = 'a { }' // interior spaces are trivia

// Parse and return the ctx so the memoized gate decision can be inspected.
const parseCtx = (build: unknown) => {
  const ctx: Record<string, unknown> = { trackLines: false, build }
  const r = compiled.parseWithContext(INPUT, ctx as never, 0)
  return { ctx, r }
}

describe('structural-node capture gate — host-arity inference', () => {
  it('a plain arity-4 host (jess shape) elides BOTH captures — the fast path', () => {
    const lean = (t: string, c: unknown[], r: unknown, s: unknown) => ({ t, n: c.length })
    expect((lean as (...a: unknown[]) => unknown).length).toBe(4)
    const { ctx } = parseCtx(lean)
    expect(ctx._pmCapTL).toBe(false) // trivia capture skipped
    expect(ctx._pmCapST).toBe(false) // state clone skipped
  })

  it('a REST-param host forces capture and RECEIVES live trivia (spread-safe)', () => {
    let tl: unknown
    const restHost = (...a: unknown[]) => { tl = a[4]; return { n: (a[1] as unknown[]).length } }
    expect((restHost as (...a: unknown[]) => unknown).length).toBe(0) // naive `>=5` would elide
    const { ctx, r } = parseCtx(restHost)
    expect(r.ok).toBe(true)
    expect(ctx._pmCapTL).toBe(true)
    expect(Array.isArray(tl) && !Object.isFrozen(tl)).toBe(true)
    expect((tl as unknown[]).length).toBeGreaterThan(0)
  })

  it('a DEFAULT-param host under-counts arity (length 4) but capture is still kept', () => {
    const host = (t: string, c: unknown[], r: unknown, s: unknown, tl: unknown[] = [], st?: unknown) =>
      ({ t, n: c.length, tl, st })
    expect((host as (...a: unknown[]) => unknown).length).toBe(4) // stops at first default
    const { ctx } = parseCtx(host)
    expect(ctx._pmCapTL).toBe(true)
    expect(ctx._pmCapST).toBe(true)
  })

  it('an `arguments`-using host forces capture', () => {
    // A plain-looking arity-2 fn that secretly reads everything via `arguments`.
    const host = function (t: string, c: unknown[]) { return { t, n: c.length, all: arguments.length } }
    const { ctx } = parseCtx(host)
    expect(ctx._pmCapTL).toBe(true)
  })

  it('elision is transparent: lean vs padded host build identical output', () => {
    const lean = (type: string, ch: unknown[], _r: unknown, span: { start: number; end: number }) =>
      ({ t: type, n: ch.length, s: span.start })
    const padded = (type: string, ch: unknown[], _r: unknown, span: { start: number; end: number }, _tl: unknown, _st: unknown) =>
      ({ t: type, n: ch.length, s: span.start })
    const a = parseCtx(lean).r, b = parseCtx(padded).r
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value))
  })
})
