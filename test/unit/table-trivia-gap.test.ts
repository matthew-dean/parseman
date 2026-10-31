/**
 * The table engines' labelled trivia skip under a root trivia selection
 * (`src/table/trivia-gap.ts`), through both engines: the closure pieces and the
 * emitted assembly.
 *
 * jess parses every dialect with `rootTrivia: { select: [comment labels] }`,
 * which keeps the root log live, so every trivia gap takes the labelled path.
 * Both engines must reach the shared skip, and record the same selected
 * chunks as before; the work a gap costs is pinned in
 * `trivia-root-selected-scan.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'
import type { Combinator } from '../../src/types.ts'
import { classifiedTrivia, literal, optional, regex, rules, sequence } from '../../src/index.ts'

type RuleMap = Record<string, Combinator<unknown>>

/** The whole program emitted, every site. */
function emitted(prog: TableProgram): TableProgram {
  return { ...prog, asm: defaultAssemblyCfgs(prog).map(cfg => {
    const em = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
    return { key: cfgKey(cfg), factory, plan: em.plan, reached: [...em.reached] }
  }) }
}

// The trivia arm sources jess uses, so the labelled spec has its chunk visitor
// and the trivia an unlabelled scanner.
const t = classifiedTrivia({
  whitespace: regex(/[ \t\n\r\f]+/),
  lineComment: regex(/\/\/[^\n\r]*/),
  blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
})
// `optional(x)` after `a` matches nothing, so `;` scans the same gap again.
const g = rules<RuleMap>({ trivia: t }, () => ({
  Doc: sequence(literal('a'), optional(literal('x')), literal(';')),
}))
const prog = encodeTable(g, { hostMode: 'ast' })
const engines = { closure: tableRules({ ...prog, asm: [] }).Doc!, fast: tableRules(emitted(prog)).Doc! }

const rows = (r: ReturnType<typeof run>) => (r as { rootTrivia?: { rows: unknown } }).rootTrivia?.rows
const opts = { rootTrivia: { select: ['blockComment'] } }

describe('a labelled trivia gap under a root trivia selection', () => {
  it('goes through the shared deferred skip in the emitted assembly', () => {
    const cfg = defaultAssemblyCfgs(prog)[0]!
    const source = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true).source
    expect(source).toContain('skipDeferredTrivia(input,cur,ctx)')
    expect(source).not.toContain('commitTriviaScan(scanTriviaCompact(')
  })

  for (const engine of ['closure', 'fast'] as const) {
    it(`parses and records exactly the selected chunks (${engine})`, () => {
      const cases: Array<[string, unknown]> = [
        ['a   ;', []],
        ['a /* c */ ;', [1, 10, 2, 9, 0]],
        ['a // l\n ;', []],
        ['a // l\n /* c */x;', [1, 15, 8, 15, 0]],
      ]
      for (const [input, want] of cases) {
        const r = run(engines[engine] as never, input, opts)
        expect(r.ok, input).toBe(true)
        expect(rows(r) ?? [], input).toEqual(want)
      }
    })
  }
})
