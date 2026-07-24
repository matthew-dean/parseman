/**
 * `_parsemanReadsChildren === false` lets a structural host that builds ONLY from
 * `rawChildren` (arg 4) elide the per-node `children` array (chV) — a byte-for-byte
 * duplicate of rawChildren for a structural grammar. Arity inference can't detect
 * this: such a host must declare `children` positionally to reach `rawChildren`/
 * `span`/`state`, so `Function.length` stays high and `_hostReads` reports "read".
 *
 * These tests pin: (1) output is byte-identical to the non-opted-out host, (2) the
 * host actually receives `children === undefined` while `rawChildren` is fully
 * populated (leaves + sub-nodes), proving the elision fired without data loss, and
 * (3) the collapse contract (`_parsemanCstCollapse`, which inspects children) keeps
 * chV even when the opt-out is also set.
 */
import { describe, it, expect } from 'vitest'
import { node, regex, sequence, literal, many, trivia, parser, rules, compile, type BuildHost } from '../../src/index.ts'

const rw = trivia(regex(/[ \t\n\r\f]+/))
// Nested structural grammar: Doc → many(Pair); Pair → Word ':' Word. Leaves
// (Word terminals + ':') and sub-nodes (Pair) both flow into the collectors.
const { Doc } = rules({ trivia: rw }, g => ({
  Word: node('Word', regex(/[a-z]+/)),
  Pair: node('Pair', sequence(g.Word, literal(':'), g.Word)),
  Doc: node('Doc', many(g.Pair)),
}))
const compiled = compile(Doc)
const INPUT = 'a : b  c : d'

/** Structural host that builds purely from rawChildren, like cssCstBuildHost. */
const fromRaw = (optOut: boolean): BuildHost => {
  const h: BuildHost = (
    type: string,
    _children: ReadonlyArray<unknown> | undefined,
    _fields: unknown,
    span: { start: number; end: number },
    rawChildren: ReadonlyArray<unknown>,
  ) => ({ _tag: 'node', type, span: { start: span.start, end: span.end }, children: rawChildren })
  if (optOut) h._parsemanReadsChildren = false
  return h
}

const parse = (build: BuildHost) => {
  const ctx: Record<string, unknown> = { trackLines: false, build }
  const r = compiled.parseWithContext(INPUT, ctx as never, 0)
  return { ctx, r }
}

describe('_parsemanReadsChildren opt-out — structural children-array elision', () => {
  it('produces byte-identical output to the non-opted-out host', () => {
    const base = parse(fromRaw(false))
    const opt = parse(fromRaw(true))
    expect(base.r.ok).toBe(true)
    expect(opt.r.ok).toBe(true)
    if (!base.r.ok || !opt.r.ok) return
    expect(JSON.stringify(opt.r.value)).toBe(JSON.stringify(base.r.value))
  })

  it('hands the opt-out host children===undefined while rawChildren stays fully populated', () => {
    const seen: Array<{ type: string; children: unknown; rawLen: number }> = []
    const spy: BuildHost = (type, children, _f, span, rawChildren) => {
      seen.push({ type, children, rawLen: rawChildren.length })
      return { _tag: 'node', type, span: { start: span.start, end: span.end }, children: rawChildren }
    }
    spy._parsemanReadsChildren = false
    const { r, ctx } = parse(spy)
    expect(r.ok).toBe(true)
    // memoized decision: children NOT needed
    expect(ctx._pmReadsCh).toBe(false)
    // every structural node saw an elided children arg…
    expect(seen.every(s => s.children === undefined)).toBe(true)
    // …but rawChildren carried the real structure: a Pair has 3 (Word, ':', Word),
    // the Doc has 2 Pairs. Proves leaves + sub-nodes reached rawChildren w/o chV.
    const pair = seen.find(s => s.type === 'Pair')!
    expect(pair.rawLen).toBe(3)
    expect(seen.find(s => s.type === 'Doc')!.rawLen).toBe(2)
  })

  it('keeps children when the host does NOT opt out (default, back-compat)', () => {
    const seen: unknown[] = []
    const host: BuildHost = (type, children, _f, span, rawChildren) => {
      seen.push(children)
      return { _tag: 'node', type, span: { start: span.start, end: span.end }, children: rawChildren }
    }
    const { r, ctx } = parse(host)
    expect(r.ok).toBe(true)
    expect(ctx._pmReadsCh).toBe(true)
    expect(seen.every(c => Array.isArray(c))).toBe(true)
  })

  it('keeps children for a collapse host even when opt-out is set (collapse inspects children)', () => {
    const host: BuildHost = (type, children, _f, span, rawChildren) =>
      ({ _tag: 'node', type, span: { start: span.start, end: span.end }, children: rawChildren })
    host._parsemanReadsChildren = false
    host._parsemanCstCollapse = () => false
    const seen: unknown[] = []
    const wrapped: BuildHost = (type, children, f, span, raw, tl, st) => {
      seen.push(children)
      return host(type, children, f, span, raw, tl, st)
    }
    wrapped._parsemanReadsChildren = false
    wrapped._parsemanCstCollapse = () => false
    const { r, ctx } = parse(wrapped)
    expect(r.ok).toBe(true)
    // collapse presence forces chV to stay allocated
    expect(ctx._pmReadsCh).toBe(true)
    expect(seen.every(c => Array.isArray(c))).toBe(true)
  })
})
