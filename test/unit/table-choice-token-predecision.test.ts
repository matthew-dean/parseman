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

function editedPrecompiled(prog: TableProgram, edit: (source: string) => string): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const factory = new Function(
    ...EMITTED_PARAMS, `'use strict';\n${edit(emitted.source)}`,
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
    source = source.replace(/const r=tp\?_pfTokPacked:([^\n]+)/, 'const r=$1')
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
      when(matches(/^(?!(?:url|calc)\($).+\($/i), sequence(routed(), literal('?'))),
    )
    const grammar = choice(
      transform(functionCall, value => value),
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
    const choiceIp = reachable.find(ip => {
      if (prog.code[ip] !== OP_CHOICE) return false
      const n = prog.code[ip + 2]!
      return Array.from({ length: n }, (_, i) => prog.code[ip + 4 + i]).includes(xformIp)
    })!
    const choiceStart = source.indexOf(`function _pf${choiceIp}(input,pos,ctx){`)
    const choiceEnd = source.indexOf('\nfunction ', choiceStart + 1)
    const choiceSource = source.slice(choiceStart, choiceEnd)
    expect(choiceStart).toBeGreaterThanOrEqual(0)
    expect(choiceSource.match(new RegExp(`_pf${xformIp}\\(input,pos,ctx\\)`, 'g'))).toHaveLength(1)
    expect(choiceSource).toContain('const selEnd=EC.e,key=sv,arm=_pfTokArm')

    const scans = { n: 0 }
    const emitted = tableRules(countedPrecompiled(prog, scans)).Root! as Entry
    for (const input of ['each(!', 'thing(?', 'url()']) {
      scans.n = 0
      expect(outcome(emitted, input).ok, input).toBe(true)
      expect(scans.n, `${input}: token recognizer calls`).toBe(1)
    }

    const planted = tableRules(countedPrecompiled(prog, scans, true)).Root! as Entry
    scans.n = 0
    expect(outcome(planted, 'thing(?').ok).toBe(true)
    expect(scans.n, 'sensitivity control: planted scan-then-rescan').toBe(2)

    const bypassed = tableRules(editedPrecompiled(prog, source => source.replace(
      `function _pf${xformIp}(input,pos,ctx){`,
      `function _pf${xformIp}(input,pos,ctx){throw new Error('unfused token arm entered')\n`,
    ))).Root! as Entry
    expect(outcome(bypassed, 'each(!').ok).toBe(true)
    expect(outcome(bypassed, 'thing(?').ok).toBe(true)

    const misrouted = tableRules(editedPrecompiled(prog, source => source.replace(
      'const selEnd=EC.e,key=sv,arm=_pfTokArm',
      'const selEnd=EC.e,key=sv,arm=1-_pfTokArm',
    ))).Root! as Entry
    expect(outcome(misrouted, 'each(!')).not.toEqual(outcome(emitted, 'each(!'))
    expect(outcome(misrouted, 'thing(?')).not.toEqual(outcome(emitted, 'thing(?'))

    // The planted factories above are RED controls for scan reuse and the direct
    // routed-arm selection. Removing
    // `_pfTokEnd=e;return 0` separately makes `url(` rank at the choice start
    // instead of the selector end, changing the identity assertion's expected set.
  })
})
