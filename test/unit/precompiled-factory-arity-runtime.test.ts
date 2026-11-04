/**
 * The runtime refuses a printed factory whose helper list is not its own. Factories take
 * their helpers by position, so one printed against a different `EMITTED_PARAMS` would
 * otherwise bind the wrong helper to a name and run wrong. The runtime reads the helper
 * count the record was printed with (`arity`), never `factory.length`, which a minifier
 * lowers; these factories have no guard of their own.
 */
import { describe, expect, it } from 'vitest'
import { literal, node, run, sequence } from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'

const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

/** 0.59.0's list: the current one with the four names it removed back in their places,
 * and without `GAP`, which 0.60.0 appended. */
function list059(): string[] {
  const out: string[] = []
  for (const name of EMITTED_PARAMS) {
    if (name === 'GAP') continue
    if (name === 'advanceTrivia') out.push('scanTrivia')
    out.push(name)
    if (name === 'TRIVIA') out.push('TRIVIALABELS')
    if (name === 'RECOG') out.push('commitTriviaScan', 'scanTriviaCompact')
  }
  return out
}

/** A precompiled record as a build prints it: `arity` is the printing parseman's helper
 * count, `null` for a record printed before 0.60.0, which carried none. */
function withFactory(prog: TableProgram, params: readonly string[], arity: number | null = params.length): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const factory = new Function(...params, emitted.source) as PrecompiledAssembly['factory']
  const record = { key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }
  return { ...prog, asm: [arity === null ? record : { ...record, arity }] }
}

describe('a precompiled factory printed against another helper list', () => {
  const prog = encodeTable({ Entry: node('Pair', sequence(literal('a'), literal('b'))) })
  const parse = (p: TableProgram) => run(tableRules(p)['Entry']!, 'ab')

  it('runs when its parameters are this runtime\'s list', () => {
    expect(parse(withFactory(prog, EMITTED_PARAMS)).ok).toBe(true)
  })

  it('runs when a minifier dropped unused trailing parameters: the runtime reads the printed arity, not factory.length', () => {
    const used = EMITTED_PARAMS.slice(0, EMITTED_PARAMS.length - 1)
    const p = withFactory(prog, used, EMITTED_PARAMS.length)
    expect(p.asm![0]!.factory.length).toBeLessThan(EMITTED_PARAMS.length)
    expect(parse(p).ok).toBe(true)
  })

  it('is refused when the record carries no arity, as one printed before 0.60.0', () => {
    expect(() => parse(withFactory(prog, EMITTED_PARAMS, null)))
      .toThrow('carries no helper count, so it was printed before parseman 0.60.0')
  })

  it.each([
    ['0.59.0, with four more helpers and no GAP', list059()],
    ['an older list, without the constructor helpers', EMITTED_PARAMS.filter(n => !n.startsWith('_'))],
  ])('is refused, naming both counts, when its arity is another list\'s: %s', (_, params) => {
    expect(params.length).not.toBe(EMITTED_PARAMS.length)
    expect(() => parse(withFactory(prog, params))).toThrow(
      `takes ${params.length} helpers, but parseman`,
    )
    expect(() => parse(withFactory(prog, params))).toThrow('printed by an older or newer parseman')
  })
})
