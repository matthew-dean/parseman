import { describe, expect, it } from 'vitest'
import { choice, compile, compiledGrammarCoverageDefinitions, createGrammarCoverageCollector, createGrammarInstrumentationContext, createGrammarTraceSink, label, literal, many, regex, rules, run, runWithGrammarCoverage, sequence, type GatedArm } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { compileRuleMap } from '../../src/compiler/codegen.ts'

describe('macro grammar coverage emission', () => {
  it('preserves the checked default generated-output baseline', () => {
    const parser = choice(literal('a'), literal('b'))
    expect(compile(parser).source).toBe(`

function _parse(input, _pos, _rp, _mf, _build, _ctx) {
  let pos = _pos
  const _code0 = _pos < input.length ? (input.codePointAt(_pos) ?? -1) : -1
  let _chv1, _che2 = _pos
  if (_code0 === 97) {
    if (_pos >= input.length || input.charCodeAt(_pos) !== 97) {
      return { ok: false, expected: ["\\"a\\""], span: { start: _pos, end: _pos } }
    }
    const _v3 = "a"
    _chv1 = _v3
    _che2 = _pos + 1
  }
  else if (_code0 === 98) {
    if (_pos >= input.length || input.charCodeAt(_pos) !== 98) {
      return { ok: false, expected: ["\\"b\\""], span: { start: _pos, end: _pos } }
    }
    const _v4 = "b"
    _chv1 = _v4
    _che2 = _pos + 1
  }
  else {
    return { ok: false, expected: ["\\"a\\"","\\"b\\""], span: { start: _pos, end: _pos } }
  }
  return { ok: true, value: _chv1, span: { start: _pos, end: _che2 } }
}`)
  })

  it('keeps non-coverage loop-termination breaks byte-identical', () => {
    const source = compile(many(literal('a'))).source
    expect(source).toContain('break _lbl2')
    expect(source).not.toContain('{ break _lbl2 }')
  })

  it('emits selected first-match and disjoint arm hooks only in coverage mode', () => {
    const firstMatch = choice(literal('a'), literal('b'))
    const ordinary = compile(firstMatch)
    const coverage = compile(firstMatch, undefined, { coverage: true })
    expect(ordinary.source).not.toContain('_grammarCoverage')
    expect(compile(firstMatch).source).toBe(ordinary.source)
    expect(coverage.source).toContain('_grammarCoverage')

    const hits: string[] = []
    const result = coverage.parseWithContext('b', { trackLines: false, _grammarCoverage: (id: string) => hits.push(id) } as never)
    expect(result.ok).toBe(true)
    expect(hits).toEqual(['choice:entry/arm:1'])
  })

  it('exposes definitions and accepts instrumentation through run() only in coverage mode', () => {
    const parser = choice(literal('a'), literal('b'))
    const compiled = compile(parser, undefined, { coverage: true })
    expect(compiled.coverageDefinitions).toEqual([
      { id: 'choice:entry/arm:0', kind: 'choice-arm' },
      { id: 'choice:entry/arm:1', kind: 'choice-arm' },
    ])
    const collector = createGrammarCoverageCollector(compiled.coverageDefinitions!)
    expect(run((input, pos, context) => compiled.parseWithContext(input, context, pos), 'b', {
      instrumentation: createGrammarInstrumentationContext({ collector }),
    }).ok).toBe(true)
    expect(collector.snapshot()).toMatchObject({ ratio: 0.5, hits: ['choice:entry/arm:1'] })
  })

  it('records the final classified arm for greedy and longest-literal choices', () => {
    const greedy = compile(choice(regex('[a-z]+'), literal('if')), undefined, { coverage: true })
    const greedyHits: string[] = []
    expect(greedy.parseWithContext('if', { trackLines: false, _grammarCoverage: (id: string) => greedyHits.push(id) } as never).ok).toBe(true)
    expect(greedyHits).toEqual(['choice:entry/arm:1'])

    const longest = compile(choice(literal('a'), literal('ab')), undefined, { coverage: true })
    const longestHits: string[] = []
    expect(longest.parseWithContext('ab', { trackLines: false, _grammarCoverage: (id: string) => longestHits.push(id) } as never).ok).toBe(true)
    expect(longestHits).toEqual(['choice:entry/arm:1'])
  })

  it('keeps the default plugin transform byte-identical and emits hooks only when requested', () => {
    const source = `import { choice, literal } from 'parseman' with { type: 'macro' }\nconst parser = choice(literal('a'), literal('b'))`
    const ordinary = transformMacro(source, 'coverage-fixture.ts', new Set(['parseman']))!
    const covered = transformMacro(source, 'coverage-fixture.ts', new Set(['parseman']), false, false, true)!
    expect(ordinary.code).not.toContain('_grammarCoverage')
    expect(covered.code).toContain('_grammarCoverage')
    expect(transformMacro(source, 'coverage-fixture.ts', new Set(['parseman']))!.code).toBe(ordinary.code)
  })

  it('attaches coverage definitions to coverage-enabled macro rule maps only', () => {
    const source = `import { choice, literal, rules } from 'parseman' with { type: 'macro' }\nconst grammar = rules(g => ({ Entry: choice(literal('a'), literal('b')) }))`
    const ordinary = transformMacro(source, 'coverage-definitions.ts', new Set(['parseman']))!
    const covered = transformMacro(source, 'coverage-definitions.ts', new Set(['parseman']), false, false, true)!
    expect(ordinary.code).not.toContain('parseman.grammarCoverageDefinitions')
    expect(covered.code).toContain('parseman.grammarCoverageDefinitions')
    const grammar = new Function(`${covered.code}\nreturn grammar`)() as Record<string, unknown>
    expect(compiledGrammarCoverageDefinitions(grammar)).toEqual([
      { id: 'choice:Entry/lazy:0/arm:0', kind: 'choice-arm' },
      { id: 'choice:Entry/lazy:0/arm:1', kind: 'choice-arm' },
      { id: 'rule:Entry', kind: 'rule' },
    ])
  })

  it('uses shared-plan rule and label IDs in coverage mode', () => {
    const grammar = rules(g => ({ Entry: choice(g.Word, literal('x')), Word: label('word', literal('w')) }))
    const compiled = compile(grammar.Entry, undefined, { coverage: true })
    const hits: string[] = []
    expect(compiled.parseWithContext('w', { trackLines: false, _grammarCoverage: (id: string) => hits.push(id) } as never).ok).toBe(true)
    expect(hits).toEqual(['rule:Entry', 'rule:Word', 'label:Entry/choice:0/lazy:0', 'choice:Entry/arm:0'])
  })

  it('emits a selected-arm trace event only in coverage mode', () => {
    const compiled = compile(choice(literal('a'), literal('b')), undefined, { coverage: true })
    const events: unknown[] = []
    expect(compiled.parseWithContext('b', { trackLines: false, _grammarTrace: { write: (event: unknown) => events.push(event) } } as never).ok).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({ id: 'choice:entry/arm:1', phase: 'selected', offset: 0 }))
    expect(compile(choice(literal('a'), literal('b'))).source).not.toContain('_grammarTrace')
  })

  it('emits ordered rule, label, and selected-choice lifecycle events', () => {
    const grammar = rules(g => ({ Entry: choice(g.Word, literal('x')), Word: label('word', literal('w')) }))
    const compiled = compile(grammar.Entry, undefined, { coverage: true })
    const events: Array<{ id: string; phase: string }> = []
    expect(compiled.parseWithContext('w', { trackLines: false, _grammarTrace: { write: (event: { id: string; phase: string }) => events.push(event) } } as never).ok).toBe(true)
    expect(events.map(event => `${event.id}/${event.phase}`)).toEqual([
      'rule:Entry/enter',
      'choice:Entry/arm:0/attempt',
      'rule:Word/enter',
      'rule:Word/success',
      'label:Entry/choice:0/lazy:0/success',
      'choice:Entry/arm:0/selected',
      'choice:Entry/arm:0/success',
      'rule:Entry/success',
    ])
  })

  it('keeps selected IDs stable for disjoint, greedy, and longest strategies', () => {
    const cases = [
      [choice(literal('a'), literal('b')), 'b', 'choice:entry/arm:1'],
      [choice(regex('[a-z]+'), literal('if')), 'if', 'choice:entry/arm:1'],
      [choice(literal('a'), literal('ab')), 'ab', 'choice:entry/arm:1'],
    ] as const
    for (const [parser, input, id] of cases) {
      const events: Array<{ id: string; phase: string }> = []
      expect(compile(parser, undefined, { coverage: true }).parseWithContext(input, {
        trackLines: false,
        _grammarTrace: { write: (event: { id: string; phase: string }) => events.push(event) },
      } as never).ok).toBe(true)
      expect(events).toContainEqual(expect.objectContaining({ id, phase: 'selected' }))
    }
  })

  it('does not emit an attempt for a gated-off arm', () => {
    const gated: GatedArm = { combinator: literal('a'), gate: () => false }
    const events: Array<{ id: string; phase: string }> = []
    expect(compile(choice(gated, literal('b')), undefined, { coverage: true }).parseWithContext('b', {
      trackLines: false,
      _grammarTrace: { write: (event: { id: string; phase: string }) => events.push(event) },
    } as never).ok).toBe(true)
    expect(events).not.toContainEqual(expect.objectContaining({ id: 'choice:entry/arm:0', phase: 'attempt' }))
    expect(events).toContainEqual(expect.objectContaining({ id: 'choice:entry/arm:1', phase: 'selected' }))
  })

  it('uses the local choice cursor and end in selected trace events', () => {
    const parser = sequence(literal('x'), choice(literal('a'), literal('b')))
    const events: Array<{ id: string; phase: string; offset: number; end?: number }> = []
    expect(compile(parser, undefined, { coverage: true }).parseWithContext('xb', {
      trackLines: false,
      _grammarTrace: { write: (event: { id: string; phase: string; offset: number; end?: number }) => events.push(event) },
    } as never).ok).toBe(true)
    expect(events).toContainEqual({ id: 'choice:entry/sequence:1/arm:1', phase: 'selected', offset: 1, end: 2 })
  })

  it('matches the interpreter first-match arm lifecycle, including deep failure offsets', () => {
    const parser = choice(sequence(literal('a'), literal('!')), literal('a'))
    const interpreterTrace = createGrammarTraceSink({ capacity: 20 })
    expect(runWithGrammarCoverage(parser, 'a', { trace: interpreterTrace }).result.ok).toBe(true)
    const macroEvents: Array<{ id: string; phase: string; offset: number; end?: number }> = []
    expect(compile(parser, undefined, { coverage: true }).parseWithContext('a', {
      trackLines: false,
      _grammarTrace: { write: (event: { id: string; phase: string; offset: number; end?: number }) => macroEvents.push(event) },
    } as never).ok).toBe(true)
    expect(macroEvents).toEqual(interpreterTrace.snapshot().events)
  })

  it('matches disjoint, greedy, longest, and auto-not choice schedules', () => {
    const cases = [
      [choice(literal('a'), literal('b')), 'b'],
      [choice(regex('[a-z]+'), literal('if')), 'if'],
      [choice(literal('a'), literal('ab')), 'ab'],
      [choice(literal('foo'), literal('foobar'), regex('[0-9]+')), 'foobar'],
    ] as const
    for (const [parser, input] of cases) {
      const interpreterTrace = createGrammarTraceSink({ capacity: 30 })
      expect(runWithGrammarCoverage(parser, input, { trace: interpreterTrace }).result.ok).toBe(true)
      const macroEvents: Array<{ id: string; phase: string; offset: number; end?: number }> = []
      expect(compile(parser, undefined, { coverage: true }).parseWithContext(input, {
        trackLines: false,
        _grammarTrace: { write: (event: { id: string; phase: string; offset: number; end?: number }) => macroEvents.push(event) },
      } as never).ok).toBe(true)
      expect(macroEvents).toEqual(interpreterTrace.snapshot().events)
    }
  })

  it('closes a greedy-classify regex-arm attempt when the super-regex misses', () => {
    const parser = choice(regex('[a-z]+'), literal('if'))
    const interpreterTrace = createGrammarTraceSink({ capacity: 20 })
    expect(runWithGrammarCoverage(parser, '1', { trace: interpreterTrace }).result.ok).toBe(false)

    const macroEvents: Array<{ id: string; phase: string; offset: number; end?: number }> = []
    expect(compile(parser, undefined, { coverage: true }).parseWithContext('1', {
      trackLines: false,
      _grammarTrace: { write: (event: { id: string; phase: string; offset: number; end?: number }) => macroEvents.push(event) },
    } as never).ok).toBe(false)
    expect(macroEvents).toEqual(interpreterTrace.snapshot().events)
  })

  it('instruments rules-map macro output while preserving its ordinary output', () => {
    const grammar = rules(g => ({ Entry: sequence(literal('('), g.Word, literal(')')), Word: literal('a') }))
    const ordinary = compileRuleMap(Object.entries(grammar))!
    const covered = compileRuleMap(Object.entries(grammar), { coverage: true })!
    expect(ordinary.replacement).not.toContain('_grammarCoverage')
    expect(ordinary.replacement).not.toContain('_grammarTrace')
    expect(covered.replacement).toContain('_grammarCoverage')

    const compiledRules = new Function(`return ${covered.replacement}`)() as {
      Entry(input: string, pos: number, ctx: unknown): unknown
    }
    const successEvents: Array<{ id: string; phase: string; offset: number }> = []
    expect(compiledRules.Entry('(a)', 0, {
      trackLines: false,
      _grammarTrace: { write: (event: { id: string; phase: string; offset: number }) => successEvents.push(event) },
    })).toMatchObject({ ok: true, span: { start: 0, end: 3 } })
    expect(successEvents.map(event => `${event.id}/${event.phase}`)).toEqual([
      'rule:Entry/enter',
      'rule:Word/enter',
      'rule:Word/success',
      'rule:Entry/success',
    ])

    const events: Array<{ id: string; phase: string; offset: number }> = []
    expect(compiledRules.Entry('(b)', 0, {
      trackLines: false,
      _grammarTrace: { write: (event: { id: string; phase: string; offset: number }) => events.push(event) },
    })).toMatchObject({ ok: false, span: { start: 1, end: 1 } })
    expect(events.map(event => `${event.id}/${event.phase}`)).toEqual([
      'rule:Entry/enter',
      'rule:Word/enter',
      'rule:Word/failure',
      'rule:Entry/failure',
    ])

    const source = `import { literal, rules } from 'parseman' with { type: 'macro' }\nconst grammar = rules(g => ({ Entry: g.Word, Word: literal('a') }))`
    const macroOrdinary = transformMacro(source, 'coverage-rules.ts', new Set(['parseman']))!
    const macroCovered = transformMacro(source, 'coverage-rules.ts', new Set(['parseman']), false, false, true)!
    expect(macroOrdinary.code).not.toContain('_grammarCoverage')
    expect(macroCovered.code).toContain('_grammarCoverage')
  })

  it('matches interpreter trace for a recursive rules-map auto-not parse', () => {
    const grammar = rules(g => ({
      Entry: choice(sequence(literal('('), g.Entry, literal(')')), g.Word),
      Word: choice(literal('foo'), literal('foobar'), regex('[0-9]+')),
    }))
    const input = '(foobar)'
    const interpreterTrace = createGrammarTraceSink({ capacity: 100 })
    expect(runWithGrammarCoverage(grammar.Entry, input, { trace: interpreterTrace }).result.ok).toBe(true)

    const source = `import { choice, literal, regex, rules, sequence } from 'parseman' with { type: 'macro' }\nconst grammar = rules(g => ({ Entry: choice(sequence(literal('('), g.Entry, literal(')')), g.Word), Word: choice(literal('foo'), literal('foobar'), regex(/[0-9]+/)) }))`
    const transformed = transformMacro(source, 'coverage-recursive-rules.ts', new Set(['parseman']), false, false, true)!
    const compiledRules = new Function(`${transformed.code}\nreturn grammar`)() as {
      Entry(input: string, pos: number, ctx: unknown): unknown
    }
    const macroEvents: Array<{ id: string; phase: string; offset: number; end?: number }> = []
    expect(compiledRules.Entry(input, 0, {
      trackLines: false,
      _grammarTrace: { write: (event: { id: string; phase: string; offset: number; end?: number }) => macroEvents.push(event) },
    })).toMatchObject({ ok: true, span: { start: 0, end: input.length } })
    expect(macroEvents).toEqual(interpreterTrace.snapshot().events)
  })

  it('emits a named-rule failure before a top-level macro failure returns', () => {
    const grammar = rules(() => ({ Entry: literal('a') }))
    const events: Array<{ id: string; phase: string }> = []
    expect(compile(grammar.Entry, undefined, { coverage: true }).parseWithContext('b', {
      trackLines: false,
      _grammarTrace: { write: (event: { id: string; phase: string }) => events.push(event) },
    } as never).ok).toBe(false)
    expect(events.map(event => `${event.id}/${event.phase}`)).toEqual(['rule:Entry/enter', 'rule:Entry/failure'])
  })

  it('orders nested named-rule failures without duplicating the inner rule', () => {
    const grammar = rules(g => ({ Entry: sequence(literal('('), g.Word, literal(')')), Word: literal('a') }))
    const events: Array<{ id: string; phase: string }> = []
    expect(compile(grammar.Entry, undefined, { coverage: true }).parseWithContext('(b)', {
      trackLines: false,
      _grammarTrace: { write: (event: { id: string; phase: string }) => events.push(event) },
    } as never).ok).toBe(false)
    expect(events.map(event => `${event.id}/${event.phase}`)).toEqual([
      'rule:Entry/enter',
      'rule:Word/enter',
      'rule:Word/failure',
      'rule:Entry/failure',
    ])
  })

  it('matches interpreter rule-failure lifecycle for nested `(b)`', () => {
    const grammar = rules(g => ({ Entry: sequence(literal('('), g.Word, literal(')')), Word: literal('a') }))
    const interpreterTrace = createGrammarTraceSink({ capacity: 20 })
    expect(runWithGrammarCoverage(grammar.Entry, '(b)', { trace: interpreterTrace }).result.ok).toBe(false)

    const macroEvents: Array<{ id: string; phase: string; offset: number }> = []
    expect(compile(grammar.Entry, undefined, { coverage: true }).parseWithContext('(b)', {
      trackLines: false,
      _grammarTrace: { write: (event: { id: string; phase: string; offset: number }) => macroEvents.push(event) },
    } as never).ok).toBe(false)
    expect(macroEvents).toEqual(interpreterTrace.snapshot().events)
  })

})
