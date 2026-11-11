/**
 * The runtime refuses a printed factory whose helpers are not its own. Factories take
 * their helpers by position, so one printed against a different `EMITTED_PARAMS`, or
 * against a helper whose parameters have since changed, would otherwise bind the wrong
 * value to a name and run wrong. The runtime reads the ABI the record was printed with
 * (`abi`: the printing minor and its helper count), never `factory.length`, which a
 * minifier lowers; these factories have no guard of their own.
 *
 * 0.62.0 changed `rollbackTriviaAt` and `rollbackScannedTriviaAt` without changing the
 * count. A factory 0.61.9 printed for `sequence(literal('x'), optional(node('E',
 * optional(literal('z')))), literal('y'))`, run on 0.62.0 past this check, records the
 * root trivia row for `x/*c*\/y` twice and reports success.
 */
import { describe, expect, it } from 'vitest'
import { literal, node, run, sequence } from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_ABI, EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
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

const MINOR = EMITTED_ABI.slice(0, EMITTED_ABI.indexOf('/'))

/** A precompiled record as a build prints it. `abi` is the printing parseman's minor and
 * helper count; a record printed before 0.62.0 carries `arity` (the count) instead, and one
 * printed before 0.60.0 carries neither. */
function withFactory(
  prog: TableProgram,
  params: readonly string[],
  stamp: { abi: string } | { arity: number } | null = { abi: `${MINOR}/${params.length}` },
): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const factory = new Function(...params, emitted.source) as PrecompiledAssembly['factory']
  const record = { key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }
  return { ...prog, asm: [{ ...record, ...stamp } as PrecompiledAssembly] }
}

describe('a precompiled factory printed against another helper list', () => {
  const prog = encodeTable({ Entry: node('Pair', sequence(literal('a'), literal('b'))) })
  const parse = (p: TableProgram) => run(tableRules(p)['Entry']!, 'ab')

  it('runs when its parameters are this runtime\'s list', () => {
    expect(parse(withFactory(prog, EMITTED_PARAMS)).ok).toBe(true)
  })

  it('runs when a minifier dropped unused trailing parameters: the runtime reads the printed abi, not factory.length', () => {
    const used = EMITTED_PARAMS.slice(0, EMITTED_PARAMS.length - 1)
    const p = withFactory(prog, used, { abi: EMITTED_ABI })
    expect(p.asm![0]!.factory.length).toBeLessThan(EMITTED_PARAMS.length)
    expect(parse(p).ok).toBe(true)
  })

  it.each([
    ['carries only the helper count, as one printed by 0.60.0 to 0.61.x', { arity: EMITTED_PARAMS.length }],
    ['carries nothing, as one printed before 0.60.0', null],
  ])('is refused when the record %s, though the count matches', (_, stamp) => {
    expect(() => parse(withFactory(prog, EMITTED_PARAMS, stamp)))
      .toThrow('carries no helper ABI, so it was printed before parseman 0.62.0, whose helpers take other arguments')
  })

  it('is refused when another minor printed it with the same helper count', () => {
    const abi = `0.61/${EMITTED_PARAMS.length}`
    expect(abi).not.toBe(EMITTED_ABI)
    expect(() => parse(withFactory(prog, EMITTED_PARAMS, { abi })))
      .toThrow(`was printed for helper ABI ${abi} (parseman minor / helper count), but parseman`)
  })

  it.each([
    ['0.59.0, with four more helpers and no GAP', list059()],
    ['an older list, without the constructor helpers', EMITTED_PARAMS.filter(n => !n.startsWith('_'))],
  ])('is refused, naming both ABIs, when it was printed against another list: %s', (_, params) => {
    expect(params.length).not.toBe(EMITTED_PARAMS.length)
    expect(() => parse(withFactory(prog, params))).toThrow(
      `was printed for helper ABI ${MINOR}/${params.length} (parseman minor / helper count), but parseman`,
    )
    expect(() => parse(withFactory(prog, params))).toThrow(`binds ${EMITTED_ABI}`)
  })
})
