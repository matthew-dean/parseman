/**
 * CST capture rollback on a failed attempt — across every backtracking path.
 *
 * A sub-parser can match terminals (capturing CSTLeaf tokens) and then fail on a
 * later term — e.g. a `[key]` group that consumes `[` then hits EOF. When that
 * attempt is abandoned, the leaves it captured must be rolled back, or they leak
 * into the enclosing node()'s children.
 *
 * The codegen has distinct rollback sites that must all agree:
 *   - emitFallible (used by many / optional / sepBy)
 *   - the non-disjoint choice per-arm rollback
 *
 * Regression: emitFallible used to break out of a failed attempt WITHOUT
 * restoring _cstLeaves, so `a[` leaked a stray `[`. Each grammar below is run in
 * all three modes — interpreter, compile(), and macro — since the rollback lives
 * in different code (runtime combinators vs codegen) that can drift apart.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import {
  node, regex, literal, sequence, many, optional, sepBy, choice, compile, parse,
} from '../../src/index.ts'

const leaves = (children: ReadonlyArray<unknown>) =>
  children
    .filter((c): c is { _tag: string; value?: unknown } =>
      typeof c === 'object' && c !== null && (c as { _tag?: string })._tag === 'leaf')
    .map(c => c.value)

const name = regex(/[a-z]+/)
const key = regex(/[a-z]+/)
const grp = sequence(literal('['), key, literal(']')) // a `[key]` group

// many: `name` + zero+ `[key]` — a failed iteration must roll back its `[`.
const manyNode = node('M', sequence(name, many(grp)), leaves)
// optional: `name` + optional `[key]` — a failed optional must roll back its `[`.
const optNode = node('O', sequence(name, optional(grp)), leaves)
// sepBy: comma-separated `[key]` groups — a failed trailing item rolls back `,` + `[`.
const sepNode = node('S', sepBy(grp, literal(',')), leaves)
// non-disjoint choice: both arms start `[`, so arm 1 captures `[a…` then fails and
// must roll back before arm 2 runs.
const choiceNode = node('C', choice(
  sequence(literal('['), literal('a'), literal(']')),
  sequence(literal('['), literal('b'), literal(']')),
), leaves)

const compiled = {
  M: compile(manyNode), O: compile(optNode), S: compile(sepNode), C: compile(choiceNode),
}

type ParseFn = (input: string, pos: number, ctx: object) =>
  { ok: boolean; value?: unknown; span: { start: number; end: number } }
let macro: Record<string, ParseFn>

const MACRO_CODE = `
import { node, regex, literal, sequence, many, optional, sepBy, choice } from 'parseman' with { type: 'macro' }
const leaves = (children) => children.filter(c => c._tag === 'leaf').map(c => c.value)
const name = regex(/[a-z]+/)
const key = regex(/[a-z]+/)
const grp = sequence(literal('['), key, literal(']'))
const M = node('M', sequence(name, many(grp)), leaves)
const O = node('O', sequence(name, optional(grp)), leaves)
const S = node('S', sepBy(grp, literal(',')), leaves)
const C = node('C', choice(
  sequence(literal('['), literal('a'), literal(']')),
  sequence(literal('['), literal('b'), literal(']')),
), leaves)
`.trim()

beforeAll(async () => {
  const { transformMacro } = await import('../../src/plugin/index.ts')
  const result = transformMacro(MACRO_CODE, 'capture-rollback.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  if (result.code.includes("from 'parseman'")) throw new Error('macro did not compile')
  const body = result.code.replace(/\bconst\b/g, 'var') + '\nreturn { M, O, S, C }'
  macro = new Function(body)() as Record<string, ParseFn>
})

// [grammar, input, expected leaf tokens]
const CASES: Array<[keyof typeof compiled, string, string[]]> = [
  // many
  ['M', 'a', ['a']],
  ['M', 'a[b]', ['a', '[', 'b', ']']],
  ['M', 'a[', ['a']],                       // dangling `[` rolled back
  ['M', 'a[b][', ['a', '[', 'b', ']']],     // trailing dangling `[` rolled back
  ['M', 'a[]', ['a']],                      // `[]` (no key) rolled back
  // optional
  ['O', 'a', ['a']],
  ['O', 'a[b]', ['a', '[', 'b', ']']],
  ['O', 'a[', ['a']],                       // failed optional rolls back `[`
  // sepBy
  ['S', '[a]', ['[', 'a', ']']],
  ['S', '[a],[b]', ['[', 'a', ']', ',', '[', 'b', ']']], // separator `,` is itself a leaf
  ['S', '[a],[', ['[', 'a', ']']],          // failed trailing item rolls back `,` + `[`
  // non-disjoint choice
  ['C', '[a]', ['[', 'a', ']']],
  ['C', '[b]', ['[', 'b', ']']],            // arm 1 captures `[` then fails → rolled back
]

describe('CST capture rollback — every path, interpreter vs compile() vs macro', () => {
  const interp: Record<string, unknown> = { M: manyNode, O: optNode, S: sepNode, C: choiceNode }
  for (const [g, input, expected] of CASES) {
    it(`interpreter ${g}: ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      const r = parse(interp[g] as never, input)
      expect(r.ok).toBe(true)
      expect((r as { value: unknown }).value).toEqual(expected)
    })
    it(`compile()   ${g}: ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      const r = compiled[g].parse(input)
      expect(r.ok).toBe(true)
      expect((r as { value: unknown }).value).toEqual(expected)
    })
    it(`macro       ${g}: ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      const r = macro[g]!(input, 0, {})
      expect(r.ok).toBe(true)
      expect(r.value).toEqual(expected)
    })
  }
})

/**
 * Speculative-branch ERROR rollback (soundness): a choice arm that recovers —
 * pushing a ParseError to ctx._errors AND embedding it as a `parseError` CST
 * child — then fails must truncate BOTH, exactly as it truncates captured leaves.
 * Otherwise a rolled-back arm leaves a GHOST error: flat ctx._errors disagrees
 * with the tree, and a diagnostics layer reports an error over input the winning
 * arm consumed cleanly.
 */
describe('speculative rollback truncates ctx._errors (no ghost error)', () => {
  it('a recovering-then-failing choice arm leaves no error behind', async () => {
    const { choice, sequence, literal, many, regex, run } = await import('../../src/index.ts')
    const item = regex(/[a-z]+/)
    const ws = regex(/[ ]*/)
    // arm1 requires a closing ']' (fails on this input after recovering inside
    // many); arm2 does not and wins. The arm1 recovery must not survive.
    const arm1 = sequence(literal('['), many(sequence(ws, item)), literal(']'))
    const arm2 = sequence(literal('['), many(sequence(ws, item)))
    const r = run(choice(arm1, arm2) as never, '[abc !!! def', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([]) // ghost error over unconsumed input is gone
  })

  it('a not() lookahead over a recovering parser leaves no error behind', async () => {
    const { not, sequence, literal, many, regex, run } = await import('../../src/index.ts')
    const item = regex(/[a-z]+/)
    const inner = sequence(literal('['), many(item), literal(']')) // recovers then fails
    // not(inner) succeeds (inner fails on '[a' — no closer) and must roll back the
    // recovered error inner pushed while failing.
    const g = sequence(not(inner), regex(/[\[a-z]+/))
    const r = run(g as never, '[a', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })
})
