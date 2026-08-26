import { describe, expect, it } from 'vitest'
import { literal, optional, regex, sequence, transform, type Combinator } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { AssemblyCache, tableRules } from '../../src/table/assemble.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_SEQX } from '../../src/table/ops.ts'
import { run } from '../../src/functional/run.ts'
import { createParseContext } from '../../src/parse-context.ts'

function seqxIp(parser: Combinator<unknown>): { prog: ReturnType<typeof encodeTable>; ip: number } {
  const prog = encodeTable({ Entry: parser })
  const ip = [...reachableIps(prog)].find(at => prog.code[at] === OP_SEQX)
  if (ip === undefined) throw new Error('test grammar did not lower to OP_SEQX')
  return { prog, ip }
}

describe('table sequence direct projection', () => {
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
