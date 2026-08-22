import { describe, expect, it } from 'vitest'
import { attempt, choice, literal, regex, run, sequence, transform, type Combinator } from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE } from '../../src/table/ops.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'

type Entry = Parameters<typeof run>[0]
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

function outcome(entry: Entry, input: string): unknown {
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
})
