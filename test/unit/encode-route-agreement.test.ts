/**
 * ONE GRAMMAR, TWO ROUTES, ONE PROGRAM.
 *
 * A grammar reaches `encodeTable` two ways. At RUNTIME the `rules()` factory in
 * `combinators/parser.ts` builds the map. At BUILD time `plugin/evaluator.ts`'s
 * `evaluateParserFactory` builds it — a second implementation of the same job,
 * over the same source text, feeding the same encoder. Nothing asserted that the
 * two produce the same program, and both had silently drifted:
 *
 *   - `evaluateParserFactory` never ran `rules()`'s closing `markUnusedValues`
 *     pass, so every container reached the encoder with `valueUnused` unset and
 *     every `SEQ`/`REP` row built an aggregate nothing reads. On jess's less
 *     grammar: 326 tuple-building sequence rows against 8, 110 array-building
 *     repeat rows against 20.
 *   - a `g.X` that this `rules()` call does not itself define is minted as an
 *     `externalRefs` slot and never `.define()`d, because the definition arrives
 *     in the merge. `firstSetOf` degrades a throwing thunk to `any`, so the arm
 *     encoded correctly (via `winners`) and ran with its gate switched off. On
 *     the same grammar: 195 of 562 choice arms carried no first set against 103
 *     of 540, and 10 dispatch sites lost the O(1) `exclusive` piece.
 *
 * Together those cost ~29% on `benchmark.less`, on the path every consumer ships
 * — all four jess grammars macro-fuse. Both were found by accident. This is the
 * check that would have caught them on the day they landed.
 *
 * WHAT IT ASSERTS is the encoder's own observable output, not a proxy for it:
 * the reachable opcode histogram, the char-class pool, and the gating summary
 * (`openArms`, `exclusive`). Not the raw code stream — the two routes lay rules
 * out in different orders and always have, so word-for-word identity would fail
 * for a reason nobody is claiming is a defect. Every quantity here is
 * order-independent and every one of them moved under both defects.
 *
 * WHY THE SOURCE IS WRITTEN ONCE. Spelling the grammar twice — once as macro
 * source, once as runtime calls — makes the two legs' agreement contingent on a
 * human keeping two texts in step, which is the same class of failure the test
 * exists to catch. The single string is transformed by the macro on one leg and
 * evaluated with the real combinators on the other.
 */
import { describe, expect, it } from 'vitest'
import * as parseman from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { expandCompact, resolveTable, type CompactProgram, type TableProgram } from '../../src/table/program.ts'
import { opHistogram, reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE } from '../../src/table/ops.ts'
import type { Combinator } from '../../src/types.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

/** The encoder's output, reduced to what is comparable ACROSS rule orderings. */
type Shape = {
  /** Reachable rows per opcode — where `SEQ` vs `SEQV` and `REP` vs `REPV` live. */
  readonly ops: Record<string, number>
  /** Char-class pool size — the derived quantity gating widens. */
  readonly classes: number
  /** Reachable choice arms carrying NO first set. Every one is an ungated entry. */
  readonly openArms: number
  /** Dispatch sites keeping `assemble.ts`'s O(1) piece rather than the mask loop. */
  readonly exclusive: number
}

function shapeOf(prog: TableProgram): Shape {
  const t = resolveTable(prog)
  let openArms = 0
  let exclusive = 0
  for (const ip of reachableIps(prog)) {
    if (prog.code[ip] !== OP_CHOICE) continue
    const di = prog.code[ip + 1]!
    openArms += (prog.disp[di] ?? []).filter(x => x < 0).length
    if (t.disp[di]?.exclusive === true) exclusive++
  }
  return { ops: opHistogram(prog), classes: prog.cc.length, openArms, exclusive }
}

/** The program the MACRO printed, captured at the `tableRules` call it emits. */
function viaMacro(source: string): Shape {
  const out = transformMacro(source, '/virtual/grammar.ts', new Set(['parseman']))
  if (!out?.code) throw new Error('the macro lowered nothing — this test needs a lowered grammar to compare')
  if (!/\btableRules\(/.test(out.code)) {
    throw new Error('the macro emitted no table; there is no program to compare and this test would pass vacuously')
  }
  const progs: (TableProgram | CompactProgram)[] = []
  evalMacroModule(out.code, 'grammar', {
    tableRules: (p: TableProgram | CompactProgram) => { progs.push(p); return assembledRules(p) },
  })
  if (progs.length !== 1) throw new Error(`expected exactly one emitted program, got ${progs.length}`)
  return shapeOf(expandCompact(progs[0]!))
}

/**
 * The SAME source, evaluated with the real combinators — `rules()` and
 * `composeLeaf()` doing their own jobs — then encoded.
 *
 * The import line is stripped and every parseman export bound by name, so the
 * text runs unmodified. `grammar` is read key by key because `composeLeaf`
 * returns lazy accessors: reading one fuses the pieces, and reading all of them
 * is what turns the result into the plain record `encodeTable` wants.
 */
function viaRuntime(source: string): Shape {
  const body = source
    .replace(/^[ \t]*import\b[^\n]*\n/gm, '')
    .replace(/^[ \t]*export[ \t]+(?=const\b)/gm, '')
  const names = Object.keys(parseman)
  const fn = new Function(...names, `${body}\nreturn grammar`) as (...a: unknown[]) => Record<string, Combinator<unknown>>
  const grammar = fn(...names.map(n => (parseman as Record<string, unknown>)[n]))
  const rules: Record<string, Combinator<unknown>> = {}
  for (const k of Object.keys(grammar)) rules[k] = grammar[k]!
  return shapeOf(encodeTable(rules, {}))
}

/**
 * A `node()` over a `sequence` and a `many`. Under a `node()` the aggregate feeds
 * nothing — the builder reads captured children — so `markUnusedValues` marks
 * both containers and the encoder emits `SEQV`/`REPV`. A route that skips that
 * pass emits `SEQ`/`REP` and allocates a tuple and an array per execution.
 */
const DEAD_VALUE = `
import { literal, many, node, rules, sequence } from 'parseman' with { type: 'macro' }
export const grammar = rules(g => ({
  Doc: node('Doc', sequence(literal('a'), many(literal('b'))), (_children, _fields, span) => ({ type: 'Doc', span })),
}))
`

/**
 * A `choice` arm that is a reference to a rule ANOTHER piece defines. The macro
 * mints an undefined `externalRefs` slot for it — the definition arrives in the
 * merge, not in this `rules()` call — so its first set degrades to `any` and the
 * arm loses its gate, while the runtime fuse binds it before the encoder looks.
 */
const CROSS_PIECE = `
import { choice, composeLeaf, literal, node, rules } from 'parseman' with { type: 'macro' }
export const grammar = composeLeaf([
  rules(g => ({ Atom: literal('a') })),
  rules(g => ({
    Doc: node('Doc', choice(g.Atom, literal('z')), (_children, _fields, span) => ({ type: 'Doc', span })),
  })),
])
`

describe('encode route agreement — the macro and runtime rule maps must encode alike', () => {
  /**
   * A grammar with NO cross-piece reference and NO node-wrapped container is the
   * control: it proves the two routes agree at all, so a red on the cases below
   * is the defect and not an artefact of comparing them.
   */
  it('agrees on a grammar neither defect can touch', () => {
    const src = `
import { literal, rules } from 'parseman' with { type: 'macro' }
export const grammar = rules(g => ({ Doc: literal('a') }))
`
    expect(viaMacro(src)).toEqual(viaRuntime(src))
  })

  it('agrees on which containers build an aggregate (SEQ/SEQV, REP/REPV)', () => {
    const macro = viaMacro(DEAD_VALUE)
    const runtime = viaRuntime(DEAD_VALUE)
    // Named explicitly as well as compared wholesale: a diff on `ops` alone reads
    // as an opcode table dump, and the CLAIM is about these four.
    for (const op of ['SEQ', 'SEQV', 'REP', 'REPV']) {
      expect([op, macro.ops[op] ?? 0]).toEqual([op, runtime.ops[op] ?? 0])
    }
    expect(macro).toEqual(runtime)
  })

  it('agrees on choice-arm gating across a piece boundary (openArms, exclusive)', () => {
    const macro = viaMacro(CROSS_PIECE)
    const runtime = viaRuntime(CROSS_PIECE)
    expect(macro.openArms).toBe(runtime.openArms)
    expect(macro.exclusive).toBe(runtime.exclusive)
    expect(macro.classes).toBe(runtime.classes)
    expect(macro).toEqual(runtime)
  })
})
