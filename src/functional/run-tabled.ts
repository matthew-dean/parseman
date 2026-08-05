/**
 * THE PUBLIC PARSE PATH — `run()` as the main entry exports it, routed through
 * the TABLE.
 *
 * `functional/run.ts` is the DRIVER: it threads the ctx, skips trailing trivia
 * and shapes a `RunResult`. Handed a function it runs that function; handed a
 * COMBINATOR it walks `combinator.parse()`, which is the interpreter. That
 * second branch is the reason parseman has had three engines reachable at once,
 * and three engines is how a divergence gets to be silent: the interpreter,
 * source lowering and the table each decide dispatch for themselves, and on this
 * branch alone six disagreements were found that no test saw.
 *
 * So the combinator branch stops being a public parse path. This module encodes
 * the combinator to a table, assembles it, and hands the driver the resulting
 * rule FUNCTION — the same artifact a shipped table parser runs. One engine on
 * the product path, by construction rather than by discipline.
 *
 * ## Why this is a separate module and not an edit to `run.ts`
 *
 * `parseman/run` exists to be small, and `test/unit/run-entry-closure.test.ts`
 * pins its module closure to nine leaf modules with a hard "must not reach
 * `src/compiler/` or `src/combinators/`". `encodeTable` reaches both — it reads
 * first sets, build arity and field maps off the combinator graph. Putting the
 * encode inside `run.ts` would drag the compiler and the whole combinator set
 * into every consumer that ships a compiled parser, which is precisely the
 * bundle regression that entry exists to prevent.
 *
 * The split is also the honest one. Encoding is a GRAMMAR-BUILD step, and a
 * consumer of `parseman/run` has no grammar to build: it was handed functions by
 * the macro. So the driver keeps the function path, the main entry adds the
 * encode, and the combinator branch inside the driver is reachable only from
 * tests and the identity sweep — which import `functional/run.ts` directly and
 * must keep reaching all three engines to bisect against.
 *
 * ## The cache is not an optimisation
 *
 * `run()` is called in tight loops. A per-call `encodeTable` + `assemble` would
 * turn a microsecond parse into a millisecond one. Keyed on the combinator's
 * IDENTITY — a `WeakMap`, so a grammar built inside a test and dropped is
 * collected with it — the encode happens once per grammar per process and every
 * later call is one map lookup.
 */
import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { run as runDriver, type Runnable, type RunOptions, type RunResult } from './run.ts'
import { encodeTable } from '../table/encode.ts'
import { assembledRules } from '../table/assemble.ts'

const ENTRY = 'Entry'

/**
 * The assembled table entry for a combinator, built at most once per combinator.
 *
 * A root combinator is a one-rule map — the same construction `compileTable()`
 * uses, verified round-tripping value-identically on the shipped json/csv/graphql
 * roots.
 *
 * The settings come off the combinator itself, because they select the table's
 * CONTENTS and so must be known before encoding. `hostMode` decides whether
 * nodes capture for a positioned-CST host, and `trackLines` decides whether
 * literals and regexes carry their line-tracking variant; both are declared on
 * the grammar (`rules({ hostMode, trackLines }, …)`), which is exactly where the
 * interpreter reads them from too.
 */
type TableEntry = (input: string, pos: number, ctx: ParseContext) => ParseResult<unknown>

/**
 * TWO slots per combinator, `[ast, cst]`, and that is not a micro-optimisation —
 * it is what makes the routing faithful.
 *
 * `hostMode` is an ENCODE setting: it decides whether every node captures for a
 * positioned-CST host, so it has to be chosen before the table exists. A
 * compiled artifact chooses once, at build time, and `assertHostModeCompatible`
 * then refuses the other host — correctly, because an `'ast'` artifact really
 * did drop its CST branch.
 *
 * The INTERPRETER has no build step and re-decides per parse, so
 * `run(grammar, input, { build: cstBuildHost })` on a grammar that declares no
 * mode has always worked. Encoding once, unconditionally as `'ast'`, would turn
 * that into a thrown host mismatch — a table detail leaking out as a behaviour
 * change in the public API. Keying on the host instead reproduces the
 * interpreter's decision exactly, and pays for it with at most one extra
 * encode per grammar that is genuinely driven both ways.
 *
 * A grammar that DECLARES `hostMode` keeps its declaration: that is a statement
 * about the grammar, and the mismatch error is the right answer to driving it
 * with the wrong host.
 */
const TABLED = new WeakMap<Combinator<unknown>, Array<TableEntry | undefined>>()

/** Does this `ctx.build` host produce a positioned CST? Mirrors `assemble.ts`. */
function cstOutput(build: unknown): boolean {
  return (build as { _parsemanCstOutput?: true } | undefined)?._parsemanCstOutput === true
}

function tableEntryFor(c: Combinator<unknown>, hostCst: boolean, tolerant: boolean): TableEntry {
  let slots = TABLED.get(c)
  if (slots === undefined) { slots = [undefined, undefined, undefined, undefined]; TABLED.set(c, slots) }
  const i = (hostCst ? 1 : 0) | (tolerant ? 2 : 0)
  const hit = slots[i]
  if (hit !== undefined) return hit
  const declared = c._meta.grammarHostMode
  const hostMode = declared ?? (hostCst ? 'cst' : 'ast')
  const trackLines = c._def.tag === 'grammar' ? c._def.trackLines : false
  const prog = encodeTable({ [ENTRY]: c }, {
    hostMode,
    ...(trackLines ? { trackLines: true } : {}),
    ...(tolerant ? { recovery: true } : {}),
  })
  const made = assembledRules(prog)[ENTRY]!
  slots[i] = made
  return made
}

/**
 * A combinator becomes its table entry; a function is already an artifact.
 *
 * A non-rule (`undefined`, `null`, an object with no `parse`) is passed through
 * UNTOUCHED so the driver's own `run(): start production is …, not a rule`
 * TypeError is what the caller sees. Encoding it first would replace a message
 * that names the mistake with whatever the encoder happens to throw on garbage.
 */
function tabled(r: Runnable, hostCst: boolean, tolerant: boolean): Runnable {
  if (typeof r === 'function') return r
  if (typeof (r as Combinator<unknown> | undefined)?.parse !== 'function') return r
  return tableEntryFor(r, hostCst, tolerant)
}

/**
 * Run a grammar against an input.
 *
 * Identical contract to `parseman/run`'s `run()`, with one difference that is
 * the point of this module: a COMBINATOR entry is lowered to a table and the
 * table is what parses. `options.trivia` is lowered the same way — it is a parse
 * of the same grammar and would otherwise be the one place the interpreter still
 * ran on the product path.
 */
export function run(entry: Runnable, input: string, options: RunOptions = {}): RunResult {
  const hostCst = cstOutput(options.build)
  // `tolerant` selects the TABLE, not just a flag on the parse: the sync sentinel
  // a list resyncs to is inferred from grammar structure, so it has to be encoded
  // before the table exists — the same reason `hostMode` is a build setting. A
  // grammar driven both ways is encoded both ways, once each.
  const tolerant = options.tolerant === true
  const e = tabled(entry, hostCst, tolerant)
  if (options.trivia === undefined) return runDriver(e, input, options)
  // The trailing-trivia probe runs on a throwaway ctx with no host and nothing to
  // recover, so it is always the plain 'ast' lowering regardless of the entry's.
  return runDriver(e, input, { ...options, trivia: tabled(options.trivia, false, false) })
}
