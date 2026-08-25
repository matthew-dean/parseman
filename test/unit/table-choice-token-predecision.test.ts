import { describe, expect, it } from 'vitest'
import {
  attempt, choice, dispatch, literal, matches, optional, regex, run, sequence,
  token, transform, when, type Combinator,
} from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE } from '../../src/table/ops.ts'
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
  const factory = new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory']
  return { ...prog, asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }] }
}

function countedPrecompiled(
  prog: TableProgram,
  counter: { n: number },
  plantDuplicateScan = false,
  plantLeadingCode = false,
): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  let source = emitted.source.replace(
    /const (_lex\d+)=LEX\[(\d+)\]/g,
    'const $1=((r)=>(input,pos)=>{COUNT_LEX.n++;return r(input,pos)})(LEX[$2])',
  )
  source = source.replace(
    /(function _td\d+_\(input,pos,c\)\{)/g,
    '$1COUNT_LEX.n++;',
  )
  if (plantDuplicateScan) {
    source = source.replace(/const r=tp\?_pfTokPacked:([^\n]+)/, 'const r=$1')
  }
  if (plantLeadingCode) source = source.replace('c === 45', 'c === 46')
  const compiled = new Function(
    ...EMITTED_PARAMS, 'COUNT_LEX', source,
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
      regex(/-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*/),
      optional(literal('(')),
    ))
    const functionCall = dispatch(
      functionOpen,
      when('each(', literal('!')),
      when(matches(/^(?!(?:url|calc)\($).+\($/i), literal('?')),
    )
    const grammar = choice(
      transform(functionCall, value => value),
      sequence(choice(literal('url('), literal('calc(')), literal(')')),
      sequence(regex(/[A-Za-z]+/), literal(':')),
    )

    const source = expectIdentity(grammar, [
      'each(!', 'thing(?', '-thing(?', 'éclair(?', 'url()', 'calc()',
      'bare:', 'url(', 'other(', 'x',
    ])
    expect(source).toMatch(/function _td\d+_\(input,pos,c\)/)
    expect(source).toMatch(/function _td\d+_\(input,pos,c\)\{[\s\S]*?input\.charCodeAt/)
    expect(source).toContain('c === 45')
    expect(source).not.toMatch(/function _td\d+_\(input,pos,c\)\{\nconst r=_lex\d+\(input,pos\)/)
    expect(source).toMatch(/const r=tp\?_pfTokPacked:/)
    expect(source).toMatch(/_pfTokDispatch===\d+&&_pfTokInput===input/)

    const prog = encodeTable({ Root: grammar })
    const scans = { n: 0 }
    const emitted = tableRules(countedPrecompiled(prog, scans)).Root! as Entry
    for (const input of ['each(!', 'thing(?', '-thing(?', 'éclair(?', 'url()']) {
      scans.n = 0
      expect(outcome(emitted, input).ok, input).toBe(true)
      expect(scans.n, `${input}: token recognizer calls`).toBe(1)
    }

    const planted = tableRules(countedPrecompiled(prog, scans, true)).Root! as Entry
    scans.n = 0
    expect(outcome(planted, 'thing(?').ok).toBe(true)
    expect(scans.n, 'sensitivity control: planted scan-then-rescan').toBe(2)

    const plantedLead = tableRules(countedPrecompiled(prog, scans, false, true)).Root! as Entry
    const plantedLeadOutcome = outcome(plantedLead, '-thing(?')
    const emittedLeadOutcome = outcome(emitted, '-thing(?')
    expect(plantedLeadOutcome).not.toEqual(emittedLeadOutcome)

    // The planted factories above are the RED controls for both scan reuse and
    // the leading-code-unit handoff. Removing
    // `_pfTokEnd=e;return 0` separately makes `url(` rank at the choice start
    // instead of the selector end, changing the identity assertion's expected set.
  })
})
