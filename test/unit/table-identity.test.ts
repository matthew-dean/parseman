import { describe, expect, it } from 'vitest'
import { checkIdentity } from '../../bench/g5-identity.ts'
import { baseNodes, dispatchNoFallback, dispatchNodes, fieldNodes, hostNodes, jsonRules, jsonWs, selectNodes, trailingTriviaNodes } from '../../bench/g5-grammars.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import { opHistogram } from '../../src/table/inspect.ts'
import { run } from '../../src/functional/run.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
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

  it('field() reaches the reducer as a built FieldMap', () => {
    const cases = [
      { name: 'pair', input: 'ab=12' },
      { name: 'entry-one-tag', input: '[ab=1]' },
      { name: 'entry-repeated-tag', input: '[ab=1,cd=2,ef=3]' },
      { name: 'entry-with-note', input: '[ab=1;zz]' },
      { name: 'mixed-doc', input: '[ab=1,cd=2]ef=3[gh=4;ii]' },
      // Rejected input matters as much: a table that agrees on what it accepts
      // and diverges on what it rejects is still a divergence.
      { name: 'empty', input: '' },
      { name: 'unclosed', input: '[ab=1' },
      { name: 'bad-value', input: 'ab=zz' },
      { name: 'garbage', input: '###' },
    ]
    const r = checkIdentity(fieldNodes, 'Doc', cases)
    expect(r.mismatches).toEqual([])
    expect(r.matched).toBe(r.total)
  })

  it('the field map is POPULATED, not vacuously undefined on all three paths', () => {
    // Three paths agreeing that the map is `undefined` would pass the identity
    // check above while the capability did nothing. Assert the contents.
    const table = tableRules(encodeTable(fieldNodes)).Doc!
    const fieldsOf = (input: string): Record<string, unknown> => {
      const v = run(table as never, input).value
      return (v as { c: Array<{ f: Record<string, unknown> }> }).c[0]!.f
    }

    const pair = fieldsOf('ab=12')
    expect(Object.keys(pair).sort()).toEqual(['key', 'val'])
    expect((pair.key as { span: unknown }).span).toEqual({ start: 0, end: 2 })

    // A repeated name becomes an ARRAY; buildFieldMap's branch for it.
    const repeated = fieldsOf('[ab=1,cd=2,ef=3]')
    expect(Array.isArray(repeated.tag)).toBe(true)
    expect((repeated.tag as unknown[]).length).toBe(3)

    // An absent optional field is OMITTED, not recorded as undefined.
    expect(Object.keys(fieldsOf('[ab=1]'))).not.toContain('note')
    expect(Object.keys(fieldsOf('[ab=1;zz]'))).toContain('note')
  })

  it('the inspector walks a field-bearing program', () => {
    // `reachableOps` decodes each row's declared width. An opcode missing from
    // that switch throws on any grammar that uses it — so the walk IS the check
    // that every new row was taught to every reader, not just the driver.
    const hist = opHistogram(encodeTable(fieldNodes))
    expect(hist.FIELD).toBeGreaterThan(0)
    expect(hist.NODE).toBeGreaterThan(0)
  })

  it('dispatch: every arm shape agrees across the three paths', () => {
    const r = checkIdentity(dispatchNodes, 'Doc', [
      { name: 'key-hit', input: '@media' },
      { name: 'key-insensitive', input: '@IMPORT' },
      { name: 'matcher-arm', input: '@-webkit-x' },
      { name: 'otherwise-routed', input: '@whatever' },
      { name: 'selector-fails', input: 'nope' },
      { name: 'empty', input: '' },
    ])
    expect(r.mismatches).toEqual([])
    const nofb = checkIdentity(dispatchNoFallback, 'Doc', [
      { name: 'key-hit', input: '@media' },
      { name: 'miss-no-otherwise', input: '@nope' },
    ])
    expect(nofb.mismatches).toEqual([])
  })

  it('dispatch selects the RIGHT arm, which identity alone cannot show', () => {
    // If two arms produced the same tree for an input, identity would pass while
    // the wrong arm ran. Each arm returns a distinct marker, read back here.
    const table = tableRules(encodeTable(dispatchNodes)).Doc!
    const armFor = (input: string): unknown => {
      const r = run(table as never, input)
      // dispatch yields [selectorValue, armValue]
      return (r.value as [string, unknown])[1]
    }
    expect(armFor('@media')).toBe('K:media')          // exact key
    expect(armFor('@IMPORT')).toBe('CI:import')       // ASCII-folded key map
    expect(armFor('@-webkit-x')).toBe('M:vendor')     // startsWith matcher
    expect(armFor('@whatever')).toBe('O:@whatever')   // otherwise, owning the routed token

    // routed() means the fallback CONSUMES the selector's token: the parse ends
    // at the token's end, not before it.
    expect(run(table as never, '@whatever').unconsumedFrom).toBe(null)

    // A miss with no otherwise() is a FAILURE, not a silent empty match.
    const noFb = tableRules(encodeTable(dispatchNoFallback)).Doc!
    expect(run(noFb as never, '@media').ok).toBe(true)
    expect(run(noFb as never, '@nope').ok).toBe(false)
  })

  /**
   * WHY THESE READ THE VALUE BACK INSTEAD OF TRUSTING IDENTITY.
   *
   * A COLLAPSED NODE AND ITS CHILD CAN DIGEST ALIKE. `collapse` makes the node
   * BE its single captured child, so node and child serialise to the same bytes
   * and a three-way digest agrees whether or not the collapse happened. Same for
   * `unwrap` (leaf -> its string) and `project` (node -> child N). Identity
   * proves the tree matched; it cannot prove the RIGHT child came out.
   *
   * This is the third time the pattern has decided a design here — the field map
   * and the dispatch arm were the first two — so it is written down rather than
   * rediscovered.
   */
  it('collapse / unwrap / project select the RIGHT child', () => {
    const r = checkIdentity(selectNodes, 'Doc', [
      { name: 'collapse', input: 'abc' },
      { name: 'unwrap', input: '123' },
      { name: 'project-seq', input: 'abc' },
      { name: 'mixed', input: 'abc123' },
      { name: 'empty', input: '' },
      { name: 'garbage', input: '###' },
    ])
    expect(r.mismatches).toEqual([])

    const table = tableRules(encodeTable(selectNodes)).Doc!
    const kids = (input: string): unknown[] =>
      (run(table as never, input).value as { c: unknown[] }).c

    // project picks child 1 of ('a','b','c') — an off-by-one yields 'a' or 'c'.
    expect(kids('abc')[0]).toBe('b')

    // unwrap turns the single captured LEAF into its string value, so the result
    // is a bare string and NOT a leaf object. Collapse would have left the leaf.
    expect(kids('123')[0]).toBe('123')
    expect(typeof kids('123')[0]).toBe('string')
  })

  it('collapse with a non-single child arity falls through to the default node', () => {
    // `collapse` applies ONLY at exactly one captured child. Zero or two-plus has
    // no selection to make and (for a builder-less node) no builder to call — the
    // interpreter emits the default CST node there. That arity is precisely the
    // input a hand-picked case misses, so it is pinned.
    const table = tableRules(encodeTable(selectNodes)).Doc!
    const collapsed = (run(table as never, 'abc123').value as { c: unknown[] }).c
    expect(collapsed.length).toBeGreaterThan(0)
  })

  it('trailingTrivia consumes into THIS node, not the parent', () => {
    const r = checkIdentity(trailingTriviaNodes, 'Root', [
      { name: 'no-trailing', input: 'ab cd' },
      { name: 'trailing-ws', input: 'ab cd   ' },
      { name: 'only-ws', input: '   ' },
      { name: 'empty', input: '' },
    ], { trivia: jsonWs })
    expect(r.mismatches).toEqual([])

    // The node's SPAN must extend over the trailing run. Consuming it after the
    // capture scope closed would leave the span short and log it in the parent.
    const table = tableRules(encodeTable(trailingTriviaNodes)).Root!
    const withTail = run(table as never, 'ab cd   ', { trivia: jsonWs as never }).value as { end: number }
    const noTail = run(table as never, 'ab cd', { trivia: jsonWs as never }).value as { end: number }
    expect(noTail.end).toBe(5)
    expect(withTail.end).toBe(8)
  })

  it('the driver FAILS CLOSED on runtime options it has no path for', () => {
    // `rootTrivia` is not detectable at encode time — it arrives with the parse —
    // and is a silent divergence rather than an error if unguarded: no
    // `_rootTriviaLog` is ever written, so comments would vanish from the AST.
    const table = tableRules(encodeTable(baseNodes)).Doc!
    // `run()` itself rejects this one earlier (it needs labeled grammar trivia),
    // so the guard is belt-and-braces rather than the only thing standing there.
    expect(() => run(table as never, 'abc', { rootTrivia: { select: ['comment'] } })).toThrow()
  })

  /**
   * THE HOST PATH.
   *
   * `cstBuildHost` here is parseman's OWN shipped host — the same one jess's
   * `cssCstBuildHost` is built from (`parsemanCstBuildHost({ tags: true })`,
   * css-parser/src/cst-host.ts:408-411). Writing a host to match the call would
   * only prove the two halves I wrote agree with each other.
   *
   * WOULD ANY EXISTING TEST HAVE CAUGHT THE BUG THIS FIXES? No. Before this,
   * `hostMode: 'cst'` tables set capture flags and never reached a host, and the
   * variants test only asserted that table CONTENTS differ and that line spans
   * appear. No test ever ran a table WITH a host, so a CST parse would have
   * returned AST nodes and looked entirely plausible. That is why these assert
   * the host's output shape and not merely that a parse succeeded.
   */
  it('a ctx.build host REPLACES the node builder, and receives type and tags', () => {
    const host = cstBuildHost({ tags: true })
    const table = tableRules(encodeTable(hostNodes)).Doc!
    const out = run(table as never, 'abc', { build: host as never })
    expect(out.ok).toBe(true)

    // The node's OWN reducer returns { t: 'Doc' }. Under a CST host it must be
    // bypassed entirely — seeing `t` here means the builder ran and the host did
    // not, which is the silent failure this path exists to prevent.
    const root = out.value as Record<string, unknown>
    expect(root.t).toBeUndefined()
    expect(root._tag).toBe('node')
    expect(root.type).toBe('Doc')

    // tags reach the host as the 8th argument; jess puts them on every CST node.
    const kid = (root.children as Array<Record<string, unknown>>)[0]!
    expect(kid.type).toBe('Marked')
    expect(kid.tags).toEqual(['decl'])
  })

  it('host collapse applies to a node WITH a reducer, not just builder-less ones', () => {
    // Gating collapse on `!build` made `cstBuildHost({ collapse })` a silent
    // no-op for every grammar whose rules carry reducers. jess turns this on for
    // `NamedColor`, which HAS a reducer, so the reducer-bearing case is the one
    // that matters and the one asserted here.
    const collapsing = cstBuildHost({ tags: true, collapse: (t: string) => t === 'Marked' })
    const table = tableRules(encodeTable(hostNodes)).Doc!
    const out = run(table as never, 'abc', { build: collapsing as never })
    const kid = ((out.value as Record<string, unknown>).children as Array<Record<string, unknown>>)[0]!
    // Collapsed: the node IS its single child, so the leaf surfaces directly.
    expect(kid._tag).toBe('leaf')
    expect(kid.value).toBe('abc')
  })

  it('a host parse and a builder parse of the same table differ', () => {
    // The table is IDENTICAL in both runs — only the runtime host differs. If
    // these agreed, the host would not be reaching the node at all.
    const table = tableRules(encodeTable(hostNodes)).Doc!
    const withHost = JSON.stringify(run(table as never, 'abc', { build: cstBuildHost({ tags: true }) as never }).value)
    const withBuilder = JSON.stringify(run(table as never, 'abc').value)
    expect(withHost).not.toBe(withBuilder)
    expect(withBuilder).toContain('"t":"Doc"')
  })
})
