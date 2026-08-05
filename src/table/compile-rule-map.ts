import type { Combinator } from '../types.ts'
import type { HostMode } from '../compiler/codegen.ts'
import { collectGrammarReflection, type GrammarReflection } from '../cst/reflection.ts'
import { encodeTableProgram, type TableSettings } from './encode.ts'
import { emitTableExpression } from './emit.ts'
import { assembledRules } from './assemble.ts'
import type { TableProgram, TableRule } from './program.ts'
import type { GrammarCoverageDefinition } from '../compiler/grammar-coverage-ids.ts'

/**
 * `compileRuleMap()` FOR THE TABLE LOWERING — the counterpart that did not exist.
 *
 * `compileTable` covered `compile()`, the SINGLE-ROOT entry point, which the
 * plugin uses only for standalone combinators (`plugin/index.ts:1693`, `:1870`).
 * The main path — every `rules()` grammar — goes through `compileRuleMap`, and
 * with no table counterpart there was nothing for the macro build to point at.
 * This is that function, and it is the EASY direction: `encodeTable` takes a
 * named rule map natively, so nothing here adapts a shape. `compileTable` is the
 * one that adapts (it wraps a root as `{ Entry: root }`).
 *
 * ── THE CONTRACT IT MATCHES ──────────────────────────────────────────────────
 * `compileRuleMap` returns ONE `replacement` string: a self-contained expression
 * that the plugin splices over the whole `rules(factory)` call-expression
 * (`plugin/index.ts:1753`, and as an initialiser at `:1941`), evaluating ONCE to
 * the `{ name: fn, … }` map. `keys` is the entry list, for the caller to check
 * against the source's own keys. `hostMode` / `hostBranchElided` are what the
 * macro stamps the emitted map with. `reflection` is per-grammar CST node
 * reflection. It returns `null`, all-or-nothing, when the map cannot be inlined.
 *
 * Every one of those is reproduced here, with ONE stated divergence, the same
 * one `compileTable` documents: the expression references `tableRules` and is
 * therefore NOT self-contained. That reference is the entire reason a table
 * artifact is small; inlining the driver per grammar rebuilds exactly the size
 * this lowering exists to remove. The consumer owns the import.
 *
 * ── WHY `emitTableModule` WAS NOT ENOUGH ─────────────────────────────────────
 * It emits a whole rule map as one module — `import` line, `export const` — and
 * the plugin has no module to write; it has an expression slot inside an
 * existing file. `emitTableExpression` was the right emitter and needed one
 * thing: `entry: null`, meaning "the map itself" rather than one rule out of it.
 * That is a two-line change to an existing emitter, not a new one.
 */
export type TableRuleMapOptions = {
  /** Grammar-level ambient trivia, as `rules({ trivia }, …)` declares it. */
  readonly trivia?: Combinator<unknown>
  /** Grammar-level ambient scan-skip, as `rules({ scanSkip }, …)` declares it. */
  readonly scanSkip?: Combinator<unknown>[]
  readonly recovery?: boolean
  readonly hostMode?: HostMode
  readonly trackLines?: boolean
  /**
   * Accepted for signature compatibility with `compileRuleMap` and REFUSED, for
   * the reason `compileTable` states: the table has no per-statement site to
   * attach coverage instrumentation to, and a compile that quietly drops the
   * instrumentation its caller asked for reports a clean run over nothing.
   */
  readonly coverage?: boolean
  /** Identifier the emitted expression expects `tableRules` to be bound to. */
  readonly runtimeRef?: string
  /**
   * Reducer sources in `prog.fns` order, for a caller that holds them OUT OF
   * BAND — the same escape `compileTable(combinator, mapFnSources?)` provides.
   *
   * The encoder captures a source per callback from the def (`fnSrc` /
   * `buildSrc` / `predSrc` / `gateSrcs`), which the macro evaluator sets and a
   * runtime-built combinator does not have. Supplying them here is what lets a
   * grammar constructed at runtime still PRINT; it does not override captured
   * ones, it fills in for a pool that has none.
   */
  readonly fnSources?: readonly string[]
}

export type CompiledRuleMapTable = {
  /** Every entry this saw, in order — same use as `compileRuleMap`'s `keys`. */
  keys: string[]
  /** The expression that replaces the whole `rules(factory)` call. */
  replacement: string
  hostMode: HostMode
  hostBranchElided: boolean
  reflection: GrammarReflection
  /**
   * The RUNNABLE map, which the source lowering has no counterpart for — it
   * hands back text and nothing else, because its artifact only exists once the
   * emitted source is evaluated. A table exists as data before it is printed, so
   * the same call that produces the replacement can also hand back the parser.
   * That is what makes a differential against the interpreter possible without
   * `eval`, and it is why the table-vs-interpreter test can compare `expected`
   * sets rather than only accept/reject.
   */
  rules: Record<string, TableRule>
  /** The encoded program, for a caller that wants to fold or inspect it. */
  prog: TableProgram
  /**
   * The coverage DENOMINATOR — every id this map can hit — present only under
   * `{ coverage: true }`. Same field and same meaning as `compileRuleMap`'s, so
   * the plugin's stamp site needs no branch on which lowering produced it.
   */
  coverageDefinitions?: readonly GrammarCoverageDefinition[]
}

/**
 * The host mode this map was lowered for, resolved the way `compileRuleMap`
 * resolves it: an explicit option, else a `grammarHostMode` stamp left on the
 * rules by `rules({ hostMode }, …)`. The stamp is the only channel a macro build
 * has, since it passes no compile options.
 */
function resolveHostMode(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  explicit: HostMode | undefined,
): HostMode {
  return explicit
    ?? ruleMap.map(([, r]) => r._meta.grammarHostMode).find(Boolean)
    ?? 'ast'
}

function resolveTrackLines(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  explicit: boolean | undefined,
): boolean {
  return explicit === true || ruleMap.some(([, r]) => r._meta.grammarTrackLines === true)
}

/**
 * Apply grammar-level trivia / scan-skip passed as OPTIONS.
 *
 * `rules({ trivia }, …)` stamps `_meta.grammarTrivia` on every non-trivia rule
 * (combinators/parser.ts:203) and `encodeTable` reads it from there, per rule.
 * A caller that instead threads the declaration as an option — which the macro
 * does, because it re-evaluates the factory itself — must land it in the same
 * place or the whole grammar encodes with NO ambient trivia and every
 * whitespace-bearing input fails identically in every engine, which makes an
 * identity check agree while proving nothing.
 *
 * Only fills a GAP: a rule that already carries its own stamp keeps it, so a
 * `composeLeaf` map whose pieces legitimately disagree is not flattened.
 */
function applyAmbient(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opts: TableRuleMapOptions,
): void {
  for (const [, rule] of ruleMap) {
    if (rule._meta.isTrivia) continue
    const meta = rule._meta as {
      grammarTrivia?: Combinator<unknown>
      grammarScanSkip?: Combinator<unknown>[]
    }
    if (opts.trivia !== undefined && meta.grammarTrivia === undefined) meta.grammarTrivia = opts.trivia
    if (opts.scanSkip !== undefined && meta.grammarScanSkip === undefined) meta.grammarScanSkip = opts.scanSkip
  }
}

export function compileRuleMapTable(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opts: TableRuleMapOptions = {},
): CompiledRuleMapTable | null {
  if (opts.coverage === true) {
    throw new Error(
      'compileRuleMapTable: { coverage: true } is not implemented for the table lowering. '
      + 'Coverage instrumentation is emitted per generated statement by the source lowering; '
      + 'the table has no per-statement site to attach it to yet. This throws rather than '
      + 'returning a map with no coverageDefinitions, because coverage that silently '
      + 'measures nothing reads as a passing run.',
    )
  }
  applyAmbient(ruleMap, opts)
  const hostMode = resolveHostMode(ruleMap, opts.hostMode)
  const settings: TableSettings = {
    hostMode,
    ...(resolveTrackLines(ruleMap, opts.trackLines) ? { trackLines: true } : {}),
    ...(opts.recovery === true ? { recovery: true } : {}),
  }

  // ALL-OR-NOTHING, exactly as `compileRuleMap` is. A construct with no opcode
  // (`UnsupportedConstruct`) and a `g.X` reference that resolves to nothing
  // (the lazy thunk throws) both mean this map cannot become a table, and the
  // caller's existing "leave this rules() call interpreted" fallback covers it.
  let encoded: { prog: TableProgram; fnSrcs: (string | null)[] }
  try {
    encoded = encodeTableProgram(Object.fromEntries(ruleMap), settings)
  } catch {
    return null
  }
  const { prog, fnSrcs } = encoded

  // RUNTIME-ONLY: the program parses but cannot be PRINTED (a live trivia
  // combinator parked in the pool, say). `compileRuleMap` returns null for its
  // own unprintable cases rather than emitting something that loads and
  // misbehaves; this is the same answer to the same question.
  if (prog.runtimeOnly !== undefined && prog.runtimeOnly.length > 0) return null
  // The `mfCovered && buildCovered` gate, for the table's reducer pool: without
  // a source per author callback the emitters print `() => {}`, which produces a
  // module that loads and returns the wrong tree. An out-of-band list fills in
  // only where the encoder captured nothing, and only if it is COMPLETE — a
  // partial list would leave the placeholders it was passed to remove.
  const supplied = opts.fnSources
  const sources = fnSrcs.map((s, i) => s ?? supplied?.[i] ?? null)
  if (sources.some(s => s === null)) return null
  if (supplied !== undefined && supplied.length > fnSrcs.length) {
    throw new Error(
      `compileRuleMapTable: got ${supplied.length} fnSources for a pool of ${fnSrcs.length}. `
      + 'The list is positional, in prog.fns order, so a longer one means it belongs to a '
      + 'different encode — and the entries would be silently misassigned.',
    )
  }

  const replacement = emitTableExpression(prog, {
    entry: null,
    runtimeRef: opts.runtimeRef ?? 'tableRules',
    fnSources: sources as string[],
  })

  return {
    keys: ruleMap.map(([key]) => key),
    replacement,
    hostMode,
    // The table's OWN answer, not a re-derivation: `stampRuleMap` sets
    // `FUSED_HOST_ELIDED` to `mode === 'ast'` on every entry it builds, because
    // an 'ast' encode really did drop the positioned-CST branch. Reporting
    // anything else here would put the macro's stamp at odds with the artifact's.
    hostBranchElided: hostMode === 'ast',
    reflection: collectGrammarReflection(ruleMap),
    rules: assembledRules(prog),
    prog,
  }
}
