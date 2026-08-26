import { describe, expect, it } from 'vitest'
import { literal, node, optional, regex, rules, sequence, transform, type Combinator } from '../../src/index.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { AssemblyCache, tableRules } from '../../src/table/assemble.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_LIT, OP_SEQ, OP_SEQV, OP_SEQX } from '../../src/table/ops.ts'
import { ownTableProgram, resolveTable, type PrecompiledAssembly } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'
import { createParseContext } from '../../src/parse-context.ts'

function seqxIp(parser: Combinator<unknown>): { prog: ReturnType<typeof encodeTable>; ip: number } {
  const prog = encodeTable({ Entry: parser })
  const ip = [...reachableIps(prog)].find(at => prog.code[at] === OP_SEQX)
  if (ip === undefined) throw new Error('test grammar did not lower to OP_SEQX')
  return { prog, ip }
}

describe('table sequence direct projection', () => {
  it('pastes non-first single-character literals into static macro sequences', () => {
    const grammar = rules({ trivia: regex(/\s+/) }, () => ({
      Entry: node('Doc', sequence(literal('a'), literal('!'), literal('?'))),
    }))
    const prog = encodeTable(grammar)
    const seq = [...reachableIps(prog)].find(ip => {
      const op = prog.code[ip]
      return op === OP_SEQ || op === OP_SEQV || op === OP_SEQX
    })
    expect(seq).toBeTypeOf('number')
    const op = prog.code[seq!]!
    const base = op === OP_SEQX ? seq! + 3 : seq! + 2
    const second = prog.code[base + 1]!
    const third = prog.code[base + 2]!
    expect(prog.code[second]).toBe(OP_LIT)
    expect(prog.code[third]).toBe(OP_LIT)

    const cfg = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
    const ordinary = emitAssemblySource(resolveTable(prog), prog, cfg).source
    const emitted = emitAssemblySource(resolveTable(prog), prog, cfg, [], true)
    expect(ordinary).toContain(`function _pf${second}(`)
    expect(ordinary).toContain(`function _pf${third}(`)
    expect(emitted.source).not.toContain(`function _pf${second}(`)
    expect(emitted.source).not.toContain(`function _pf${third}(`)

    const factory = new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory']
    const precompiled = ownTableProgram({
      ...prog,
      asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }],
    })
    const entries = {
      interpreter: grammar.Entry,
      reference: execRules(prog).Entry!,
      closure: tableRules({ ...prog, asm: [] }).Entry!,
      macro: tableRules(precompiled).Entry!,
    }
    for (const input of ['a!?', 'a ! ?', 'a ! x', 'a', '']) {
      const expected = JSON.stringify(run(grammar.Entry, input))
      for (const [name, entry] of Object.entries(entries)) {
        expect(JSON.stringify(run(entry, input)), `${name}: ${JSON.stringify(input)}`).toBe(expected)
      }
    }
  })

  it('encodes a selected child in the existing operand and omits the reducer', () => {
    const parser = transform(
      sequence(optional(literal('a')), regex(/[0-9]+/), literal('!')),
      ([, value]) => value,
    )
    const { prog, ip } = seqxIp(parser)

    expect(prog.code[ip + 1]).toBe(~1)
    expect(prog.fns).toHaveLength(0)

    for (const input of ['7!', 'a42!']) {
      const interpreted = run(parser, input)
      const reference = run(execRules(prog).Entry!, input)
      const assembled = run(tableRules(prog).Entry!, input)
      expect(interpreted).toMatchObject({ ok: true, value: input === '7!' ? '7' : '42' })
      expect(reference).toEqual(interpreted)
      expect(assembled).toEqual(interpreted)
    }
    expect(run(tableRules(prog).Entry!, 'a42!', { tolerant: true }).value).toBe('42')

    // Failed terms before and after the projected child must not publish a
    // partial value or shift the descriptor's child index.
    for (const input of ['a!', '42?', '']) {
      expect(run(execRules(prog).Entry!, input)).toEqual(run(parser, input))
      expect(run(tableRules(prog).Entry!, input)).toEqual(run(parser, input))
    }
  })

  it('goes RED when the encoded child index is wrong', () => {
    const parser = transform(sequence(literal('left'), literal('right')), ([, value]) => value)
    const { prog, ip } = seqxIp(parser)
    const planted = { ...prog, code: [...prog.code] }
    planted.code[ip + 1] = ~0

    expect(run(parser, 'leftright').value).toBe('right')
    // This assertion proves the differential is capable of detecting the real
    // descriptor defect; a same-engine or unobserved-operand test stays green.
    expect(run(tableRules(planted).Entry!, 'leftright').value).toBe('left')
  })

  it('runs the projection through the emitted assembly itself', () => {
    const parser = transform(sequence(literal('left'), literal('right')), ([, value]) => value)
    const { prog } = seqxIp(parser)
    const assembly = new AssemblyCache(prog).for({
      hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false,
    })
    expect(assembly.emitRefusal, 'projection must not silently fall back to closure pieces').toBeUndefined()

    const ctx = createParseContext()
    assembly.begin(ctx)
    try {
      expect(assembly.pieces.Entry!('leftright', 0, ctx)).toBe('right')
      expect(assembly.end()).toBe('leftright'.length)
    } finally {
      assembly.finish()
    }
  })

  it('leaves every non-projection callback in the function pool', () => {
    const reducers = [
      ([value]: unknown[]) => value ?? '',
      ([value = '']: unknown[]) => value,
      ([...values]: unknown[]) => values[0],
      ([value]: unknown[]) => { return value },
    ]
    for (const reducer of reducers) {
      const parser = transform(sequence(literal('x')), reducer)
      const { prog, ip } = seqxIp(parser)
      expect(prog.code[ip + 1], String(reducer)).toBeGreaterThanOrEqual(0)
      expect(prog.fns, String(reducer)).toHaveLength(1)
      expect(run(tableRules(prog).Entry!, 'x')).toEqual(run(parser, 'x'))
    }
  })
})
