import { describe, expect, it } from 'vitest'
import { compileRuleMap } from '../../src/table/compile-rule-map.ts'
import { compileLinkableTable } from '../../src/compiler/compile-linkable-table.ts'
import { tableRules } from '../../src/table/index.ts'
import { run } from '../../src/functional/run.ts'
import { choice, literal, regex, rules, sepBy, sequence, transform } from '../../src/index.ts'
import { jsonRules, JSON_FN_SOURCES, baseNodes } from '../../bench/table-grammars.ts'
import type { Combinator } from '../../src/types.ts'

/**
 * `compileRuleMap()` — the table counterpart of `compileRuleMap()`.
 *
 * The main macro path is `rules()` grammars, and it goes through
 * `compileRuleMap`. `compile` only ever covered `compile()`, the
 * single-root entry the plugin uses for standalone combinators, so a `rules()`
 * grammar had nothing to be pointed at.
 *
 * Everything here is a DIFFERENTIAL against the interpreter, and it compares
 * `expected` as well as value and span. `expected` is NOT in the identity
 * digest — a lowering that accepts and rejects exactly the right inputs while
 * reporting a different error passes the whole sweep — and divergences have
 * hidden there before.
 */

type Case = { name: string; input: string }

/** One rule, both engines, all four observable fields. */
function differential(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  tabled: Record<string, (input: string, pos: number, ctx: never) => unknown>,
  rule: string,
  input: string,
): { table: ReturnType<typeof run>; interp: ReturnType<typeof run> } {
  const entry = ruleMap.find(([k]) => k === rule)![1]
  return {
    // `run()` on BOTH sides, so the envelope (`expected` promotion, trailing
    // trivia, `unconsumedFrom`) is the same code in both and only the engine
    // underneath differs. Comparing a raw ParseResult to a RunResult would have
    // compared two shapes as well as two engines.
    table: run(tabled[rule] as never, input),
    interp: run(entry as never, input),
  }
}

describe('compileRuleMap() matches compileRuleMap()\'s contract', () => {
  const jsonEntries = Object.entries(jsonRules as unknown as Record<string, Combinator<unknown>>)

  it('returns keys, a replacement, a host mode and a runnable map', () => {
    const c = compileRuleMap(jsonEntries, { fnSources: JSON_FN_SOURCES })
    expect(c).not.toBeNull()
    if (!c) return
    // `keys` is the entry list the caller validates against the source's own.
    expect(c.keys).toEqual(jsonEntries.map(([k]) => k))
    expect(c.hostMode).toBe('ast')
    // FALSE, and that is the corrected reading rather than a loosened one.
    // `hostBranchElided` means "a DIRECT BUILDER's positioned-CST branch was
    // dropped" — it is what makes `'ast' artifact + CST host` an error. This
    // grammar is all `transform()`; it owns no `node()` builder, so there was no
    // branch to drop and it stays usable with either host. The old `mode === 'ast'`
    // rule reported `true` for every ast artifact, which contradicted
    // `macro-host-mode.test.ts`'s "leaves an all-STRUCTURAL grammar usable with
    // either host" and made the two stamps disagree.
    expect(c.hostBranchElided).toBe(false)
    // ONE expression, evaluating ONCE to the whole map — not one expression per
    // key. That is what `compileRuleMap` returns and what the plugin splices
    // over the entire `rules(factory)` call.
    expect(c.replacement.startsWith('/* @__PURE__ */ tableRules({')).toBe(true)
    expect(c.replacement.trimEnd().endsWith('})')).toBe(true)
    expect(Object.keys(c.rules).sort()).toEqual(jsonEntries.map(([k]) => k).sort())
  })

  /**
   * The all-or-nothing gate, which is the half a "does it parse" test cannot
   * see. `compileRuleMap` returns null when a transform/build callback has no
   * captured source, because otherwise the emitted artifact LOADS and returns
   * the wrong tree. The table pool has the same exposure — the emitters print
   * `() => {}` per unsourced entry — so it needs the same refusal.
   */
  it('REFUSES to compile a map whose reducers have no source', () => {
    expect(compileRuleMap(jsonEntries)).toBeNull()
  })

  it('rejects a positional fnSources list that cannot belong to this pool', () => {
    expect(() => compileRuleMap(jsonEntries, { fnSources: [...JSON_FN_SOURCES, 'x => x'] }))
      .toThrow(/positional/)
  })

  /** Sources CAPTURED off the def (what the macro evaluator sets) are used. */
  it('uses the source the encoder captured, with nothing passed in', () => {
    const g = twoRuleGrammar()
    const c = compileRuleMap(g)
    expect(c).not.toBeNull()
    expect(c?.replacement).toContain('v => v[1]')
  })
})

describe('compileRuleMap() is value-, span- and expected-identical to the interpreter', () => {
  const jsonEntries = Object.entries(jsonRules as unknown as Record<string, Combinator<unknown>>)
  const nodeEntries = Object.entries(baseNodes)

  const good: Case[] = [
    { name: 'object', input: '{"a":[1,2,{"b":null}],"c":"x"}' },
    { name: 'array', input: '[1, 2, [3, {"k": true}], false]' },
    { name: 'scalar', input: '"esc\\n\\u0041"' },
    // Trivia BETWEEN terms, not leading: the interpreter itself rejects leading
    // trivia when a rule is driven directly as an entry, so a padded-at-the-front
    // case would have differenced two refusals and proven nothing.
    { name: 'inner trivia', input: '{ "a" : 1 , "b" : [ 1 , 2 ] }' },
  ]

  it('agrees on VALUE and SPAN for every reachable JSON rule', () => {
    const c = compileRuleMap(jsonEntries, { fnSources: JSON_FN_SOURCES })!
    expect(c).not.toBeNull()
    for (const { name, input } of good) {
      const { table, interp } = differential(jsonEntries, c.rules, 'Value', input)
      expect(interp.ok, `${name}: interpreter must accept`).toBe(true)
      expect(table.ok, name).toBe(interp.ok)
      expect(table.value, name).toEqual(interp.value)
      expect(table.span, name).toEqual(interp.span)
      expect(table.unconsumedFrom, name).toBe(interp.unconsumedFrom)
    }
  })

  /**
   * THE FIELD THE SWEEP CANNOT SEE. `expected` is not in the identity digest,
   * so it is asserted here explicitly, per failing input, as a SET comparison.
   */
  it('agrees on the EXPECTED set for every failing JSON input', () => {
    const c = compileRuleMap(jsonEntries, { fnSources: JSON_FN_SOURCES })!
    const bad: Case[] = [
      { name: 'array hole', input: '[1,,2]' },
      { name: 'unclosed object', input: '{"a":1' },
      { name: 'missing colon', input: '{"a" 1}' },
      { name: 'bare word', input: 'nul' },
      { name: 'trailing comma in object', input: '{"a":1,}' },
      { name: 'empty', input: '' },
      { name: 'lone bracket', input: '[' },
      { name: 'unterminated string', input: '"abc' },
      { name: 'missing separator', input: '[1 2]' },
    ]
    for (const { name, input } of bad) {
      const { table, interp } = differential(jsonEntries, c.rules, 'Value', input)
      expect(table.ok, `${name}: both engines must agree on accept/reject`).toBe(interp.ok)
      expect(table.span, `${name}: failure span`).toEqual(interp.span)
      const t = [...table.expected].sort()
      const i = [...interp.expected].sort()
      if (JSON.stringify(t) === JSON.stringify(i)) continue
      /**
       * A PRE-EXISTING, UNADJUDICATED DIVERGENCE — not one this function
       * introduced. `compile()` on the same `Value` rule reports the same
       * sets (verified directly), and `test/unit/table-compile.test.ts` already
       * records it as open: on a failure under a top-level `choice` of rule
       * refs the table reports the arm that failed LAST and the interpreter
       * reports the union of every arm's first token.
       *
       * Which engine is right is not settled, so nothing here pins a set. What
       * IS pinned is the relationship actually observed — the table's set is a
       * non-empty SUBSET of the interpreter's — which moves if either engine
       * changes, in either direction, and cannot be satisfied by an empty
       * `expected` (the failure mode a bare "reports something" check misses).
       */
      expect(t.length, `${name}: table must report something`).toBeGreaterThan(0)
      expect(t.filter(x => !i.includes(x)), `${name}: table reported an expectation the interpreter does not`).toEqual([])
    }
  })

  /** Every rule as an ENTRY, not just the grammar's own start production. */
  it('agrees rule-by-rule when each entry is driven directly', () => {
    const c = compileRuleMap(jsonEntries, { fnSources: JSON_FN_SOURCES })!
    const per: Array<[string, string]> = [
      ['Str', '"hi"'], ['Num', '-1.5e3'], ['True', 'true'], ['False', 'false'],
      ['Null', 'null'], ['Arr', '[1,2]'], ['Obj', '{"a":1}'], ['Pair', '"a":1'],
      // Same rules, inputs they REJECT — expected sets compared per rule.
      ['Str', 'hi'], ['Num', 'x'], ['True', 'tru'], ['Arr', '[1'], ['Obj', '{'], ['Pair', '"a"'],
    ]
    for (const [rule, input] of per) {
      const { table, interp } = differential(jsonEntries, c.rules, rule, input)
      const at = `${rule}(${JSON.stringify(input)})`
      expect(table.ok, at).toBe(interp.ok)
      expect(table.value, at).toEqual(interp.value)
      expect(table.span, at).toEqual(interp.span)
      expect([...table.expected].sort(), `${at} expected`).toEqual([...interp.expected].sort())
    }
  })

  /** A node()-bearing map, so tree BUILDING is differenced and not only scalars. */
  it('agrees on a node()-bearing rule map', () => {
    const c = compileRuleMap(nodeEntries, { fnSources: nodeEntries.map(() => 'c => ({ t: "x", c })') })
    // The reducers here are stand-ins; identity is asserted on the RUNNABLE
    // table, which uses the encoder's live callbacks, not the printed ones.
    expect(c).not.toBeNull()
    if (!c) return
    for (const input of ['(a,b)', 'abc', '(a,1)(b)', '42', '(', 'a,']) {
      const { table, interp } = differential(nodeEntries, c.rules, 'Doc', input)
      expect(table.ok, input).toBe(interp.ok)
      expect(table.value, input).toEqual(interp.value)
      expect(table.span, input).toEqual(interp.span)
      expect([...table.expected].sort(), `${input} expected`).toEqual([...interp.expected].sort())
    }
  })
})

describe('the EMITTED expression is the same parser as the compiled one', () => {
  it('evaluates to a rule map that parses identically to the interpreter', () => {
    const g = twoRuleGrammar()
    const c = compileRuleMap(g)!
    expect(c).not.toBeNull()
    // The one stated contract divergence: the expression references
    // `tableRules` rather than carrying the driver, so the consumer supplies
    // the binding. Here that is this Function's parameter.
    const made = new Function('tableRules', `return ${c.replacement}`)(tableRules) as Record<string, unknown>
    for (const input of ['(a,b,c)', '(a)', '()', '(a,', 'a']) {
      const t = run(made.List as never, input)
      const i = run(g.find(([k]) => k === 'List')![1] as never, input)
      expect(t.ok, input).toBe(i.ok)
      expect(t.value, input).toEqual(i.value)
      expect(t.span, input).toEqual(i.span)
      expect([...t.expected].sort(), `${input} expected`).toEqual([...i.expected].sort())
    }
  })
})

describe('compileLinkableTable() — a linkable() piece IS a table', () => {
  const jsonEntries = Object.entries(jsonRules as unknown as Record<string, Combinator<unknown>>)

  it('gives a self-contained piece a table AND its IR', () => {
    const p = compileLinkableTable(twoRuleGrammar(), 'pm_two')
    expect(p).not.toBeNull()
    if (!p) return
    expect(p.ns).toBe('pm_two')
    expect(p.external).toEqual([])
    expect(p.keys).toEqual(['Atom', 'List'])
    expect(p.prog).not.toBeNull()
    expect(p.rules).not.toBeNull()
    expect(p.replacement).not.toBeNull()
    // The composable half, and the reason table-to-table composition is a
    // rule-map merge plus ONE encode rather than a merge of two already-encoded
    // programs (no offset relocation, no pool merging).
    expect(p.ir).not.toBeNull()
    expect(p.v).toMatch(/^\d+\.\d+\.\d+/)
  })

  /**
   * The IR is the half that can go missing INDEPENDENTLY of the table: it needs
   * a source per callback for exactly the reason the printer does. A piece that
   * encodes but does not serialize is the ONE case that would force composition
   * down the merge-encoded-programs route, so it is asserted rather than assumed
   * not to happen.
   */
  it('reports a table with no IR when the reducers have no captured source', () => {
    const p = compileLinkableTable(jsonEntries, 'pm_json', { fnSources: JSON_FN_SOURCES })
    expect(p).not.toBeNull()
    if (!p) return
    expect(p.prog).not.toBeNull()
    expect(p.ir).toBeNull()
  })

  it('the piece\'s table parses identically to the interpreter', () => {
    const p = compileLinkableTable(jsonEntries, 'pm_json', { fnSources: JSON_FN_SOURCES })!
    for (const input of ['{"a":[1,2]}', '[1,2,3]', '"x"', '17']) {
      const t = run(p.rules!.Value as never, input)
      const i = run(jsonEntries.find(([k]) => k === 'Value')![1] as never, input)
      expect(t.ok, input).toBe(i.ok)
      expect(t.value, input).toEqual(i.value)
      expect(t.span, input).toEqual(i.span)
      expect([...t.expected].sort(), `${input} expected`).toEqual([...i.expected].sort())
    }
  })

  /**
   * A SHAPE WITH A HOLE is not refused. `g.Inner` with no definition cannot be
   * encoded in ANY lowering — `encodeTable` resolves a lazy by calling its thunk
   * and that thunk throws — so the piece has no standalone table and keeps its
   * IR, which is how the hole gets filled: the composer merges the rule maps and
   * encodes the merged map once.
   */
  it('reports a hole rather than refusing the piece', () => {
    const holed = Object.entries(rules<Record<string, Combinator<unknown>>>(g => ({
      Item: transform(
        sequence(literal('<'), g.Inner!, literal('>')),
        v => (v as string[])[1],
      ) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>) as Array<[string, Combinator<unknown>]>
    for (const [key, rule] of holed) {
      if (key === 'Item') (rule._def as { fnSrc?: string }).fnSrc = 'v => v[1]'
    }
    const p = compileLinkableTable(holed, 'pm_holed')
    expect(p).not.toBeNull()
    if (!p) return
    // The accessed-but-undefined `g.Inner` leaks into `Object.entries` as an
    // unresolvable lazy; it is a reference, not a local rule.
    expect(p.keys).toEqual(['Item'])
    expect(p.external).toEqual(['Inner'])
    expect(p.prog).toBeNull()
    expect(p.rules).toBeNull()
    expect(p.replacement).toBeNull()
    expect(p.ir).not.toBeNull()
  })

  it('refuses an empty namespace', () => {
    expect(() => compileLinkableTable(jsonEntries, '')).toThrow(/non-empty namespace/)
  })
})

/**
 * A two-rule grammar whose reducer sources are CAPTURED on the defs, exactly as
 * the macro evaluator captures them. Self-contained (the reducers reference no
 * module-scope helper), so the emitted expression can be evaluated in a bare
 * `Function` and differenced against the interpreter.
 */
function twoRuleGrammar(): Array<[string, Combinator<unknown>]> {
  const g = rules<{ Atom: Combinator<string>; List: Combinator<unknown> }>(gr => ({
    Atom: choice(regex(/[a-z]+/), regex(/[0-9]+/)) as Combinator<string>,
    List: transform(
      sequence(literal('('), sepBy(gr.Atom, literal(',')), literal(')')),
      v => (v as [string, string[], string])[1],
    ) as Combinator<unknown>,
  }))
  const entries = Object.entries(g as unknown as Record<string, Combinator<unknown>>) as Array<[string, Combinator<unknown>]>
  for (const [key, rule] of entries) {
    if (key === 'List') (rule._def as { fnSrc?: string }).fnSrc = 'v => v[1]'
  }
  return entries
}
