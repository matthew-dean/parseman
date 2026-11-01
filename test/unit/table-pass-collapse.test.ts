/**
 * A `collapse: true` node over one node opens no capture frame of its own in
 * either table engine, so a chain of them costs the frames of the nodes that
 * build, not one per level (`run-support.ts` `collapseEmpty`) — and the tree is
 * the one the per-level frames built.
 *
 * A frame is a collector a node installs for its body (`ctx._cstBuf` or
 * `ctx._cstChildren`); the count is taken by watching those two fields on the
 * context of one parse.
 */
import { describe, expect, it } from 'vitest'
import { choice, literal, many, node, optional, regex, rules, sequence } from '../../src/index.ts'
import type { Combinator, ParseContext } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { FAIL } from '../../src/table/cell.ts'

type Raw = { value?: unknown; span?: { start: number; end: number } }
const rawOf = (raw: readonly unknown[]): unknown[] =>
  raw.map(r => [(r as Raw).value, (r as Raw).span?.start, (r as Raw).span?.end])

type Parent = 'children' | 'raw' | 'rawCount' | 'whole' | 'none'

/**
 * A precedence ladder under `parent`: `Top` over a `Sum` of `Atom`s, an `Atom`
 * over one `Unary`, a `Unary` over the word. `Top` and `Atom` are collapses over
 * one node; `Sum` and `Unary` are collapses over a sequence and keep their
 * frames. A `u` builds nothing at all, which a frame does not count as a child;
 * `Unary` then builds nothing either. With `spaced`, a gap may sit inside a
 * level's span.
 */
function ladder(parent: Parent, spaced = false): Record<string, Combinator<unknown>> {
  return rules(spaced ? { trivia: regex(/ +/) } : {}, (g: Record<string, Combinator<unknown>>) => ({
    Root: parent === 'none' ? g.Top! : g.Value!,
    Value: parent === 'whole'
      ? node('Value', g.Top!, (children, _fields, _span, raw) => ({ value: children, raw: rawOf(raw) }))
      : node('Value', sequence(optional(literal('=')), choice(g.Top!, literal('-')), optional(literal(';'))),
        parent === 'raw'
          ? (children, _fields, _span, raw) => ({ value: children, raw: rawOf(raw) })
          // Reads the trivia log, not `rawChildren`: a buffer that keeps only a raw count.
          : parent === 'rawCount'
            ? (children, _fields, _span, _raw, tl, state) => ({ value: children, tl: [...tl], state: state ?? null })
            : children => ({ value: children })),
    // A collapse over one node whose reducer reads `rawChildren`.
    Top: node('Top', g.Sum!, (children, _fields, span, raw) => ({ top: children, span, raw: rawOf(raw) }), { collapse: true }),
    Sum: node('Sum', sequence(g.Atom!, many(sequence(literal('+'), g.Atom!))),
      children => ({ sum: children }), { collapse: true }),
    // Reads `rawChildren` too, where a child that builds nothing still has a raw entry.
    Atom: node('Atom', g.Unary!, (children, _fields, _span, raw) => ({ atom: children, raw: rawOf(raw) }), { collapse: true }),
    Unary: node('Unary', sequence(optional(literal('-')), g.Word!),
      children => children.length === 0 ? undefined : { neg: children }, { collapse: true }),
    Word: node('Word', regex(/[a-z]+/), children => (children[0] as Raw).value === 'u' ? undefined : { word: children[0] }),
  })) as Record<string, Combinator<unknown>>
}

// The frames are counted on the CONTEXT, so the emitted engine runs the
// collector protocol here; direct values are counted on the source below.
const CFG = { hostCst: false, hostReadsChildren: true, trackLines: false, tolerant: false, coverage: false, probe: false, direct: false }
const DIRECT = { ...CFG, direct: true }

/** Node frames a direct-values assembly binds: one `ks` array per framed node body. */
function directFrames(prog: TableProgram): number {
  return emitAssemblySource(resolveTable(prog), prog, DIRECT).source.split('{const ks=[]').length - 1
}

/** The collectors installed during one parse, and its value. */
function framesOf(prog: TableProgram, input: string): { frames: number; value: unknown; emitted: boolean } {
  const linked = assemble(resolveTable(prog), prog, CFG)
  const seen = new Set<unknown>()
  let frames = 0
  const ctx = new Proxy(createParseContext(), {
    set(target, key, value) {
      if ((key === '_cstBuf' || key === '_cstChildren') && value !== undefined && !seen.has(value)) {
        seen.add(value)
        frames++
      }
      return Reflect.set(target, key, value)
    },
  }) as ParseContext
  linked.begin(ctx)
  const value = linked.pieces.Root!(input, 0, ctx)
  linked.finish()
  return { frames, value: value === FAIL ? 'FAIL' : value, emitted: linked.emitRefusal === undefined }
}

/** No precompiled assembly: `assemble` emits one. An empty inventory: it runs closures. */
function emittedOf(prog: TableProgram): TableProgram {
  const { asm: _none, ...rest } = prog
  return rest
}
const ENGINES = {
  emitted: emittedOf,
  closure: (prog: TableProgram): TableProgram => ({ ...prog, asm: [] }),
}

describe('pass-through collapse', () => {
  for (const [engine, select] of Object.entries(ENGINES)) {
    it(`${engine}: a collapse over one node opens no frame`, () => {
      const prog = select(encodeTable(ladder('children')))
      const r = framesOf(prog, 'a')
      expect(r.emitted).toBe(engine === 'emitted')
      expect(r.value).toEqual({ value: [{ word: { _tag: 'leaf', value: 'a', span: { start: 0, end: 1 } } }] })
      // `Value`, `Sum`, `Unary` and `Word`: `Top` and `Atom` open none.
      expect(r.frames).toBe(4)
      if (engine === 'emitted') expect(directFrames(prog)).toBe(4)
    })

    it(`${engine}: a chain of collapses over one node each opens only the frames that build`, () => {
      const g = rules((g: Record<string, Combinator<unknown>>) => ({
        Root: node('Outer', g.Middle!, children => ({ outer: children }), { collapse: true }),
        Middle: node('Middle', g.Inner!, children => ({ middle: children }), { collapse: true }),
        Inner: node('Inner', sequence(literal('('), g.Word!, literal(')')), children => ({ inner: children })),
        Word: node('Word', regex(/[a-z]+/), children => ({ word: children[0] })),
      })) as Record<string, Combinator<unknown>>
      const r = framesOf(select(encodeTable(g)), '(a)')
      expect(r.value).toMatchObject({ inner: [{ value: '(' }, { word: { value: 'a' } }, { value: ')' }] })
      // `Inner`'s and `Word`'s.
      expect(r.frames).toBe(2)
      if (engine === 'emitted') expect(directFrames(encodeTable(g))).toBe(2)
    })
  }

  // Every collector a collapse can find its parent holding, and every outcome:
  // the lone child, a child that builds nothing, a level that builds, a failure.
  const inputs = ['a', '-a', 'a+b', '-a+b+-c', 'a+', 'a+-', '-', '+a', '', 'a;', '=a', '=-', 'u', 'u+a', '=u+a', '-u', 'a+u;', '=u;']
  const spacedInputs = [' a', '- a', 'a + b', ' - a + b ', 'a +', ' ', 'a ;', '= a ;', '= - a + b ;', '= u + a', '- u ;', ' u', '= u ;']
  for (const spaced of [false, true]) {
    for (const parent of ['children', 'raw', 'rawCount', 'whole', 'none'] as const) {
      it(`under a ${parent} parent${spaced ? ', with trivia' : ''}: both engines build the reference tree`, () => {
        const grammar = ladder(parent, spaced)
        const prog = encodeTable(grammar)
        const reference = execRules(prog).Root!
        const emitted = tableRules(emittedOf(prog)).Root!
        const closure = tableRules({ ...prog, asm: [] }).Root!
        for (const input of spaced ? spacedInputs : inputs) {
          const ref = run(reference, input)
          // The interpreter's failure reports a narrower expected set than the
          // table engines', so it is compared on what it built.
          const interp = run(grammar.Root!, input)
          expect(digestValue([interp.ok, interp.ok ? interp.value : null, interp.span]), `${input} interpreter`)
            .toBe(digestValue([ref.ok, ref.ok ? ref.value : null, ref.span]))
          expect(digestValue(run(emitted, input)), `${input} emitted`).toBe(digestValue(ref))
          expect(digestValue(run(closure, input)), `${input} closure`).toBe(digestValue(ref))
        }
      })
    }
  }
})
