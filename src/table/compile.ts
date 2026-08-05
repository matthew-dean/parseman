import type { Combinator, ParseContext, ParseError, ParseResult } from '../types.ts'
import type { CompiledParser, HostMode } from '../compiler/codegen.ts'
import { createParseContext } from '../parse-context.ts'
import { encodeTableProgram, type TableSettings } from './encode.ts'
import { emitTableModule, emitTableExpression } from './emit.ts'
import { assembledRules } from './assemble.ts'
import { buildGrammarPlan } from '../compiler/grammar-coverage-ids.ts'

/**
 * `compile()` FOR THE TABLE LOWERING — same contract, different artifact.
 *
 * The entry rule is named rather than positional because the table indexes rules
 * by name. A root combinator is simply a one-rule map: `{ Entry: root }` encodes
 * and round-trips value-identically to the interpreter, which is what makes this
 * a drop-in for the source-lowering `compile()` rather than a second API.
 */
const ENTRY = 'Entry'

/**
 * THE LAST RESORT FOR A REDUCER'S SOURCE — the function's own text.
 *
 * Third in precedence, behind the encoder's captured `fnSrc`/`buildSrc`/`predSrc`
 * and behind a positional list. It exists because `compileTable` is the library
 * `compile()` (`src/index.ts`), and a grammar BUILT AT RUNTIME has no captured
 * sources at all — every `examples/*` fixture is one. Refusing them outright would
 * make `.source` and `.inlineExpression` empty for every library caller, which
 * `test/unit/table-compile.test.ts` pins against directly.
 *
 * WHAT IT IS NOT is a licence to print a placeholder. `() => {}` is only ever
 * produced here if the author literally wrote it, so a reducer that silently
 * returns nothing is not reachable through this path. A closure over its module's
 * privates prints text that throws a ReferenceError when the module loads — LOUD,
 * at load, naming the binding — which is the failure mode this project prefers
 * over an artifact that parses and returns the wrong tree.
 *
 * Native and bound functions have no recoverable body (`[native code]`), so they
 * return null and the caller refuses BY NAME.
 */
function ownSource(fn: unknown): string | null {
  if (typeof fn !== 'function') return null
  const text = Function.prototype.toString.call(fn)
  if (!text.includes('[native code]')) return text
  // A BUILT-IN GLOBAL USED AS A REDUCER — `leaf(regex(…), parseFloat)` is exactly
  // that, and `examples/graphql/parser.ts` writes it. It has no body to print, but
  // its NAME is a global binding that denotes the identical function in any module,
  // so the name IS the faithful source. Verified by identity against `globalThis`,
  // never by name alone: `Number.parseFloat` and a shadowed local both fail that.
  const name = (fn as { name?: unknown }).name
  return typeof name === 'string' && name.length > 0
    && (globalThis as unknown as Record<string, unknown>)[name] === fn
    ? name
    : null
}

/**
 * THE CONTRACT DIVERGENCE, stated rather than hidden.
 *
 * `CompiledParser.inlineExpression` is documented as a self-contained IIFE with
 * "no external references". A table artifact cannot honour that clause and stay
 * a table: the shared driver being EXTERNAL is the entire reason the artifact is
 * 0.56 MB instead of source lowering's 2.10 MB. Inlining the driver per grammar
 * reproduces exactly the size this lowering exists to avoid.
 *
 * So the expression references `tableRules`, and the consumer is responsible for
 * having imported it. That is a real change to what an inliner must do, and it
 * is the reason this is a lowering swap rather than a rename.
 *
 * It is NOT null. Returning null would be the quiet failure: `plugin/index.ts`
 * warns and SKIPS on null, leaving the grammar interpreted — 79 ms against 14 ms
 * on `benchmark.less`, a ~5x regression that no test would have reported.
 */
export type TableCompileOptions = {
  readonly hostMode?: HostMode
  readonly trackLines?: boolean
  /**
   * ACCEPTED AND IGNORED — recovery is ALWAYS lowered (see `TableSettings.recovery`).
   * Kept so this stays a drop-in for `compile(g, …, { recovery: true })`.
   */
  readonly recovery?: boolean
  /**
   * GRAMMAR-COVERAGE COUNTERS, lowered as `OP_COV` rows plus the definition pool
   * (`TableProgram.cov`). Same ids as the source lowering, because both mint them
   * from the same `buildGrammarPlan` walk over the same combinator graph.
   *
   * COUNTERS ONLY — owner ruling. `_grammarTrace`'s six phases are emitted at
   * ~40 fine-grained sites by codegen and are deferred to 0.48
   * (`notes/RELEASE-0.48-TARGET.md` §1). A trace sink installed on a context
   * running a table simply receives nothing; the plugin's coverage path reads
   * `_grammarCoverage` and the definitions stamp, neither of which is trace.
   *
   * The remaining options below are accepted for signature compatibility with
   * `compile()`. Any that the table lowering cannot honour THROWS rather than
   * being ignored — a compile that silently drops the instrumentation its caller
   * asked for is the failure class this project keeps finding, and coverage that
   * silently reports nothing is worse than a build error that says why.
   */
  readonly coverage?: boolean
  readonly duplication?: unknown
  readonly maxInline?: number
  /** Identifier the emitted expression expects to find `tableRules` under. */
  readonly runtimeRef?: string
  /** Source text per `prog.fns` entry, for a module/expression that must be printable. */
  readonly fnSources?: readonly string[]
}

export function compileTable<T>(
  combinator: Combinator<T>,
  mapFnSources?: readonly string[],
  opts: TableCompileOptions = {},
): CompiledParser<T> {
  // Argument order mirrors `compile(combinator, mapFnSources?, opts?)` so this is
  // a drop-in, not a second API with a different shape.
  // THE SAME WALK CODEGEN USES FOR A SINGLE ROOT (`codegen.ts:5377`): no winner
  // map, so the paths are rooted at `entry` and the ids are the ones a caller
  // switching lowerings already has. Building it differently here would produce a
  // set that is internally consistent and lines up with nothing.
  const plan = opts.coverage === true ? buildGrammarPlan(combinator as Combinator<unknown>) : undefined
  const settings: TableSettings = {
    ...(opts.hostMode === undefined ? {} : { hostMode: opts.hostMode }),
    ...(opts.trackLines === undefined ? {} : { trackLines: opts.trackLines }),
    ...(plan === undefined ? {} : { coverage: plan }),
  }
  // `encodeTableProgram`, NOT `encodeTable`. The plain `encodeTable` drops the
  // `fnSrcs` side-channel on the floor, and dropping it is what made a printed
  // module return NO VALUE: `emitTable*` falls back to `prog.fns.map(() => '() => {}')`
  // (emit.ts:178/219/252), so every author reducer — `node` build fns, `transform`,
  // `leaf` — became an empty arrow. The grammar still parsed, still returned `ok`,
  // and returned `undefined` where the interpreter and codegen both returned a tree.
  // `compileRuleMapTable` has guarded this since it was written (compile-rule-map.ts);
  // this is the same guard on the single-root entry point.
  const { prog, fnSrcs } = encodeTableProgram({ [ENTRY]: combinator as Combinator<unknown> }, settings)
  const entry = assembledRules(prog)[ENTRY]!

  // Captured-first, supplied-as-fill-in. The encoder records a source per author
  // callback from the def (`fnSrc` / `buildSrc` / `predSrc` / `gateSrcs`), which the
  // macro evaluator sets; the out-of-band list is the escape for a combinator built
  // at runtime, and it only fills HOLES.
  //
  // The list is POSITIONAL, in `prog.fns` order, so it is only usable when it indexes
  // THIS pool — a different length means it came from a different walk (the evaluator
  // collects one entry per callback it SEES; the encoder pools one per callback it
  // EMITS, and those need not coincide) and applying it would misassign reducers
  // silently. A mismatched list is therefore not consulted at all; if that leaves a
  // hole, the refusal below fires and says so, which is the safe direction.
  const offered = opts.fnSources ?? mapFnSources
  const supplied = offered !== undefined && offered.length === fnSrcs.length ? offered : undefined
  const sources = fnSrcs.map((s, i) => s ?? supplied?.[i] ?? ownSource(prog.fns[i]))

  // `runtimeOnly` reasons mean the program RUNS but cannot be printed. The parse
  // functions below are unaffected; only `source` / `inlineExpression` are, and
  // they degrade to null rather than throwing out of the printer at a call site
  // that only wanted to parse.
  //
  // AN UNSOURCED REDUCER IS ONE OF THOSE REASONS. It is not a licence to print a
  // placeholder: a module that loads, parses, and returns the wrong tree is worse
  // than one that refuses, because nothing reports it. REFUSE, with a name.
  const unsourced = sources.reduce<number[]>((acc, s, i) => (s === null ? [...acc, i] : acc), [])
  const runtimeOnly = [
    ...(prog.runtimeOnly ?? []),
    ...(unsourced.length === 0
      ? []
      : [`author reducer source missing for prog.fns[${unsourced.join(', ')}] — printing would emit \`() => {}\` and the parse would return no value`]),
  ]
  const printable = runtimeOnly.length === 0
  const emitOpts = { fnSources: sources as string[] }
  const source = printable ? emitTableModule(prog, { name: 'grammar', ...emitOpts }) : ''
  const inlineExpression = printable
    ? emitTableExpression(prog, { entry: ENTRY, runtimeRef: opts.runtimeRef ?? 'tableRules', ...emitOpts })
    : null

  const runOnce = (input: string, pos: number, ctx: ParseContext): ParseResult<T> =>
    entry(input, pos, ctx) as ParseResult<T>

  return {
    source,
    inlineExpression,
    ...(printable ? {} : { runtimeOnly }),
    // The DENOMINATOR, handed back rather than scraped out of the emitted text.
    // `plugin/index.ts` prefers a compiler-supplied `coverageDefinitions` and only
    // falls back to regex-scanning generated hooks; a table has no hooks to scan,
    // so this is the channel.
    ...(plan === undefined ? {} : { coverageDefinitions: plan.definitions }),
    parse(input: string, pos = 0): ParseResult<T> {
      return runOnce(input, pos, createParseContext())
    },
    parseWithContext(input: string, parseCtx: ParseContext, pos = 0): ParseResult<T> {
      return runOnce(input, pos, parseCtx)
    },
    /**
     * NO LONGER REFUSES. It used to throw unless the caller passed
     * `{ recovery: true }`, because setting `_tolerant` on a table with no
     * recovery rows would report a clean parse with an empty error list whatever
     * the input — refusing was the right answer to that, and OPTIONAL RECOVERY
     * was the wrong question. `compile()` requires no such flag, so the refusal
     * was a `CompiledParser` contract break; recovery is now always lowered and
     * there is nothing left to refuse.
     */
    parseWithErrors(input: string, pos = 0): ParseResult<T> & { errors: ParseError[] } {
      const ctx = createParseContext()
      const errors: ParseError[] = []
      ctx._errors = errors
      ctx._tolerant = true
      const r = runOnce(input, pos, ctx)
      return { ...r, errors } as ParseResult<T> & { errors: ParseError[] }
    },
  }
}
