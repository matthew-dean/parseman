import { describe, expect, it } from 'vitest'
import {
  attempt, choice, dispatch, literal, matches, optional, regex, run, sequence,
  routed, token, transform, when, type Combinator,
} from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE, OP_DISPATCH, OP_XFORM } from '../../src/table/ops.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'

type Entry = Parameters<typeof run>[0]
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

function outcome(entry: Entry, input: string) {
  const result = run(entry, input)
  return {
    ok: result.ok,
    value: result.value,
    span: result.span,
    expected: result.expected,
    unconsumedFrom: result.unconsumedFrom,
  }
}

function precompiled(prog: TableProgram): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const factory = new Function(
    ...EMITTED_PARAMS, `'use strict';\n${emitted.source}`,
  ) as PrecompiledAssembly['factory']
  return { ...prog, asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }] }
}

function countedPrecompiled(
  prog: TableProgram,
  counter: { n: number },
  plantDuplicateScan = false,
): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  let source = emitted.source.replace(
    /const (_lex\d+)=LEX\[(\d+)\]/g,
    'const $1=((r)=>(input,pos)=>{COUNT_LEX.n++;return r(input,pos)})(LEX[$2])',
  )
  if (plantDuplicateScan) {
    const recognizer = source.match(/function _td\d+_\(input,pos\)\{\nconst r=(_lex\d+)\(input,pos\)/)?.[1]
    if (recognizer === undefined) throw new Error('missing token-decision recognizer')
    source = source.replace('const tr=_pfTokPacked', `const tr=_pfTokPacked\n${recognizer}(input,pos)`)
  }
  const compiled = new Function(
    ...EMITTED_PARAMS, 'COUNT_LEX', `'use strict';\n${source}`,
  ) as (...args: unknown[]) => ReturnType<PrecompiledAssembly['factory']>
  const factory = ((...args: Parameters<PrecompiledAssembly['factory']>) =>
    compiled(...args, counter)) as PrecompiledAssembly['factory']
  return { ...prog, asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }] }
}

function engines(grammar: Combinator<unknown>): { entries: Record<string, Entry>; source: string } {
  const prog = encodeTable({ Root: grammar })
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  return {
    entries: {
      interpreter: grammar as Entry,
      reference: execRules(prog).Root! as Entry,
      closure: tableRules({ ...prog, asm: [] }).Root! as Entry,
      emitted: tableRules(precompiled(prog)).Root! as Entry,
    },
    source: emitted.source,
  }
}

function expectIdentity(grammar: Combinator<unknown>, inputs: readonly string[]): string {
  const made = engines(grammar)
  for (const input of inputs) {
    const expected = outcome(made.entries.interpreter!, input)
    for (const [name, entry] of Object.entries(made.entries)) {
      expect(outcome(entry, input), `${name}: ${JSON.stringify(input)}`).toEqual(expected)
    }
  }
  return made.source
}

describe('small-choice token predecision', () => {
  it('rejects a wrapped regex miss before the arm while preserving source-order fallback', () => {
    const grammar = choice(
      attempt(transform(sequence(regex(/a(?=!)/), literal('!')), () => 'bang')),
      attempt(transform(sequence(regex(/a(?=\?)/), literal('?')), () => 'question')),
    )
    const prog = encodeTable({ Root: grammar })
    const choiceIp = [...reachableIps(prog)].find(ip => prog.code[ip] === OP_CHOICE)!
    expect(resolveTable(prog).disp[prog.code[choiceIp + 1]!]!.exclusive).toBe(false)

    const source = expectIdentity(grammar, ['a!', 'a?', 'ax', 'x'])
    expect(source).toMatch(/&&_rec\d+\(input,pos\)>=0/)
  })

  it('keeps both arms live when they share the same recognized token', () => {
    const grammar = choice(
      attempt(transform(sequence(regex(/a/), literal('!')), () => 'bang')),
      attempt(transform(sequence(regex(/a/), literal('?')), () => 'question')),
      attempt(transform(sequence(regex(/a/), literal('.')), () => 'dot')),
    )
    expectIdentity(grammar, ['a!', 'a?', 'a.', 'a:', 'x'])
  })

  it('does not add a predecision to a direct terminal choice', () => {
    const grammar = choice(sequence(regex(/a/), literal('!')), sequence(regex(/a/), literal('?')))
    const source = expectIdentity(grammar, ['a!', 'a?', 'a:', 'x'])
    expect(source).not.toMatch(/&&_rec\d+_\(input,pos\)>=0/)
  })

  it('decides a wrapped dispatch from its token and reuses the recognized range', () => {
    const functionOpen = token(sequence(
      regex(/[A-Za-z]+/),
      optional(literal('(')),
    ))
    const functionCall = dispatch(
      functionOpen,
      when('each(', sequence(routed(), literal('!'))),
      when(
        matches(/^(?!(?:url|calc)\($).+\($/i),
        sequence(routed(), literal('?')),
      ),
    )
    const grammar = choice(
      transform(functionCall, ([, statement]) => statement),
      sequence(choice(literal('url('), literal('calc(')), literal(')')),
      sequence(regex(/[A-Za-z]+/), literal(':')),
    )

    const source = expectIdentity(grammar, [
      'each(!', 'thing(?', 'url()', 'calc()', 'bare:', 'url(', 'other(', 'x',
    ])
    expect(source).toMatch(/function _td\d+_\(input,pos\)/)
    expect(source).toMatch(/const r=tp\?_pfTokPacked:/)
    expect(source).toMatch(/_pfTokDispatch===\d+&&_pfTokInput===input/)

    const prog = encodeTable({ Root: grammar })
    const reachable = [...reachableIps(prog)]
    const xformIp = reachable.find(ip =>
      prog.code[ip] === OP_XFORM && prog.code[prog.code[ip + 2]!] === OP_DISPATCH,
    )!
    const dispatchIp = prog.code[xformIp + 2]!
    const selectorIp = prog.code[dispatchIp + 1]!
    expect(prog.code[xformIp + 1]).toBe(~1)
    expect(prog.fns).toHaveLength(0)

    const xformStart = source.indexOf(`function _pf${xformIp}(input,pos,ctx){`)
    const xformEnd = source.indexOf('\nfunction ', xformStart + 1)
    const xformSource = source.slice(xformStart, xformEnd)
    expect(xformStart).toBeGreaterThanOrEqual(0)
    expect(xformSource).not.toContain(`_pf${selectorIp}(input,pos,ctx)`)
    expect(xformSource).toContain('const tr=_pfTokPacked')

    const scans = { n: 0 }
    const emittedEntry = tableRules(countedPrecompiled(prog, scans)).Root! as Entry
    for (const input of ['each(!', 'thing(?', 'url()']) {
      scans.n = 0
      expect(outcome(emittedEntry, input).ok, input).toBe(true)
      expect(scans.n, `${input}: token recognizer calls`).toBe(1)
    }

    const planted = tableRules(countedPrecompiled(prog, scans, true)).Root! as Entry
    scans.n = 0
    expect(outcome(planted, 'thing(?').ok).toBe(true)
    expect(scans.n, 'sensitivity control: planted scan-then-rescan').toBe(2)

    const selectorBypassed = tableRules(precompiled(prog)).Root! as Entry
    const originalSelector = `_pf${selectorIp}(input,pos,ctx){`
    const emittedSource = emitAssemblySource(resolveTable(prog), prog, STRICT)
    expect(emittedSource.source).toContain(originalSelector)
    const throwingFactory = new Function(
      ...EMITTED_PARAMS,
      `'use strict';\n${emittedSource.source.replace(
        originalSelector,
        `${originalSelector}throw new Error('token selector re-entered')\n`,
      )}`,
    ) as PrecompiledAssembly['factory']
    const bypassProgram = {
      ...prog,
      asm: [{
        key: 0,
        factory: throwingFactory,
        plan: emittedSource.plan,
        reached: [...emittedSource.reached],
      }],
    }
    const bypassEntry = tableRules(bypassProgram).Root! as Entry
    expect(outcome(selectorBypassed, 'each(!')).toEqual(outcome(bypassEntry, 'each(!'))
    expect(outcome(selectorBypassed, 'thing(?')).toEqual(outcome(bypassEntry, 'thing(?'))

    // The planted factories above are the RED controls for scan reuse and for
    // bypassing the selector/dispatch topology. Removing
    // `_pfTokEnd=e;return 0` separately makes `url(` rank at the choice start
    // instead of the selector end, changing the identity assertion's expected set.
  })
})
