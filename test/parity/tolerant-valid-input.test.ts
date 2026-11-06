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
import { describe, expect, it, vi } from 'vitest'
import {
  choice, cstBuildHost, dispatch, gate, transform, literal, many, node, noTrivia, not, oneOrMore, optional, peek, regex, rules, run, sepBy, sequence, token, trivia, when, withCtx,
} from '../../src/index.ts'
import { parseDoc, type ParseDoc } from '../../src/functional/doc.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { closureArtifact } from '../../src/table/program.ts'
import { run as runTabled } from '../../src/functional/run-tabled.ts'
import { run as runInterpreter } from '../../src/functional/run.ts'
import { compile } from '../../src/table/compile.ts'
import { execRules } from '../../src/table/exec.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { REC } from '../../src/recovery/scan.ts'
import { createParseContext } from '../../src/parse-context.ts'
import type { Combinator, ParseContext } from '../../src/index.ts'

const ws = trivia(regex(/[ \t\n]+/))
const ident = regex(/[a-z][a-z-]*/)
const num = regex(/[0-9]+/)

type Entry = Combinator<unknown>

function expectClean(entry: Entry, input: string, amb?: Entry): void {
  const grammar = rules(amb === undefined ? {} : { trivia: amb }, () => ({ Entry: entry }))
  const strict = runInterpreter(grammar.Entry, input)
  expect(strict.ok, `strict reads ${input}`).toBe(true)
  const reads = vi.spyOn(REC, 'furthest').mockClear()
  const answers = {
    interpreter: runInterpreter(grammar.Entry, input, { tolerant: true }),
    tabled: runTabled(grammar.Entry, input, { tolerant: true }),
    compile: compile(grammar.Entry).parseWithErrors(input),
    rule: run(compile(grammar).Entry!, input, { tolerant: true }),
    emitted: runInterpreter(tableRules(encodeTable(grammar as never, { recovery: true }))['Entry']!, input, { tolerant: true }),
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
  expect(reads, `a valid document reads no arm again: ${input}`).not.toHaveBeenCalled()
  reads.mockRestore()
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

/** Every engine, under recovery, as `{ ok, errors, unconsumedFrom, value }`. */
function allEngines(grammar: { Entry: Entry }, input: string, build?: ParseContext['build']): Record<string, unknown> {
  const opts = build === undefined ? { tolerant: true } : { tolerant: true, build }
  const enc = encodeTable(grammar as never, { recovery: true, ...(build === undefined ? {} : { hostMode: 'cst' as const }) })
  const read = (r: { ok: boolean; errors: readonly { span: { start: number; end: number } }[]; unconsumedFrom: number | null; value?: unknown }) => ({
    ok: r.ok,
    errors: r.errors.map(e => [e.span.start, e.span.end]),
    unconsumedFrom: r.unconsumedFrom,
    value: r.ok ? r.value : undefined,
  })
  return {
    interpreter: read(runInterpreter(grammar.Entry, input, opts)),
    closure: read(runInterpreter(tableRules(closureArtifact(enc))['Entry']!, input, opts)),
    emitted: read(runInterpreter(tableRules(enc)['Entry']!, input, opts)),
    reference: read(runInterpreter(execRules(enc)['Entry']!, input, opts)),
  }
}

/** Every engine gives the same answer, which is returned. */
function agreed(entry: Entry, input: string, amb?: Entry): { ok: boolean; errors: number[][]; unconsumedFrom: number | null; value?: unknown } {
  const grammar = rules(amb === undefined ? {} : { trivia: amb }, () => ({ Entry: entry }))
  const { interpreter, ...rest } = allEngines(grammar, input)
  for (const [engine, answer] of Object.entries(rest)) expect(answer, `${engine}: ${input}`).toEqual(interpreter)
  return interpreter as { ok: boolean; errors: number[][]; unconsumedFrom: number | null; value?: unknown }
}

describe('tolerant: positions and trivia on a valid document', () => {
  it('the tree is the strict one, node for node', () => {
    const grammar = rules({ trivia: ws }, self => ({
      Decl: node('Decl', sequence(ident, literal(':'), many(ident), literal(';'))),
      Rule: node('Rule', sequence(ident, literal('{'), many(self.Stmt), literal('}'))),
      Stmt: choice(self.Decl, self.Rule),
      Entry: node('Doc', many(self.Stmt)),
    }))
    const input = 'a: b c;\n/**/d {\n  e: f;\n  g { h: i; }\n}\n'.replace('/**/', '')
    const build = cstBuildHost()
    const strict = runInterpreter(grammar.Entry, input, { build })
    expect(strict.ok).toBe(true)
    for (const [engine, answer] of Object.entries(allEngines(grammar, input, build))) {
      expect((answer as { errors: unknown[] }).errors, engine).toEqual([])
      expect((answer as { value: unknown }).value, engine).toEqual(strict.value)
    }
  })
})

describe('tolerant: which constructs are read as a strict parse reads them', () => {
  it('an arm is strict when any later arm could start, not only the next one', () => {
    const list = sequence(ident, many(num), literal(';'))
    expectClean(choice(list, sequence(literal('?'), num), sequence(ident, literal('!'))), 'a!')
  })

  it('a list before a term with no first set ends anywhere, whatever encloses it', () => {
    const inner = sequence(many(ident), gate(() => true), literal(';'))
    expectClean(sequence(literal('{'), inner, literal('}')), '{a b;}', ws)
    // No gate, so the emitted assembly really reads this one.
    const lookahead = sequence(many(ident), not(literal('!')), literal(';'))
    expectClean(sequence(literal('{'), lookahead, literal('}')), '{a b;}', ws)
  })

  it('a list before a term that dispatches ends anywhere, on the emitted assembly too', () => {
    const inner = sequence(many(ident), dispatch(literal(';'), when(';', literal('!'))))
    expectClean(sequence(literal('{'), inner, literal('}')), '{a b;!}', ws)
  })

  it('a list can end at the separator it gives back', () => {
    expectClean(sequence(sepBy(ident, literal(',')), literal(','), num), 'a,1', ws)
  })

  it('an item the list can end at keeps the lists inside it from recovering', () => {
    expectClean(sequence(many(sequence(ident, many(num), literal(';'))), ident, literal('!')), 'a 1; b !', ws)
  })

  it('a list can end before trivia and the separator it gives back', () => {
    expectClean(sequence(sepBy(ident, literal(',')), literal(','), num), 'a ,1', ws)
  })

  it('an item the list can end at keeps a list with items in it from recovering', () => {
    const entry = sequence(many(sequence(ident, many(num), literal(';'))), ident, num, literal('!'), literal(';'))
    expectClean(entry, 'a 1; b 1 !;', ws)
  })

  it('a negative lookahead reads as a strict parse does', () => {
    expectClean(sequence(not(sequence(ident, many(num), literal(';'))), ident, num, literal('!'), literal(';')), 'a 1 !;', ws)
  })

  it('a list with nothing in it can end at the end of the input', () => {
    expectClean(sepBy(sepBy(ident, literal(';')), literal(',')), '', ws)
    expectClean(sequence(ident, sepBy(num, literal(',')), optional(literal('!'))), 'a', ws)
    expectClean(sequence(ident, sepBy(num, literal(',')), optional(literal('!'))), 'a ', ws)
    expectClean(sepBy(sequence(sepBy(num, literal(',')), ident), literal(';')), '', ws)
    expect(agreed(sepBy(ident, literal(',')), 'a,', ws).errors).toEqual([[1, 2]])
  })

  it('a list with nothing in it can end after the leading trivia', () => {
    expectClean(sequence(sepBy(ident, literal(';')), literal('!')), ' !', ws)
  })

  it('what follows a list can start with the list\'s own separator', () => {
    expectClean(sequence(sepBy(ident, literal(';')), optional(literal(';'))), 'a;', ws)
    expectClean(sequence(sepBy(ident, literal(';')), literal(';')), 'a;', ws)
    expectClean(sequence(ident, literal('('), sepBy(num, literal(',')), optional(sequence(literal(','), literal('...'), ident)), literal(')')), 'f(1,...x)', ws)
    expectClean(sequence(literal('('), sepBy(num, literal(',')), optional(sequence(literal(','), ident)), literal(')')), '(1,a)', ws)
  })

  it('at the end of the input no arm reads again', () => {
    const on = (c: Entry) => ({ gate: () => true, combinator: c })
    const arms = choice(on(sequence(ident, literal(':'))), on(sequence(ident, literal('='))))
    expectClean(sequence(ident, optional(arms)), 'a', ws)
    expectClean(sequence(ident, optional(arms)), 'a ', ws)
    expectClean(sepBy(arms, literal(';')), '', ws)
    expectClean(sepBy(arms, literal(';')), ' ', ws)
    // A gate has no first set, so the interpreter can't rule these arms out either.
    const open = gate(() => true)
    expectClean(sequence(ident, optional(choice(sequence(open, ident, literal(':')), sequence(open, ident, literal('='))))), 'a', ws)
  })
})

describe('tolerant: damage where the arms overlap', () => {
  it('an arm that committed keeps its claim when its failure comes from the record', () => {
    const inner = choice(dispatch(literal('b'), when('b', literal('x'))), sequence(literal('b'), literal('!')))
    const entry = many(choice(sequence(ident, inner), sequence(ident, literal('b'), literal('c'), literal('?'))))
    agreed(entry, 'a b c !', ws)
  })

  it('a lookahead reads as a strict parse does, even where its list could resync', () => {
    const lookahead = peek(sequence(ident, many(num), literal(';')))
    const r = agreed(many(sequence(lookahead, ident, num, literal('!'), literal(';'))), 'a 1 !;', ws)
    expect(r.errors).toEqual([[0, 6]])
  })

  const statements = rules({ trivia: ws }, self => ({
    Stmt: choice(sequence(ident, literal('{'), many(self.Stmt), literal('}')), sequence(ident, literal(':'), num, literal(';'))),
    Entry: many(self.Stmt),
  }))

  it('a bad declaration in a nested block stays in the block, and the document is kept', () => {
    const r = agreed(statements.Entry, 'd: 1; a { b: ?; } e: 2;', ws)
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBeNull()
    expect(r.errors).toEqual([[10, 16]])
    expect(JSON.stringify(r.value)).toContain('"e"')
  })

  it('the arm that read the furthest is the one that recovers', () => {
    const value = sequence(ident, literal(':'), many(ident), literal(';'))
    const rule = sequence(ident, literal(':'), ident, literal('{'), many(value), literal('}'))
    const grammar = rules({ trivia: ws }, () => ({ Entry: many(choice(value, rule)) }))
    const r = agreed(grammar.Entry, 'a:b { c: ?; } d: e;', ws)
    expect(r.errors).toEqual([[9, 10]])
    expect(r.unconsumedFrom).toBeNull()
    expect(JSON.stringify(r.value)).toContain('"d"')
  })

  it('how far an arm read looks through a nested choice', () => {
    const grammar = rules({ trivia: ws }, self => ({
      Block: choice(
        sequence(ident, literal('{'), many(self.Stmt), literal('}')),
        sequence(ident, literal('['), many(self.Stmt), literal(']')),
      ),
      Decl: sequence(ident, literal(':'), num, literal(';')),
      Stmt: choice(self.Decl, self.Block),
      Entry: many(self.Stmt),
    }))
    const r = agreed(grammar.Entry, 'a { b; } c: 1;', ws)
    expect(r.errors).toEqual([[4, 7]])
    expect(r.unconsumedFrom).toBeNull()
    expect(JSON.stringify(r.value)).toContain('"c"')
  })

  it('how far an arm read looks through a list that stopped', () => {
    const decl = sequence(ident, literal(':'), num, literal(';'))
    const block = sequence(ident, literal('{'), many(decl), literal('}'))
    const value = sequence(ident, literal('{'), ident, literal('!'))
    const r = agreed(many(choice(value, block)), 'a { b: ?; } c { d: 1; }', ws)
    expect(r.errors).toEqual([[4, 10]])
    expect(r.unconsumedFrom).toBeNull()
  })

  it('on a tie the first arm recovers', () => {
    const semi = sequence(ident, literal(':'), many(ident), literal(';'))
    const bang = sequence(ident, literal(':'), many(ident), literal('!'))
    expect(agreed(many(choice(semi, bang)), 'a: ? b; c: d;', ws).errors).toEqual([[3, 6]])
    expect(agreed(many(choice(bang, semi)), 'a: ? b! c: d!', ws).errors).toEqual([[3, 6]])
  })

  it('how far an arm read counts a choice nothing could start', () => {
    const decl = sequence(ident, choice(literal(':'), literal('=')), num, literal(';'))
    const block = sequence(ident, literal('{'), many(decl), literal('}'))
    const short = sequence(ident, literal('{'), ident, literal('!'))
    expect(agreed(many(choice(block, short)), 'a { b ? }', ws).errors).toEqual([[4, 8]])
  })

  it('how far an arm read does not count what a lookahead looked at', () => {
    const looks = sequence(not(sequence(ident, ident, ident, literal('!'))), ident, many(num), literal(';'))
    const reads = sequence(ident, many(ident), literal(';'))
    expect(agreed(many(choice(looks, reads)), 'a b ? ;', ws).errors).toEqual([[4, 6]])
  })

  it('a failure met again says how far it read', () => {
    const block = choice(
      sequence(ident, literal('{'), many(sequence(ident, literal(':'), num, literal(';'))), literal('}')),
      sequence(ident, literal('['), literal(']')),
    )
    const statement = choice(sequence(ident, literal('=')), sequence(block, literal(';')))
    const r = agreed(many(choice(sequence(statement, literal('!')), sequence(statement, literal('?')))), 'a { b: ?; };!', ws)
    expect(r.errors).toEqual([[4, 10]])
    expect(r.unconsumedFrom).toBeNull()
  })

  it('an arm read to measure it leaves nothing in the tree', () => {
    const grammar = rules({ trivia: ws }, self => ({
      Stmt: choice(
        sequence(ident, literal(':'), num, literal(';')),
        sequence(ident, literal('{'), many(self.Stmt), literal('}')),
      ),
      Entry: node('Doc', many(self.Stmt)),
    }))
    const starts = (n: unknown, out: number[] = []): number[] => {
      const { _tag, span, children } = n as { _tag: string; span: { start: number }; children?: unknown[] }
      if (_tag !== 'node') out.push(span.start)
      for (const c of children ?? []) starts(c, out)
      return out
    }
    for (const [engine, answer] of Object.entries(allEngines(grammar, 'a { b: ?; } c: 1;', cstBuildHost()))) {
      expect(starts((answer as { value: unknown }).value), engine).toEqual([0, 2, 4, 10, 12, 13, 15, 16])
    }
  })

  it('a real error after an arm that failed is still recovered', () => {
    const entry = sequence(
      literal('{'),
      many(choice(sequence(ident, literal(':'), num, literal(';')), sequence(ident, literal('='), num, literal(';')))),
      literal('}'),
    )
    const r = agreed(entry, '{a:1; b:?; c=2;}', ws)
    expect(r.errors).toEqual([[6, 15]])
    expect(r.ok).toBe(true)
  })

  it('a gated-off arm does not make the arm beside it overlap', () => {
    const entry = oneOrMore(sequence(ident, choice(
      { gate: () => true, combinator: sepBy(literal('->'), literal(';')) },
      { gate: () => false, combinator: not(num) },
    )))
    const r = agreed(entry, 'foo > ->', ws)
    expect(r.unconsumedFrom).toBeNull()
    expect(r.errors).toEqual([[4, 8]])
  })

  it('a strict read inside a tolerant parse lowers its gates the way the assembly does', () => {
    const N = (c: Entry) => node('N', c)
    const grammar = rules({ trivia: ws }, () => ({
      Entry: choice(N(sequence(optional(ident), N(oneOrMore(literal(':'))))), N(many(not(literal('}'))))),
    }))
    const { interpreter, ...rest } = allEngines(grammar, ' :: ', cstBuildHost())
    for (const [engine, answer] of Object.entries(rest)) expect(answer, engine).toEqual(interpreter)
  })

  it('a gated-off arm does not change the answer', () => {
    const on = sequence(literal('{'), many(sequence(ident, literal(';'))), literal('}'))
    const off = sequence(literal('{'), literal('!'))
    const r = agreed(choice({ gate: () => true, combinator: on }, { gate: () => false, combinator: off }), '{a;?;b;}', ws)
    expect(r.errors).toEqual([[3, 7]])
    expect(r.ok).toBe(true)
  })

  it('the engines agree on a separator of several characters', () => {
    expect(agreed(sequence(sepBy(many(num), literal('->')), literal(';')), '1 -x 2;', ws).ok).toBe(false)
    expect(agreed(sequence(sepBy(many(num), literal('->')), literal(';')), '1 -> 2;', ws).errors).toEqual([])
  })

  it('a lookahead does not recover inside a damaged document', () => {
    const lookahead = peek(sequence(ident, many(num), literal(';')))
    const r = agreed(many(sequence(lookahead, ident, literal(';'))), 'a !; b;', ws)
    expect(r.errors).toEqual([[0, 7]])
  })
})

describe('tolerant: time', () => {
  /** Overlapping arms over a nested region, three per level, counted by a gate in each. */
  function nested(limit: number): { entry: Entry; calls: () => number; reset: () => void } {
    let calls = 0
    const counted = gate(() => {
      if (++calls > limit) throw new Error(`more than ${limit} arm entries`)
      return true
    })
    const grammar = rules({ trivia: ws }, self => ({
      X: choice(
        sequence(counted, literal('('), self.X, literal(')'), literal(';')),
        sequence(counted, literal('('), self.X, literal(')'), literal('!')),
        sequence(counted, literal('('), self.X, literal(')')),
        num,
      ),
      Entry: sequence(literal('{'), many(self.X), literal('}')),
    }))
    return { entry: grammar.Entry, calls: () => calls, reset: () => { calls = 0 } }
  }

  it.each([['unclosed', '('.repeat(40)], ['closed around an error', `${'('.repeat(40)}?${')'.repeat(40)}`]])(
    'failing nested text stays linear: %s',
    (_name, body) => {
      const { entry } = nested(100_000)
      const r = agreed(entry, `{${body}}`, ws)
      expect(r.errors.length).toBeGreaterThan(0)
    },
  )

  it('an arm that committed before failing is worked out once as well', () => {
    let calls = 0
    const counted = gate(() => {
      calls++
      return true
    })
    const grammar = rules({ trivia: ws }, self => ({
      X: choice(
        sequence(counted, dispatch(literal('('), when('(', sequence(self.X, literal(')'))))),
        sequence(counted, literal('('), literal('!')),
        num,
      ),
      Entry: sequence(literal('{'), many(self.X), literal('}')),
    }))
    const enc = encodeTable(grammar as never, { recovery: true })
    const input = `{${'('.repeat(30)}}`
    for (const [engine, entry] of [
      ['interpreter', grammar.Entry],
      ['closure', tableRules(closureArtifact(enc))['Entry']!],
      ['reference', execRules(enc)['Entry']!],
    ] as const) {
      calls = 0
      runInterpreter(entry, input, { tolerant: true })
      expect(calls, engine).toBeLessThan(300)
    }
  })

  it('a state that gates a choice is part of what failed', () => {
    const open = (s: unknown): boolean => (s as { open?: boolean } | undefined)?.open === true
    const x = choice(sequence(gate(open), ident, literal('!')), sequence(gate(open), ident, literal(';')))
    const entry = choice(
      sequence(withCtx(() => ({ open: false }), x), literal('?')),
      withCtx(() => ({ open: true }), x),
    )
    expect(agreed(entry, 'a;', ws)).toMatchObject({ ok: true, errors: [], unconsumedFrom: null })
  })

  it('a trivia scope is part of what failed', () => {
    const x = choice(sequence(ident, literal('!')), sequence(ident, literal(';')))
    expectClean(choice(noTrivia(x), x), 'a ;', ws)
  })

  it('the emitted assembly does not work out a failed choice again', () => {
    // No gates, so `tableRules` really emits this. Three arms a level: 3^40 without the record.
    let reads = 0
    const open = transform(literal('('), v => {
      if (++reads > 100_000) throw new Error('more than 100000 reads of an opener')
      return v
    })
    const grammar = rules({ trivia: ws }, self => ({
      X: choice(
        sequence(open, self.X, literal(')'), literal(';')),
        sequence(open, self.X, literal(')'), literal('!')),
        sequence(open, self.X, literal(')')),
        num,
      ),
      Entry: sequence(literal('{'), many(self.X), literal('}')),
    }))
    const enc = encodeTable(grammar as never, { recovery: true })
    const entry = tableRules(enc)['Entry']!
    runInterpreter(entry, `{${'('.repeat(40)}}`, { tolerant: true })
    expect(reads).toBeGreaterThan(40)
    expect(reads).toBeLessThan(5_000)
  })

  it('a state copied on the way in is the same state', () => {
    const nestedIn: { X?: Entry } = {}
    let calls = 0
    const counted = gate(() => {
      if (++calls > 100_000) throw new Error('more than 100000 arm entries')
      return true
    })
    const grammar = rules({ trivia: ws }, self => {
      nestedIn.X = withCtx((s: unknown) => ({ ...(s as object), depth: 1 }), self.X)
      return {
        X: choice(
          sequence(counted, literal('('), nestedIn.X, literal(';')),
          sequence(counted, literal('('), nestedIn.X, literal('!')),
          num,
        ),
        Entry: sequence(literal('{'), many(self.X), literal('}')),
      }
    })
    expect(agreed(grammar.Entry, `{${'('.repeat(40)}}`, ws).errors.length).toBeGreaterThan(0)
  })
})

describe('tolerant: a parse never stops silently', () => {
  const entry = many(sequence(ident, literal(';')))

  it('what it did not read is an error', () => {
    expect(agreed(entry, 'a; ? b;', ws)).toMatchObject({ ok: true, errors: [[3, 7]], unconsumedFrom: 3 })
    expect(agreed(entry, '?', ws)).toMatchObject({ ok: true, errors: [[0, 1]], unconsumedFrom: 0 })
    expect(agreed(entry, 'a; ', ws)).toMatchObject({ ok: true, errors: [], unconsumedFrom: null })
  })

  it('a strict parse is unchanged', () => {
    const grammar = rules({ trivia: ws }, () => ({ Entry: entry }))
    expect(runInterpreter(grammar.Entry, 'a; ? b;').errors).toEqual([])
  })
})

describe('tolerant: an edit gives what a fresh parse gives', () => {
  const grammar = rules({ trivia: ws }, self => ({
    Decl: node('Decl', sequence(ident, literal(':'), num, literal(';'))),
    Block: node('Block', sequence(literal('{'), many(self.Stmt), literal('}'))),
    Rule: node('Rule', sequence(ident, self.Block)),
    Stmt: choice(self.Rule, self.Decl),
    Entry: node('Doc', many(self.Stmt)),
  }))
  const table = tableRules(closureArtifact(encodeTable(grammar as never, { recovery: true })))
  const build = cstBuildHost()
  const opts = { tolerant: true, structuralReuse: true, build }
  const answer = (doc: ParseDoc<never>) => ({
    tree: doc.tree,
    errors: doc.errors.map(e => [e.span.start, e.span.end]),
    unconsumedFrom: doc.unconsumedFrom,
  })

  it('a list that stops at the item a fresh parse stops at', () => {
    const tailed = rules({ trivia: ws }, self => ({
      Decl: node('Decl', sequence(ident, literal(':'), num, literal(';'))),
      Block: node('Block', sequence(literal('{'), many(self.Decl), literal('}'))),
      Rule: node('Rule', sequence(ident, self.Block)),
      Entry: node('Doc', sequence(many(self.Rule), optional(ident))),
    }))
    const reg = tableRules(closureArtifact(encodeTable(tailed as never, { recovery: true })))
    const input = 'a { b: 1; c: 2; d: 3; }\nd { e: 3; f: 4; g: 5; }\nh { i: 6; j: 7; k: 8; }\n'
    const edited = parseDoc(reg as never, 'Entry', input, opts).edit('a { b'.length - 1, 'a { b'.length - 1, ';')
    const fresh = parseDoc(reg as never, 'Entry', edited.input, opts)
    expect(answer(edited as never)).toEqual(answer(fresh as never))
  })

  it.each([
    ['a character inside a declaration', 'a { b: 1; c: 2; }\nd { e: 3; }\n', 'a { b'.length - 1, 0, ';'],
    ['a stray brace', 'a { b: 1; c: 2; }\nd { e: 3; }\n', 'a { b: 1;'.length, 0, '}'],
    ['an unclosed block', 'a { b: 1; c: 2; }\nd { e: 3; }\n', 'a { b: 1;'.length, 0, '{'],
    ['a deleted colon', 'a { b: 1; c: 2; }\n', 'a { b'.length, 1, ''],
    ['what stops the parse', 'a { b: 1; }\nd { e: 3; }\n', 'a { b: 1; }\n'.length, 0, '?'],
  ])('%s', (_name, input, from, removed, inserted) => {
    const before = parseDoc(table as never, 'Entry', input, opts)
    expect(before.unconsumedFrom).toBeNull()
    const edited = before.edit(from, from + removed, inserted)
    const fresh = parseDoc(table as never, 'Entry', edited.input, opts)
    expect(answer(edited as never)).toEqual(answer(fresh as never))
  })

  it('an edit before where the parse stopped still reports what it did not read', () => {
    const input = 'a { b: 1; }\n?\nd { e: 3; }\n'
    const before = parseDoc(table as never, 'Entry', input, opts)
    expect(before.unconsumedFrom).toBe(12)
    const edited = before.edit('a { b: '.length, 'a { b: 1'.length, '2')
    expect(edited.errors.map(e => [e.span.start, e.span.end])).toEqual([[12, input.length]])
    expect(answer(edited as never)).toEqual(answer(parseDoc(table as never, 'Entry', edited.input, opts) as never))
  })
})

describe('tolerant: what stays out of a strict parse', () => {
  const arms = (): Entry => choice(sequence(ident, literal('!')), sequence(regex(/[a-z]/), literal('?')))

  it('records no failed choice', () => {
    const grammar = rules(() => ({ Entry: sequence(arms(), literal(';')) }))
    const enc = encodeTable(grammar, { recovery: true })
    const legs: Record<string, (ctx: ParseContext) => unknown> = {
      interpreter: ctx => grammar.Entry.parse('a#', 0, ctx),
      closure: ctx => tableRules(closureArtifact(enc)).Entry!('a#', 0, ctx),
      emitted: ctx => tableRules(enc).Entry!('a#', 0, ctx),
      reference: ctx => execRules(enc).Entry!('a#', 0, ctx),
    }
    for (const [engine, parse] of Object.entries(legs)) {
      const ctx = createParseContext()
      parse(ctx)
      expect(ctx._failed, engine).toBeUndefined()
    }
  })

  it('leaves a compiled parser working on a tolerant context with no helpers in it', () => {
    const parser = compile(sequence(arms(), many(ident), literal(';')))
    const ctx = { ...createParseContext(), _tolerant: true as const, _errors: [] }
    const r = parser.parseWithContext('a?b;', ctx)
    expect(r.ok).toBe(true)
    expect(ctx._errors).toEqual([])
  })
})
