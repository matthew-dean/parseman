/**
 * A VALID DOCUMENT IS CLEAN UNDER `tolerant: true`, on every engine: no errors,
 * `ok`, and the tree a strict parse gives. Recovery only starts once nothing else
 * can read the input, so each grammar here reads a real construct that some list,
 * arm or lookahead must fail on before the document's actual reading succeeds.
 *
 * `compile()` is the emitted assembly here. `table-closure-existing-matrix.test.ts`
 * runs this file again with the emitter off, so the same assertions reach the closure
 * assembly through `compile()` too.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, literal, many, noTrivia, not, optional, peek, regex, rules, run, sepBy, sequence, token, trivia,
} from '../../src/index.ts'
import { run as runTabled } from '../../src/functional/run-tabled.ts'
import { run as runInterpreter } from '../../src/functional/run.ts'
import { compile } from '../../src/table/compile.ts'
import { execRules } from '../../src/table/exec.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { REC } from '../../src/recovery/scan.ts'
import type { Combinator, ParseContext } from '../../src/index.ts'

const ws = trivia(regex(/[ \t\n]+/))
const ident = regex(/[a-z][a-z-]*/)
const num = regex(/[0-9]+/)

type Entry = Combinator<unknown>

function expectClean(entry: Entry, input: string, amb?: Entry): void {
  const grammar = rules(amb === undefined ? {} : { trivia: amb }, () => ({ Entry: entry }))
  const strict = runInterpreter(grammar.Entry, input)
  expect(strict.ok, `strict reads ${input}`).toBe(true)
  const answers = {
    interpreter: runInterpreter(grammar.Entry, input, { tolerant: true }),
    tabled: runTabled(grammar.Entry, input, { tolerant: true }),
    compile: compile(grammar.Entry).parseWithErrors(input),
    rule: run(compile(grammar).Entry!, input, { tolerant: true }),
  }
  for (const [engine, r] of Object.entries(answers)) {
    expect(r.errors, `${engine}: ${input}`).toEqual([])
    expect(r.ok, `${engine}: ${input}`).toBe(true)
    expect(r.ok ? r.value : undefined, `${engine}: ${input}`).toEqual(strict.value)
  }
  const errors: unknown[] = []
  const ctx = { trackLines: false, _errors: errors, _tolerant: true, _rec: REC } as unknown as ParseContext
  const out = execRules(encodeTable(grammar, { recovery: true }))['Entry']!(input, 0, ctx) as { ok: boolean; value?: unknown }
  expect(errors, `exec: ${input}`).toEqual([])
  expect(out.value, `exec: ${input}`).toEqual(strict.value)
}

describe('tolerant: a valid document has no errors and the strict tree', () => {
  it('a list followed only by optional terms ends at what the enclosing sequence reads', () => {
    const value = sequence(num, many(sequence(literal('+'), num)), optional(literal('!')))
    const decl = sequence(literal('a'), value, literal(';'))
    expectClean(decl, 'a1;')
    expectClean(decl, 'a1+2!;')
  })

  it('a declaration arm that fails on a selector leaves the input to the rule arm', () => {
    const decl = sequence(ident, literal(':'), many(ident), literal(';'))
    const rule = sequence(ident, literal(':'), ident, literal('{'), many(decl), literal('}'))
    const sheet = many(choice(decl, rule))
    expectClean(sheet, 'a:hover { color: red; }', ws)
    expectClean(sheet, 'color: red; a:hover { color: blue; }', ws)
  })

  it('a value list inside a comma list ends at the comma and at the terminator', () => {
    const decl = sequence(ident, literal(':'), sepBy(many(ident), literal(',')), literal(';'))
    expectClean(many(decl), 'font: a b, c d;\nmargin: e;', ws)
  })

  it('a list item that can end leaves the next item to the list', () => {
    const call = sequence(ident, many(num))
    expectClean(sequence(many(call), literal(';')), 'a 1 2 b 3;', ws)
  })

  it('an optional prefix that fails leaves the input to what follows it', () => {
    const prelude = sequence(optional(sequence(many(ident), literal('&'))), many(ident), literal('{'), many(ident), literal('&'), literal('}'))
    expectClean(prelude, 'screen { a & }', ws)
    expectClean(prelude, 'screen & print { a & }', ws)
  })

  it('a lookahead fails the way a strict parse does, even when its list could resync later on', () => {
    const body = sequence(ident, many(ident))
    const ahead = sequence(peek(sequence(many(ident), literal('{'))), body, literal('{'), literal('}'))
    const none = sequence(not(sequence(many(ident), literal('{'))), body, literal(';'))
    const stmt = many(choice(ahead, none))
    expectClean(stmt, 'color red; a b { }', ws)
  })

  it('a list in a region with no trivia ends where the outer trivia starts', () => {
    const subclass = sequence(literal('.'), ident)
    const compound = noTrivia(sequence(ident, many(subclass)))
    const selector = sequence(compound, many(compound), literal('{'))
    expectClean(selector, 'a.b c.d {', ws)
    expectClean(selector, 'a {', ws)
  })

  it('a token is one contiguous run: a list inside it does not recover', () => {
    const name = token(sequence(ident, many(sequence(literal('.'), ident))))
    expectClean(sequence(name, name, literal(';')), 'a.b c;', ws)
  })
})

describe('tolerant: real errors in a list are still recovered', () => {
  const decl = sequence(ident, literal(':'), num, literal(';'))
  const grammar = rules({ trivia: ws }, () => ({ Entry: sequence(literal('{'), many(decl), literal('}')) }))

  it('reports the bad entry, and keeps the entries after it', () => {
    const input = '{ a: 1; b: ?; c: 3; }'
    const r = run(grammar.Entry, input, { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]!.span.start).toBe(input.indexOf('b'))
    const compiled = compile(grammar.Entry).parseWithErrors(input)
    expect(compiled.ok).toBe(true)
    expect(compiled.errors).toEqual(r.errors)
  })
})
