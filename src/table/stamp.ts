/**
 * The rule-map envelope both table drivers share.
 *
 * Everything here is about what a table ENTRY has to look like to `run()` and to
 * the linker's public wrappers — trivia metadata, host-mode stamps, the
 * `_lineStarts` seeding, the ambient `scanSkip` install and the failure-to-
 * `ParseResult` conversion. None of it is recognition, and having two copies of
 * it (one in `exec.ts`, one in `assemble.ts`) would be two places for a
 * divergence the three-way identity sweep would then have to catch.
 *
 * The drivers supply only what differs: how a rule RUNS.
 */
import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { FUSED_HOST_ELIDED, FUSED_HOST_MODE } from '../cst/host-mode.ts'
import { GRAMMAR_COVERAGE_DEFINITIONS } from '../grammar-metadata.ts'
import { reachableIps } from './inspect.ts'
import { OP_NODE, OP_NODE_TRACK, OP_SCOPE, OP_SCOPE_PLAIN } from './ops.ts'
import { covDefinitions, resolveTable, type ResolvedTable, type TableProgram, type TableRule } from './program.ts'

const EMPTY_FX: string[] = []

/**
 * Did something inside CUT?
 *
 * Read through a call so TypeScript does not narrow `_fc` to `false` from the
 * assignment that precedes each speculative attempt — the driver mutates it and
 * the checker cannot see that. Lives here rather than in a driver because the
 * ENVELOPE reads it too, and a third copy would be a third place to drift.
 */
export function committed(c: ParseContext): boolean {
  return c._fc === true
}

/**
 * The ENTRY result's span, line-annotated when the table tracks lines.
 *
 * Codegen annotates the root result the moment `ctx.lineTracking` is on — both
 * the success span and the failure span (`_spanLines(_ctx, …)`), and so does the
 * interpreter's `parser({ trackLines: true })` scope. The table's envelope built
 * a bare `{ start, end }` regardless, so a tracked table parse handed back a
 * result with no `startLine`/`endColumn` at all while paying for the tracking.
 *
 * The binary search over `_lineStarts` now lives in `run-support.ts`. The
 * private copy that sat here was justified by "not worth giving the hot node
 * piece a cross-module call"; the EMITTED engine needs the same answer, the
 * node piece no longer calls this copy at all, and a THIRD copy is how a
 * reported column drifts between two engines that are gated against each other
 * precisely so that it cannot.
 */
import { spanLines } from './run-support.ts'
export { spanLines }

/**
 * What a driver must provide per parse, in the order the entry needs it.
 *
 * `run` returns the driver's own FAIL sentinel for a failed parse. The sentinel
 * is module-private on each side, so it is never compared here — `runRule`
 * answers with `undefined` for failure instead, and the caller's sentinel never
 * leaves its module.
 */
export type RuleRunner = {
  /**
   * Run rule `ri` and return its end position, or −1 on failure.
   *
   * Returning the position rather than the value keeps the driver's FAIL
   * sentinel private; the value is fetched separately only on success.
   */
  readonly runRule: (ri: number, input: string, pos: number, ctx: ParseContext) => number
  /** The value the last successful `runRule` produced. */
  readonly lastValue: () => unknown
  /** The ambient `scanSkip` set for rule `ri`, if the program declares one. */
  readonly scanSkipFor: (ri: number, ctx: ParseContext) => readonly Combinator<unknown>[] | undefined
}

/**
 * Wrap a driver's per-rule run into the map an artifact exports.
 *
 * The entries have the SAME signature as codegen rule functions, so `run()`, the
 * linker's public wrappers and every consumer are unchanged.
 */
export function stampRuleMap(
  prog: TableProgram,
  d: RuleRunner,
  artifactMetadata: Readonly<Record<symbol, unknown>> = {},
  resolved: ResolvedTable = resolveTable(prog),
): Record<string, TableRule> {
  // `run()` reads trivia metadata off the ENTRY and takes its
  // `typeof r === 'function'` branch for compiled entries, which codegen stamps
  // with `_meta`. A table entry is a function too, so it must be stamped or
  // `run({ rootTrivia })` rejects a grammar that plainly has labelled trivia.
  //
  // `grammarTrivia` joins them for the same reason and with a sharper edge: `run()`
  // now consumes the DOCUMENT ROOT's trailing trivia off the entry's own ambient
  // trivia (see `ambientTriviaFromRunnable`), which a combinator entry carries on
  // `_meta.grammarTrivia`. A table entry that did not carry it would leave the tail
  // unconsumed and report a short `span` / a non-null `unconsumedFrom` where the
  // interpreter reports the whole file — a three-way identity divergence that shows
  // up as `ok: true` with bytes missing, never as an error.
  //
  // Read from the ENTRY ROW, not from one program-wide slot: `encodeRule` wraps each
  // rule's entry in `OP_SCOPE_PLAIN <triviaSlot> <body>` iff THAT rule has ambient trivia,
  // and a `composeLeaf` grammar's pieces do not agree (the same disagreement
  // `scanSkipOf` exists for). The owning driver passes its resolved table, so
  // this is the exact trivia array it already built.
  const triviaOfRule = (ip: number): Combinator<unknown> | undefined => {
    if (prog.code[ip] !== OP_SCOPE_PLAIN && prog.code[ip] !== OP_SCOPE) return undefined
    const slot = prog.code[ip + 1]!
    return slot < 0 ? undefined : resolved.trivia[slot]
  }
  const baseMeta = prog.labels === undefined && prog.classified !== 1
    ? undefined
    : {
        ...(prog.labels === undefined ? {} : { triviaKindLabels: prog.labels }),
        ...(prog.classified === 1 ? { rootTriviaClassified: true as const } : {}),
      }
  // Chosen ONCE, from table data, at rule-map construction. Not a per-parse
  // branch on an option: a plain table never has this wrapper at all.
  const lines = prog.lines === 1
  const mode = prog.hostMode ?? 'ast'
  const elided = mode === 'ast' && hasDirectBuilder(prog)
  const coverageDefinitions = prog.cov === undefined
    ? undefined
    : Object.freeze(covDefinitions(prog).map(Object.freeze))
  // Metadata lives on the map's prototype FROM BIRTH. Symbol reads keep their
  // existing contract, while Object.keys, object spread and Object.assign see
  // only the map's own rule entries. This is the no-descriptor equivalent of the
  // old non-enumerable stamps: no post-construction shape transition, WeakMap or
  // generated wrapper is involved.
  const metadataPrototype = {
    ...artifactMetadata,
    [FUSED_HOST_MODE]: mode,
    [FUSED_HOST_ELIDED]: elided,
    ...(coverageDefinitions === undefined
      ? {}
      : { [GRAMMAR_COVERAGE_DEFINITIONS]: coverageDefinitions }),
  }
  const out = Object.create(metadataPrototype) as Record<string, TableRule>
  const names = Object.keys(prog.rules)
  for (let ri = 0; ri < names.length; ri++) {
    const name = names[ri]!
    const index = ri
    const entryFn = (input: string, pos: number, ctx: ParseContext): ParseResult<unknown> => {
      // The table lowering ships coverage counters in 0.47 but not codegen's
      // fine-grained trace phases. Failing at the artifact boundary is deliberate:
      // accepting the public sink and writing no events produces a plausible empty
      // trace, which is indistinguishable from a genuinely unvisited grammar.
      if (ctx._grammarTrace !== undefined) {
        throw new TypeError(
          'parseman: grammar tracing is not supported by table-backed parsers in 0.47; '
            + 'remove the _grammarTrace sink or run the combinator through the interpreter',
        )
      }
      // Ambient scanSkip, which `run()` cannot install for a function entry.
      // Chosen PER RULE, because that is what `run()` does — it reads the ENTRY
      // rule's own `_meta.grammarScanSkip`. One program-wide set instead gave a
      // `composeLeaf` piece's rules a skip list the interpreter never gives them.
      const ownSkip = d.scanSkipFor(index, ctx)
      if (ownSkip !== undefined && ctx.scanSkip === undefined) {
        ctx.scanSkip = ownSkip as ParseContext['scanSkip']
      }
      ctx._fe = -1
      ctx._fx = EMPTY_FX
      // `_fc` is a SPECULATION-LOCAL bit cleared at the boundary so a stale
      // `true` from a PREVIOUS parse on a reused `ctx` cannot read as "the cut
      // fired".
      ctx._fc = false
      if (lines && ctx._lineStarts === undefined) { ctx._lineStarts = [0]; ctx._lineScannedTo = 0 }
      const end = d.runRule(index, input, pos, ctx)
      if (end < 0) {
        const fe = ctx._fe
        const at = fe === undefined || fe < 0 ? pos : fe
        const fspan = lines ? spanLines(ctx, at, at) : { start: at, end: at }
        // `committed` IS PART OF THE FAILURE ENVELOPE, not a diagnostic extra.
        // The interpreter carries it on the result (`{ ok: false, …, committed: true }`)
        // and codegen re-derives it from the same bit this driver uses
        // (`codegen.ts`: `...(_ctx._fc ? { committed: true } : {})`). The table
        // dropped it, so a table entry embedded as a CHILD of another parser — the
        // one place the field is read rather than merely reported — lost the cut.
        return committed(ctx)
          ? { ok: false, expected: (ctx._fx ?? EMPTY_FX) as string[], span: fspan, committed: true }
          : { ok: false, expected: (ctx._fx ?? EMPTY_FX) as string[], span: fspan }
      }
      return { ok: true, value: d.lastValue(), span: lines ? spanLines(ctx, pos, end) : { start: pos, end } }
    }
    const ownTrivia = triviaOfRule(prog.rules[name]!)
    const meta = ownTrivia === undefined
      ? baseMeta
      : { ...baseMeta, grammarTrivia: ownTrivia }
    // A standalone entry has no registry from which `run()` could recover host
    // mode, so keep the two ordinary symbol fields on the function itself. Every
    // entry receives them in the same construction-time order.
    out[name] = Object.assign(entryFn, {
      ...(meta === undefined ? {} : { _meta: meta }),
      [FUSED_HOST_MODE]: mode,
      [FUSED_HOST_ELIDED]: elided,
    })
  }
  // STAMP THE HOST MODE. `run()` reads it off the entry through `FUSED_HOST_MODE`
  // and `assertHostModeCompatible` throws when a 'cst' artifact runs without a
  // CST host. Encoding with `hostMode: 'cst'` set the capture flags but nothing
  // stamped the mode, so such a table returned the grammar's own AST objects with
  // `ok: true` while paying full CST capture.
  // WHAT `FUSED_HOST_ELIDED` MEANS is "a DIRECT BUILDER's positioned-CST branch was
  // dropped" — it is what makes `'ast' artifact + CST host` an error rather than a
  // preference. `mode === 'ast'` alone over-reports it: an all-STRUCTURAL grammar has
  // no direct builder, so no branch was dropped and it stays usable with either host
  // (the `node(parser)` contract). A node row carries `-1` in its build slot when it
  // has no direct builder, so the program answers this itself — and it MUST agree with
  // the macro's emitted stamp, or re-stamping the same map throws
  // "Cannot redefine property".
  return out
}

/**
 * Does any REACHABLE node row own a direct builder?
 *
 * Reachability, not a scan for the opcode's numeric value: operands are ordinary
 * integers and collide with opcodes, so counting words reports confident nonsense
 * (`inspect.ts` states the same thing about `opHistogram`). One linear pass at load,
 * beside the assembly pass that already visits every row.
 */
function hasDirectBuilder(prog: TableProgram): boolean {
  const code = prog.code
  for (const ip of reachableIps(prog)) {
    const op = code[ip]
    if ((op === OP_NODE || op === OP_NODE_TRACK) && code[ip + 1] !== -1) return true
  }
  return false
}
