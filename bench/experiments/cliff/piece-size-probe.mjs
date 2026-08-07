/**
 * Cheap, single-process, no-loop probe: the BytecodeArray length of each PIECE body
 * (and of each wrapper flavour), read off a COLD function.
 *
 *   node --allow-natives-syntax bench/experiments/cliff/piece-size-probe.mjs
 *
 * Two traps this avoids:
 *  - an UNCALLED function has no BytecodeArray at all (lazy compilation), so each
 *    function is called exactly once first;
 *  - a TIERED-UP function prints `- code: <Code TURBOFAN_JS>` and NO bytecode line, so
 *    one call is also the ceiling — nothing here is allowed to get hot.
 *
 * Motivation: the per-site wrapper recovers `many` entirely (91.09 -> 65.61 ns/op) while
 * being pure loss on `seq` and `choice`. If `many.parse` sits on the far side of
 * --max-inlined-bytecode-size=460 and the other two sit on the near side, that asymmetry
 * is a size effect and needs no wrapper-specific explanation at all.
 */
import { buildSites, wrapSites, wrapSitesShared, wrapSitesIndirect, makeCtx } from './pieces.mjs'

const dbg = (x) => %DebugPrint(x)

const ctx = makeCtx()
const LIMIT = 460 // --max-inlined-bytecode-size in this build

for (const kind of ['seq', 'choice', 'many']) {
  const built = buildSites(kind, 2, 'distinct', 0, false, 0)
  const inner = built.sites[0]
  const input = built.inputs[0]

  process.stdout.write(`\n===PIECE ${kind}\n`)
  inner.parse(input, 0, ctx)
  dbg(inner.parse)

  process.stdout.write(`\n===LEAF ${kind}\n`)
  const leaf = kind === 'many' ? inner._def.combinator : inner._def.parsers[0]
  leaf.parse('a', 0, ctx)
  dbg(leaf.parse)

  for (const [label, fn] of [
    ['wrapCAP', wrapSites], ['wrapIND', wrapSitesIndirect], ['wrapSHARED', wrapSitesShared],
  ]) {
    const w = fn(buildSites(kind, 2, 'distinct', 0, false, 0).sites)
    process.stdout.write(`\n===${label} ${kind} bytes=${w.bytes}\n`)
    w.wrapped[0].parse(input, 0, ctx)
    dbg(w.wrapped[0].parse)
  }
}
process.stdout.write(`\n===LIMIT ${LIMIT}\n`)
