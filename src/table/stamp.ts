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
import { reachableIps } from './inspect.ts'
import { OP_NODE, OP_NODE_TRACK } from './ops.ts'
import type { TableProgram, TableRule } from './program.ts'

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
export function stampRuleMap(prog: TableProgram, d: RuleRunner): Record<string, TableRule> {
  const out: Record<string, TableRule> = {}
  // `run()` reads trivia metadata off the ENTRY and takes its
  // `typeof r === 'function'` branch for compiled entries, which codegen stamps
  // with `_meta`. A table entry is a function too, so it must be stamped or
  // `run({ rootTrivia })` rejects a grammar that plainly has labelled trivia.
  const meta = prog.labels === undefined && prog.classified !== 1
    ? undefined
    : {
        ...(prog.labels === undefined ? {} : { triviaKindLabels: prog.labels }),
        ...(prog.classified === 1 ? { rootTriviaClassified: true as const } : {}),
      }
  // Chosen ONCE, from table data, at rule-map construction. Not a per-parse
  // branch on an option: a plain table never has this wrapper at all.
  const lines = prog.lines === 1
  const names = Object.keys(prog.rules)
  for (let ri = 0; ri < names.length; ri++) {
    const name = names[ri]!
    const index = ri
    const entryFn = (input: string, pos: number, ctx: ParseContext): ParseResult<unknown> => {
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
    out[name] = meta === undefined ? entryFn : Object.assign(entryFn, { _meta: meta })
  }
  // STAMP THE HOST MODE. `run()` reads it off the entry through `FUSED_HOST_MODE`
  // and `assertHostModeCompatible` throws when a 'cst' artifact runs without a
  // CST host. Encoding with `hostMode: 'cst'` set the capture flags but nothing
  // stamped the mode, so such a table returned the grammar's own AST objects with
  // `ok: true` while paying full CST capture.
  const mode = prog.hostMode ?? 'ast'
  // WHAT `FUSED_HOST_ELIDED` MEANS is "a DIRECT BUILDER's positioned-CST branch was
  // dropped" — it is what makes `'ast' artifact + CST host` an error rather than a
  // preference. `mode === 'ast'` alone over-reports it: an all-STRUCTURAL grammar has
  // no direct builder, so no branch was dropped and it stays usable with either host
  // (the `node(parser)` contract). A node row carries `-1` in its build slot when it
  // has no direct builder, so the program answers this itself — and it MUST agree with
  // the macro's emitted stamp, or re-stamping the same map throws
  // "Cannot redefine property".
  const elided = mode === 'ast' && hasDirectBuilder(prog)
  for (const name of Object.keys(out)) {
    Object.defineProperty(out[name]!, FUSED_HOST_MODE, { value: mode, enumerable: false })
    Object.defineProperty(out[name]!, FUSED_HOST_ELIDED, { value: elided, enumerable: false })
  }
  Object.defineProperty(out, FUSED_HOST_MODE, { value: mode, enumerable: false })
  Object.defineProperty(out, FUSED_HOST_ELIDED, { value: elided, enumerable: false })
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
