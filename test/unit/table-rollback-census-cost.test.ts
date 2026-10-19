import { describe, expect, it } from 'vitest'
import { choice, field, literal, node, rules, sequence, type Combinator } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE } from '../../src/table/ops.ts'
import { choiceRollbackMask } from '../../src/table/program.ts'

type Reads = { n: number }

/** Counts every read of `c._def` — the unit of work of each link-time analysis. */
function counted<T extends Combinator<unknown>>(c: T, reads: Reads): T {
  const def = c._def
  Object.defineProperty(c, '_def', { get() { reads.n++; return def } })
  return c
}

/**
 * `n` recursive value rules: each a choice of two `node()` arms over the next
 * rule and a terminal arm, the last rule closing the cycle back at `V0`. The
 * terminal arm of `V0` is `withField`'s, when given.
 */
function valueRules(n: number, reads: Reads, withField = false): Record<string, Combinator<unknown>> {
  return rules((g: Record<string, Combinator<unknown>>) => {
    const out: Record<string, Combinator<unknown>> = { Root: g.V0! }
    for (let i = 0; i < n; i++) {
      const next = g[`V${(i + 1) % n}`]!
      const leaf = literal(`x${i}`)
      out[`V${i}`] = counted(choice(
        counted(node(`Paren${i}`, sequence(literal(`(${i}`), next, literal(')'))), reads),
        counted(node(`Bracket${i}`, sequence(literal(`[${i}`), next, literal(']'))), reads),
        i === 0 && withField ? field('leaf', leaf) : leaf,
      ), reads)
    }
    return out
  }) as Record<string, Combinator<unknown>>
}

function linkReads(n: number): number {
  const reads = { n: 0 }
  const grammar = valueRules(n, reads)
  reads.n = 0
  encodeTable(grammar)
  return reads.n
}

function rollbackMasks(n: number, withField: boolean): number[] {
  const prog = encodeTable(valueRules(n, { n: 0 }, withField))
  return [...reachableIps(prog)]
    .filter(ip => prog.code[ip] === OP_CHOICE)
    .map(ip => choiceRollbackMask(prog, ip)!)
    .sort((a, b) => a - b)
}

describe('link-time rollback census over recursive rules', () => {
  // Each rule's two arms both reach the next rule, so a walk that keeps no
  // answer for a node whose walk was cut at a cycle re-enters every rule along
  // all 2^n paths: doubling the depth squared the link's work. The census
  // enters each node once; the rest of the link is at most quadratic in the
  // number of choice sites, so doubling the depth may at most quadruple it.
  it('does polynomial, not exponential, link work over recursive rules', () => {
    const small = linkReads(8)
    const large = linkReads(16)
    expect(large / small).toBeLessThan(4)
  })

  it('keeps the rollback of every arm that reaches a field only around the cycle', () => {
    const n = 12
    const withField = rollbackMasks(n, true)
    expect(withField).toHaveLength(n)
    // V0: both node arms and the field arm. Every other rule: its two node
    // arms, which reach V0's field around the cycle, and not its terminal.
    expect(withField.filter(mask => mask === 0b111)).toHaveLength(1)
    expect(withField.filter(mask => mask === 0b011)).toHaveLength(n - 1)
    expect(rollbackMasks(n, false)).toEqual(Array.from({ length: n }, () => 0))
  })
})
