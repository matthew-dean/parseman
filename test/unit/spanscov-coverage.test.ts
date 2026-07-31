/**
 * `src/coverage.ts` — the coverage graph, the trace sink, and the ratio.
 *
 * THE RATIO IS THE POINT. It once defaulted to `1` when there was nothing to measure, so
 * a grammar whose definitions failed to load reported 100% covered and every consumer
 * gate of the shape `ratio >= threshold` passed on zero evidence. The tests below assert
 * that "nothing measured" is reported as NaN AND flagged `measurable: false`, and — the
 * part that actually matters — that such a snapshot FAILS a threshold comparison rather
 * than passing it.
 *
 * The rest pins the coverage-graph rebuild: every structural `ParserDef` tag has to be
 * reconstructed from coverage-aware children, and a tag that silently falls through to
 * the shared source parser loses coverage inside it without failing anything. So each tag
 * is checked by asserting BOTH the parse result and the ids collected underneath it.
 */
import { describe, it, expect } from 'vitest'
import {
  attempt, choice, dispatch, expect as expectP, field, gate, keywords, label, leaf,
  literal, many, matches, node, not, oneOrMore, optional, parser, peek, regex, rules, scanTo,
  sepBy, sequence, skip, token, transform, trivia, when, otherwise, withCtx,
  createGrammarCoverageCollector, createGrammarInstrumentationContext, createGrammarTraceSink,
  compiledGrammarCoverageDefinitions, composedGrammarCoverageDefinitions,
  grammarCoverageDefinitions, runWithGrammarCoverage, compose,
  type Combinator, type GrammarCoverageDefinition,
} from '../../src/index.ts'

const DEF = (id: string): GrammarCoverageDefinition => ({ id, kind: 'rule' })

describe('the ratio — "unmeasurable" must NOT read as "perfect"', () => {
  it('reports NaN and measurable:false for an empty definition set, and fails a threshold', () => {
    const snap = createGrammarCoverageCollector([]).snapshot()
    expect(snap.measurable).toBe(false)
    expect(Number.isNaN(snap.ratio)).toBe(true)
    // The regression in one line: NaN >= anything is false, so a gate fails CLOSED.
    expect(snap.ratio >= 0.8).toBe(false)
    expect(snap.ratio >= 0).toBe(false)
    expect(snap.definitions).toEqual([])
    expect(snap.hits).toEqual([])
    expect(snap.unhit).toEqual([])
  })

  it('distinguishes a genuine 0% — measurable, ratio exactly 0 — from that', () => {
    const snap = createGrammarCoverageCollector([DEF('rule:A')]).snapshot()
    expect(snap.measurable).toBe(true)
    expect(snap.ratio).toBe(0)
    expect(snap.unhit).toEqual(['rule:A'])
  })

  it('computes hit/total exactly, sorted, and ignores an id it was not given', () => {
    const c = createGrammarCoverageCollector([DEF('rule:B'), DEF('rule:A'), DEF('rule:C'), DEF('rule:D')])
    c.hit('rule:C')
    c.hit('rule:A')
    c.hit('rule:NOT-IN-THE-SET')
    const snap = c.snapshot()
    expect(snap.definitions.map(d => d.id)).toEqual(['rule:A', 'rule:B', 'rule:C', 'rule:D'])
    expect(snap.hits).toEqual(['rule:A', 'rule:C'])
    expect(snap.unhit).toEqual(['rule:B', 'rule:D'])
    expect(snap.ratio).toBe(0.5)
    expect(snap.measurable).toBe(true)
  })

  it('reset() clears the hits and returns the snapshot to a measurable 0', () => {
    const c = createGrammarCoverageCollector([DEF('rule:A'), DEF('rule:B')])
    c.hit('rule:A')
    expect(c.snapshot().ratio).toBe(0.5)
    c.reset()
    const snap = c.snapshot()
    expect(snap.hits).toEqual([])
    expect(snap.ratio).toBe(0)
    expect(snap.measurable).toBe(true)
  })
})

describe('compiledGrammarCoverageDefinitions rejects everything that is not a definition set', () => {
  const SYM = Symbol.for('parseman.grammarCoverageDefinitions')
  const MSG = 'grammar has no coverage definitions; enable grammarCoverage for this macro build'

  it('throws on a missing, non-array or EMPTY set — the vacuous-every hole', () => {
    expect(() => compiledGrammarCoverageDefinitions({})).toThrow(MSG)
    expect(() => compiledGrammarCoverageDefinitions({ [SYM]: 'nope' })).toThrow(TypeError)
    // `[].every(...)` is vacuously true; the empty array is the ONE input whose name the
    // error spells out, and it is the one that used to sail through.
    expect(() => compiledGrammarCoverageDefinitions({ [SYM]: [] })).toThrow(MSG)
  })

  it('throws on entries that are not objects, lack an id, or carry an unknown kind', () => {
    expect(() => compiledGrammarCoverageDefinitions({ [SYM]: [null] })).toThrow(MSG)
    expect(() => compiledGrammarCoverageDefinitions({ [SYM]: ['rule:A'] })).toThrow(MSG)
    expect(() => compiledGrammarCoverageDefinitions({ [SYM]: [{ id: 1, kind: 'rule' }] })).toThrow(MSG)
    expect(() => compiledGrammarCoverageDefinitions({ [SYM]: [{ id: 'a', kind: 'not-a-kind' }] })).toThrow(MSG)
  })

  it('returns the set unchanged for every valid kind', () => {
    const defs = [
      { id: 'rule:A', kind: 'rule' },
      { id: 'choice:A/arm:0', kind: 'choice-arm' },
      { id: 'dispatch:A/arm:0', kind: 'dispatch-arm' },
      { id: 'label:A/x', kind: 'label' },
    ]
    expect(compiledGrammarCoverageDefinitions({ [SYM]: defs })).toBe(defs)
  })
})

describe('the instrumentation context', () => {
  it('omits every optional key that was not asked for', () => {
    const ctx = createGrammarInstrumentationContext()
    expect(ctx.trackLines).toBe(false)
    expect('state' in ctx).toBe(false)
    expect('_grammarCoverage' in ctx).toBe(false)
    expect('_grammarTrace' in ctx).toBe(false)
  })

  it('routes _grammarCoverage into the collector it was given', () => {
    const c = createGrammarCoverageCollector([DEF('rule:A')])
    const ctx = createGrammarInstrumentationContext({ collector: c, trackLines: true })
    expect(ctx.trackLines).toBe(true)
    ctx._grammarCoverage!('rule:A')
    expect(c.snapshot().hits).toEqual(['rule:A'])
  })
})

describe('the bounded trace sink', () => {
  it('rejects a capacity that is not a finite non-negative integer', () => {
    for (const capacity of [-1, 1.5, NaN, Infinity]) {
      expect(() => createGrammarTraceSink({ capacity })).toThrow('trace capacity must be a finite non-negative integer')
    }
  })

  it('keeps the first N events and counts the rest as dropped', () => {
    const sink = createGrammarTraceSink({ capacity: 2 })
    for (let i = 0; i < 5; i++) sink.write({ id: `r${i}`, phase: 'enter', offset: i })
    const s = sink.snapshot()
    expect(s.events.map(e => e.id)).toEqual(['r0', 'r1'])
    expect(s.truncated).toBe(true)
    expect(s.dropped).toBe(3)
    // Frozen: a consumer cannot mutate the record it was handed.
    expect(Object.isFrozen(s)).toBe(true)
    expect(Object.isFrozen(s.events[0])).toBe(true)
  })

  it('a capacity of 0 records nothing and reports every event dropped', () => {
    const sink = createGrammarTraceSink({ capacity: 0 })
    sink.write({ id: 'r', phase: 'enter', offset: 0 })
    expect(sink.snapshot()).toEqual({ events: [], truncated: true, dropped: 1 })
  })

  it('is untruncated and drops nothing while under capacity', () => {
    const sink = createGrammarTraceSink({ capacity: 4 })
    sink.write({ id: 'r', phase: 'enter', offset: 0 })
    expect(sink.snapshot()).toEqual({ events: [{ id: 'r', phase: 'enter', offset: 0 }], truncated: false, dropped: 0 })
  })

  it('a callback returning false DETACHES — the event already written is kept, later ones drop', () => {
    const seen: string[] = []
    const sink = createGrammarTraceSink({ capacity: 10, write: e => { seen.push(e.id); return e.id !== 'stop' } })
    sink.write({ id: 'a', phase: 'enter', offset: 0 })
    sink.write({ id: 'stop', phase: 'enter', offset: 1 })
    sink.write({ id: 'b', phase: 'enter', offset: 2 })
    expect(seen).toEqual(['a', 'stop'])
    const s = sink.snapshot()
    expect(s.events.map(e => e.id)).toEqual(['a', 'stop'])
    expect(s.truncated).toBe(true)
    expect(s.dropped).toBe(1)
  })

  it('a THROWING callback detaches instead of propagating', () => {
    const sink = createGrammarTraceSink({ capacity: 10, write: () => { throw new Error('boom') } })
    expect(() => sink.write({ id: 'a', phase: 'enter', offset: 0 })).not.toThrow()
    const s = sink.snapshot()
    expect(s.events.map(e => e.id)).toEqual(['a'])
    expect(s.truncated).toBe(true)
  })
})

describe('runWithGrammarCoverage', () => {
  it('refuses a compiled function entry by name', () => {
    expect(() => runWithGrammarCoverage(() => ({ ok: false }) as never, 'x'))
      .toThrow('runWithGrammarCoverage currently requires an interpreter combinator entry')
  })

  it('uses a caller-supplied collector, so hits accumulate across runs', () => {
    const g = rules(gg => ({ Entry: choice(gg.A, gg.B), A: literal('a'), B: literal('b') }))
    const collector = createGrammarCoverageCollector(grammarCoverageDefinitions(g.Entry))
    const first = runWithGrammarCoverage(g.Entry, 'a', { collector })
    expect(first.result.ok).toBe(true)
    expect(first.coverage.hits).toContain('rule:A')
    expect(first.coverage.hits).not.toContain('rule:B')
    const second = runWithGrammarCoverage(g.Entry, 'b', { collector })
    expect(second.coverage.hits).toContain('rule:A')
    expect(second.coverage.hits).toContain('rule:B')
    expect(second.coverage.ratio).toBe(1)
  })

  it('records a failure phase in the trace and leaves the run result untouched', () => {
    const g = rules(() => ({ Entry: literal('a') }))
    const trace = createGrammarTraceSink({ capacity: 50 })
    const { result } = runWithGrammarCoverage(g.Entry, 'z', { trace })
    expect(result.ok).toBe(false)
    expect(trace.snapshot().events.some(e => e.id === 'rule:Entry' && e.phase === 'failure')).toBe(true)
  })
})

describe('greedyClassify — only the FINAL semantic arm is counted', () => {
  const g = rules(() => ({
    Entry: choice(regex(/[a-z]+/), literal('if'), literal('else')),
  })) as Record<string, Combinator<unknown>>

  it('credits the literal arm when the text IS that literal', () => {
    const { result, coverage } = runWithGrammarCoverage(g.Entry!, 'if')
    expect(result).toMatchObject({ ok: true })
    expect(coverage.hits).toContain('choice:Entry/arm:1')
    // The super arm ran as an implementation detail; it must not be credited.
    expect(coverage.hits).not.toContain('choice:Entry/arm:0')
  })

  it('credits the SUPER arm when the text matches no literal', () => {
    const { result, coverage } = runWithGrammarCoverage(g.Entry!, 'zzz')
    expect(result).toMatchObject({ ok: true })
    expect(coverage.hits).toContain('choice:Entry/arm:0')
    expect(coverage.hits).not.toContain('choice:Entry/arm:1')
  })
})

describe('dispatch arms — the regex matcher kind', () => {
  const p = dispatch(
    regex(/@[A-Za-z0-9-]+/),
    when('@media', literal('{')),
    when(matches(/^@[0-9]+$/), literal('!')),
    otherwise(literal(';')),
  )

  it('names the regex matcher in the definition id', () => {
    expect(grammarCoverageDefinitions(p).map(d => d.id)).toContain('dispatch:entry/matcher:matches:%5E%40%5B0-9%5D%2B%24')
  })

  it('credits ONLY the regex-matched arm, and traces it against the dispatch start', () => {
    const trace = createGrammarTraceSink({ capacity: 50 })
    const run = runWithGrammarCoverage(p, '@42!', { trace })
    expect(run.result.ok).toBe(true)
    expect(run.coverage.hits).toEqual(['dispatch:entry/matcher:matches:%5E%40%5B0-9%5D%2B%24'])
    expect(trace.snapshot().events).toEqual([
      { id: 'dispatch:entry/matcher:matches:%5E%40%5B0-9%5D%2B%24', phase: 'attempt', offset: 0 },
      { id: 'dispatch:entry/matcher:matches:%5E%40%5B0-9%5D%2B%24', phase: 'selected', offset: 0, end: 4 },
      { id: 'dispatch:entry/matcher:matches:%5E%40%5B0-9%5D%2B%24', phase: 'success', offset: 0, end: 4 },
    ])
  })

  it('falls through to otherwise when the regex does not match', () => {
    const run = runWithGrammarCoverage(p, '@zzz;')
    expect(run.result.ok).toBe(true)
    expect(run.coverage.hits).toEqual(['dispatch:entry/otherwise'])
  })
})

describe('every structural def tag is rebuilt, so coverage survives inside it', () => {
  /** Ids hit under `entry` for `input`, plus the run result. */
  const runIt = (entry: Combinator<unknown>, input: string): { ok: boolean; hits: readonly string[] } => {
    const { result, coverage } = runWithGrammarCoverage(entry, input)
    return { ok: result.ok, hits: coverage.hits }
  }

  it('sequence / many / oneOrMore / optional', () => {
    const g = rules(gg => ({
      Entry: sequence(optional(gg.Opt), many(gg.M), oneOrMore(gg.One)),
      Opt: literal('?'),
      M: literal('m'),
      One: literal('1'),
    })) as Record<string, Combinator<unknown>>
    const r = runIt(g.Entry!, '?mm11')
    expect(r.ok).toBe(true)
    expect(r.hits).toEqual(expect.arrayContaining(['rule:Opt', 'rule:M', 'rule:One']))

    // `optional` really is optional under the rebuild, and its rule goes unhit.
    const r2 = runIt(g.Entry!, '1')
    expect(r2.ok).toBe(true)
    expect(r2.hits).not.toContain('rule:Opt')
  })

  it('sepBy, with min/max/trailing carried through the rebuild', () => {
    const g = rules(gg => ({
      Entry: sepBy(gg.Item, literal(','), { min: 2, max: 3, trailing: 'allow' }),
      Item: regex(/[a-z]/),
    })) as Record<string, Combinator<unknown>>
    expect(runIt(g.Entry!, 'a,b').ok).toBe(true)
    expect(runIt(g.Entry!, 'a,b,').ok).toBe(true)
    // min:2 survived the rebuild — a single item is not enough.
    expect(runIt(g.Entry!, 'a').ok).toBe(false)
    expect(runIt(g.Entry!, 'a,b').hits).toContain('rule:Item')
  })

  it('transform and leaf keep their reducer', () => {
    const g = rules(gg => ({ Entry: transform(gg.N, v => `t:${String(v)}`), N: literal('n') }))
    const { result, coverage } = runWithGrammarCoverage(g.Entry, 'n')
    expect(result).toMatchObject({ ok: true, value: 't:n' })
    expect(coverage.hits).toContain('rule:N')

    const l = rules(gg => ({ Entry: leaf(gg.N, (_v, span) => span.end), N: regex(/[0-9]+/) }))
    const lr = runWithGrammarCoverage(l.Entry, '123')
    expect(lr.result).toMatchObject({ ok: true, value: 3 })
    expect(lr.coverage.hits).toContain('rule:N')
  })

  it('skip and trivia', () => {
    const g = rules(gg => ({ Entry: skip(gg.Main, literal(' ')), Main: literal('x') })) as Record<string, Combinator<unknown>>
    expect(runIt(g.Entry!, 'x').hits).toContain('rule:Main')

    const t = rules(gg => ({ Entry: sequence(trivia(gg.WS), literal('x')), WS: regex(/ +/) })) as Record<string, Combinator<unknown>>
    const tr = runIt(t.Entry!, '  x')
    expect(tr.ok).toBe(true)
    expect(tr.hits).toContain('rule:WS')
  })

  it('token flattens to the matched text and still covers underneath', () => {
    const g = rules(gg => ({ Entry: token(gg.Inner), Inner: sequence(literal('a'), literal('b')) }))
    const { result, coverage } = runWithGrammarCoverage(g.Entry, 'ab')
    expect(result).toMatchObject({ ok: true, value: 'ab' })
    expect(coverage.hits).toContain('rule:Inner')
  })

  it('field keeps its NAME and span through the rebuild', () => {
    const g = rules(gg => ({
      Entry: node('E', sequence(literal('['), field('name', gg.Name), literal(']')), (_c, fields) => fields),
      Name: regex(/[a-z]+/),
    }))
    const { result, coverage } = runWithGrammarCoverage(g.Entry, '[abc]')
    expect(result).toMatchObject({ ok: true, value: { name: { value: 'abc', span: { start: 1, end: 4 } } } })
    expect(coverage.hits).toContain('rule:Name')
  })

  it('a nested grammar scope rebuilds with its trivia, and one with trivia:null clears it', () => {
    const withTrivia = rules(gg => ({
      Entry: parser({ trivia: regex(/ +/) }, sequence(gg.A, gg.B)),
      A: literal('a'),
      B: literal('b'),
    })) as Record<string, Combinator<unknown>>
    const r = runIt(withTrivia.Entry!, 'a  b')
    expect(r.ok).toBe(true)
    expect(r.hits).toEqual(expect.arrayContaining(['rule:A', 'rule:B']))

    const cleared = rules(gg => ({
      Entry: parser({ trivia: null }, sequence(gg.A, gg.B)),
      A: literal('a'),
      B: literal('b'),
    })) as Record<string, Combinator<unknown>>
    expect(runIt(cleared.Entry!, 'a  b').ok).toBe(false)
    expect(runIt(cleared.Entry!, 'ab').ok).toBe(true)
  })

  it('not and peek keep their zero-width semantics', () => {
    const g = rules(gg => ({
      Entry: sequence(not(gg.Bad), peek(gg.Good), literal('g')),
      Bad: literal('b'),
      Good: literal('g'),
    })) as Record<string, Combinator<unknown>>
    const r = runIt(g.Entry!, 'g')
    expect(r.ok).toBe(true)
    expect(r.hits).toEqual(expect.arrayContaining(['rule:Bad', 'rule:Good']))
    expect(runIt(g.Entry!, 'b').ok).toBe(false)
  })

  it('node keeps type, unwrap/collapse/project options through the rebuild', () => {
    const projected = rules(gg => ({
      Entry: node('E', sequence(literal('('), gg.Inner, literal(')')), { project: 1 }),
      Inner: regex(/[0-9]+/),
    }))
    const p = runWithGrammarCoverage(projected.Entry, '(7)')
    expect(p.result).toMatchObject({ ok: true, value: '7' })
    expect(p.coverage.hits).toContain('rule:Inner')

    const typed = rules(gg => ({ Entry: node('Typed', sequence(gg.Inner)), Inner: literal('i') }))
    const tr = runWithGrammarCoverage(typed.Entry, 'i')
    expect(JSON.stringify(tr.result)).toContain('Typed')
    expect(tr.coverage.hits).toContain('rule:Inner')
  })

  it('gate reads parser state, and withCtx supplies it', () => {
    const allowed = rules(gg => ({
      Entry: withCtx({ on: true }, sequence(gg.G, literal('x'))),
      G: gate(s => (s as { on: boolean }).on),
    })) as Record<string, Combinator<unknown>>
    expect(runIt(allowed.Entry!, 'x').ok).toBe(true)
    expect(runIt(allowed.Entry!, 'x').hits).toContain('rule:G')

    const denied = rules(gg => ({
      Entry: withCtx({ on: false }, sequence(gg.G, literal('x'))),
      G: gate(s => (s as { on: boolean }).on),
    })) as Record<string, Combinator<unknown>>
    expect(runIt(denied.Entry!, 'x').ok).toBe(false)
  })

  it('expect keeps its label, and yields a parseError value rather than failing', () => {
    const g = rules(gg => ({ Entry: expectP(gg.Semi, 'a semicolon'), Semi: literal(';') }))
    const { result } = runWithGrammarCoverage(g.Entry, 'x')
    expect(result).toMatchObject({ ok: true, value: { _tag: 'parseError', expected: ['a semicolon'] } })
  })

  it('scanTo keeps its sentinel, skip list and orEOF', () => {
    const g = rules(gg => ({
      Entry: scanTo(gg.Semi, { skip: [gg.Str], orEOF: true }),
      Semi: literal(';'),
      Str: sequence(literal('"'), regex(/[^"]*/), literal('"')),
    })) as Record<string, Combinator<unknown>>
    const r = runIt(g.Entry!, 'a"x;y";')
    expect(r.ok).toBe(true)
    expect(r.hits).toContain('rule:Semi')
    // orEOF survived: no sentinel at all is still a success.
    expect(runIt(g.Entry!, 'abc').ok).toBe(true)
  })

  it('attempt rolls back, and the rollback is traced', () => {
    const g = rules(gg => ({
      Entry: choice(attempt(sequence(gg.A, gg.B)), gg.A),
      A: literal('a'),
      B: literal('b'),
    })) as Record<string, Combinator<unknown>>
    const trace = createGrammarTraceSink({ capacity: 200 })
    const { result, coverage } = runWithGrammarCoverage(g.Entry!, 'a', { trace })
    expect(result.ok).toBe(true)
    expect(coverage.hits).toContain('rule:A')
    expect(trace.snapshot().events.some(e => e.phase === 'rollback')).toBe(true)
  })

  it('terminal recognizers (literal / regex / keywords) are shared, not rebuilt', () => {
    const g = rules(gg => ({ Entry: sequence(gg.K, gg.L, gg.R), K: keywords(['if', 'ifx']), L: literal('!'), R: regex(/[0-9]/) })) as Record<string, Combinator<unknown>>
    const r = runIt(g.Entry!, 'ifx!5')
    expect(r.ok).toBe(true)
    expect(r.hits).toEqual(expect.arrayContaining(['rule:K', 'rule:L', 'rule:R']))
  })

  it('label ids are credited only on SUCCESS', () => {
    const g = rules(() => ({ Entry: choice(label('word', literal('w')), literal('x')) }))
    const hit = runWithGrammarCoverage(g.Entry, 'w').coverage.hits
    expect(hit.some(id => id.startsWith('label:'))).toBe(true)
    const missed = runWithGrammarCoverage(g.Entry, 'x').coverage.hits
    expect(missed.some(id => id.startsWith('label:'))).toBe(false)
  })
})

describe('composedGrammarCoverageDefinitions', () => {
  const composed = compose([rules(gg => ({ Entry: choice(gg.A, literal('b')), A: literal('a') }))])

  it('names the start rule it could not find, quoted', () => {
    expect(() => composedGrammarCoverageDefinitions(composed, 'Nope'))
      .toThrow('semantic coverage start rule "Nope" is not a final winner')
  })

  it('returns the final-winner definitions for a real start rule', () => {
    const defs = composedGrammarCoverageDefinitions(composed, 'Entry')
    expect(defs.map(d => d.id)).toEqual(expect.arrayContaining(['rule:Entry', 'rule:A']))
  })

  it('refuses a grammar that carries no re-lowerable composed IR', () => {
    expect(() => composedGrammarCoverageDefinitions({ Entry: literal('a') }, 'Entry'))
      .toThrow('semantic coverage needs re-lowerable composed IR; this composition contains an opaque artifact')
  })
})

describe('the rebuild REFUSES a tag it cannot reconstruct, by name', () => {
  const wrap = (tag: 'recover' | 'unknown'): Combinator<unknown> => {
    const inner = literal('a')
    return {
      _tag: tag,
      _meta: inner._meta,
      _def: tag === 'recover'
        ? { tag: 'recover', parser: inner, sentinel: literal(';') }
        : { tag: 'unknown' },
      parse: (input, pos, ctx) => inner.parse(input, pos, ctx),
    }
  }

  it('names `recover` rather than silently sharing the source parser', () => {
    // Silently falling through would still PARSE — and would report zero coverage
    // underneath, which is the failure mode this throw exists to prevent.
    expect(() => runWithGrammarCoverage(wrap('recover'), 'a'))
      .toThrow('runWithGrammarCoverage does not yet support recover')
  })

  it('names `unknown` the same way', () => {
    expect(() => runWithGrammarCoverage(wrap('unknown'), 'a'))
      .toThrow('runWithGrammarCoverage does not yet support unknown')
  })
})

describe('the rebuild carries options a shorter grammar never sets', () => {
  it('keeps an ANONYMOUS node anonymous — the untyped overload, not `node(undefined, …)`', () => {
    const g = rules(() => ({ Entry: node(sequence(literal('a'), literal('b')), children => children.length) }))
    expect(runWithGrammarCoverage(g.Entry, 'ab').result).toMatchObject({ ok: true, value: 2 })
  })

  it('keeps node captureTrivia and trailingTrivia', () => {
    const g = rules(() => ({
      Entry: parser({ trivia: many(literal(' ')) },
        node('N', sequence(literal('a'), literal('b')), children => children.length,
          { captureTrivia: true, trailingTrivia: true })),
    }))
    expect(runWithGrammarCoverage(g.Entry, 'a b ').result).toMatchObject({ ok: true, value: 2 })
  })

  it('keeps a nested grammar scope\'s captureTrivia and trackLines', () => {
    const g = rules(() => ({
      Entry: parser({ trivia: many(literal(' ')), captureTrivia: true, trackLines: true },
        sequence(literal('a'), literal('\n'), literal('b'))),
    }))
    const r = runWithGrammarCoverage(g.Entry, 'a\nb').result
    expect(r.ok).toBe(true)
    // trackLines is what puts a line number on the span; dropping it leaves it absent.
    expect(r.span).toMatchObject({ start: 0, end: 3, endLine: 2 })
  })

  it('keeps a dispatch matcher arm\'s caseInsensitive flag', () => {
    const p = dispatch(regex(/[A-Za-z]+/), when(matches(/^ur/), literal('!'), { caseInsensitive: true }))
    // Without the flag the uppercase selector would route nowhere and nothing would be hit.
    const upper = runWithGrammarCoverage(p, 'URL!')
    expect(upper.result.ok).toBe(true)
    expect(upper.coverage.hits).toEqual(['dispatch:entry/matcher:matches:%5Eur'])
  })

  it('rebuilds a STANDALONE attempt(), the one with no rollback id of its own', () => {
    const g = rules(() => ({
      Entry: choice(sequence(attempt(sequence(literal('a'), literal('b'))), literal('c')), literal('a')),
    }))
    expect(runWithGrammarCoverage(g.Entry, 'abc').result).toMatchObject({ ok: true })
    // The attempt rolls the position back to 0, so the second arm still takes a bare 'a'.
    expect(runWithGrammarCoverage(g.Entry, 'a').result).toMatchObject({ ok: true, value: 'a' })
  })
})
