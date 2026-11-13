import { describe, expect, it } from 'vitest'
import { attempt, choice, compile, compose, dispatch, lines, literal, many, node, not, optional, peek, regex, routed, rules, sequence, transform, when } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { fuseInterpreted } from '../../src/compiler/linker.ts'
import { compileRuleMapRunnable } from '../../src/table/compile-rule-map.ts'
import { run } from '../../src/functional/run.ts'
import { readers } from '../helpers/table-readers.ts'
import type { Combinator } from '../../src/types.ts'

/**
 * MERGE THE RULE MAPS AND ENCODE ONCE — the composition route the table
 * lowering is supposed to take, pinned against the interpreter.
 *
 * The claim it rests on is that table-to-table composition never has to merge
 * two ALREADY-ENCODED programs: the composer evaluates each piece back to a rule
 * map, merges the maps (later names win, which is what `compose()` MEANS), and
 * encodes the merged map once. No offset relocation, no pool merging.
 *
 * That claim is TRUE, but it was not true of the encoder as it stood, and the
 * way it failed is the reason these tests exist rather than a sweep. `case
 * 'lazy'` resolved a rule reference by calling its thunk, and a thunk closes
 * over the piece that DEFINED the reference. So a base piece's internal
 * `g.Atom` kept reaching the base's own `Atom` even after the merged map bound
 * that name to an override. Nothing threw. The merged map encoded, the table
 * parsed, and it returned the BASE's tree — open recursion, most of what
 * `compose()` is for, silently absent.
 *
 * A digest-based identity sweep cannot see that: both engines accept the same
 * inputs and reject the same inputs, and only the VALUE differs. So every case
 * here differences value, span AND `expected` against the interpreter, and at
 * least one asserts the overridden value directly rather than only agreement —
 * two engines that are both wrong in the same direction would agree.
 *
 * `fuseInterpreted` is the reference because it documents itself as having
 * `compose()`'s exact fuse semantics (later piece wins; an override reroutes the
 * base piece's own calls; composing trivia governs every rule). It MUTATES the
 * piece objects it binds, so every case builds a fresh instance per side.
 */

type Entries = Array<[string, Combinator<unknown>]>

/** The `rules()` map each piece's entries came from: runtime `compose()` links
 * recipes, so the reference side needs the map, not a copy of its entries. */
const sourceOf = new WeakMap<Entries, Record<string, unknown>>()
const entriesOf = (g: object): Entries => {
  const entries = Object.entries(g as Record<string, Combinator<unknown>>) as Entries
  sourceOf.set(entries, g as Record<string, unknown>)
  return entries
}

/** Merge pieces the way `compose()` composes them: later names win. */
function mergeMaps(pieces: Entries[]): Record<string, Combinator<unknown>> {
  const merged = new Map<string, Combinator<unknown>>()
  for (const piece of pieces) for (const [name, rule] of piece) merged.set(name, rule)
  return Object.fromEntries(merged)
}

/** The merged map as a RUNNABLE table — merge, then ONE encode. */
function tabledMerge(pieces: Entries[]): Record<string, unknown> {
  return tableRules(encodeTable(mergeMaps(pieces))) as unknown as Record<string, unknown>
}

/** Both engines over one rule and one input, all four observable fields. */
function differential(
  build: () => Entries[],
  rule: string,
  input: string,
): { table: ReturnType<typeof run>; interp: ReturnType<typeof run> } {
  return {
    table: run(tabledMerge(build())[rule] as never, input),
    interp: run(fuseInterpreted(build().map(p => sourceOf.get(p)!))[rule] as never, input),
  }
}

function expectIdentical(
  build: () => Entries[],
  rule: string,
  input: string,
): ReturnType<typeof run> {
  const { table, interp } = differential(build, rule, input)
  const at = `${rule}(${JSON.stringify(input)})`
  expect(table.ok, at).toBe(interp.ok)
  expect(table.value, at).toEqual(interp.value)
  expect(table.span, at).toEqual(interp.span)
  expect([...table.expected].sort(), `${at} expected`).toEqual([...interp.expected].sort())
  // Every reader of the one encoded program, the emitted assemblies included:
  // the rollback masks a failed choice arm reads are printed only into those.
  for (const [name, rules] of readers(encodeTable(mergeMaps(build())))) {
    const r = run(rules[rule] as never, input)
    expect({ ok: r.ok, value: r.value, span: r.span, expected: [...r.expected].sort() }, `${at} ${name}`)
      .toEqual({ ok: interp.ok, value: interp.value, span: interp.span, expected: [...interp.expected].sort() })
  }
  return table
}

describe('a MERGED rule map encodes to the parser compose() means', () => {
  /**
   * OPEN RECURSION — the case the thunk resolver got wrong. `Doc` is defined by
   * the BASE and references `Atom`; a later piece overrides `Atom`. The base's
   * own call must reroute to the override.
   */
  const overridden = (): Entries[] => [
    entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
      Atom: transform(literal('a'), () => 'BASE-ATOM') as Combinator<unknown>,
      Doc: transform(
        sequence(literal('<'), g.Atom!, literal('>')),
        v => ['Doc', (v as unknown[])[1]],
      ) as Combinator<unknown>,
    }))),
    entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({
      Atom: transform(literal('a'), () => 'OVER-ATOM') as Combinator<unknown>,
    }))),
  ]

  it('reroutes a BASE rule\'s own reference to a later override', () => {
    const table = expectIdentical(overridden, 'Doc', '<a>')
    // Asserted DIRECTLY, not only as agreement: the failure this pins is a
    // silently wrong VALUE, and two engines wrong the same way would agree.
    expect(table.value).toEqual(['Doc', 'OVER-ATOM'])
  })

  it('agrees on span and expected when the overridden rule FAILS', () => {
    for (const input of ['<b>', '<a', '<', '', 'a>']) {
      expectIdentical(overridden, 'Doc', input)
    }
  })

  /**
   * An override that can commit a failure where the base's rule cannot. The rollback
   * census has to read the override, as emission does, or a contained attempt over an
   * optional of it keeps what the failed item captured.
   */
  const committingOverride = (): Entries[] => [
    entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
      Item: sequence(literal('-'), regex(/[a-z]+/), literal('?')) as Combinator<unknown>,
      R: node('N', choice(attempt(optional(g.Item!), { contain: true }), sequence(literal('-'), regex(/[a-z]+/)))) as Combinator<unknown>,
    }))),
    entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({
      Item: sequence(literal('-'), dispatch(regex(/[a-z]+/), when('foo', sequence(routed(), literal('!'))))) as Combinator<unknown>,
    }))),
  ]

  it('takes back what an overriding rule captured before it committed a failure', () => {
    const table = expectIdentical(committingOverride, 'R', '-foo')
    expect((table.value as { children: Array<{ value: unknown }> }).children.map(c => c.value)).toEqual(['-', 'foo'])
  })

  // The overridden reference is inside the repeated item, not the item itself.
  const nestedOverride = (): Entries[] => [
    entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
      Item: sequence(literal('-'), regex(/[a-z]+/), literal('?')) as Combinator<unknown>,
      R: node('N', choice(
        attempt(optional(sequence(literal('+'), g.Item!)), { contain: true }),
        sequence(literal('+'), literal('-'), regex(/[a-z]+/)),
      )) as Combinator<unknown>,
    }))),
    entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({
      Item: sequence(literal('-'), dispatch(regex(/[a-z]+/), when('foo', sequence(routed(), literal('!'))))) as Combinator<unknown>,
    }))),
  ]

  it('takes back the captures when the override sits inside the repeated item', () => {
    const table = expectIdentical(nestedOverride, 'R', '+-foo')
    expect((table.value as { children: Array<{ value: unknown }> }).children.map(c => c.value)).toEqual(['+', '-', 'foo'])
  })

  // The override makes a later term of a sequence fallible, after an earlier term
  // captured. The override is a node, so it keeps its own captures to itself.
  const fallibleOverride = (): Entries[] => [
    entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
      Item: literal('?') as Combinator<unknown>,
      R: node('N', choice(
        attempt(sequence(literal('-'), optional(g.Item!)), { contain: true }),
        sequence(literal('-'), regex(/[a-z]+/)),
      )) as Combinator<unknown>,
    }))),
    entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({
      Item: node('M', dispatch(regex(/[a-z]+/), when('foo', sequence(routed(), literal('!'))))) as Combinator<unknown>,
    }))),
  ]

  it('takes back an earlier term when the override makes a later one fail', () => {
    const table = expectIdentical(fallibleOverride, 'R', '-foo')
    expect((table.value as { children: Array<{ value: unknown }> }).children.map(c => c.value)).toEqual(['-', 'foo'])
  })

  // A choice arm that IS the overridden reference. The base's `Item` captures
  // nothing it could leave behind; the override captures `a` and then fails, and
  // the next arm must not see that `a`.
  const armOverride = (arm: (item: Combinator<unknown>) => Combinator<unknown>) => (): Entries[] => [
    entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
      Item: literal('?') as Combinator<unknown>,
      R: node('N', choice(arm(g.Item!), sequence(literal('a'), literal('c')))) as Combinator<unknown>,
    }))),
    entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({
      Item: sequence(literal('a'), literal('b')) as Combinator<unknown>,
    }))),
  ]

  it('takes back what an overridden arm captured before it failed', () => {
    const table = expectIdentical(armOverride(item => item), 'R', 'ac')
    expect((table.value as { children: Array<{ value: unknown }> }).children.map(c => c.value)).toEqual(['a', 'c'])
  })

  it('takes back what an overridden reference under a wrapper captured', () => {
    const table = expectIdentical(armOverride(item => transform(item, v => v) as Combinator<unknown>), 'R', 'ac')
    expect((table.value as { children: Array<{ value: unknown }> }).children.map(c => c.value)).toEqual(['a', 'c'])
  })

  // A later term that is the overridden reference: the base's `Item` cannot fail,
  // the override can, after the arm's first term captured.
  const fallibleTerm = (): Entries[] => [
    entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
      Item: optional(literal('b')) as Combinator<unknown>,
      R: node('N', choice(sequence(literal('a'), g.Item!), sequence(regex(/[a-z]/), literal('c')))) as Combinator<unknown>,
    }))),
    entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({ Item: literal('b') as Combinator<unknown> }))),
  ]

  it('takes back an earlier term when an overridden later term fails', () => {
    const table = expectIdentical(fallibleTerm, 'R', 'ac')
    expect((table.value as { children: Array<{ value: unknown }> }).children.map(c => c.value)).toEqual(['a', 'c'])
  })

  // An overridden dispatch selector: the base's `Sel` only looks ahead, the
  // override captures what it read before the selected arm fails.
  const capturingSelector = (): Entries[] => [
    entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
      Sel: peek(regex(/[a-z]/)) as Combinator<unknown>,
      R: node('N', choice(
        attempt(optional(dispatch(g.Sel! as Combinator<string>, when('a', not(literal('c'))))), { contain: true }),
        sequence(literal('a'), literal('c')),
      )) as Combinator<unknown>,
    }))),
    entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({ Sel: regex(/[a-z]/) as Combinator<unknown> }))),
  ]

  it('takes back what an overridden selector captured', () => {
    const table = expectIdentical(capturingSelector, 'R', 'ac')
    expect((table.value as { children: Array<{ value: unknown }> }).children.map(c => c.value)).toEqual(['a', 'c'])
  })

  // The override is referenced only inside a `lines()` body, so the capability
  // walk has to descend into it to record what the reference reads as.
  const linesBody = (): Entries[] => [
    entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
      Item: literal('?') as Combinator<unknown>,
      R: lines(literal('> '), g.Item!) as Combinator<unknown>,
    }))),
    entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({ Item: regex(/[a-z]+/) as Combinator<unknown> }))),
  ]

  // The closure reader only: the emitted one prints no `lines()` body.
  it('reads an override referenced only inside a lines body', () => {
    for (const input of ['> abc', '> ?', '> abc\n> de']) {
      const { table, interp } = differential(linesBody, 'R', input)
      expect({ ok: table.ok, value: table.value, span: table.span }, input).toEqual({ ok: interp.ok, value: interp.value, span: interp.span })
    }
    expect(differential(linesBody, 'R', '> abc').table.ok).toBe(true)
  })

  // `hostBranchElided` says a direct builder's CST branch was dropped. The base's
  // `Item` has a builder, the override does not, and the encoded artifact holds
  // the override: there is no builder, so nothing was dropped.
  it('reads a shadowed base builder as absent from the merged map', () => {
    const merged = Object.entries(mergeMaps([
      entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
        Item: node('I', literal('x'), () => 'built') as Combinator<unknown>,
        R: node('N', g.Item!) as Combinator<unknown>,
      }))),
      entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({
        Item: node('M', literal('x')) as Combinator<unknown>,
      }))),
    ]))
    expect(compileRuleMapRunnable(merged)?.hostBranchElided).toBe(false)
  })

  /**
   * A HOLE FILLED BY A LATER PIECE — the shape `compileLinkableTable` keeps IR
   * for. Neither piece is a parser alone; the merge is what makes one.
   */
  const holeFilled = (): Entries[] => [
    entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
      Item: transform(
        sequence(literal('<'), g.Inner!, literal('>')),
        v => (v as unknown[])[1],
      ) as Combinator<unknown>,
    }))),
    entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({
      Inner: regex(/[0-9]+/) as Combinator<unknown>,
    }))),
  ]

  it('binds a cross-piece hole through the merge', () => {
    const table = expectIdentical(holeFilled, 'Item', '<42>')
    expect(table.value).toBe('42')
  })

  it('agrees on the expected set when the FILLED hole rejects', () => {
    for (const input of ['<x>', '<>', '<42', '']) {
      expectIdentical(holeFilled, 'Item', input)
    }
  })

  /**
   * THREE PIECES, and the override sits in the MIDDLE — so "later wins" is
   * tested as an ordering, not just as "the last piece is visible".
   */
  const threeDeep = (): Entries[] => [
    entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
      Word: transform(regex(/[a-z]+/), () => 'v1') as Combinator<unknown>,
      Doc: transform(many(g.Word!), v => (v as unknown[]).join(',')) as Combinator<unknown>,
    }))),
    entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({
      Word: transform(regex(/[a-z]+/), () => 'v2') as Combinator<unknown>,
    }))),
    entriesOf(rules<Record<string, Combinator<unknown>>>(() => ({
      Word: transform(regex(/[a-z]+/), () => 'v3') as Combinator<unknown>,
    }))),
  ]

  it('takes the LAST definition of a name overridden more than once', () => {
    const table = expectIdentical(threeDeep, 'Doc', 'ab cd')
    expect(table.value).toBe('v3')
  })

  /**
   * A rule the merge does NOT touch must be unchanged. This is the no-op half of
   * the by-name resolution: for an un-merged map the name resolves to the same
   * combinator the thunk returns, and nothing about the encode may move.
   */
  it('leaves a non-overridden rule identical to the single-piece encode', () => {
    const build = (): Entries[] => [
      entriesOf(rules<Record<string, Combinator<unknown>>>(g => ({
        Atom: choice(regex(/[a-z]+/), regex(/[0-9]+/)) as Combinator<unknown>,
        Pair: transform(
          sequence(g.Atom!, literal(':'), g.Atom!),
          v => [(v as unknown[])[0], (v as unknown[])[2]],
        ) as Combinator<unknown>,
      }))),
    ]
    for (const input of ['ab:12', '1:2', 'ab:', ':x', '']) {
      expectIdentical(build, 'Pair', input)
    }
  })
})

describe('compile(ruleMap): a runtime composition opted into a table', () => {
  it('encodes the linked winners, override included', () => {
    const base = rules(g => ({ Doc: sequence(g.Atom, literal('!')), Atom: literal('a') }))
    const table = compile(compose([base, rules(() => ({ Atom: literal('b') }))]))
    expect(run(table.Doc!, 'b!').ok).toBe(true)
    expect(run(table.Doc!, 'a!').ok).toBe(false)
  })

  it('refuses an entry that is not a parser instead of dropping its rule', () => {
    expect(() => compile({ Doc: literal('a'), Typo: 'literal' } as unknown as Record<string, unknown>))
      .toThrow(TypeError)
  })
})
