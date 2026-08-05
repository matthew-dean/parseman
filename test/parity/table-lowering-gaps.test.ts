/**
 * TABLE-LOWERING GAPS THE IDENTITY SWEEP CANNOT SEE.
 *
 * `bench/table-lowering-identity.ts` digests `{ ok, value, unconsumedFrom }`.
 * Neither `expected` nor `committed` is in that digest, and a construct the
 * encoder REFUSES never reaches the sweep at all — so every divergence below
 * passed it. They surfaced only when `compile()` was pointed at the table
 * lowering and the existing suites ran against it.
 *
 * Each case compares the interpreter against BOTH table drivers as a WHOLE
 * result: `exec.ts` interprets the program and `assemble.ts` links it into
 * closures, and `exec.ts` is only useful as the bisection reference while it
 * still agrees.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, dispatch, endsWith, expect as expectParser, literal, matches, ref, regex,
  otherwise as otherwiseParser, parser as grammarScope, sequence, startsWith, token, when,
  type Combinator, type ParseContext, type ParseResult,
} from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { reachableOps } from '../../src/table/inspect.ts'

/** The interpreter's answer, and both drivers', for one grammar and one input. */
function engines(entry: Combinator<unknown>, input: string): {
  interpreted: ParseResult<unknown>; exec: ParseResult<unknown>; assembled: ParseResult<unknown>
} {
  const ctx = (): ParseContext => ({ trackLines: false } as ParseContext)
  const prog = encodeTable({ Entry: entry })
  return {
    interpreted: entry.parse(input, 0, ctx()),
    exec: tableRules(prog)['Entry']!(input, 0, ctx()),
    assembled: assembledRules(prog)['Entry']!(input, 0, ctx()),
  }
}

function expectAgreement(entry: Combinator<unknown>, input: string): ParseResult<unknown> {
  const r = engines(entry, input)
  expect(r.exec, `exec table must equal interpreter for ${JSON.stringify(input)}`).toEqual(r.interpreted)
  expect(r.assembled, `assembled table must equal interpreter for ${JSON.stringify(input)}`).toEqual(r.interpreted)
  return r.interpreted
}

describe('table lowering — gaps found by pointing compile() at the table', () => {
  /**
   * THE ONE THAT REJECTED VALID INPUT, which is the most serious shape a
   * divergence can take. Everything else here is a wrong diagnostic.
   */
  it('expect() clears the commit bit when it recovers, so an outer choice still falls through', () => {
    const parser = choice(
      sequence(
        expectParser(dispatch(literal('k'), when('k', literal('x'))), 'dispatch tail'),
        literal('z'),
      ),
      literal('kq'),
    )
    // `dispatch` commits once its selector matches, so the failing tail raises the
    // cut. `expect()` then turns that failure into a zero-width SUCCESS — the cut
    // must not survive it, or the enclosing choice never reaches `literal('kq')`.
    // The interpreter has no bit to clear (commitment rides the result object);
    // both table drivers share `ctx._fc` and had to be told.
    expect(expectAgreement(parser, 'kq')).toEqual({ ok: true, value: 'kq', span: { start: 0, end: 2 } })
  })

  it('carries `committed` on the entry failure envelope', () => {
    // The cut is not merely a diagnostic: a table entry embedded as a CHILD of
    // another parser is the one place `committed` is READ, and dropping it there
    // silently converts a cut into a backtrack.
    const parser = choice(
      dispatch(literal('@media'), when('@media', literal('{')), otherwiseParser(literal(';'))),
      sequence(literal('@media'), literal('x')),
    )
    expect(expectAgreement(parser, '@mediax')).toEqual({
      ok: false,
      expected: ['"{"'],
      span: { start: 6, end: 6 },
      committed: true,
    })
  })

  it('applies `{ caseInsensitive: true }` to MATCHER arms, not only to key arms', () => {
    // The encoder dropped the flag and both drivers rebuilt the matcher with a
    // hardcoded `caseInsensitive: false`, so these arms never claimed their key
    // and the parse fell through to a different branch — a wrong ARM, i.e. a
    // wrong parse, on input the interpreter accepts.
    const head = token(regex(/(?:PRE[A-Za-z]+|fnOPEN\(|--CUSTOM|plain)/))
    const parser = dispatch(
      head,
      when(startsWith('pre'), literal('!'), { caseInsensitive: true }),
      when(endsWith('open('), literal('?'), { caseInsensitive: true }),
      when(matches(/^--custom$/), literal(';'), { caseInsensitive: true }),
    )
    expect(expectAgreement(parser, 'PRElude!')).toMatchObject({ ok: true, value: ['PRElude', '!'] })
    expect(expectAgreement(parser, 'fnOPEN(?')).toMatchObject({ ok: true, value: ['fnOPEN(', '?'] })
    expect(expectAgreement(parser, '--CUSTOM;')).toMatchObject({ ok: true, value: ['--CUSTOM', ';'] })
    // Case-SENSITIVE arms are unchanged by the fold.
    const strict = dispatch(head, when(startsWith('pre'), literal('!')))
    expect(expectAgreement(strict, 'PRElude!').ok).toBe(false)
  })

  it('runs a HAND-WRITTEN combinator live instead of refusing it', () => {
    // `_def: { tag: 'unknown' }` is the public escape for a parser built outside
    // the library. Codegen delegates to its `.parse` at run time
    // (`emitRuntimeFallback`); the encoder threw `UnsupportedConstruct`, so the
    // table lowering rejected a grammar the source lowering compiles.
    const foreign: Combinator<string> = {
      _tag: 'foreign',
      _meta: { firstSet: { kind: 'any' }, canMatchNewline: false, isTrivia: false },
      _def: { tag: 'unknown' },
      parse: (input, pos) => input.startsWith('ab', pos)
        ? { ok: true, value: 'ab', span: { start: pos, end: pos + 2 } }
        : { ok: false, expected: ['foreign'], span: { start: pos, end: pos } },
    }
    const parser = sequence(foreign, literal('!'))
    expect(expectAgreement(parser, 'ab!')).toEqual({ ok: true, value: ['ab', '!'], span: { start: 0, end: 3 } })
    expect(expectAgreement(parser, 'zz!')).toMatchObject({ ok: false, expected: ['foreign'] })

    // The cost is STATED: a live combinator is not data, so the program runs and
    // refuses to PRINT — the same degradation codegen makes when `runtimeParsers`
    // is non-empty and `inlineExpression` goes null.
    const prog = encodeTable({ Entry: parser })
    expect(prog.runtimeOnly?.join(' ')).toMatch(/hand-written combinator/)
    // The reachability walk must know the opcode: it throws on an unknown one,
    // and three separate lanes have shipped an opcode without reaching it.
    expect(() => reachableOps(prog)).not.toThrow()
  })

  it('line-annotates the ENTRY result span when the table tracks lines', () => {
    // Codegen annotates the root result — success span and failure span both —
    // the moment `ctx.lineTracking` is on, and so does the interpreter's
    // `parser({ trackLines: true })` scope. The table's shared envelope built a
    // bare `{ start, end }` regardless, so a tracked table parse paid for the
    // tracking and handed back a span with no line fields at all.
    const g = grammarScope({ trackLines: true }, sequence(literal('foo'), literal('\n'), literal('bar')))
    const r = expectAgreement(g as Combinator<unknown>, 'foo\nbar')
    expect(r.ok).toBe(true)
    expect(r.span).toMatchObject({ startLine: 1, startColumn: 1, endLine: 2, endColumn: 4 })

    const bad = expectAgreement(g as Combinator<unknown>, 'foo\nbaz')
    expect(bad.ok).toBe(false)
    expect(bad.span).toMatchObject({ startLine: 2, endLine: 2 })
  })

  it('defers an undefined ref() to its own .parse instead of throwing at build time', () => {
    // `ref<T>()` throws from its thunk until `.define()` runs. Codegen catches
    // exactly that and falls back to running the ref live (`emitLazy`), so a
    // grammar assembled before every slot is filled still COMPILES. The encoder
    // threw, which is a build failure for a grammar codegen accepts.
    const slot = ref<string>()
    expect(() => encodeTable({ Entry: sequence(slot, slot) })).not.toThrow()
    const prog = encodeTable({ Entry: sequence(slot, slot) })
    expect(prog.runtimeOnly?.join(' ')).toMatch(/ref\(\) used before \.define\(\)/)
    // Deferred, not swallowed: parsing THROUGH the empty slot still throws, and
    // it throws the ref's own message, exactly as the compiled fallback does.
    expect(() => assembledRules(prog)['Entry']!('ab', 0, { trackLines: false } as ParseContext))
      .toThrow(/used before \.define\(\)/)
    // Once defined, the same slot lowers normally.
    slot.define(literal('a') as Combinator<string>)
    expect(expectAgreement(sequence(slot, slot), 'aa'))
      .toEqual({ ok: true, value: ['a', 'a'], span: { start: 0, end: 2 } })
  })
})
