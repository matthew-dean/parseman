/**
 * `parseman/table` — THE SHIPPED BUNDLE, NOT THE SOURCE.
 *
 * ── WHY THIS FILE IMPORTS `dist/` ───────────────────────────────────────────────
 * `regex()` used to get its first-set analyzer by RUNTIME REGISTRATION from
 * `src/index.ts` (`registerRegexAnalyzer`). Every test in this suite imports the
 * library entry somewhere in the same module graph, so the analyzer was always
 * registered and the seam was invisible from source — a source-only test passed
 * before the fix and would pass again after a regression.
 *
 * A published subpath is its OWN module graph. `dist/table/index.js` never runs
 * `src/index.ts`, so its private copy of `regex()` fell back to the permissive
 * `any()` first-set; `buildTrivia` (`src/table/program.ts`) rebuilds classified
 * trivia through that `regex()`, and `classifiedTrivia()` — which requires a
 * concrete finite first set per arm — then threw on EVERY arm:
 *
 *   TypeError: classifiedTrivia(): "whitespace" must be non-nullable with a
 *   concrete finite first set.
 *
 * So `./table`, an advertised export, could not run any grammar with labelled
 * trivia. Plain `trivia(regex(...))` survived because it asserts nothing.
 *
 * The fix makes the analyzer INTRINSIC to `src/combinators/regex.ts`. The first
 * test below proves it where it broke — through the built artifact, reached by
 * package self-reference so it resolves exactly as a consumer's would. The second
 * pins the property that made the bug possible, for every entry at once.
 *
 * dist/ is present whenever this runs: `prepare` builds it on install (see the
 * install step in `.github/workflows/ci.yml`). A missing bundle is a hard failure
 * here, never a skip — a skipped guard is not a guard.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
// Type-only, and from the PUBLISHED types on purpose: the values below come from
// `dist/`, so their declarations should too.
import type { Combinator } from 'parseman'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Bundling several entries with esbuild is not a 5s in-process unit test. */
const CLOSURE_BUDGET_MS = 60_000

describe('parseman/table — the SHIPPED entry runs a classifiedTrivia grammar', () => {
  beforeAll(() => {
    for (const f of ['dist/index.js', 'dist/table/index.js']) {
      if (!existsSync(resolve(ROOT, f))) {
        throw new Error(
          `${f} is missing — this file tests the BUILT artifact. Run \`pnpm build\`. ` +
            '(CI gets it from the `prepare` lifecycle script on install.)',
        )
      }
    }
  })

  it('encodes and drives a labelled-trivia grammar, agreeing with the interpreter', async () => {
    // Both specifiers go through package.json `exports` to `dist/`, which is the
    // point: two SEPARATE bundles, each with its own copy of `regex()`. Anything
    // one of them registers on a module-global cannot reach the other.
    const lib = await import('parseman')
    const table = await import('parseman/table')
    // `run()` drives a table-lowered rule and an interpreted one identically, so
    // the two sides below are compared through one driver rather than two.
    const { run } = await import('parseman/run')

    const trivia = lib.classifiedTrivia({
      whitespace: lib.regex(/[ \t\n\r]+/),
      comment: lib.regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
    })
    type Rules = Record<string, Combinator<unknown>>
    const grammar = lib.rules<Rules>({ trivia }, g => ({
      Word: lib.node('Word', lib.regex(/[a-z]+/), c => ({ t: 'Word', c })),
      Doc: lib.node('Doc', lib.many(g.Word!), c => ({ t: 'Doc', c })),
    })) as unknown as Rules

    // The throw was HERE: resolveTable -> buildTrivia -> classifiedTrivia.
    const prog = table.encodeTable(grammar as never)
    const driven = table.tableRules(prog) as Record<string, unknown>

    expect(Object.keys(driven).sort()).toEqual(['Doc', 'Word'])

    // And it does not merely construct — the interpreter is the oracle for what it
    // parses, so a first-set that silently widened would still have to agree.
    for (const input of ['abc def', 'a /* c */ b', '  ', '', 'a/*unclosed']) {
      const fromTable = run(driven.Doc as never, input)
      const fromInterpreter = run(grammar.Doc as never, input)
      expect(JSON.stringify(fromTable), `table vs interpreter on ${JSON.stringify(input)}`)
        .toBe(JSON.stringify(fromInterpreter))
    }
  })
})

describe('parseman/table — the macro artifact dependency', () => {
  it('initializes no WeakMap or descriptor metadata cache', () => {
    // This is deliberately a fresh Node process.  The property is about the
    // package export a consumer imports, not a source module already resident in
    // Vitest's graph; an in-process import can only prove a previous test warmed
    // the same cache first.
    const probe = `
      const RealWeakMap = globalThis.WeakMap
      const realDefine = Object.defineProperty
      let weakMaps = 0
      let descriptors = 0
      class CountedWeakMap extends RealWeakMap {
        constructor(...args) { super(...args); weakMaps++ }
      }
      globalThis.WeakMap = CountedWeakMap
      Object.defineProperty = new Proxy(realDefine, {
        apply(target, thisArg, args) { descriptors++; return Reflect.apply(target, thisArg, args) },
      })
      try {
        const runtime = await import('parseman/table')
        console.log(JSON.stringify({ weakMaps, descriptors, tableRules: typeof runtime.tableRules }))
      } finally {
        globalThis.WeakMap = RealWeakMap
        Object.defineProperty = realDefine
      }
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(JSON.parse(out) as { weakMaps: number, descriptors: number, tableRules: string }).toEqual({
      weakMaps: 0,
      descriptors: 0,
      tableRules: 'function',
    })
  })
})

describe("regex()'s first-set is intrinsic, not registered", () => {
  /** Every source module an entry pulls in, repo-relative. */
  async function closureOf(entry: string): Promise<Set<string>> {
    const result = await build({
      entryPoints: [resolve(ROOT, entry)],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      target: 'es2022',
      logLevel: 'silent',
    })
    return new Set(Object.keys(result.metafile.inputs).map(f => relative(ROOT, resolve(ROOT, f))))
  }

  /**
   * The source entry behind each `exports` subpath, plus the `bin`. `./table` is
   * the one that threw, but it was never the only entry with a graph-dependent
   * `regex()`: `./diagnostics`, `./spec`, `./language-service` and the CLI all
   * build grammars without `src/index.ts` in their graph, so all of them ran on
   * the permissive fallback and silently lost choice dispatch. Listing every
   * entry is what makes this a guard on the PROPERTY rather than on one bug.
   */
  const ENTRIES: Record<string, string> = {
    '.': 'src/index.ts',
    './diagnostics': 'src/analysis/diagnostics.ts',
    './plugin': 'src/plugin/index.ts',
    './run': 'src/run/index.ts',
    './table': 'src/table/index.ts',
    './spec': 'src/spec/index.ts',
    './language-service': 'src/language-service/index.ts',
    './oracle': 'src/oracle/index.ts',
    bin: 'src/cli/index.ts',
  }

  it(
    'no entry can hold regex() without the analyzer that gives it a real first set',
    async () => {
      const offenders: string[] = []
      for (const [name, entry] of Object.entries(ENTRIES)) {
        const closure = await closureOf(entry)
        if (closure.has('src/combinators/regex.ts') && !closure.has('src/regex/first-set.ts')) {
          offenders.push(name)
        }
      }
      expect(offenders, 'entries whose regex() would fall back to a permissive first set').toEqual([])
    },
    CLOSURE_BUDGET_MS,
  )
})
