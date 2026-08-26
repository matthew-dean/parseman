import { describe, expect, it } from 'vitest'
import {
  attempt, choice, expect as recover, field, label, literal, node, optional, rules, run, sequence, type Combinator, word,
} from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_ATTEMPT, OP_CHOICE, OP_OPT } from '../../src/table/ops.ts'
import {
  choiceRollbackMask, failureRollbackClean, ownTableProgram, resolveTable,
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

function precompiledCountingExpectedMerges(prog: TableProgram, counter: { n: number }): Entry {
  const owned = ownTableProgram(prog)
  const emitted = emitAssemblySource(resolveTable(owned), owned, STRICT)
  const source = emitted.source
    .replace('function _accSet(ax,acc){', 'function _countAcc(ax,acc){COUNT.n++')
    .replaceAll('_accSet(', '_countAcc(')
  const compiled = new Function(
    ...EMITTED_PARAMS, 'COUNT', source,
  ) as (...args: unknown[]) => ReturnType<PrecompiledAssembly['factory']>
  const factory = ((...args: Parameters<PrecompiledAssembly['factory']>) =>
    compiled(...args, counter)) as PrecompiledAssembly['factory']
  return tableRules(ownTableProgram({
    ...owned,
    asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }],
  })).Root! as Entry
}

function precompiledCountingExpectedCopies(prog: TableProgram, counter: { n: number }): Entry {
  const owned = ownTableProgram(prog)
  const emitted = emitAssemblySource(resolveTable(owned), owned, STRICT)
  const source = emitted.source.replaceAll('return ax.slice()', 'COUNT.n++;return ax.slice()')
    .replaceAll('acc=acc.slice()', 'COUNT.n++;acc=acc.slice()')
  const compiled = new Function(
    ...EMITTED_PARAMS, 'COUNT', source,
  ) as (...args: unknown[]) => ReturnType<PrecompiledAssembly['factory']>
  const factory = ((...args: Parameters<PrecompiledAssembly['factory']>) =>
    compiled(...args, counter)) as PrecompiledAssembly['factory']
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
  it('borrows a speculative dynamic expected set when a later arm succeeds', () => {
    const grammar = choice(
      attempt(sequence(literal('a'), literal('!'))),
      literal('ab'),
    )
    const prog = encodeTable({ Root: grammar })
    const copies = { n: 0 }
    const emitted = precompiledCountingExpectedCopies(prog, copies)

    expect(projection(emitted, 'ab')).toEqual(projection(grammar as Entry, 'ab'))
    expect(copies.n).toBe(0)
  })

  it('does no expected-array work for exact start failures before a later arm succeeds', () => {
    const grammar = choice(literal('ab'), literal('ac'), literal('ad'))
    const prog = encodeTable({ Root: grammar })
    const merges = { n: 0 }
    const emitted = precompiledCountingExpectedMerges(prog, merges)

    expect(projection(emitted, 'ac')).toEqual(projection(grammar as Entry, 'ac'))
    expect(merges.n).toBe(0)

    merges.n = 0
    expect(projection(emitted, 'ax')).toEqual(projection(grammar as Entry, 'ax'))
    expect(merges.n).toBe(0)

    // attempt() re-anchors a deeper child failure at the choice start. Its
    // dynamic expected set is not the static leading-terminal set, so it must
    // remain outside this authority.
    const unsafe = choice(attempt(sequence(literal('a'), literal('!'))), literal('ab'))
    expect(projection(precompiled(encodeTable({ Root: unsafe })), 'ax'))
      .toEqual(projection(unsafe as Entry, 'ax'))

    // label() replaces its child's failure set even when the child fails at
    // the choice start. The scalar opener remains useful for recognition, but
    // it cannot authorize the static choice expectation set.
    const labelled = rules((g: Record<string, Combinator<unknown>>) => ({
      Root: choice(g.Supports!, g.Media!, g.Container!, literal(';')),
      Supports: label('keyword', literal('@supports')),
      Media: label('keyword', literal('@media')),
      Container: label('keyword', literal('@container')),
    })) as Record<string, Combinator<unknown>>
    expect(projection(precompiled(encodeTable(labelled)), '@charset'))
      .toEqual(projection(labelled.Root! as Entry, '@charset'))

    // word() deliberately reports its token-family label while deriveExpected
    // names the literal at the enclosing choice. A scalar-start proof must
    // compare those two authorities before substituting one for the other.
    const boundary = '-_a-zA-Z0-9\\u0080-\\uFFFF'
    const keywordChoice = choice(
      sequence(word('@supports', boundary, { caseInsensitive: true }), literal('{')),
      sequence(word('@media', boundary, { caseInsensitive: true }), literal('{')),
      sequence(word('@container', boundary, { caseInsensitive: true }), literal('{')),
    )
    expect(projection(precompiled(encodeTable({ Root: keywordChoice })), '@charset'))
      .toEqual(projection(keywordChoice as Entry, '@charset'))
  })

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

    // A named rule is emitted from a TOP label because it can also be entered
    // directly. When called from inside a field-reading node, its sink-free
    // rollback must leave fields captured before the call untouched.
    const named = rules((g: Record<string, Combinator<unknown>>) => ({
      Root: node('NamedRoot', sequence(field('seed', literal('s')), g.Maybe!), (_children, captured) => captured),
      Maybe: optional(sequence(literal('a'), literal('!'))),
    })) as Record<string, Combinator<unknown>>
    const namedProg = encodeTable(named)
    expect(projection(precompiled(namedProg), 'sa')).toEqual(projection(named.Root! as Entry, 'sa'))
    expect(run(precompiled(namedProg), 'sa').value).toMatchObject({ seed: { value: 's' } })
  })

  it('omits optional and attempt marks when failed children own their capture', () => {
    const contained = node('Contained', sequence(literal('a'), literal('!')))
    const grammar = node('Root', sequence(optional(contained), attempt(contained), literal('?')))
    const prog = encodeTable({ Root: grammar })
    const optionalIp = [...reachableIps(prog)].find(ip => prog.code[ip] === OP_OPT)
    const attemptIp = [...reachableIps(prog)].find(ip => prog.code[ip] === OP_ATTEMPT)
    expect(optionalIp).toBeTypeOf('number')
    expect(attemptIp).toBeTypeOf('number')
    expect(failureRollbackClean(prog, optionalIp!)).toBe(true)
    expect(failureRollbackClean(prog, attemptIp!)).toBe(true)

    const source = emitAssemblySource(resolveTable(prog), prog, STRICT).source
    expect(emittedBody(source, optionalIp!)).not.toMatch(/_rbBuf\(ctx/)
    expect(emittedBody(source, attemptIp!)).not.toMatch(/_rbBuf\(ctx/)

    const emitted = precompiled(prog)
    for (const input of ['a!?', 'a!a!?', '?', 'a?']) {
      expect(projection(emitted, input), input).toEqual(projection(grammar as Entry, input))
    }
  })

  it('keeps optional rollback when a failed child can leak a captured prefix', () => {
    const grammar = node('Root', sequence(
      optional(sequence(literal('a'), literal('!'))),
      literal('a'),
    ))
    const prog = encodeTable({ Root: grammar })
    const optionalIp = [...reachableIps(prog)].find(ip => prog.code[ip] === OP_OPT)!
    expect(failureRollbackClean(prog, optionalIp)).toBe(false)

    const expected = projection(grammar as Entry, 'a')
    expect(projection(precompiled(prog), 'a')).toEqual(expected)

    // RED control: granting clean authority to a leaking child leaves the
    // optional's failed prefix in the enclosing node before the final arm wins.
    const planted = ownTableProgram(prog, undefined, undefined, new Set([optionalIp]))
    expect(projection(precompiled(planted), 'a')).not.toEqual(expected)
  })
})
