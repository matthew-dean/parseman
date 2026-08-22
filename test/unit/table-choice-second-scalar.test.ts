import { describe, expect, it } from 'vitest'
import {
  choice, literal, noTrivia, parser, regex, run, sequence, type Combinator,
} from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE } from '../../src/table/ops.ts'
import {
  choiceSecondScalarPlan, ownTableProgram, resolveTable, type TableProgram,
} from '../../src/table/program.ts'

type Entry = Parameters<typeof run>[0]
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

function choiceIp(prog: TableProgram): number {
  const ip = [...reachableIps(prog)].find(at => prog.code[at] === OP_CHOICE)
  if (ip === undefined) throw new TypeError('expected an encoded choice')
  return ip
}

function projection(entry: Entry, input: string): unknown {
  const result = run(entry, input)
  return {
    ok: result.ok,
    value: result.value,
    span: result.span,
    expected: result.expected,
    unconsumedFrom: result.unconsumedFrom,
  }
}

function prefixGrammar(): Combinator<unknown> {
  return choice(
    noTrivia(sequence(literal('@{'), regex(/[a-z]+/), literal('}'))),
    noTrivia(sequence(literal('@@'), regex(/[a-z]+/))),
    noTrivia(sequence(literal('@'), regex(/[a-z]+/))),
    literal('#'),
  )
}

describe('emitted ordered-choice second-scalar decisions', () => {
  it('partitions overlapping noTrivia arms from a compiler-only prefix proof', () => {
    const grammar = prefixGrammar()
    const prog = encodeTable({ Root: grammar })
    const ip = choiceIp(prog)
    const plan = choiceSecondScalarPlan(prog, ip)
    expect(plan?.first).toBe('@'.codePointAt(0))
    expect(plan?.armClasses.slice(0, 2).every(index => index >= 0)).toBe(true)
    expect(plan?.armClasses.slice(2)).toEqual([-1, -1])

    const source = emitAssemblySource(resolveTable(prog), prog, STRICT).source
    expect(source).toContain('codePointAt(pos+1)')

    // RED control: remove only the compiler-owned prefix authority. The same
    // program still parses, but the static assembly loses the decision pretest.
    const planted = ownTableProgram(prog, undefined, undefined, new Map())
    const plantedSource = emitAssemblySource(resolveTable(planted), planted, STRICT).source
    expect(plantedSource).not.toContain('codePointAt(pos+1)')

    const engines: Record<string, Entry> = {
      interpreter: grammar as Entry,
      reference: execRules(prog).Root! as Entry,
      emitted: tableRules(prog).Root! as Entry,
    }
    for (const input of ['@{x}', '@@x', '@x', '#', '@!']) {
      const expected = projection(engines.interpreter!, input)
      for (const [name, entry] of Object.entries(engines)) {
        expect(projection(entry, input), `${name}: ${input}`).toEqual(expected)
      }
    }
  })

  it('declines a raw-prefix plan when a local trivia scope may move the child start', () => {
    const local = (tail: string): Combinator<unknown> => parser(
      { trivia: regex(/[ ]+/) }, sequence(literal('@'), literal(tail)),
    )
    const grammar = choice(local('{'), local('@'), local('x'), literal('#'))
    const prog = encodeTable({ Root: grammar })
    expect(choiceSecondScalarPlan(prog, choiceIp(prog))).toBeUndefined()
  })
})
