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
import { choice, classifiedTrivia, gate, leaf, literal, node, optional, regex, rules, sequence, withCtx } from '../../src/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { skipDeferredTrivia } from '../../src/table/trivia-gap.ts'

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

// A trivia arm that reads state: spaces count only while `on`. Both choice arms
// scan the gap after `b` from the same position, the first with `on` false
// (nothing matches, so `c` fails) and the second with `on` true, which must get
// the spaces rather than the first arm's answer.
const gated = classifiedTrivia({
  space: sequence(regex(/[ ]+/), gate(s => (s as { on?: boolean } | undefined)?.on === true)),
  blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
})
const gg = rules<RuleMap>({ trivia: gated }, () => ({
  Doc: choice(
    withCtx({ on: false }, sequence(literal('b'), literal('c'), literal('!'))),
    withCtx({ on: true }, sequence(literal('b'), literal('c'))),
  ),
}))
const gprog = encodeTable(gg, { hostMode: 'ast' })
const gEngines = { closure: tableRules({ ...gprog, asm: [] }).Doc!, fast: tableRules(emitted(gprog)).Doc! }

describe('a remembered trivia gap', () => {
  for (const engine of ['closure', 'fast'] as const) {
    it(`is not reused under another state (${engine})`, () => {
      const r = run(gEngines[engine] as never, 'b  c', opts)
      expect(r.ok).toBe(true)
    })
  }

  // A `leaf` sets the trivia log aside while its child runs, so the zero-width
  // `optional` inside it scans the gap with no log; the node's next term asks for
  // the same gap with the log back and must record it.
  const lg = rules<RuleMap>({ trivia: t }, () => ({
    Doc: node(
      sequence(leaf(sequence(literal('a'), optional(literal('x'))), (v: unknown) => v), literal(';')),
      (_c: unknown, _f: unknown, _s: unknown, _r: unknown, triviaLog: unknown) => ({ triviaLog }),
    ),
  }))
  const lprog = encodeTable(lg, { hostMode: 'ast' })
  const lEngines = { interpreter: lg.Doc!, closure: tableRules({ ...lprog, asm: [] }).Doc!, fast: tableRules(emitted(lprog)).Doc! }
  it('is not reused across a trivia log a leaf set aside', () => {
    const want = run(lEngines.interpreter as never, 'a /* c */ ;', opts)
    expect(want.ok).toBe(true)
    for (const engine of ['closure', 'fast'] as const) {
      const r = run(lEngines[engine] as never, 'a /* c */ ;', opts)
      expect(r.value, engine).toEqual(want.value)
      expect(rows(r), engine).toEqual(rows(want))
    }
  })

  it('is held by the parse context, so it is released with the parse', () => {
    // The context `run()` builds for `rootTrivia: { select: ['blockComment'] }`.
    const rooted = (): ReturnType<typeof createParseContext> => {
      const ctx = createParseContext()
      ctx.trivia = t as Combinator<unknown>
      ctx._rootTriviaLog = []
      ctx._rootTriviaKindIndex = { blockComment: 0 }
      return ctx
    }
    const ctx = rooted()
    expect(skipDeferredTrivia('a   ;', 1, ctx)).toBe(4)
    expect(ctx._gap).toMatchObject({ at: 1, end: 4, input: 'a   ;' })
    const other = rooted()
    expect(other._gap).toBeUndefined()
    expect(skipDeferredTrivia('a ;', 1, other)).toBe(2)
    expect(ctx._gap).toMatchObject({ at: 1, end: 4, input: 'a   ;' })
  })
})
