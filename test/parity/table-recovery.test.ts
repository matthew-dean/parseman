/**
 * TOLERANT RECOVERY, compared across all FOUR engines, on the two fields the
 * identity sweep does not digest.
 *
 * `bench/table-lowering-identity.ts` hashes `{ ok, value, unconsumedFrom }`.
 * `errors` and `expected` are not in that digest, so every divergence this file
 * exists to catch would pass the sweep: the tree is the same and the diagnostics
 * are gone. The table had NO recovery at all — `run()` routed through it
 * returned `ok: true` with an empty `errors` array on input the other two engines
 * report on — and that is precisely the shape a value digest cannot see.
 *
 * Both table engines are here because they are separate implementations of the
 * same table: `exec.ts` interprets it and `assemble.ts` links it into closures.
 * `exec.ts` is the reference a divergence is bisected against, so a recovery it
 * does not implement makes the reference useless exactly when it is needed.
 */
import { describe, expect, it } from 'vitest'
import { literal, regex, sequence, many, oneOrMore, sepBy, node, rules, trivia, parser, label, classifiedTrivia, dispatch, when } from '../../src/index.ts'
import { run as runInterpreter } from '../../src/functional/run.ts'
import { run as runTabled } from '../../src/functional/run-tabled.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { compileTable } from '../../src/table/compile.ts'
import { compile } from '../../src/compiler/codegen.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
import { REC } from '../../src/recovery/scan.ts'
import type { Combinator, ParseContext } from '../../src/index.ts'

const ident = regex(/[a-z]+/)
const num = regex(/[0-9]+/)
const decl = sequence(ident, literal(':'), num)

/** Every engine's tolerant answer for one grammar and one input. */
function engines(entry: Combinator<unknown>, input: string, amb?: Combinator<unknown>) {
  const opts = amb ? { tolerant: true, trivia: amb } : { tolerant: true }
  const prog = encodeTable({ Entry: entry }, { recovery: true })
  const execCtxErrors: unknown[] = []
  const execCtx = { trackLines: false, _errors: execCtxErrors, _tolerant: true, _rec: REC } as unknown as ParseContext
  const execEntry = tableRules(prog)['Entry']!
  const execResult = execEntry(input, 0, execCtx) as { ok: boolean; value?: unknown }
  const asmErrors: unknown[] = []
  const asmCtx = { trackLines: false, _errors: asmErrors, _tolerant: true, _rec: REC } as unknown as ParseContext
  const asmEntry = assembledRules(prog)['Entry']!
  const asmResult = asmEntry(input, 0, asmCtx) as { ok: boolean; value?: unknown }
  return {
    interpreter: runInterpreter(entry, input, opts),
    tabled: runTabled(entry, input, opts),
    exec: { ok: execResult.ok, value: execResult.ok ? execResult.value : undefined, errors: execCtxErrors },
    assembled: { ok: asmResult.ok, value: asmResult.ok ? asmResult.value : undefined, errors: asmErrors },
  }
}

function assertFourWay(entry: Combinator<unknown>, inputs: string[], amb?: Combinator<unknown>): void {
  for (const input of inputs) {
    const e = engines(entry, input, amb)
    expect(e.tabled.ok, `${input} ok (tabled)`).toBe(e.interpreter.ok)
    expect(e.tabled.value, `${input} value (tabled)`).toEqual(e.interpreter.value)
    // THE FIELDS THE DIGEST DROPS.
    expect(e.tabled.errors, `${input} errors (tabled)`).toEqual(e.interpreter.errors)
    expect(e.tabled.expected, `${input} expected (tabled)`).toEqual(e.interpreter.expected)
    expect(e.exec.ok, `${input} ok (exec)`).toBe(e.interpreter.ok)
    expect(e.exec.value, `${input} value (exec)`).toEqual(e.interpreter.value)
    expect(e.exec.errors, `${input} errors (exec)`).toEqual(e.interpreter.errors)
    expect(e.assembled.errors, `${input} errors (assembled)`).toEqual(e.interpreter.errors)
    expect(e.assembled.value, `${input} value (assembled)`).toEqual(e.interpreter.value)
  }
}

describe('tolerant recovery — four engines agree on errors, not just values', () => {
  it('many: junk in every position', () => {
    assertFourWay(sequence(literal('{'), many(decl), literal('}')) as Combinator<unknown>, [
      '{a:1b:2}', '{a:1$$b:2}', '{a:1$$}', '{$$a:1}', '{a:1}', '{}', '{a:1@@b:2c:3}', '{@@}',
    ])
  })

  it('oneOrMore: a partial element resynced to the inferred terminator', () => {
    assertFourWay(sequence(oneOrMore(decl), literal('%')) as Combinator<unknown>,
      ['a:1b:2%', 'a:1b:%', 'a:1$$b:2%', 'a:1%'])
  })

  it('sepBy: first / middle / last / consecutive junk', () => {
    assertFourWay(sequence(literal('{'), sepBy(decl, literal(';')), literal('}')) as Combinator<unknown>, [
      '{a:1;b:2}', '{a:1;$$;b:2}', '{a:1;$$}', '{$$;a:1}', '{a:1;;b:2}', '{$$}',
      '{a:1;$$;$$;b:2}', '{;a:1}', '{a:1;b:2;$$}',
    ])
  })

  it('ambient trivia: recovery across whitespace', () => {
    const ws = trivia(oneOrMore(regex(/[ \t\n]+/)))
    const g = rules({ trivia: ws }, () => ({
      block: sequence(literal('{'), sepBy(decl, literal(';')), literal('}')),
    }))
    assertFourWay(g.block as Combinator<unknown>,
      ['{ a:1 ; b:2 }', '{ a:1 ; $$ ; b:2 }', '{ a:1 ; $$ }', '{ $$ ; a:1 }', '{ }'],
      ws as Combinator<unknown>)
  })

  it('a strict parse of a RECOVERY table recovers nothing — the lowering is dormant, not armed', () => {
    const block = sequence(literal('{'), sepBy(decl, literal(';')), literal('}')) as Combinator<unknown>
    const strict = runTabled(block, '{a:1;$$;b:2}')
    expect(strict.ok).toBe(false)
    expect(strict.errors).toHaveLength(0)
    expect(strict).toEqual(runInterpreter(block, '{a:1;$$;b:2}'))
  })
})

describe('tolerant recovery — the CST embed, which lives only in the tree', () => {
  const g = rules(self => ({
    Block: node(sequence(literal('{'), sepBy(self.Decl, literal(';')), literal('}'))),
    Decl: node(sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/))),
  }))

  it('the table embeds the same parseError children as the compiled path', () => {
    const compiled = compile(g.Block as Combinator<unknown>, undefined, { recovery: true })
    for (const input of ['{a:1;b:2}', '{a:1;$$;b:2}', '{a:1;$$}', '{$$;a:1}']) {
      const ri = runTabled(g.Block as Combinator<unknown>, input, { tolerant: true, build: cstBuildHost() })
      const errors: unknown[] = []
      const rc = compiled.parseWithContext(input, {
        trackLines: false, _errors: errors, _tolerant: true, _rec: REC, build: cstBuildHost(),
      } as unknown as ParseContext, 0) as { ok: boolean; value: unknown }
      expect(rc.ok, `${input} ok`).toBe(ri.ok)
      expect(rc.value, `${input} tree`).toEqual(ri.value)
      expect(errors, `${input} errors`).toEqual(ri.errors)
    }
  })
})

describe('compileTable().parseWithErrors()', () => {
  const block = sequence(literal('{'), sepBy(decl, literal(';')), literal('}')) as Combinator<unknown>

  it('collects the errors the interpreter collects when built with { recovery: true }', () => {
    const r = compileTable(block, undefined, { recovery: true }).parseWithErrors('{a:1;$$;b:2}')
    const ri = runInterpreter(block, '{a:1;$$;b:2}', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual(ri.errors)
  })

  it('REFUSES rather than reporting a clean parse when the parser was not built to recover', () => {
    const p = compileTable(block, undefined, {})
    expect(() => p.parseWithErrors('{a:1;$$;b:2}')).toThrow(/recovery: true/)
  })
})


/**
 * The other half of a local trivia scope, which the table also had nothing for.
 *
 * Both bits are read by BOTH table engines, and `run()` only ever reaches the
 * assembled one — so the interpreted driver's arm has no coverage at all unless
 * it is driven directly, which is what this does.
 */
describe('table drivers — local trivia scope root-capture policy', () => {
  const outer = classifiedTrivia({
    whitespace: regex(/[ \t\n\r\f]+/),
    blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
  })
  const collapsed = trivia(label('whitespace', regex(/(?:(?:[ \t\n\r\f]+)|(?:\/\*(?:[^*]|\*(?!\/))*\*\/))+/)))
  const message = "parser(): selected root trivia requires classifiedTrivia() for every local trivia scope, or rootCapture: 'opaque'."

  const drive = (entry: Combinator<unknown>, input: string, ctx: Partial<ParseContext>) => {
    const prog = encodeTable({ Entry: entry }, {})
    return {
      exec: () => tableRules(prog)['Entry']!(input, 0, { trackLines: false, ...ctx } as ParseContext),
      assembled: () => assembledRules(prog)['Entry']!(input, 0, { trackLines: false, ...ctx } as ParseContext),
    }
  }

  it('refuses an unclassified local scope under selected root capture, in both drivers', () => {
    const entry = parser({ trivia: outer }, sequence(
      literal('a'),
      parser({ trivia: collapsed }, literal('b')),
    )) as unknown as Combinator<unknown>
    const d = drive(entry, 'a b', { _rootTriviaStrictScopes: true })
    expect(d.exec, 'exec').toThrow(message)
    expect(d.assembled, 'assembled').toThrow(message)
  })

  it('an opaque scope suppresses selected root rows, in both drivers', () => {
    const entry = parser({ trivia: outer }, sequence(
      literal('a'),
      parser({ trivia: outer, rootCapture: 'opaque' }, sequence(literal('b'), literal('c'))),
    )) as unknown as Combinator<unknown>
    for (const which of ['exec', 'assembled'] as const) {
      const rows: number[] = []
      const d = drive(entry, 'a b/* hidden */c', {
        _rootTriviaLog: rows,
        _rootTriviaKindIndex: { blockComment: 0 },
        _rootTriviaStrictScopes: true,
      })
      const r = d[which]() as { ok: boolean }
      expect(r.ok, which).toBe(true)
      expect(rows, which).toEqual([])
    }
  })
})

describe('a COMMITTED failure is never recovered — all three engines', () => {
  it('codegen no longer swallows a cut inside a many() item', () => {
    // `dispatch()` commits: the selector picks an arm, so a failure INSIDE that
    // arm is definitive — the author ruled the input out. Resyncing past it
    // invents a parse.
    //
    // `emitMany`'s STRICT branch has always checked `_fc`; its RECOVERY branch
    // did not. So under `{recovery: true}` the compiled engine swallowed the cut
    // into a resync, the loop exited clean, and the parse SUCCEEDED on input the
    // interpreter rejects — measured before the fix:
    //
    //   interpreter  ok=false end=1
    //   codegen      ok=TRUE  end=0     <- a different language, not a different error
    //
    // The interpreter checks `committed` FIRST (`repeat.ts:158,252`) and the
    // table matches the interpreter, so codegen was the lone outlier. It mattered
    // beyond codegen: the identity sweep compares the TABLE against this engine,
    // so a recovery-plus-cut case in the corpus would have reported the table as
    // wrong.
    const item = dispatch(regex(/[@a-z]/), when('@', sequence(literal('@'), literal('ok'))))
    const g = rules(() => ({ Doc: many(item) })) as Record<string, Combinator<unknown>>
    const input = '@bad'

    const viaInterp = runInterpreter(g.Doc! as never, input, { tolerant: true })
    const viaCodegen = compile(g.Doc! as never, undefined, { recovery: true }).parseWithErrors(input)

    expect(viaInterp.ok, 'interpreter rejects a committed failure').toBe(false)
    expect(viaCodegen.ok, 'codegen must reject it too').toBe(false)
    expect(viaCodegen.span?.end, 'and stop where the interpreter stops').toBe(viaInterp.span.end)
  })
})
