import { describe, expect, it } from 'vitest'
import { checkIdentity } from '../../bench/g5-identity.ts'
import { baseNodes, jsonRules, jsonWs } from '../../bench/g5-grammars.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import { run } from '../../src/functional/run.ts'
import { many, node, regex, rules } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'

/**
 * CI gate for the table lowering (`src/table/`, design ledger G5).
 *
 * The lane's own gate is `bench/g5-run.ts`, which is run by hand over seven
 * grammars. This is the subset that has to stay true on every commit, because a
 * table lowering that silently disagrees with the compiled path is exactly the
 * failure the three-way digest exists to catch — every defect it caught this far
 * PARSED FINE and moved only the tree, so no ordinary assertion would have seen
 * any of them.
 */
describe('table lowering — tree identity', () => {
  it('json: interpreted, compiled and table agree on every case', () => {
    const r = checkIdentity(
      jsonRules as unknown as Record<string, Combinator<unknown>>,
      'Value',
      [
        { name: 'scalars', input: '[1, -2.5, 1e10, true, false, null, "a\\nb", "\\u0041"]' },
        { name: 'nested', input: '{"a":{"b":[{"c":[[[]]]}]},"d":[]}' },
        { name: 'empty-obj', input: '{}' },
        { name: 'empty-arr', input: '[]' },
        { name: 'ws', input: '  {  "a" :  [ 1 , 2 ]  ,  "b" : null  }  ' },
        { name: 'unicode-key', input: '{"\\u00e9": "caf\\u00e9"}' },
        { name: 'bad-trailing-comma', input: '[1,2,]' },
        { name: 'bad-unclosed', input: '{"a":' },
        { name: 'bad-garbage', input: '@@@' },
      ],
      { trivia: jsonWs },
    )
    expect(r.mismatches).toEqual([])
    expect(r.matched).toBe(r.total)
  })

  it('a node()-building grammar agrees, including sepBy separator demotion', () => {
    // `7cb528e feat(lists)!` — a list contributes its ITEMS and nothing else.
    // The driver captured the separator until this case caught it.
    const r = checkIdentity(baseNodes, 'Doc', [
      { name: 'atom', input: 'abc' },
      { name: 'list', input: '(a,b,12)' },
      { name: 'nested-doc', input: '(a,1)zz(b)7' },
      { name: 'empty', input: '' },
      { name: 'unclosed', input: '(a,b' },
      { name: 'trailing-sep', input: '(a,)' },
    ])
    expect(r.mismatches).toEqual([])
    expect(r.matched).toBe(r.total)
  })

  it('a settings pair changes the TABLE, not the driver', () => {
    const plain = encodeTable(baseNodes)
    const tracked = encodeTable(baseNodes, { trackLines: true })
    // Same shape, different rows.
    expect(tracked.code.length).toBe(plain.code.length)
    expect(tracked.lines).toBe(1)
    expect(plain.lines).toBe(0)
    expect(tracked.code).not.toEqual(plain.code)
    // And the driver never reads a setting: comments stripped, no option survives.
    // (The full check lives in bench/g5-variants.ts; this pins the table half.)
  })

  it('line tracking is observable in the parse output', () => {
    // A reducer that RETURNS the span it was handed, so the variant's effect is
    // visible in the tree and not only in the table.
    const probe = rules<Record<string, Combinator<unknown>>>(g => ({
      W: node('W', regex(/[^\s()]+/), (_c, _f, span) => span),
      Doc: node('Doc', many(g.W!), c => ({ spans: c })),
    })) as unknown as Record<string, Combinator<unknown>>

    const input = 'ab\ncd'
    const spansOf = (v: unknown): Array<Record<string, unknown>> =>
      (v as { spans: Array<Record<string, unknown>> }).spans

    const plain = run(tableRules(encodeTable(probe)).Doc! as never, input)
    const tracked = run(tableRules(encodeTable(probe, { trackLines: true })).Doc! as never, input)
    expect(plain.ok).toBe(true)
    expect(tracked.ok).toBe(true)
    expect(Object.keys(spansOf(plain.value)[0]!)).toEqual(['start', 'end'])
    expect(Object.keys(spansOf(tracked.value)[0]!)).toContain('startLine')
  })

  it('the emitted module is data plus the author reducers, not a recognizer', () => {
    const src = emitTableModule(encodeTable(baseNodes), { name: 'g', fnSources: [] })
    expect(src).toContain('tableRules(')
    // No recognition logic is emitted per grammar — that is the whole claim.
    expect(src).not.toMatch(/\bfunction\b/)
    expect(src).not.toMatch(/charCodeAt|startsWith|lastIndex/)
  })
})

/**
 * The full sweep, promoted from `bench/g5-run.ts` into CI.
 *
 * That file ran seven grammars by hand. A hand-run gate is one forgotten command
 * from being no gate, and every defect this lowering has produced PARSED FINE and
 * moved only the tree — `optional()` yielding `undefined` instead of `null`,
 * `token()` treated as transparent, `balanced()` encoded from a `_def` its own
 * `.parse` overrides, separators still captured after the items-only change. None
 * of those would fail an ordinary assertion, and four of them were found only
 * because a digest disagreed.
 *
 * Running the same sweep here also means `src/table/` is exercised by tests rather
 * than by a benchmark, which is why its coverage was a cliff.
 */
describe('table lowering — three-way identity across every encodable grammar', () => {
  it('json: interpreted, compiled and table agree on every case', async () => {
    const { checkIdentity: ci } = await import('../../bench/g5-identity.ts')
    const { JSON_CASES } = await import('./table-identity-cases.ts')
    const r = ci(jsonRules as unknown as Record<string, Combinator<unknown>>, 'Value', JSON_CASES, { trivia: jsonWs })
    expect(r.mismatches, JSON.stringify(r.mismatches.slice(0, 3))).toEqual([])
    // total counts (case x path) pairs; matched must equal it, not merely be non-zero.
    expect(r.matched).toBe(r.total)
    expect(r.total).toBeGreaterThan(0)
  })

  it('node ladder at 4, 8, 16 and 32 rules', async () => {
    const { checkIdentity: ci } = await import('../../bench/g5-identity.ts')
    const { nodeLadder } = await import('../../bench/g5-grammars.ts')
    const { ladderCases } = await import('./table-identity-cases.ts')
    for (const n of [4, 8, 16, 32]) {
      const r = ci(nodeLadder(n), 'Root', ladderCases(n))
      expect(r.mismatches, `ladder ${n}: ${JSON.stringify(r.mismatches.slice(0, 2))}`).toEqual([])
    }
  })

  it('the node-building base grammar', async () => {
    const { checkIdentity: ci } = await import('../../bench/g5-identity.ts')
    const { BASE_CASES } = await import('./table-identity-cases.ts')
    const r = ci(baseNodes, 'Doc', BASE_CASES)
    expect(r.mismatches, JSON.stringify(r.mismatches.slice(0, 3))).toEqual([])
  })

  it('the 29-rule Less workload grammar on real stylesheet input', async () => {
    const { checkIdentity: ci } = await import('../../bench/g5-identity.ts')
    const { lessRules } = await import('../../bench/workloads/less.ts')
    const { LESS_CASES } = await import('./table-identity-cases.ts')
    const r = ci(lessRules as unknown as Record<string, Combinator<unknown>>, 'Stylesheet', LESS_CASES)
    expect(r.mismatches, JSON.stringify(r.mismatches.slice(0, 3))).toEqual([])
  })
})
