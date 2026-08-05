import { describe, expect, it } from 'vitest'
import { choice, literal, many, regex, rules, sequence, transform } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { fuseInterpreted } from '../../src/compiler/linker.ts'
import { run } from '../../src/functional/run.ts'
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

const entriesOf = (g: object): Entries =>
  Object.entries(g as Record<string, Combinator<unknown>>) as Entries

/** Merge pieces the way `compose()` composes them: later names win. */
function mergeMaps(pieces: Entries[]): Record<string, Combinator<unknown>> {
  const merged = new Map<string, Combinator<unknown>>()
  for (const piece of pieces) for (const [name, rule] of piece) merged.set(name, rule)
  return Object.fromEntries(merged)
}

/** The merged map as a RUNNABLE table — merge, then ONE encode. */
function tabledMerge(pieces: Entries[]): Record<string, unknown> {
  return assembledRules(encodeTable(mergeMaps(pieces))) as unknown as Record<string, unknown>
}

/** Both engines over one rule and one input, all four observable fields. */
function differential(
  build: () => Entries[],
  rule: string,
  input: string,
): { table: ReturnType<typeof run>; interp: ReturnType<typeof run> } {
  return {
    table: run(tabledMerge(build())[rule] as never, input),
    // A fresh build per side: an interpreted fuse binds the shared placeholder
    // objects IN PLACE, so reusing the table's pieces would hand the table a
    // grammar the reference had already rewritten.
    interp: run(fuseInterpreted(build().map(p => Object.fromEntries(p)) as never)[rule] as never, input),
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
