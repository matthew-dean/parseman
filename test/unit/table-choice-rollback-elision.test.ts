import { describe, expect, it } from 'vitest'
import {
  choice, expect as recover, field, literal, node, optional, run, sequence, type Combinator,
} from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE, OP_OPT } from '../../src/table/ops.ts'
import {
  choiceRollbackMask, ownTableProgram, resolveTable,
  type PrecompiledAssembly, type TableProgram,
} from '../../src/table/program.ts'

type Entry = Parameters<typeof run>[0]
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
const TOLERANT = { ...STRICT, tolerant: true }

function choiceIp(prog: TableProgram): number {
  const ip = [...reachableIps(prog)].find(at => prog.code[at] === OP_CHOICE)
  if (ip === undefined) throw new TypeError('expected an encoded choice')
  return ip
}

function precompiled(prog: TableProgram): Entry {
  const owned = ownTableProgram(prog)
  const emitted = emitAssemblySource(resolveTable(owned), owned, STRICT)
  const factory = new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory']
  return tableRules(ownTableProgram({
    ...owned,
    asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }],
  })).Root! as Entry
}

function projection(entry: Entry, input: string): unknown {
  const result = run(entry, input)
  return {
    ok: result.ok,
    value: result.value,
    expected: result.expected,
    unconsumedFrom: result.unconsumedFrom,
  }
}

function emittedBody(source: string, ip: number): string {
  const start = source.indexOf(`function _pf${ip}(`)
  if (start < 0) throw new TypeError(`missing emitted body for table ip ${ip}`)
  const end = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, end < 0 ? source.length : end)
}

describe('emitted ordered-choice rollback elision', () => {
  it('omits the outer mark when every arm contains its own failed capture', () => {
    const grammar = choice(
      node('Bang', sequence(literal('a'), literal('!'))),
      node('Question', sequence(literal('a'), literal('?'))),
    )
    const prog = encodeTable({ Root: grammar })
    expect(choiceRollbackMask(prog, choiceIp(prog))).toBe(0)

    const strict = emitAssemblySource(resolveTable(prog), prog, STRICT).source
    const tolerantProg = ownTableProgram({ ...prog, rec: 1 })
    const tolerant = emitAssemblySource(resolveTable(tolerantProg), tolerantProg, TOLERANT).source
    expect((strict.match(/_rbBuf\(ctx/g) ?? []).length).toBe(1)
    expect((tolerant.match(/rollbackTriviaAt\(ctx/g) ?? []).length).toBeGreaterThan(0)

    const emitted = precompiled(prog)
    expect(projection(emitted, 'a?')).toEqual(projection(grammar as Entry, 'a?'))
  })

  it('keeps rollback for an arm that can leak a captured prefix', () => {
    const grammar = node('Root', choice(
      sequence(literal('a'), literal('!')),
      sequence(literal('a'), literal('?')),
    ))
    const prog = encodeTable({ Root: grammar })
    expect(choiceRollbackMask(prog, choiceIp(prog))).not.toBe(0)

    const expected = projection(grammar as Entry, 'a?')
    expect(projection(precompiled(prog), 'a?')).toEqual(expected)

    // RED control: deleting the compiler's rollback authority leaves the first
    // arm's captured `a` in the outer node before the second arm succeeds.
    const planted = ownTableProgram(prog, undefined, new Map([[choiceIp(prog), 0]]))
    expect(projection(precompiled(planted), 'a?')).not.toEqual(expected)
  })

  it('keeps the mask conservative beyond the 31-bit arm boundary', () => {
    const arms: Combinator<unknown>[] = Array.from({ length: 32 }, (_, i) =>
      literal(String.fromCharCode(33 + i)))
    const grammar = choice(...arms as [Combinator<unknown>, ...Combinator<unknown>[]])
    const prog = encodeTable({ Root: grammar })
    expect(choiceRollbackMask(prog, choiceIp(prog))).toBe(-1)
  })

  it('marks only the side sinks reachable from each speculative subtree', () => {
    const plain = optional(sequence(literal('a'), literal('!')))
    const fields = optional(field('value', sequence(literal('b'), literal('?'))))
    const errors = optional(recover(sequence(literal('c'), literal('#'))))
    const prog = encodeTable({ Root: node('Root', sequence(plain, fields, errors)) })
    const optionals = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_OPT).sort((a, b) => a - b)
    expect(optionals).toHaveLength(3)

    const source = emitAssemblySource(resolveTable(prog), prog, STRICT).source
    const [plainBody, fieldBody, errorBody] = optionals.map(ip => emittedBody(source, ip))
    expect(plainBody).not.toMatch(/_fd\b|_er\b/)
    expect(fieldBody).toMatch(/_fd\b/)
    expect(fieldBody).not.toMatch(/_er\b/)
    expect(errorBody).not.toMatch(/_fd\b/)
    expect(errorBody).toMatch(/_er\b/)

    const emitted = precompiled(prog)
    for (const input of ['', 'a', 'a!', 'b', 'b?', 'c', 'c#', 'a!b?c#']) {
      expect(projection(emitted, input), input).toEqual(projection(node('Root', sequence(plain, fields, errors)) as Entry, input))
    }
  })
})
