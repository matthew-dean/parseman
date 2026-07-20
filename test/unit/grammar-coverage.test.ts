import { describe, expect, it } from 'vitest'
import { choice, compose, composedGrammarCoverageDefinitions, createGrammarCoverageCollector, createGrammarInstrumentationContext, createGrammarTraceSink, grammarCoverageDefinitions, label, literal, regex, rules, runWithGrammarCoverage, sequence, transform, type GatedArm } from '../../src/index.ts'

describe('grammar semantic coverage', () => {
  const grammar = rules(g => ({
    Entry: choice(g.Word, literal('x')),
    Word: label('word', literal('w')),
  }))

  it('creates a typed opt-in context for covered compiled parsers', () => {
    const collector = createGrammarCoverageCollector(grammarCoverageDefinitions(grammar.Entry))
    const trace = createGrammarTraceSink({ capacity: 10 })
    const context = createGrammarInstrumentationContext({ collector, trace, state: { test: true } })
    expect(context.trackLines).toBe(false)
    expect(context.state).toEqual({ test: true })
  })

  it('uses a separate coverage graph without changing the grammar or RunResult', () => {
    const definitions = grammarCoverageDefinitions(grammar.Entry)
    expect(definitions.map(definition => definition.id)).toEqual([
      'choice:Entry/arm:0',
      'choice:Entry/arm:1',
      'label:Entry/choice:0/lazy:0',
      'rule:Entry',
      'rule:Word',
    ])

    const parseBefore = grammar.Entry.parse
    const { result, coverage } = runWithGrammarCoverage(grammar.Entry, 'w')
    expect(result).toMatchObject({ ok: true })
    expect('coverage' in result).toBe(false)
    expect(grammar.Entry.parse).toBe(parseBefore)
    expect(coverage.hits).toEqual(['choice:Entry/arm:0', 'label:Entry/choice:0/lazy:0', 'rule:Entry', 'rule:Word'])
    expect(coverage.unhit).toContain('choice:Entry/arm:1')
  })

  it('keeps coverage active through a structural parent rather than delegating to the source graph', () => {
    const nested = rules(g => ({
      Entry: sequence(g.Word, literal('!')),
      Word: choice(label('word', literal('w')), literal('x')),
    }))
    const { result, coverage } = runWithGrammarCoverage(nested.Entry, 'w!')
    expect(result.ok).toBe(true)
    expect(coverage.hits).toEqual(expect.arrayContaining([
      'rule:Entry',
      'rule:Word',
      'choice:Entry/sequence:0/lazy:0/arm:0',
      'label:Entry/sequence:0/lazy:0/choice:0',
    ]))
  })

  it('uses the final compose winner when resolving a referenced rule', () => {
    const base = rules(g => ({
      Entry: sequence(g.Value),
      Value: label('base-value', literal('a')),
    }))
    const overlay = rules(() => ({
      Value: label('overlay-value', literal('b')),
    }))
    const composed = compose([base, overlay])
    expect(composedGrammarCoverageDefinitions(composed, 'Entry').map(definition => definition.id)).toEqual([
      'label:Entry/sequence:0/lazy:0',
      'rule:Entry',
      'rule:Value',
    ])
  })

  it('traces rule and selected-arm events through the same plan with bounded retention', () => {
    const trace = createGrammarTraceSink({ capacity: 3 })
    const { result } = runWithGrammarCoverage(grammar.Entry, 'w', { trace })
    expect(result.ok).toBe(true)
    expect(trace.snapshot()).toMatchObject({ truncated: true, dropped: expect.any(Number) })
    expect(trace.snapshot().events).toEqual([
      { id: 'rule:Entry', phase: 'enter', offset: 0 },
      { id: 'choice:Entry/arm:0', phase: 'attempt', offset: 0 },
      { id: 'rule:Word', phase: 'enter', offset: 0 },
    ])
  })

  it('traces greedy classification as its classified final arm', () => {
    const trace = createGrammarTraceSink({ capacity: 20 })
    const parser = choice(regex('[a-z]+'), literal('if'))
    const run = runWithGrammarCoverage(parser, 'if', { trace })
    expect(run.result.ok).toBe(true)
    expect(run.coverage.hits).toEqual(['choice:entry/arm:1'])
    expect(run.coverage.unhit).toEqual(['choice:entry/arm:0'])
    expect(trace.snapshot().events).toContainEqual({ id: 'choice:entry/arm:1', phase: 'selected', offset: 0, end: 2 })
  })

  it('has deterministic first-N and callback-detach sink ownership', () => {
    const full = createGrammarTraceSink({ capacity: 1 })
    full.write({ id: 'rule:A', phase: 'enter', offset: 0 })
    full.write({ id: 'rule:A', phase: 'success', offset: 0, end: 1 })
    expect(full.snapshot()).toEqual({ events: [{ id: 'rule:A', phase: 'enter', offset: 0 }], truncated: true, dropped: 1 })

    const detached = createGrammarTraceSink({ capacity: 3, write: () => false })
    detached.write({ id: 'rule:A', phase: 'enter', offset: 0 })
    detached.write({ id: 'rule:A', phase: 'success', offset: 0, end: 1 })
    expect(detached.snapshot()).toEqual({ events: [{ id: 'rule:A', phase: 'enter', offset: 0 }], truncated: true, dropped: 1 })
  })

  it('uses the same selected IDs for disjoint, greedy, and longest choices', () => {
    const cases = [
      [choice(literal('a'), literal('b')), 'b'],
      [choice(regex('[a-z]+'), literal('if')), 'if'],
      [choice(literal('a'), literal('ab')), 'ab'],
    ] as const
    for (const [parser, input] of cases) {
      const trace = createGrammarTraceSink({ capacity: 20 })
      expect(runWithGrammarCoverage(parser, input, { trace }).result.ok).toBe(true)
      expect(trace.snapshot().events).toContainEqual(expect.objectContaining({ id: 'choice:entry/arm:1', phase: 'selected' }))
    }
  })

  it('does not trace a gated-off arm attempt', () => {
    const gated: GatedArm = { combinator: literal('a'), gate: () => false }
    const parser = choice(gated, literal('b'))
    const trace = createGrammarTraceSink({ capacity: 20 })
    expect(runWithGrammarCoverage(parser, 'b', { trace }).result.ok).toBe(true)
    expect(trace.snapshot().events).not.toContainEqual(expect.objectContaining({ id: 'choice:entry/arm:0', phase: 'attempt' }))
    expect(trace.snapshot().events).toContainEqual(expect.objectContaining({ id: 'choice:entry/arm:1', phase: 'selected' }))
  })

  it('backtracks an auto-not rejected prefix before selecting the transformed longer arm', () => {
    const parser = choice(literal('a'), transform(literal('ab'), value => value))
    const trace = createGrammarTraceSink({ capacity: 30 })
    expect(runWithGrammarCoverage(parser, 'ab', { trace }).result.ok).toBe(true)
    expect(trace.snapshot().events).toContainEqual(expect.objectContaining({ id: 'choice:entry/arm:1', phase: 'selected' }))
  })

  it('merges only explicitly shared collector and trace sink ownership across runs', () => {
    const collector = createGrammarCoverageCollector(grammarCoverageDefinitions(grammar.Entry))
    const trace = createGrammarTraceSink({ capacity: 50 })
    runWithGrammarCoverage(grammar.Entry, 'w', { collector, trace })
    runWithGrammarCoverage(grammar.Entry, 'x', { collector, trace })
    expect(collector.snapshot().hits).toEqual([
      'choice:Entry/arm:0',
      'choice:Entry/arm:1',
      'label:Entry/choice:0/lazy:0',
      'rule:Entry',
      'rule:Word',
    ])
    expect(trace.snapshot().events.filter(event => event.id === 'rule:Entry' && event.phase === 'enter')).toHaveLength(2)
  })

  it('keeps choice trace state per recursive invocation', () => {
    const recursive = rules(g => ({
      Entry: choice(sequence(literal('('), g.Entry, literal(')')), literal('x')),
    }))
    const trace = createGrammarTraceSink({ capacity: 50 })
    expect(runWithGrammarCoverage(recursive.Entry, '(x)', { trace }).result.ok).toBe(true)
    expect(trace.snapshot().events).not.toContainEqual(expect.objectContaining({ id: 'choice:Entry/lazy:0/arm:1', phase: 'failure' }))
  })

})
