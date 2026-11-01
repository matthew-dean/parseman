/**
 * A collapse over `optional(…)` terms and then one node opens no frame of its own
 * where the character it starts at opens none of those terms and no trivia: the
 * body is the node alone there (`site-labels.ts` `gatedPassCollapse`). Anywhere
 * else it keeps its frame. Both table engines; the tree is the frame's.
 */
import { describe, expect, it } from 'vitest'
import { literal, many, node, noTrivia, optional, regex, rules, sequence } from '../../src/index.ts'
import type { Combinator, ParseContext } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { createParseContext } from '../../src/parse-context.ts'

/** A sign before a word, as a precedence ladder spells a unary minus. */
const g = rules({ trivia: regex(/ +/) }, (g: Record<string, Combinator<unknown>>) => ({
  Root: node('List', sequence(g.Unary!, many(g.Unary!)), children => ({ list: children })),
  Unary: node('Unary', sequence(optional(noTrivia(regex(/-(?=[a-z])/))), optional(literal('!')), g.Word!),
    children => ({ neg: children }), { collapse: true }),
  Word: node('Word', regex(/[a-z]+/), children => (children[0] as { value: string }).value === 'u' ? undefined : { word: children[0] }),
})) as Record<string, Combinator<unknown>>

const CFG = { hostCst: false, hostReadsChildren: true, trackLines: false, tolerant: false, coverage: false, probe: false, direct: false }

/**
 * Node frames one parse opens. Under the collector protocol a frame installs a
 * collector on the context. Under direct values (`direct`) its children are a
 * local array, and what it still writes to the context is `_fields`, saved and
 * restored once per frame.
 */
function frames(prog: TableProgram, input: string, direct = false): number {
  const linked = assemble(resolveTable(prog), prog, { ...CFG, direct })
  const seen = new Set<unknown>()
  let n = 0
  let fieldWrites = 0
  const ctx = new Proxy(createParseContext(), {
    set(target, key, value) {
      if ((key === '_cstBuf' || key === '_cstChildren') && value !== undefined && !seen.has(value)) { seen.add(value); n++ }
      if (key === '_fields') fieldWrites++
      return Reflect.set(target, key, value)
    },
  }) as ParseContext
  linked.begin(ctx)
  linked.pieces.Root!(input, 0, ctx)
  linked.finish()
  if (direct) {
    expect(n).toBe(0)
    return fieldWrites / 2
  }
  return n
}

function emittedOf(prog: TableProgram): TableProgram {
  const { asm: _none, ...rest } = prog
  return rest
}

describe('gated pass-through collapse', () => {
  for (const [engine, select] of [['emitted', emittedOf], ['closure', (p: TableProgram): TableProgram => ({ ...p, asm: [] })]] as const) {
    it(`${engine}: a word with no sign opens no Unary frame; a signed one does`, () => {
      const prog = select(encodeTable(g))
      // `List` and two `Word`s.
      expect(frames(prog, 'a b')).toBe(3)
      // One `Unary` frame for the signed word.
      expect(frames(prog, '-a b')).toBe(4)
      expect(frames(prog, '!a b')).toBe(4)
    })
  }

  it('emitted with direct values: the same frames, none of them on the context', () => {
    const prog = emittedOf(encodeTable(g))
    expect(frames(prog, 'a b', true)).toBe(3)
    expect(frames(prog, '-a b', true)).toBe(4)
    expect(frames(prog, '!a b', true)).toBe(4)
  })

  it('builds the reference tree in both engines', () => {
    const prog = encodeTable(g)
    const reference = execRules(prog).Root!
    const emitted = tableRules(emittedOf(prog)).Root!
    const closure = tableRules({ ...prog, asm: [] }).Root!
    for (const input of ['a', 'a b', '-a', '!a', '-!a', '- a', '! a', 'u', '-u', 'a -', '-', '', '!', ' a', 'a  -b !u']) {
      const ref = run(reference, input)
      const interp = run(g.Root!, input)
      expect(digestValue([interp.ok, interp.ok ? interp.value : null, interp.span]), `${input} interpreter`)
        .toBe(digestValue([ref.ok, ref.ok ? ref.value : null, ref.span]))
      expect(digestValue(run(emitted, input)), `${input} emitted`).toBe(digestValue(ref))
      expect(digestValue(run(closure, input)), `${input} closure`).toBe(digestValue(ref))
    }
  })
})
