/**
 * The emitted assembly takes its rollback marks through SHARED helpers
 * (`_mkBC`/`_mkBO`/`_mkBU`/`_mkN`, the marked skips, `_unscan`, `_fm`), not as
 * inline text repeated at every site. These tests pin both halves of that:
 *
 *  - the text: the per-site mark code no longer grows with the grammar;
 *  - the meaning: a parse through the emitted assembly still equals the closure
 *    engine's on the paths those marks serve — a zero-width term after a trivia
 *    scan (the scan is undone), a failed arm after a scan into labelled trivia
 *    (root trivia rows are rolled back), CST capture with a trivia log, and the
 *    expected set a failing choice reports.
 */
import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'
import { cssRules } from '../../examples/css/parser.ts'
import { jsonRules } from '../../bench/table-grammars.ts'
import type { Combinator } from '../../src/types.ts'
import {
  choice, classifiedTrivia, cstBuildHost, literal, many, node, optional, regex, rules, sequence,
} from '../../src/index.ts'

type RuleMap = Record<string, Combinator<unknown>>

function emittedSource(prog: TableProgram): string {
  const cfg = defaultAssemblyCfgs(prog)[0]!
  return emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true).source
}

/** The whole program emitted, every site — the shipped form at an unlimited budget. */
function emitted(prog: TableProgram): TableProgram {
  return { ...prog, asm: defaultAssemblyCfgs(prog).map(cfg => {
    const em = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
    return { key: cfgKey(cfg), factory, plan: em.plan, reached: [...em.reached] }
  }) }
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe('emitted rollback marks are shared, not repeated per site', () => {
  const css = emittedSource(encodeTable(cssRules as unknown as RuleMap, {}))
  const json = emittedSource(encodeTable(jsonRules as unknown as RuleMap, {}))

  it('undoes a scanned term through one helper', () => {
    expect(count(css, 'rollbackScannedTriviaAt(')).toBe(1)
    expect(count(json, 'rollbackScannedTriviaAt(')).toBe(1)
  })

  it('reads the root trivia log once per repetition, not once per term or mark', () => {
    // The prelude reads it a fixed number of times, each marked skip (one per
    // distinct skip, not per site) once, and a repetition still takes its own
    // loop mark inline. No other site reads it.
    const read = 'ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length'
    const own = (text: string) => count(text, read) - count(text, 'for(;;){') - count(text, 'M(input,cur,ctx){')
    expect(own(css)).toBe(own(json))
  })

  it('takes a mark without the inline sink chain', () => {
    const chain = '}else if(ctx._cstLeaves!==undefined||ctx._cstRawChildren!==undefined'
    expect(count(css, chain)).toBe(0)
    expect(count(json, chain)).toBe(0)
  })
})

describe('an emitted assembly with shared marks parses exactly as the closure engine', () => {
  const t = classifiedTrivia({ space: regex(/[ ]+/), comment: regex(/\/\*[^]*?\*\//) })
  const g = rules<RuleMap>({ trivia: t }, g => ({
    Doc: many(g.Item!),
    Item: choice(g.Long!, g.Short!, g.Wrapped!, g.List!),
    // `optional(x)` after `a` is the zero-width term after a scan: the trivia it
    // skipped (and the comment row it recorded) must be undone, then rescanned
    // by `;`. `Long` fails after scanning into the same comment, so its arm's
    // rows must roll back before `Short` runs.
    Long: sequence(literal('a'), optional(literal('x')), literal('!'), literal(';')),
    Short: sequence(literal('a'), optional(literal('x')), literal(';')),
    Wrapped: node('Wrapped', sequence(literal('('), many(g.Word!), optional(literal('x')), literal(')')),
      (children, _fields, span, _raw, triviaLog) => ({ n: children.length, span, triviaLog })),
    List: sequence(literal('['), many(sequence(g.Word!, optional(literal(',')))), literal(']')),
    Word: regex(/[a-z]+/),
  }))
  const engines = (hostMode: 'ast' | 'cst') => {
    const prog = encodeTable(g, { hostMode })
    const slow = tableRules({ ...prog, asm: [] }), quick = tableRules(emitted(prog))
    return { closure: slow.Doc!, fast: quick.Doc!, closureItem: slow.Item!, fastItem: quick.Item! }
  }
  // `RunResult.rootTrivia.index` carries per-result closures; its rows are the data.
  const view = (r: ReturnType<typeof run>) =>
    ({ ...r, rootTrivia: (r as { rootTrivia?: { rows: unknown } }).rootTrivia?.rows })
  const INPUTS = [
    'a /* c */ ;', 'a /* c */ x ;', 'a/*c*/x/*d*/!/*e*/;', 'a /* c */ ! ;',
    '( b /* c */ d /* e */ )', '( b /* c */ x )', '[ b /* c */ , d /* e */ ]',
    'a /* c */ ; ( q ) [ r ]', 'a /* c */ ? ;', '( b /* c */',
    // A comment row recorded BEFORE a choice that backtracks: the arm's rollback
    // must truncate the root log to its mark, not past it.
    'a ; /* z */ a /* c */ ;', '( b ) /* z */ a /* c */ x ;', '[ b ] /* z */ ( c /* d */ x )',
  ]

  it('with root trivia capture', () => {
    const { closure, fast } = engines('ast')
    for (const input of INPUTS) {
      const opts = { rootTrivia: { select: ['comment'] } }
      expect(view(run(fast as never, input, opts)), input).toEqual(view(run(closure as never, input, opts)))
    }
  })

  it('with a CST host', () => {
    const { closure, fast } = engines('cst')
    for (const input of INPUTS) {
      const opts = { build: cstBuildHost as never, rootTrivia: { select: ['comment'] } }
      expect(view(run(fast as never, input, opts)), input).toEqual(view(run(closure as never, input, opts)))
    }
  })

  it('reports the same expected set when two arms fail at the same depth', () => {
    const { closureItem, fastItem } = engines('ast')
    for (const input of ['a /* c */ ?', 'a x ?', 'a', '( b ?', '[ b , ?']) {
      const want = run(closureItem as never, input)
      expect(want.ok, input).toBe(false)
      expect(view(run(fastItem as never, input)), input).toEqual(view(want))
    }
  })
})
