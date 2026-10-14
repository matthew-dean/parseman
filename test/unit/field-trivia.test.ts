import { describe, expect, it } from 'vitest'
import {
  classifiedTrivia, cstBuildHost, field, literal, node, oneOrMore, oneOrMoreSep, regex, rules, sepBy, sequence, trivia,
  type Combinator, type FieldCapture, type FieldMap,
} from '../../src/index.ts'
// The interpreter's own driver: `run` from the package root lowers a combinator to a
// table first, which would make the interpreter leg a second table leg.
import { run } from '../../src/functional/run.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { serializeCombinator } from '../../src/compiler/ir-serialize.ts'
import { evalCombinatorIR } from '../../src/plugin/ir-eval.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'
import { assertEnginesAgreeAll } from '../parity/helpers/engine-parity.ts'

/**
 * `field(…, { leadingTrivia, trailingTrivia })`: a separator's capture carries the
 * comments written either side of it, which no term owns. Every engine must hand a
 * builder the same captures, so each case runs the interpreter, the reference
 * table driver, the closure assembly and the emitted assembly.
 */
type Entry = Parameters<typeof run>[0]
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

const triviaTable = () => classifiedTrivia({
  whitespace: regex(/[ \t\n\r\f]+/),
  comment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
})
const word = () => regex(/[a-z]+/)

const listOf = (sep: Combinator<unknown>) => rules({ trivia: triviaTable() }, () => ({
  Entry: node('List', oneOrMoreSep(word(), sep), (children, fields) => ({ children, fields })),
}))
const commaWithTrivia = () => field('sep', literal(','), { leadingTrivia: true, trailingTrivia: true })

function precompiled(prog: TableProgram): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const factory = new Function(...EMITTED_PARAMS, `'use strict';\n${emitted.source}`) as PrecompiledAssembly['factory']
  return { ...prog, asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }] }
}

function engines(entry: Combinator<unknown>): Record<string, Entry> {
  const prog = encodeTable({ Entry: entry })
  return {
    interpreter: entry as Entry,
    reference: execRules(prog).Entry! as Entry,
    closure: tableRules({ ...prog, asm: [] }).Entry! as Entry,
    emitted: tableRules(precompiled(prog)).Entry! as Entry,
  }
}

function expectIdentity(entry: Combinator<unknown>, inputs: readonly string[]): void {
  const made = engines(entry)
  for (const input of inputs) {
    const want = run(made.interpreter!, input)
    for (const [name, e] of Object.entries(made)) {
      expect(run(e, input), `${name}: ${JSON.stringify(input)}`).toEqual(want)
    }
  }
}

const captures = (fields: FieldMap | undefined, name: string): FieldCapture[] => {
  const f = fields?.[name]
  return f === undefined ? [] : Array.isArray(f) ? f : [f]
}

describe('field(…, { leadingTrivia, trailingTrivia })', () => {
  it('hands a separator the trivia on both sides of it', () => {
    const r = run(listOf(commaWithTrivia()).Entry!, 'a /* x */ , /* y */ b,c')
    expect(r.ok).toBe(true)
    const { fields } = r.value as { fields: FieldMap }
    expect(captures(fields, 'sep').map(c => [c.leading, c.value, c.trailing, c.span])).toEqual([
      [' /* x */ ', ',', ' /* y */ ', { start: 10, end: 11 }],
      ['', ',', '', { start: 21, end: 22 }],
    ])
  })

  it('records leading trivia for a sequence term after the first, and not for the first', () => {
    const g = rules({ trivia: triviaTable() }, () => ({
      Entry: node('Pair', sequence(
        field('key', word(), { leadingTrivia: true }),
        field('eq', literal('='), { leadingTrivia: true }),
        word(),
      ), (_children, fields) => fields),
    }))
    const r = run(g.Entry!, 'x /*c*/ = y')
    expect(r.ok).toBe(true)
    const fields = r.value as FieldMap
    expect(captures(fields, 'key')[0]!.leading).toBe('')
    expect(captures(fields, 'eq')[0]!.leading).toBe(' /*c*/ ')
  })

  it('records nothing for a wrapped field, which no boundary hands a cursor', () => {
    const g = rules({ trivia: triviaTable() }, () => ({
      Entry: node('Pair', sequence(word(), sequence(field('eq', literal('='), { leadingTrivia: true })), word()),
        (_children, fields) => fields),
    }))
    const r = run(g.Entry!, 'x /*c*/ = y')
    expect(r.ok).toBe(true)
    expect(captures(r.value as FieldMap, 'eq')[0]!.leading).toBe('')
  })

  it('leaves a plain field\'s capture as it was', () => {
    const r = run(listOf(field('sep', literal(','))).Entry!, 'a , b')
    expect(r.ok).toBe(true)
    expect(captures((r.value as { fields: FieldMap }).fields, 'sep')).toEqual([{ value: ',', span: { start: 2, end: 3 } }])
  })

  it('rolls a trailing separator back with its trivia when no item follows', () => {
    const g = listOf(commaWithTrivia())
    const r = run(g.Entry!, 'a , /* z */ ')
    expect(r.unconsumedFrom).toBe(2)
    expect(r.span).toEqual({ start: 0, end: 2 })
    expect((r.value as { fields?: FieldMap }).fields).toBeUndefined()
  })

  const inputs = ['a', 'a,b', 'a /* x */ , /* y */ b , c', 'a ,', 'a , /* z */ ', ' a', '']

  it('matches the interpreter in every engine, list and sequence', () => {
    expectIdentity(listOf(commaWithTrivia()).Entry!, inputs)
    expectIdentity(listOf(field('sep', literal(','), { leadingTrivia: true })).Entry!, inputs)
    expectIdentity(listOf(field('sep', literal(','), { trailingTrivia: true })).Entry!, inputs)
    const sepByGrammar = rules({ trivia: triviaTable() }, () => ({
      Entry: node('List', sepBy(word(), commaWithTrivia(), { trailing: 'allow' }), (children, fields) => ({ children, fields })),
    }))
    // Not a trailing separator: there the interpreter keeps the kept separator's
    // field and the table engines drop it, for a plain field too, as of 0.53.0.
    expectIdentity(sepByGrammar.Entry!, inputs.filter(input => !/,(?:\s|\/\*[^*]*\*\/)*$/.test(input)))
    const pair = rules({ trivia: triviaTable() }, () => ({
      Entry: node('Pair', sequence(word(), field('eq', literal('='), { leadingTrivia: true, trailingTrivia: true }), word()),
        (children, fields) => ({ children, fields })),
    }))
    expectIdentity(pair.Entry!, ['x=y', 'x /*c*/ = /*d*/ y', 'x =', 'x'])
  })

  it('hands the cursor over after the scan, so a field inside the trivia grammar cannot take it', () => {
    const tr = trivia(oneOrMore(field('ignored', regex(/\s+/), { leadingTrivia: true })))
    const g = rules({ trivia: tr }, () => ({
      Entry: node('Pair', sequence(literal('a'), field('b', literal('b'), { leadingTrivia: true })), (_children, fields) => fields),
    }))
    expect(captures(run(g.Entry!, 'a b').value as FieldMap, 'b')[0]!.leading).toBe(' ')
    expectIdentity(g.Entry!, ['a b', 'ab', 'a  b'])
  })

  it('matches the interpreter on the compiled path, including the capture sinks', () => {
    assertEnginesAgreeAll(listOf(commaWithTrivia()).Entry!, inputs, { trivia: triviaTable() })
  })

  it('hands a CST host the same field map from the interpreter and a CST table', () => {
    const g = listOf(commaWithTrivia())
    const table = tableRules({ ...encodeTable({ Entry: g.Entry! }, { hostMode: 'cst' }), asm: [] }).Entry! as Entry
    const fieldsSeen = (entry: Entry, input: string): unknown[] => {
      const seen: unknown[] = []
      const host = Object.assign(
        (...args: Parameters<typeof cstBuildHost>) => { seen.push(args[2]); return cstBuildHost(...args) },
        { _parsemanCstOutput: true as const },
      )
      expect(run(entry, input, { build: host }).ok).toBe(true)
      return seen
    }
    const input = 'a /* x */ , /* y */ b'
    const viaTable = fieldsSeen(table, input)
    expect(viaTable).toEqual(fieldsSeen(g.Entry as Entry, input))
    expect(JSON.stringify(viaTable)).toContain('" /* x */ "')
  })

  it('survives an IR round trip and the macro', () => {
    const src = serializeCombinator(commaWithTrivia())
    expect(src).toContain('leadingTrivia: true, trailingTrivia: true')
    expect(evalCombinatorIR(src!)!._def).toMatchObject({ tag: 'field', name: 'sep', leadingTrivia: true, trailingTrivia: true })

    const lowered = transformMacro(`
import { classifiedTrivia, field, literal, node, oneOrMoreSep, regex, rules } from 'parseman' with { type: 'macro' }
export const g = rules({ trivia: classifiedTrivia({ whitespace: regex(/[ \\t\\n\\r\\f]+/), comment: regex(/\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\//) }) }, g => {
  const Entry = node('List', oneOrMoreSep(regex(/[a-z]+/), field('sep', literal(','), { leadingTrivia: true, trailingTrivia: true })), (children, fields) => ({ children, fields }))
  return { Entry }
})
`.trim(), 'field-trivia.ts', new Set(['parseman']))!
    expect(lowered.warnings).toEqual([])
    const entry = evalMacroModule<Record<string, Entry>>(lowered.code, 'g').Entry!
    expect(run(entry, 'a /* x */ , /* y */ b')).toEqual(run(listOf(commaWithTrivia()).Entry!, 'a /* x */ , /* y */ b'))
  })
})
