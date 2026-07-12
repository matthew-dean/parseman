/**
 * Interpreter ⇔ compiled parity for automatic list recovery. The compiled path
 * (opt-in via `compile(g, undefined, { recovery: true })`) reuses the EXACT
 * interpreter recovery functions through `ctx._rec`, so a tolerant compiled parse
 * must produce byte-for-byte the same value tree + ParseError set as the
 * interpreter. Covers `many`/`oneOrMore` (sepBy compiled recovery lands next).
 */
import { describe, it, expect } from 'vitest'
import { regex, literal, sequence, many, oneOrMore, run, compile } from '../../src/index.ts'
import { recoverScan, matchesAt, orSentinel } from '../../src/recovery/scan.ts'
import type { Combinator, ParseContext } from '../../src/index.ts'

const REC = { scan: recoverScan, at: matchesAt, or: orSentinel }
const ident = regex(/[a-z]+/)
const num = regex(/[0-9]+/)
const decl = sequence(ident, literal(':'), num)

// Run a compiled grammar tolerantly (build the ctx run() would, incl. _rec).
function runCompiledTolerant(compiled: { parseWithContext(i: string, c: ParseContext, p?: number): unknown }, input: string) {
  const errors: unknown[] = []
  const ctx = { trackLines: false, _errors: errors, _tolerant: true, _rec: REC } as unknown as ParseContext
  const r = compiled.parseWithContext(input, ctx, 0) as { ok: boolean; value: unknown }
  return { ok: r.ok, value: r.value, errors }
}

function assertParity(entry: Combinator<unknown>, inputs: string[]) {
  const compiled = compile(entry, undefined, { recovery: true })
  for (const input of inputs) {
    const ri = run(entry, input, { tolerant: true })
    const rc = runCompiledTolerant(compiled, input)
    expect(rc.ok, `${input} ok`).toBe(ri.ok)
    expect(rc.value, `${input} value`).toEqual(ri.value)
    expect(rc.errors, `${input} errors`).toEqual(ri.errors)
  }
}

describe('interpreter ⇔ compiled recovery parity (many)', () => {
  const block = sequence(literal('{'), many(decl), literal('}'))
  it('matches across valid + junk-in-various-positions inputs', () => {
    assertParity(block as Combinator<unknown>, [
      '{a:1b:2}', '{a:1$$b:2}', '{a:1$$}', '{$$a:1}', '{a:1}', '{}',
      '{a:1@@b:2c:3}', '{@@}', '{a:1 b:2}', '{a:b:2}',
    ])
  })
})

describe('interpreter ⇔ compiled recovery parity (oneOrMore)', () => {
  const fenced = sequence(oneOrMore(decl), literal('%'))
  it('matches for a partial element resynced to the inferred terminator', () => {
    assertParity(fenced as Combinator<unknown>, ['a:1b:2%', 'a:1b:%', 'a:1$$b:2%', 'a:1%'])
  })
})

describe('compiled recovery is dormant on the strict path', () => {
  it('a recovery-compiled grammar run WITHOUT tolerant behaves strictly', () => {
    const block = sequence(literal('{'), many(decl), literal('}'))
    const compiled = compile(block as Combinator<unknown>, undefined, { recovery: true })
    // Strict (no _tolerant/_rec): the bad element makes the whole parse fail, and
    // it matches a strict interpreter run.
    const rc = compiled.parse('{a:1$$b:2}')
    const ri = run(block as Combinator<unknown>, '{a:1$$b:2}')
    expect(rc.ok).toBe(ri.ok)
    expect(rc.ok).toBe(false)
  })
})
