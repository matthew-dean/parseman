import type { Combinator } from '../types.ts'
import { hasDirectBuildDef } from '../analysis/commitment.ts'
import type { HostMode } from '../cst/host-mode.ts'
import { collectGrammarReflection, type GrammarReflection } from '../cst/reflection.ts'
import { encodeTableProgram, type TableSettings } from './encode.ts'
import { defaultAssemblyCfgs, emitTableExpression } from './emit.ts'
import { tableRules } from './assemble.ts'
import { closureArtifact } from './program.ts'
import type { TableProgram, TableRule } from './program.ts'
import { buildGrammarPlan, type GrammarCoverageDefinition } from '../compiler/grammar-coverage-ids.ts'
import { runDuplicationDiagnosticRules, type DuplicationOption } from './duplication-hook.ts'

/**
 * Static assembly has a fixed source cost that tiny grammars cannot amortize.
 * The canonical size probe's composeLeaf is 62 words and grows by ~12 kB with
 * a factory; the shipping Jess leaves are 6,365/10,892 words. Keep the policy
 * between those measured populations so small artifacts retain table density.
 */
const DEFAULT_PRECOMPILE_MIN_WORDS = 1_024

/**
 * `compileRuleMap()` FOR THE TABLE LOWERING — the counterpart that did not exist.
 *
 * `compile` covered `compile()`, the SINGLE-ROOT entry point, which the
 * plugin uses only for standalone combinators (`plugin/index.ts:1693`, `:1870`).
 * The main path — every `rules()` grammar — goes through `compileRuleMap`, and
 * with no table counterpart there was nothing for the macro build to point at.
 * This is that function, and it is the EASY direction: `encodeTable` takes a
 * named rule map natively, so nothing here adapts a shape. `compile` is the
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
 * one `compile` documents: the expression references `tableRules` and is
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
   * GRAMMAR-COVERAGE COUNTERS. This is the MACRO's path — `plugin/index.ts` passes
   * `coverage: grammarCoverage` here for every `rules()` grammar — so this is what
   * makes `{ grammarCoverage: true }` a working build under the table lowering.
   *
   * COUNTERS ONLY, per the owner ruling recorded in `notes/RELEASE-0.48-TARGET.md`
   * §1; `_grammarTrace` parity is 0.48 work. The plugin's coverage path needs the
   * DEFINITIONS STAMP and the HITS, and both are here.
   */
  readonly coverage?: boolean
  /** Identifier the emitted expression expects `tableRules` to be bound to. */
  readonly runtimeRef?: string
  /**
   * Reducer sources in `prog.fns` order, for a caller that holds them OUT OF
   * BAND — the same escape `compile(combinator, mapFnSources?)` provides.
   *
   * The encoder captures a source per callback from the def (`fnSrc` /
   * `buildSrc` / `predSrc` / `gateSrcs`), which the macro evaluator sets and a
   * runtime-built combinator does not have. Supplying them here is what lets a
   * grammar constructed at runtime still PRINT; it does not override captured
   * ones, it fills in for a pool that has none.
   */
  readonly fnSources?: readonly string[]
  /**
   * WHY THIS REFUSED, filled in on the `null` return.
   *
   * `null` means "leave this grammar interpreted", which is ~79 ms against ~14 ms
   * on `benchmark.less` — a ~5x regression that produces no test failure and no
   * warning content beyond "couldn't be inlined". The reasons exist inside the
   * encoder (`prog.runtimeOnly`) and simply had no way out; this is that way out,
   * so the plugin's warning can name the construct instead of the outcome.
   *
   * An out-parameter rather than a changed return type: every existing caller
   * checks for `null` and that contract is unchanged.
   */
  readonly refusals?: string[]
  /**
   * The structural duplication diagnostic. Ran inside the source lowering; it runs
   * here for the same reason, so a build that asked for it keeps getting it.
   */
  readonly duplication?: DuplicationOption
}

export type CompiledRuleMapTable = {
  /** Every entry this saw, in order — same use as `compileRuleMap`'s `keys`. */
  keys: string[]
  /** The expression that replaces the whole `rules(factory)` call. */
  replacement: string
  /** Re-emit the same table call with construction-time artifact metadata. */
  replacementWithMetadata(
    metadataSource: string,
    options?: { readonly precompileDefault?: boolean },
  ): string
  hostMode: HostMode
  hostBranchElided: boolean
  reflection: GrammarReflection
  /**
   * The LIVE RUNNABLE map, which the source lowering has no counterpart for — it
   * hands back text and nothing else, because its artifact only exists once the
   * emitted source is evaluated. A table exists as data before it is printed, so
   * the same call that produces the replacement can also hand back the parser.
   * It may use runtime assembly specialisation; `prog` and `replacement` remain
   * serialized closure artifacts. That is what makes a differential against the
   * interpreter possible without `eval`, and it is why the table-vs-interpreter
   * test can compare `expected` sets rather than only accept/reject.
   */
  rules: Record<string, TableRule>
  /** The closure-stamped wire program, for a caller that wants to fold or inspect it. */
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
 * Apply grammar-level trivia / scan-skip passed as OPTIONS to ENCODING-LOCAL
 * rule wrappers.
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
 *
 * The wrappers are load-bearing. This used to write directly to `rule._meta`,
 * which made a compile option part of the caller's grammar forever: compile the
 * same map once with whitespace trivia and a later compile with comma trivia
 * would still use whitespace. Encoding is synchronous, but a copy is safer than
 * a save/restore mutation (including on the exception path), and keeps compiler
 * options out of long-lived grammar metadata altogether.
 */
function withAmbient(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opts: TableRuleMapOptions,
): ReadonlyArray<readonly [string, Combinator<unknown>]> {
  if (opts.trivia === undefined && opts.scanSkip === undefined) return ruleMap

  const wrappers = new Map<Combinator<unknown>, Combinator<unknown>>()
  return ruleMap.map(([name, rule]) => {
    if (rule._meta.isTrivia) return [name, rule] as const
    const addTrivia = opts.trivia !== undefined && rule._meta.grammarTrivia === undefined
    const addScanSkip = opts.scanSkip !== undefined && rule._meta.grammarScanSkip === undefined
    if (!addTrivia && !addScanSkip) return [name, rule] as const

    let wrapped = wrappers.get(rule)
    if (wrapped === undefined) {
      wrapped = {
        ...rule,
        _meta: {
          ...rule._meta,
          ...(addTrivia ? { grammarTrivia: opts.trivia } : {}),
          ...(addScanSkip ? { grammarScanSkip: opts.scanSkip } : {}),
        },
      }
      wrappers.set(rule, wrapped)
    }
    return [name, wrapped] as const
  })
}

/**
 * ENCODE FOR RUNNING, with no printability requirement.
 *
 * `compileRuleMap` refuses a map whose author callbacks have no captured SOURCE,
 * because PRINTING one would emit `() => {}` and the parse would return the wrong tree.
 * That gate is right for the macro, which prints, and wrong for every caller that only
 * ever RUNS the result: a grammar built at runtime has live callbacks and no sources by
 * construction, and `encodeTableProgram` parks the live function in the pool where the
 * driver calls it perfectly well.
 *
 * Conflating the two is the single defect this project has now hit three times — a
 * runtime `compose()`, `linkable()`, and the fuse — each presenting as "this grammar
 * cannot be compiled" for a grammar that runs. The split lives here, once, so the next
 * caller inherits the right answer instead of rediscovering it.
 */
export function compileRuleMapRunnable(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opts: TableRuleMapOptions = {},
): Omit<CompiledRuleMapTable, 'replacement' | 'replacementWithMetadata'> | null {
  const encoded = encodeForRun(ruleMap, opts)
  if (encoded === null) return null
  const { prog, hostMode, plan } = encoded
  const artifact = closureArtifact(prog)
  return {
    keys: ruleMap.map(([key]) => key),
    hostMode,
    hostBranchElided: hostMode === 'ast' && ruleMap.some(([, rule]) => hasDirectBuildDef(rule)),
    reflection: collectGrammarReflection(ruleMap),
    ...(plan === undefined ? {} : { coverageDefinitions: plan.definitions }),
    rules: tableRules(prog),
    prog: artifact,
  }
}

function encodeForRun(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opts: TableRuleMapOptions,
): { prog: TableProgram; fnSrcs: (string | null)[]; hostMode: HostMode; plan: ReturnType<typeof buildGrammarPlan> | undefined } | null {
  runDuplicationDiagnosticRules(ruleMap, opts.duplication)
  const encodeMap = withAmbient(ruleMap, opts)
  // WINNERS ARE THE NON-`lazy` ENTRIES, exactly as `codegen.ts:5639` picks them.
  // A `rules()` map stores named lazy proxies beside resolved bodies, and the plan
  // uses the winner map to give a shared subtree ONE owner; filtering differently
  // here would mint `rule:` ids the source lowering does not, so a consumer
  // comparing the two engines' coverage would be comparing two denominators.
  const plan = opts.coverage === true
    ? buildGrammarPlan(
        encodeMap.map(([, rule]) => rule),
        Object.fromEntries(encodeMap.filter(([, rule]) => rule._def.tag !== 'lazy')),
      )
    : undefined
  const hostMode = resolveHostMode(ruleMap, opts.hostMode)
  const settings: TableSettings = {
    hostMode,
    ...(resolveTrackLines(ruleMap, opts.trackLines) ? { trackLines: true } : {}),
    ...(opts.recovery === true ? { recovery: true } : {}),
    ...(plan === undefined ? {} : { coverage: plan }),
  }
  try {
    const { prog, fnSrcs } = encodeTableProgram(Object.fromEntries(encodeMap), settings)
    return { prog, fnSrcs, hostMode, plan }
  } catch (e) {
    opts.refusals?.push(e instanceof Error ? e.message : String(e))
    return null
  }
}

export function compileRuleMap(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opts: TableRuleMapOptions = {},
): CompiledRuleMapTable | null {
  // ALL-OR-NOTHING, exactly as `compileRuleMap` is. A construct with no opcode
  // (`UnsupportedConstruct`) and a `g.X` reference that resolves to nothing
  // (the lazy thunk throws) both mean this map cannot become a table, and the
  // caller's existing "leave this rules() call interpreted" fallback covers it.
  const encoded = encodeForRun(ruleMap, opts)
  if (encoded === null) return null
  const { prog, fnSrcs, hostMode, plan } = encoded
  const artifact = closureArtifact(prog)

  // RUNTIME-ONLY: the program parses but cannot be PRINTED (a live trivia
  // combinator parked in the pool, say). `compileRuleMap` returns null for its
  // own unprintable cases rather than emitting something that loads and
  // misbehaves; this is the same answer to the same question.
  if (artifact.runtimeOnly !== undefined && artifact.runtimeOnly.length > 0) {
    opts.refusals?.push(...artifact.runtimeOnly)
    return null
  }
  // The `mfCovered && buildCovered` gate, for the table's reducer pool: without
  // a source per author callback the emitters print `() => {}`, which produces a
  // module that loads and returns the wrong tree. An out-of-band list fills in
  // only where the encoder captured nothing, and only if it is COMPLETE — a
  // partial list would leave the placeholders it was passed to remove.
  const supplied = opts.fnSources
  const sources = fnSrcs.map((s, i) => s ?? supplied?.[i] ?? null)
  if (sources.some(s => s === null)) {
    const missing = sources.flatMap((s, i) => (s === null ? [i] : []))
    opts.refusals?.push(
      `author reducer source missing for prog.fns[${missing.join(', ')}] — printing would emit \`() => {}\` and the parse would return no value`,
    )
    return null
  }
  if (supplied !== undefined && supplied.length > fnSrcs.length) {
    throw new Error(
      `compileRuleMap: got ${supplied.length} fnSources for a pool of ${fnSrcs.length}. `
      + 'The list is positional, in prog.fns order, so a longer one means it belongs to a '
      + 'different encode — and the entries would be silently misassigned.',
    )
  }

  const replacementWithMetadata = (
    metadataSource?: string,
    options: { readonly precompileDefault?: boolean } = {},
  ): string => emitTableExpression(artifact, {
    entry: null,
    runtimeRef: opts.runtimeRef ?? 'tableRules',
    fnSources: sources as string[],
    ...(options.precompileDefault === true && hostMode === 'ast' && prog.lines !== 1
      && prog.code.length >= DEFAULT_PRECOMPILE_MIN_WORDS
      ? { assemblies: defaultAssemblyCfgs(artifact).slice(0, 1) }
      : {}),
    ...(metadataSource === undefined ? {} : { metadataSource }),
  })
  const replacement = replacementWithMetadata()

  return {
    keys: ruleMap.map(([key]) => key),
    replacement,
    replacementWithMetadata,
    hostMode,
    // WHAT THE FLAG MEANS is "a DIRECT BUILDER's positioned-CST branch was
    // dropped", which is what the driver's `'ast' artifact + CST host` check keys
    // off. `mode === 'ast'` alone over-reports it: an all-STRUCTURAL grammar has no
    // direct builder, so there was no branch to drop and it stays usable with either
    // host — the long-standing `node(parser)` contract. Same predicate codegen uses
    // for its own `hasDirectBuilders` (both read `analysis/commitment.ts`), so the two
    // lowerings stamp the same artifact rather than disagreeing about it.
    hostBranchElided: hostMode === 'ast' && ruleMap.some(([, rule]) => hasDirectBuildDef(rule)),
    reflection: collectGrammarReflection(ruleMap),
    ...(plan === undefined ? {} : { coverageDefinitions: plan.definitions }),
    rules: tableRules(prog),
    prog: artifact,
  }
}
