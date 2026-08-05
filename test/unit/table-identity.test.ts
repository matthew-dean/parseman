import { describe, expect, it } from 'vitest'
import { checkIdentity } from '../../bench/table-lowering-identity.ts'
import { baseNodes, dispatchNoFallback, dispatchNodes, fieldNodes, cutUnderChoice, cutUnderMany, forbidSep, hostNodes, jsonRules, jsonWs, rootTriviaNodes, selectNodes, trailingSep, trailingTriviaNodes } from '../../bench/table-grammars.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import { opHistogram } from '../../src/table/inspect.ts'
import { run } from '../../src/functional/run.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
import { literal, many, node, oneOrMore, oneOrMoreSep, regex, rules, sepBy } from '../../src/index.ts'
import { csvParser } from '../../examples/csv/parser.ts'
import type { Combinator } from '../../src/types.ts'

/**
 * CI gate for the table lowering (`src/table/`, design ledger G5).
 *
 * The lane's own gate is `bench/table-lowering-sweep.ts`, which is run by hand over seven
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
    // TWO CASES ARE KNOWN-DIVERGENT and named rather than excluded, so this fails
    // if a THIRD appears or if these are fixed without the list being updated.
    //
    // Both are failure-REPORTING divergences, newly visible because the identity
    // digest now covers `expected` — it compared only success before, which made
    // every difference in HOW a parse fails invisible to every sweep. The
    // remaining gap is furthest-failure merging: both engines report the set at
    // the furthest position reached (so `[1,2,]` includes the enclosing `"]"`),
    // while the table reports the failing choice's own union at its own
    // position. The trees and consumption agree; only the expected set differs.
    const KNOWN_EXPECTED_SET_DIVERGENCE = ['bad-trailing-comma', 'bad-unclosed']
    expect([...new Set(r.mismatches.map(m => m.case))].sort())
      .toEqual(KNOWN_EXPECTED_SET_DIVERGENCE)
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
    // (The full check lives in bench/table-variants.ts; this pins the table half.)
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
 * The full sweep, promoted from `bench/table-lowering-sweep.ts` into CI.
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
    const { checkIdentity: ci } = await import('../../bench/table-lowering-identity.ts')
    const { JSON_CASES } = await import('./table-identity-cases.ts')
    const r = ci(jsonRules as unknown as Record<string, Combinator<unknown>>, 'Value', JSON_CASES, { trivia: jsonWs })
    // Two KNOWN failure-reporting divergences, named rather than excluded, so a
    // third one fails this and so does fixing these without updating the list.
    // Newly visible: the identity digest now covers `expected`, where before it
    // compared only success. The residual gap is furthest-failure merging —
    // both engines report the set at the furthest position reached (so `[1,2,]`
    // includes the enclosing `"]"`) while the table reports the failing choice's
    // own union at its own position. Trees and consumption agree.
    const KNOWN_EXPECTED_SET_DIVERGENCE = ['bad-trailing-comma', 'bad-unclosed']
    expect([...new Set(r.mismatches.map(m => m.case))].sort(), JSON.stringify(r.mismatches.slice(0, 3)))
      .toEqual(KNOWN_EXPECTED_SET_DIVERGENCE)
    expect(r.total).toBeGreaterThan(0)
  })

  it('node ladder at 4, 8, 16 and 32 rules', async () => {
    const { checkIdentity: ci } = await import('../../bench/table-lowering-identity.ts')
    const { nodeLadder } = await import('../../bench/table-grammars.ts')
    const { ladderCases } = await import('./table-identity-cases.ts')
    for (const n of [4, 8, 16, 32]) {
      const r = ci(nodeLadder(n), 'Root', ladderCases(n))
      expect(r.mismatches, `ladder ${n}: ${JSON.stringify(r.mismatches.slice(0, 2))}`).toEqual([])
    }
  })

  it('the node-building base grammar', async () => {
    const { checkIdentity: ci } = await import('../../bench/table-lowering-identity.ts')
    const { BASE_CASES } = await import('./table-identity-cases.ts')
    const r = ci(baseNodes, 'Doc', BASE_CASES)
    expect(r.mismatches, JSON.stringify(r.mismatches.slice(0, 3))).toEqual([])
  })

  it('the 29-rule Less workload grammar on real stylesheet input', async () => {
    const { checkIdentity: ci } = await import('../../bench/table-lowering-identity.ts')
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
      // 'abc' is eaten by Proj, which sits AHEAD of Coll — so none of the
      // original cases ever reached the collapse branch at all. 'zzz' does.
      { name: 'collapse', input: 'zzz' },
      { name: 'unwrap', input: '123' },
      { name: 'project-seq', input: 'abc' },
      { name: 'collapse-multi', input: 'zz!zz' },
      { name: 'mixed', input: 'abc123zzz' },
      { name: 'empty', input: '' },
      { name: 'garbage', input: '###' },
    ])
    expect(r.mismatches).toEqual([])

    const table = tableRules(encodeTable(selectNodes)).Doc!
    const kids = (input: string): unknown[] =>
      (run(table as never, input).value as { c: unknown[] }).c

    // project picks child 1 of ('a','b','c') — an off-by-one yields 'a' or 'c'.
    expect(kids('abc')[0]).toBe('b')

    // COLLAPSE: the node IS its single captured child, so what surfaces is the
    // CHILD's node type, never 'Coll'. Deleting the collapse branch yields a
    // 'Coll' node here instead, which this now catches.
    const collapsed = kids('zzz')[0] as Record<string, unknown>
    expect(collapsed.t).toBe('Marker')

    // unwrap turns the single captured LEAF into its string value, so the result
    // is a bare string and NOT a leaf object. Collapse would have left the leaf.
    expect(kids('123')[0]).toBe('123')
    expect(typeof kids('123')[0]).toBe('string')
  })

  it('collapse at a NON-single arity falls through to the default node', () => {
    // `collapse` applies ONLY at exactly one captured child. `CollMulti` captures
    // two, so there is no selection and no builder — the default CST node is the
    // only branch left. The previous version of this test used a grammar whose
    // collapse body was always single-child, so the arity it named could not
    // occur, and `expect(length).toBeGreaterThan(0)` passed for any non-empty
    // array regardless.
    const table = tableRules(encodeTable(selectNodes)).Doc!
    const kids = (run(table as never, 'zz!zz').value as { c: unknown[] }).c
    const node0 = kids[0] as Record<string, unknown>
    expect(node0._tag).toBe('node')
    expect(node0.type).toBe('CollMulti')
    expect((node0.children as unknown[]).length).toBe(3)
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

  /*
   * DELETED: 'the driver FAILS CLOSED on runtime options it has no path for'.
   *
   * It asserted a bare `toThrow()` on `run({ rootTrivia })` for a grammar with
   * unlabelled trivia — which is `run.ts:273`'s OWN precondition, thrown before
   * the driver is reached, and thrown identically by the interpreted entry. The
   * driver contributed nothing to it. It had already outlived the guards it was
   * written for: both were removed when the host and root-trivia paths landed,
   * and the test stayed green because it was never testing them.
   *
   * A test that passes with the feature deleted is not covering the feature.
   * The root-trivia behaviour that IS the driver's is covered by the two tests
   * above, which assert a specific comment's marker span and that an unselected
   * kind records nothing.
   */
  it('a ctx.build host REPLACES the node builder, and receives type and tags', () => {
    // ENCODE FOR THE MODE YOU DRIVE. An 'ast' artifact given a CST host is
    // rejected by `assertHostModeCompatible` — the compiled engine forbids that
    // pairing, and these tests only passed before because the table carried no
    // stamped mode at all.
    const host = cstBuildHost({ tags: true })
    const table = tableRules(encodeTable(hostNodes, { hostMode: 'cst' })).Doc!
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
    const table = tableRules(encodeTable(hostNodes, { hostMode: 'cst' })).Doc!
    const out = run(table as never, 'abc', { build: collapsing as never })
    const kid = ((out.value as Record<string, unknown>).children as Array<Record<string, unknown>>)[0]!
    // Collapsed: the node IS its single child, so the leaf surfaces directly.
    expect(kid._tag).toBe('leaf')
    expect(kid.value).toBe('abc')
  })

  it('a host parse and a builder parse of the same table differ', () => {
    // The table is IDENTICAL in both runs — only the runtime host differs. If
    // these agreed, the host would not be reaching the node at all.
    // Two TABLES from one grammar — the 'cst' one is driven with a host, the
    // 'ast' one with its own builders. That is the shape the engine allows, and
    // the two must differ or the host is not reaching the node.
    const cstTable = tableRules(encodeTable(hostNodes, { hostMode: 'cst' })).Doc!
    const astTable = tableRules(encodeTable(hostNodes)).Doc!
    const withHost = JSON.stringify(run(cstTable as never, 'abc', { build: cstBuildHost({ tags: true }) as never }).value)
    const withBuilder = JSON.stringify(run(astTable as never, 'abc').value)
    expect(withHost).not.toBe(withBuilder)
    expect(withBuilder).toContain('"t":"Doc"')
  })

  it('a parse allocates ZERO regex objects — same identity across parses', () => {
    // notes/derived-tokenization.md §10.4.3 records that a codegen parse
    // allocates no regex per parse, because emitted literals sit in a per-rule
    // IIFE closure evaluated once at module load. A TABLE HAS NO PER-RULE
    // IIFEs, so the property has to be re-established rather than inherited.
    //
    // It holds by a different mechanism: regexes are built once at ENCODE time
    // into the const pool (`encode.ts` `this.constant(new RegExp(...))`) and the
    // driver only READS `k[i]`. Identity across parses is the observable form of
    // "not reallocated" — a fresh RegExp each parse would compare unequal.
    // COMPARING THE POOL TO ITSELF PROVES NOTHING — both snapshots read the same
    // array the driver only ever reads, so rebuilding the RegExp on every match
    // leaves this green. The observable that distinguishes them is `lastIndex`:
    // the driver sets it on the POOLED object before `exec`. If it rebuilt per
    // match, the pooled object would never be touched and stay at 0.
    const prog = encodeTable(baseNodes)
    const pooled = prog.k.filter((x): x is RegExp => x instanceof RegExp)
    expect(pooled.length).toBeGreaterThan(0)
    for (const re of pooled) re.lastIndex = 0

    const table = tableRules(prog).Doc!
    run(table as never, '(a,1)zz(b)7')

    // At least one pooled regex must show it was USED by the parse.
    expect(pooled.some(re => re.lastIndex !== 0)).toBe(true)
    // And the pool is still the same objects — no entry was replaced.
    const after = prog.k.filter((x): x is RegExp => x instanceof RegExp)
    expect(after.length).toBe(pooled.length)
    for (let i = 0; i < pooled.length; i++) expect(after[i]).toBe(pooled[i])
  })

  /**
   * ROOT TRIVIA — asserted as a SPECIFIC comment at a SPECIFIC place.
   *
   * "a log exists" or "length > 0" would pass while the wrong span, the wrong
   * kind, or somebody else's comment was recorded. Comments silently vanishing
   * from an AST is the same failure shape as ambient trivia silently absent:
   * every path agrees and nothing is proven.
   *
   * THE SEMANTIC THAT IS WRONG BY INFERENCE: root rows are written ONLY on the
   * labelled scan path (trivia-skip.ts:212). The unlabelled fast scanner returns
   * before any root logging and does not even TEST `_rootTriviaLog`, so trivia
   * without kind labels captures nothing at the root. `run()` reads those labels
   * off the ENTRY's `_meta` and takes a `typeof r === 'function'` branch for
   * compiled entries — and a table entry is a function too.
   */
  it('rootTrivia records the exact comment span, and matches the interpreter', () => {
    const input = 'aa /* keep me */ bb'
    const opts = { rootTrivia: { select: ['comment'] } } as never
    const table = tableRules(encodeTable(rootTriviaNodes)).Doc!

    const fromTable = run(table as never, input, opts)
    const fromInterp = run(rootTriviaNodes.Doc! as never, input, opts)
    expect(fromTable.ok).toBe(true)

    // [gapStart, gapEnd, markerStart, markerEnd, selectedKindIndex]
    // The comment is at 3..16; the surrounding gap (space before, space after)
    // is 2..17. A row that recorded the GAP as the marker would still be
    // "nonzero length" and would still be wrong.
    expect([...fromTable.rootTrivia!.rows]).toEqual([2, 17, 3, 16, 0])
    expect(input.slice(3, 16)).toBe('/* keep me */')
    expect(fromTable.rootTrivia!.select).toEqual(['comment'])
    expect([...fromTable.rootTrivia!.rows]).toEqual([...fromInterp.rootTrivia!.rows])
  })

  it('an UNSELECTED trivia kind records no root row', () => {
    // Whitespace is labelled but not selected, so it must produce nothing —
    // a driver that logged every trivia run would still pass a length check.
    const opts = { rootTrivia: { select: ['comment'] } } as never
    const table = tableRules(encodeTable(rootTriviaNodes)).Doc!
    const fromTable = run(table as never, 'aa    bb', opts)
    const fromInterp = run(rootTriviaNodes.Doc! as never, 'aa    bb', opts)
    expect(fromTable.ok).toBe(true)
    // Nothing selected matched, so no capture is produced at all — the shape is
    // `undefined`, not an empty rows array. Pinned against the interpreter so
    // the assertion states the engine's behaviour rather than my expectation of
    // it; guessing `[]` here was wrong and the driver was right.
    expect(fromTable.rootTrivia?.rows ?? null).toEqual(fromInterp.rootTrivia?.rows ?? null)
    expect(fromTable.rootTrivia).toBeUndefined()
  })

  it('the table entry carries the trivia metadata run() reads off it', () => {
    // Without this stamp `run({ rootTrivia })` rejects a grammar that plainly
    // HAS labelled trivia, because it inspects the entry rather than the table.
    const entry = tableRules(encodeTable(rootTriviaNodes)).Doc!
    expect((entry as { _meta?: { triviaKindLabels?: readonly string[] } })._meta?.triviaKindLabels)
      .toEqual(['space', 'comment'])
  })

  /**
   * ROUND-TRIP: emit -> load -> parse, compared against the in-memory table.
   *
   * Emitting IS the point of this lowering, and it had NO behavioural coverage —
   * the only emit test asserted the output STRING contained `tableRules(` and no
   * `function`. Nothing ever fed an emitted module back through `tableRules` and
   * parsed with it, so every field the driver reads but the emitter forgot to
   * write was invisible. Two such fields shipped: `p` (dispatch specs) threw
   * "Cannot read properties of undefined (reading 'byKey')" on every input, and
   * `lb`/`rc` silently dropped the trivia metadata `run({ rootTrivia })` needs.
   *
   * A string assertion cannot catch a missing field. Only a parse can.
   */
  function roundTrip(prog: ReturnType<typeof encodeTable>, fnSources: string[]): Record<string, unknown> {
    const src = emitTableModule(prog, { name: 'g', fnSources })
    // Strip the import and evaluate the literal, so the test exercises the
    // EMITTED SHAPE rather than a module loader.
    const body = src.replace(/^import .*$/m, '').replace(/^export const g = /m, 'return ')
    // eslint-disable-next-line no-new-func
    return (new Function('tableRules', `${body}`) as (t: typeof tableRules) => Record<string, unknown>)(tableRules)
  }

  it('an emitted DISPATCH grammar round-trips and parses', () => {
    const prog = encodeTable(dispatchNodes)
    expect(prog.dsp.length).toBeGreaterThan(0)
    const emitted = roundTrip(prog, [
      `() => 'K:media'`, `() => 'CI:import'`, `() => 'M:vendor'`, `v => 'O:' + String(v)`,
    ])
    const inMemory = tableRules(prog)
    for (const input of ['@media', '@IMPORT', '@-webkit-x', '@whatever', 'nope']) {
      const a = run(inMemory.Doc! as never, input)
      const b = run(emitted.Doc as never, input)
      expect(b.ok).toBe(a.ok)
      expect(JSON.stringify(b.value)).toBe(JSON.stringify(a.value))
    }
  })

  it('a TRIVIA-BEARING grammar round-trips through the emitted module', () => {
    // The test that could not exist before trivia lowered. This grammar has
    // LABELLED ambient trivia, which used to park a live combinator in the const
    // pool so emit refused outright — and that refusal covered every
    // `rules({ trivia }, …)` grammar, which is all four shipping dialects.
    //
    // `classifiedTrivia()` is `trivia(oneOrMore(choice(label(name, arm)…)))`
    // with regex arms (src/combinators/map.ts), so it lowers to
    // `[label, source, flags]` triples and is rebuilt at load with the SHARED
    // constructor — one trivia implementation, not a second one over the table.
    const prog = encodeTable(rootTriviaNodes)
    expect(prog.labels).toEqual(['space', 'comment'])
    expect(prog.triviaSpecs?.[0]?.arms.map(a => a[0])).toEqual(['space', 'comment'])
    expect(prog.runtimeOnly).toBeUndefined()

    // The emitted module needs the grammar's REAL reducers, in pool order —
    // placeholders would make the trees differ for a reason that has nothing to
    // do with the lowering under test.
    expect(prog.fns.length).toBe(2)
    const emitted = roundTrip(prog, [`c => ({ t: 'Word', c })`, `c => ({ t: 'Doc', c })`])
    const inMemory = tableRules(prog)
    const input = 'aa /* keep me */ bb'
    const opts = { rootTrivia: { select: ['comment'] } } as never

    // The emitted entry carries the metadata `run()` reads off it...
    expect((emitted.Doc as { _meta?: { triviaKindLabels?: readonly string[] } })._meta?.triviaKindLabels)
      .toEqual(['space', 'comment'])
    // ...produces the same tree...
    const a = run(inMemory.Doc! as never, input, opts)
    const b = run(emitted.Doc as never, input, opts)
    expect(JSON.stringify(b.value)).toBe(JSON.stringify(a.value))
    // ...and the same root-trivia rows, with the comment's own marker span.
    expect([...b.rootTrivia!.rows]).toEqual([...a.rootTrivia!.rows])
    expect([...b.rootTrivia!.rows]).toEqual([2, 17, 3, 16, 0])
    expect(input.slice(3, 16)).toBe('/* keep me */')
  })

  it('the emitter WRITES every field expandCompact reads', () => {
    // Field-by-field, write side against read side. A missing field is invisible
    // to a string assertion and fatal to a parse, which is why the round-trips
    // above exist — this one only guards the enumeration.
    const READ_BY_EXPAND = ['c', 'k', 'x', 'e', 'd', 'r', 'f', 'l', 'p', 'lb', 'rc', 'h', 'tv']
    const dispatchSrc = emitTableModule(encodeTable(dispatchNodes), { name: 'g', fnSources: ['() => 0', '() => 0', '() => 0', '() => 0'] })
    for (const key of ['c', 'k', 'x', 'e', 'd', 'r', 'f', 'p']) {
      expect(dispatchSrc, `emitter must write "${key}:"`).toContain(`${key}:`)
    }
    const triviaSrc = emitTableModule(encodeTable(rootTriviaNodes), { name: 'g', fnSources: encodeTable(rootTriviaNodes).fns.map(() => '() => 0') })
    for (const key of ['lb', 'rc', 'tv']) {
      expect(triviaSrc, `emitter must write "${key}:"`).toContain(`${key}:`)
    }
    const cstSrc = emitTableModule(encodeTable(hostNodes, { hostMode: 'cst' }), { name: 'g', fnSources: ['() => 0', '() => 0'] })
    expect(cstSrc).toContain('h:"cst"')
    expect(READ_BY_EXPAND.length).toBe(13)
  })

  it('a hostMode:cst table run WITHOUT a host throws, as the compiled engine does', () => {
    // Encoding with hostMode:'cst' forces the capture flags on, but nothing
    // stamped the mode onto the entry — so `run()` read it as 'ast' and the
    // table returned the grammar's own AST objects with ok:true while paying
    // full CST capture. `encodeTable` with `hostMode` had ZERO coverage.
    const cst = tableRules(encodeTable(hostNodes, { hostMode: 'cst' }))
    expect(() => run(cst.Doc! as never, 'abc')).toThrow()

    // With a CST host it is fine, and the host — not the reducer — builds.
    const withHost = run(cst.Doc! as never, 'abc', { build: cstBuildHost({ tags: true }) as never })
    expect(withHost.ok).toBe(true)
    expect((withHost.value as Record<string, unknown>).t).toBeUndefined()

    // And an 'ast' table is unaffected.
    const ast = tableRules(encodeTable(hostNodes))
    expect(run(ast.Doc! as never, 'abc').ok).toBe(true)
  })

  /**
   * THE CUT. `dispatch()` is the library's one true cut and `attempt()`
   * deliberately does not undo it. The driver SET `ctx._fc` and read it nowhere,
   * so the cut existed in name only: the table accepted input both shipped
   * engines reject, and `many(dispatch(...))` — the real `many(AtRule)` shape —
   * returned `ok: true` with a SILENTLY TRUNCATED document.
   *
   * Compared against BOTH engines rather than asserted from expectation.
   */
  it('a failed dispatch branch cuts, under choice and under repetition', () => {
    for (const [name, g, input] of [
      ['choice', cutUnderChoice, '@x'],
      ['many', cutUnderMany, '@x!@x'],
    ] as const) {
      const table = tableRules(encodeTable(g)).Doc!
      const fromTable = run(table as never, input)
      const fromInterp = run(g.Doc! as never, input)
      expect(fromTable.ok, `${name}: must not accept what the interpreter rejects`).toBe(fromInterp.ok)
      expect(fromTable.ok).toBe(false)
      expect(fromTable.unconsumedFrom).toBe(fromInterp.unconsumedFrom)
    }
  })

  it('sepBy trailing:allow keeps the trailing separator; forbid does not', () => {
    // Bit 0 of the repetition flags was WRITTEN by the encoder and read by
    // nobody, so 'a,b,' stopped at 3 while both engines consumed to 4. The
    // contrast against `forbid` is what makes this test about the BIT rather
    // than about the parse happening to succeed.
    const allow = tableRules(encodeTable(trailingSep)).Doc!
    const forbid = tableRules(encodeTable(forbidSep)).Doc!

    const a = run(allow as never, 'a,b,')
    expect(a.ok).toBe(true)
    expect(a.unconsumedFrom).toBe(run(trailingSep.Doc! as never, 'a,b,').unconsumedFrom)
    expect(a.unconsumedFrom).toBe(null)

    const f = run(forbid as never, 'a,b,')
    expect(f.unconsumedFrom).toBe(run(forbidSep.Doc! as never, 'a,b,').unconsumedFrom)
    expect(f.unconsumedFrom).toBe(3)
  })

  /**
   * A NULLABLE repetition ITEM — the one shape the 2,833-file corpus sweep never
   * contained, and the only known case where the table was the odd engine out. It
   * was found in parseman's own `examples/csv`, whose unquoted field is
   * a regex matching a possibly-empty run of non-comma, non-newline characters:
   * an empty CSV line is ONE empty field, not zero fields.
   *
   * `repItem`'s zero-width stop is a TERMINATION device — a `many` loop whose only
   * source of progress is the item spins forever without it. The driver applied it
   * to every item, including the ones `repItem` never parses: `oneOrMore`/`atLeast`
   * parse the mandatory first item themselves (repeat.ts:203) and `sepBy` parses
   * BOTH its first (:412) and every post-separator item (:481) itself, because a
   * separated list is advanced by its SEPARATOR and needs no such stop. The result
   * was a table that returned `[]` for `sepBy` over `",a"` having consumed NOTHING
   * — a wrong tree that dropped real input, with no error.
   *
   * Pinned as the ENGINE-AGREEMENT it is, plus the literal values, so neither a
   * table regression nor a silent move in the two shipped engines can pass.
   */
  it('a NULLABLE repetition item: all three engines agree, and count a zero-width item', () => {
    const Field = regex(/[^,]*/)
    const shapes = {
      Many: many(Field),
      More: oneOrMore(Field),
      Sep: sepBy(Field, literal(',')),
      SepMin: oneOrMoreSep(Field, literal(',')),
      SepTrail: sepBy(Field, literal(','), { trailing: 'allow' }),
    } as unknown as Record<string, Combinator<unknown>>

    const r = checkIdentity(shapes, 'Sep', [
      { name: 'empty', input: '' },
      { name: 'bare-sep', input: ',' },
      { name: 'two-seps', input: ',,' },
      { name: 'trailing-empty', input: 'a,' },
      { name: 'leading-empty', input: ',a' },
      { name: 'plain', input: 'a,b' },
    ])
    expect(r.mismatches).toEqual([])
    expect(r.matched).toBe(r.total)

    const tbl = tableRules(encodeTable(shapes))
    const val = (rule: string, input: string): unknown => run(tbl[rule]! as never, input).value
    // A SEPARATED list counts items as separators + 1, zero-width or not — the
    // `,a` row is the one no reading of `(item (sep item)*)?` can call `[]`.
    expect(val('Sep', '')).toEqual([''])
    expect(val('Sep', ',')).toEqual(['', ''])
    expect(val('Sep', ',a')).toEqual(['', 'a'])
    expect(val('Sep', 'a,')).toEqual(['a', ''])
    expect(val('SepMin', '')).toEqual([''])
    expect(val('SepTrail', 'a,')).toEqual(['a', ''])
    // `many` is the one that genuinely must stop: its loop has no other source of
    // progress, so a zero-width item ends the list and yields NO item.
    expect(val('Many', '')).toEqual([])
    expect(val('Many', ',a')).toEqual([])
    // …and the mandatory first item is not subject to that stop, in all three.
    expect(val('More', '')).toEqual([''])
    expect(val('More', ',a')).toEqual([''])
  })

  it('the csv example drops its trailing empty row on all three engines', () => {
    // The defect's real-world face: `row` is `sepBy(field, comma)` over a nullable
    // field, and the grammar's drop-trailing-empty-row transform tests for exactly
    // `['']`. Under the table's `[]` it never fired, so a 4-row fixture parsed as
    // 5 — a wrong tree, no error, invisible to every assertion but this one.
    const map = { CSV: csvParser } as unknown as Record<string, Combinator<unknown>>
    const r = checkIdentity(map, 'CSV', [
      { name: 'trailing-newline', input: 'a,b\n1,2\n3,4\n5,6\n' },
      { name: 'no-trailing-newline', input: 'a,b\n1,2' },
      { name: 'empty-fields', input: 'a,,b\n,,\n' },
    ])
    expect(r.mismatches).toEqual([])
    expect(run(tableRules(encodeTable(map)).CSV! as never, 'a,b\n1,2\n3,4\n5,6\n').value)
      .toEqual([['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']])
  })
})
