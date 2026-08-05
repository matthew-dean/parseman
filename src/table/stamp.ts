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
import type { TableProgram, TableRule } from './program.ts'

const EMPTY_FX: string[] = []

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
        return { ok: false, expected: (ctx._fx ?? EMPTY_FX) as string[], span: { start: at, end: at } }
      }
      return { ok: true, value: d.lastValue(), span: { start: pos, end } }
    }
    out[name] = meta === undefined ? entryFn : Object.assign(entryFn, { _meta: meta })
  }
  // STAMP THE HOST MODE. `run()` reads it off the entry through `FUSED_HOST_MODE`
  // and `assertHostModeCompatible` throws when a 'cst' artifact runs without a
  // CST host. Encoding with `hostMode: 'cst'` set the capture flags but nothing
  // stamped the mode, so such a table returned the grammar's own AST objects with
  // `ok: true` while paying full CST capture.
  const mode = prog.hostMode ?? 'ast'
  const elided = mode === 'ast'
  for (const name of Object.keys(out)) {
    Object.defineProperty(out[name]!, FUSED_HOST_MODE, { value: mode, enumerable: false })
    Object.defineProperty(out[name]!, FUSED_HOST_ELIDED, { value: elided, enumerable: false })
  }
  Object.defineProperty(out, FUSED_HOST_MODE, { value: mode, enumerable: false })
  Object.defineProperty(out, FUSED_HOST_ELIDED, { value: elided, enumerable: false })
  return out
}
