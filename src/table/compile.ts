import type { Combinator, ParseContext, ParseError, ParseResult } from '../types.ts'
import type { CompiledParser, HostMode } from '../compiler/codegen.ts'
import { createParseContext } from '../parse-context.ts'
import { encodeTable, type TableSettings } from './encode.ts'
import { emitTableModule, emitTableExpression } from './emit.ts'
import { assembledRules } from './assemble.ts'

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
   * Lower tolerant recovery, as the source lowering's `{ recovery: true }` does:
   * `many`/`sepBy`/`oneOrMore` resync to a sync point inferred from grammar
   * structure and emit a `ParseError` over the skipped span, and `expect()`
   * embeds its error in the tree. Dormant until a parse sets `ctx._tolerant` —
   * which `parseWithErrors` does, and which is why building WITHOUT this makes
   * `parseWithErrors` refuse rather than quietly collect nothing.
   */
  readonly recovery?: boolean
  /**
   * Accepted for signature compatibility with the source-lowering `compile()`.
   * Any of these that the table lowering cannot yet honour THROWS rather than
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
  if (opts.coverage === true) {
    throw new Error(
      'compileTable: { coverage: true } is not implemented for the table lowering. '
      + 'Coverage instrumentation is emitted per generated statement by the source '
      + 'lowering; the table has no per-statement site to attach it to yet. This '
      + 'throws rather than returning a parser with no coverageDefinitions, because '
      + 'coverage that silently measures nothing reads as a passing run.',
    )
  }
  const settings: TableSettings = {
    ...(opts.hostMode === undefined ? {} : { hostMode: opts.hostMode }),
    ...(opts.trackLines === undefined ? {} : { trackLines: opts.trackLines }),
    ...(opts.recovery === true ? { recovery: true } : {}),
  }
  const prog = encodeTable({ [ENTRY]: combinator as Combinator<unknown> }, settings)
  const entry = assembledRules(prog)[ENTRY]!

  // `runtimeOnly` reasons mean the program RUNS but cannot be printed. The parse
  // functions below are unaffected; only `source` / `inlineExpression` are, and
  // they degrade to null rather than throwing out of the printer at a call site
  // that only wanted to parse.
  const printable = (prog.runtimeOnly === undefined || prog.runtimeOnly.length === 0)
  const sources = opts.fnSources ?? mapFnSources
  const emitOpts = sources === undefined ? {} : { fnSources: [...sources] }
  const source = printable ? emitTableModule(prog, { name: 'grammar', ...emitOpts }) : ''
  const inlineExpression = printable
    ? emitTableExpression(prog, { entry: ENTRY, runtimeRef: opts.runtimeRef ?? 'tableRules', ...emitOpts })
    : null

  const runOnce = (input: string, pos: number, ctx: ParseContext): ParseResult<T> =>
    entry(input, pos, ctx) as ParseResult<T>

  return {
    source,
    inlineExpression,
    parse(input: string, pos = 0): ParseResult<T> {
      return runOnce(input, pos, createParseContext())
    },
    parseWithContext(input: string, parseCtx: ParseContext, pos = 0): ParseResult<T> {
      return runOnce(input, pos, parseCtx)
    },
    /**
     * REFUSES A PARSER THAT CANNOT RECOVER, rather than returning `errors: []`.
     *
     * This set `_tolerant` on a driver with no recovery lowered into it at all,
     * so every call reported a clean parse with an empty error list whatever the
     * input — a flag that measures nothing, which is the same defect class as
     * coverage instrumentation that silently records none. `expect()` alone would
     * still have filled `_errors`, which is worse: SOME grammars looked like they
     * worked.
     */
    parseWithErrors(input: string, pos = 0): ParseResult<T> & { errors: ParseError[] } {
      if (opts.recovery !== true) {
        throw new Error(
          'compileTable: parseWithErrors() needs a parser built with { recovery: true }. '
          + 'The sync point a tolerant list resyncs to is inferred from grammar structure and '
          + 'lowered into the table, so it has to be chosen at BUILD time. Without it this call '
          + 'would parse strictly and hand back an empty `errors` array, which reads as a clean file.',
        )
      }
      const ctx = createParseContext()
      const errors: ParseError[] = []
      ctx._errors = errors
      ctx._tolerant = true
      const r = runOnce(input, pos, ctx)
      return { ...r, errors } as ParseResult<T> & { errors: ParseError[] }
    },
  }
}
