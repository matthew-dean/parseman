import { attempt, choice, compile, createGrammarTraceSink, expect as required, field, literal, node, oneOrMore, parser as grammarParser, runWithGrammarCoverage, sequence, trivia, type Combinator, type ParseContext } from '../../src/index.ts'
import { describe, expect, it } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

type Runner = { parse(input: string, pos: number, ctx: Record<string, unknown>): { ok: boolean; value?: unknown; span: { start: number; end: number }; expected?: string[] } }

function both(parser: Combinator<unknown>): Runner[] {
  const compiled = compile(parser)
  return [
    { parse: (input, pos, ctx) => parser.parse(input, pos, ctx as ParseContext) },
    { parse: (input, pos, ctx) => compiled.parseWithContext(input, ctx as ParseContext, pos) },
  ]
}

describe('attempt', () => {
  it('rolls a consumed prefix back to an ordered-choice fallback in interpreter and compiled output', () => {
    const grammar = choice(attempt(sequence(literal('a'), literal('b'))), sequence(literal('a'), literal('c')))
    for (const parser of both(grammar)) {
      const result = parser.parse('ac', 0, { trackLines: false })
      expect(result).toMatchObject({ ok: true, value: ['a', 'c'], span: { start: 0, end: 2 } })
    }
  })

  it('nests without committing an inner consumed failure', () => {
    const grammar = choice(attempt(sequence(literal('a'), attempt(sequence(literal('b'), literal('c'))))), literal('a'))
    for (const parser of both(grammar)) {
      const result = parser.parse('ab', 0, { trackLines: false })
      expect(result).toMatchObject({ ok: true, value: 'a', span: { start: 0, end: 1 } })
    }
  })

  it('rolls back CST leaves, raw children, fields, and trivia before the fallback commits', () => {
    const body = choice(
      attempt(sequence(field('rejected', literal('a')), literal('!'))),
      sequence(field('accepted', literal('a')), literal('c')),
    )
    const ws = trivia(oneOrMore(literal(' ')))
    const grammar = grammarParser({ trivia: ws }, node('Root', body, (children, fields, _span, raw, triviaLog) => ({ children, fields, raw, triviaLog })))
    for (const parser of both(grammar)) {
      const leaves: unknown[] = []
      const raw: unknown[] = []
      const capturedTrivia: number[] = []
      const fields: unknown[] = []
      const triviaLog: number[] = []
      const result = parser.parse('a c', 0, {
        trackLines: false, trivia: ws, captureTrivia: true,
        _cstLeaves: leaves, _cstRawChildren: raw, _cstTriviaLog: capturedTrivia,
        _fields: fields, _triviaLog: triviaLog,
      })
      expect(result).toMatchObject({ ok: true, span: { start: 0, end: 3 }, value: {
        children: [{ value: 'a' }, { value: 'c' }], raw: [{ value: 'a' }, { value: 'c' }],
        fields: { accepted: { value: 'a' } }, triviaLog: [1, 2, 1],
      } })
      // `node()` owns its private buffer; no rejected fact reaches the outer collector.
      expect(leaves).toEqual([])
      // Interpreter/compiled outer collectors differ for a semantic node, but
      // neither receives the rejected branch; the node's own raw payload above
      // is the authoritative CST assertion.
      expect(fields).toEqual([])
      expect(capturedTrivia).toEqual([])
      expect(triviaLog).toEqual([1, 2])
    }
  })

  it('removes recovery diagnostics emitted inside a rejected transaction', () => {
    const grammar = choice(attempt(sequence(required(literal('a')), literal('!'))), literal('x'))
    for (const parser of both(grammar)) {
      const errors: unknown[] = []
      const result = parser.parse('x', 0, { trackLines: false, _errors: errors })
      expect(result).toMatchObject({ ok: true, value: 'x', span: { start: 0, end: 1 } })
      expect(errors).toEqual([])
    }
  })

  it('reports a rejected transaction at its entry while preserving the inner expectation', () => {
    const grammar = sequence(literal('x'), attempt(sequence(literal('a'), literal('b'))))
    for (const parser of both(grammar)) {
      const result = parser.parse('xa', 0, { trackLines: false })
      expect(result).toEqual({ ok: false, expected: ['"b"'], span: { start: 1, end: 1 } })
    }
  })

  it('macro-lowers the transaction without retaining a runtime combinator route', () => {
    const source = `import { attempt, choice, literal, sequence } from 'parseman' with { type: 'macro' }\nconst parser = choice(attempt(sequence(literal('a'), literal('b'))), literal('a'))`
    const transformed = transformMacro(source, 'attempt-macro.ts', new Set(['parseman']))!
    expect(transformed.code).not.toContain("from 'parseman'")
    expect(transformed.code).not.toMatch(/\battempt\s*\(/)
    const parser = evalMacroModule<(input: string, pos: number, ctx: ParseContext) => unknown>(transformed.code, 'parser')
    expect(parser('a', 0, { trackLines: false })).toMatchObject({ ok: true, value: 'a', span: { start: 0, end: 1 } })
  })

  const rollbackGrammar = () => choice(
    attempt(choice(sequence(literal('a'), literal('!')), literal('x'))),
    literal('a'),
  )

  const ROLLBACK_MACRO_SRC = `import { attempt, choice, literal, sequence } from 'parseman' with { type: 'macro' }\nconst parser = choice(attempt(choice(sequence(literal('a'), literal('!')), literal('x'))), literal('a'))`

  // THE INTERPRETER IS THE REFERENCE, and it is engine-independent — coverage
  // counters and the six trace phases both. This half stays LIVE; only the
  // lowered-artifact half below is parked.
  it('traces a transaction rollback distinctly and never credits its rejected choice arm', () => {
    const parser = rollbackGrammar()
    const interpreterTrace = createGrammarTraceSink({ capacity: 30 })
    const interpreted = runWithGrammarCoverage(parser, 'a', { trace: interpreterTrace })
    expect(interpreted.result.ok).toBe(true)
    expect(interpreted.coverage.hits).toEqual(['choice:entry/arm:1'])
    expect(interpreted.coverage.unhit).toEqual(expect.arrayContaining([
      'choice:entry/arm:0', 'choice:entry/choice:0/attempt:0/arm:0', 'choice:entry/choice:0/attempt:0/arm:1',
    ]))
    expect(interpreterTrace.snapshot().events).toContainEqual({ id: 'attempt:entry/choice:0', phase: 'rollback', offset: 0 })
  })

  // TODO(table/grammar-trace) — 0.48. `_grammarTrace`'s SIX PHASES — `attempt`,
  // `selected`, `success`, `failure`, `backtrack`, `rollback` — ship in the
  // interpreter and in the SOURCE lowering only. The table lowering emits
  // coverage COUNTERS and no trace events at all, and the macro build now lowers
  // through the table, so the emitted module carries `tableRules`/`cv:[]` where
  // it used to carry `phase: 'rollback'`. Tracked in
  // `notes/RELEASE-0.48-TARGET.md` §1 — roughly 40 fine-grained emission sites
  // need table equivalents, and the instrumented pieces must stay
  // assembly-SELECTED rather than testing a flag per node (INV-6).
  //
  // `.todo` rather than deleted: this is the ONLY in-suite record that trace was
  // ever covered end to end, and these assertions are exactly what the 0.48 work
  // must satisfy — the lowered artifact's event stream, compared whole against
  // the interpreter's. It is written against the PUBLIC `compile()` (the table)
  // deliberately: it was passing against `compiler/codegen.ts`, and restoring it
  // by pointing it back at an engine that is being deleted would park the gap
  // instead of recording it. Do not weaken it to make it pass.
  it.todo('the lowered artifact emits the interpreter\'s trace events, phase for phase', () => {
    const parser = rollbackGrammar()
    const interpreterTrace = createGrammarTraceSink({ capacity: 30 })
    expect(runWithGrammarCoverage(parser, 'a', { trace: interpreterTrace }).result.ok).toBe(true)

    const artifactEvents: Array<{ id: string; phase: string; offset: number; end?: number }> = []
    const compiled = compile(parser, undefined, { coverage: true })
    expect(compiled.parseWithContext('a', { trackLines: false, _grammarTrace: { write: (event: { id: string; phase: string; offset: number; end?: number }) => artifactEvents.push(event) } } as never)).toMatchObject({ ok: true })
    expect(artifactEvents).toEqual(interpreterTrace.snapshot().events)

    const transformed = transformMacro(ROLLBACK_MACRO_SRC, 'attempt-coverage-macro.ts', new Set(['parseman']), false, false, true)!
    const macroParser = evalMacroModule<(input: string, pos: number, ctx: ParseContext) => unknown>(transformed.code, 'parser')
    const pluginEvents: Array<{ id: string; phase: string; offset: number; end?: number }> = []
    expect(macroParser('a', 0, { trackLines: false, _grammarTrace: { write: (event: { id: string; phase: string; offset: number; end?: number }) => pluginEvents.push(event) } } as never)).toMatchObject({ ok: true })
    expect(pluginEvents).toEqual(interpreterTrace.snapshot().events)
  })
})
