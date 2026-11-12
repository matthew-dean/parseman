/**
 * The runtime refuses a printed factory whose helpers are not its own. Factories take
 * their helpers by position, so one printed against a different `EMITTED_PARAMS`, or
 * against a helper whose parameters have since changed, would otherwise bind the wrong
 * value to a name and run wrong. The runtime reads the ABI the record was printed with
 * (`abi`: the printing minor and its helper count), never `factory.length`, which a
 * minifier lowers; these factories have no guard of their own.
 *
 * 0.62.0 changed `rollbackTriviaAt` and `rollbackScannedTriviaAt` without changing the
 * count. The last block below runs factories 0.61.9 printed, kept as a fixture.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifiedTrivia, literal, node, optional, regex, rules, run, sequence, trivia } from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_ABI, EMITTED_PARAMS, emitAssemblySource, emittedAbi } from '../../src/table/emit-assembly.ts'
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

/**
 * Factories 0.61.9 printed for one grammar (`test/fixtures/printed-factory-0.61.9.json`:
 * the helper list, and each assembly's source, plan and reached sites). The helper count
 * is this runtime's, so only the minor tells the two apart.
 */
describe('a factory 0.61.9 printed, on this runtime', () => {
  const printed = JSON.parse(readFileSync(new URL('../fixtures/printed-factory-0.61.9.json', import.meta.url), 'utf8')) as {
    version: string
    params: string[]
    recs: { key: number; source: string; plan: PrecompiledAssembly['plan']; reached: number[] }[]
  }
  const t = classifiedTrivia({ ws: regex(/[ ]+/), comment: regex(/\/\*[^*]*\*\//) })
  const g = rules({ trivia: t }, () => ({
    Doc: sequence(literal('x'), optional(node('E', optional(literal('z')))), literal('y')),
  })) as Record<string, Parameters<typeof run>[0]>
  const prog = encodeTable(g as never, { hostMode: 'ast' })
  const withPrinted = (stamp: { arity: number } | { abi: string }): TableProgram => ({
    ...prog,
    asm: printed.recs.map(r => ({
      key: r.key,
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      factory: new Function(...printed.params, r.source) as PrecompiledAssembly['factory'],
      plan: r.plan,
      reached: r.reached,
      ...stamp,
    } as PrecompiledAssembly)),
  })
  const opts = { rootTrivia: { select: ['comment'] } }

  it('binds its helpers at the positions this runtime still uses: slots only append', () => {
    expect(printed.version).toBe('0.61.9')
    expect(EMITTED_PARAMS.slice(0, printed.params.length)).toEqual(printed.params)
  })

  it('is refused when stamped with the ABI 0.62.0 had before recordUnlabelledGap was appended', () => {
    expect(EMITTED_ABI).not.toBe('0.62/59')
    expect(() => run(tableRules(withPrinted({ abi: '0.62/59' })).Doc!, 'x/*c*/y', opts))
      .toThrow('was printed for helper ABI 0.62/59')
  })

  it('is refused, as 0.61.9 stamped it', () => {
    expect(() => run(tableRules(withPrinted({ arity: printed.params.length })).Doc!, 'x/*c*/y', opts))
      .toThrow('carries no helper ABI, so it was printed before parseman 0.62.0, whose helpers take other arguments')
  })

  it('records the comment twice when its stamp is forged past the check', () => {
    expect(run(g.Doc!, 'x/*c*/y', opts).rootTrivia?.rows).toEqual(Int32Array.of(1, 6, 1, 6, 0))
    const forged = run(tableRules(withPrinted({ abi: EMITTED_ABI })).Doc!, 'x/*c*/y', opts)
    expect(forged.ok).toBe(true)
    expect(forged.rootTrivia?.rows).toEqual(Int32Array.of(1, 6, 1, 6, 0, 1, 6, 1, 6, 0))
  })
})

/**
 * Within one minor, helpers are only appended: none changes its parameters. A helper whose
 * parameters change needs the next minor, so the printed `abi` refuses factories printed
 * before it. This pins each helper's `length` beside the ABI it was declared under; a
 * change here without a new minor is the misbind 0.61.9's factories show above.
 */
describe('the helpers a printed factory binds', () => {
  it('never include the retired skipTriviaScanned, whose slot is bound to undefined', () => {
    const grammars = [
      rules({ trivia: trivia(regex(/[ \n]+/)) }, () => ({ Entry: node('Pair', sequence(literal('a'), optional(literal('b')))) })),
      rules({ trivia: classifiedTrivia({ ws: regex(/[ \n]+/), c: regex(/\/\*[^*]*\*\//) }) }, () => ({
        Entry: node('Pair', sequence(literal('a'), optional(literal('b')))),
      })),
    ]
    for (const g of grammars) {
      const prog = encodeTable(g)
      for (const options of [STRICT, { hostCst: true, trackLines: true, tolerant: true, coverage: false, probe: true }]) {
        expect(emitAssemblySource(resolveTable(prog), prog, options).source).not.toMatch(/\bskipTriviaScanned\b/)
      }
    }
  })

  it('have the parameter counts declared for this ABI', () => {
    expect(EMITTED_ABI).toBe('0.62/61')
    const prog = encodeTable({ Entry: node('Pair', sequence(literal('a'), literal('b'))) })
    const em = emitAssemblySource(resolveTable(prog), prog, STRICT)
    const real = new Function(...EMITTED_PARAMS, em.source) as (...helpers: unknown[]) => unknown
    let bound: unknown[] = []
    const factory = ((...helpers: unknown[]) => {
      bound = helpers
      return real(...helpers)
    }) as unknown as PrecompiledAssembly['factory']
    const record = { key: 0, abi: EMITTED_ABI, factory, plan: em.plan, reached: [...em.reached] }
    expect(run(tableRules({ ...prog, asm: [record] })['Entry']!, 'ab').ok).toBe(true)
    expect(bound).toHaveLength(EMITTED_PARAMS.length)
    const lengths: Record<string, number> = {}
    EMITTED_PARAMS.forEach((name, i) => {
      const helper = bound[i]
      if (typeof helper === 'function') lengths[name] = helper.length
    })
    expect(lengths).toEqual({
      cstCaptureActive: 1,
      pushCstLeaf: 2,
      pushCstChild: 3,
      rollbackTriviaAt: 7,
      rollbackScannedTriviaAt: 5,
      failAt: 3,
      classHas: 2,
      consumeTrivia: 3,
      buildFieldMap: 1,
      projectChild: 3,
      unwrapChild: 1,
      demoteCapturedToRaw: 2,
      cstLeavesLen: 1,
      recordUnlabelledGap: 3,
      pushCstTriviaEntry: 4,
      needsDeferredTriviaCommit: 1,
      advanceTrivia: 3,
      refuseUnclassifiedRootScope: 1,
      spanLines: 3,
      rawEntry: 4,
      lead: 2,
      asciiFoldKey: 1,
      matchesAt: 4,
      recoverScan: 5,
      orSentinel: 2,
      captureError: 2,
      adjacencyHolds: 5,
      triviaFieldCapture: 7,
      skipDeferredTrivia: 3,
      collapseEmpty: 6,
      popCstChild: 1,
      _SP: 2,
      _LF: 2,
      _ND: 4,
      _FC: 3,
      _BUF: 3,
    })
  })

  it('reads major.minor from a release or a prerelease version', () => {
    expect(emittedAbi('0.62.0', 59)).toBe('0.62/59')
    expect(emittedAbi('0.62.0-alpha.1', 59)).toBe('0.62/59')
    expect(emittedAbi('0.62.10-rc.2', 59)).toBe('0.62/59')
    expect(emittedAbi('1.0.0-beta.3', 7)).toBe('1.0/7')
    expect(() => emittedAbi('next', 59)).toThrow('has no major.minor')
  })
})
