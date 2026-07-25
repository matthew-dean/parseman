/**
 * Gating analysis for a WHOLE grammar value — including a `compose()` result.
 *
 * `analyzeGatingRules` walks combinators. A `compose()` result holds none: fusion
 * lowers every rule to an executable function and the combinator graph is gone from
 * the returned map. Walking one therefore saw nothing — and, because the default-on
 * fuse-time diagnostic swallowed the resulting error, saw nothing SILENTLY. That is
 * the shape every real composed grammar has (`compose([importedArtifact, rules(…)])`),
 * so the diagnostic was blind on exactly the grammars it exists to serve.
 *
 * The graph is recoverable: `compose()` retains its inputs as carried IR, and that IR
 * re-lowers to real combinators. This module does that recovery, and — where a piece
 * is a genuinely opaque precompiled artifact carrying rule FUNCTIONS rather than IR —
 * reports it as `unanalysable` instead of quietly dropping it.
 */
import type { Combinator } from '../types.ts'
import { analyzeGatingRules, type AnalyzeGatingOptions, type GatingReport, type Unanalysable } from './gating.ts'
import { recoverComposedRules } from '../compiler/linker.ts'

/** A `rules()` map, a `compose()` result, or any rule-name → value record. */
export type AnalysableGrammar = Record<string, unknown>

/**
 * Analyze a grammar's choices, resolving a composed grammar back to its carried IR
 * first. Accepts a `rules()` map (walked directly) or a `compose()` result (recovered).
 *
 * The returned report's `unanalysable` is authoritative: non-empty means part of the
 * grammar was never examined, and a clean `ungated` must NOT be read as a pass.
 */
export function analyzeGrammarGating(
  grammar: AnalysableGrammar,
  opts?: AnalyzeGatingOptions,
): GatingReport {
  const recovered = recoverComposedRules(grammar)
  if (recovered === undefined) {
    // Not a composed grammar — a plain `rules()` map of combinators. Walk it as-is;
    // any non-combinator value is reported by the walk itself.
    return analyzeGatingRules(Object.entries(grammar) as Array<[string, Combinator<unknown>]>, opts)
  }
  const { rules: winners, opaque } = recovered
  const entries = [...winners]
  const report = analyzeGatingRules(entries, { ...opts, resolveRef: name => winners.get(name) })
  const fromOpaque: Unanalysable[] = opaque.map(o => ({
    rule: o.ruleNames.length > 0 ? o.ruleNames.join(', ') : `<artifact ${o.ns}>`,
    kind: 'opaque-artifact' as const,
    reason: `precompiled artifact "${o.ns}" carries compiled rule functions, not re-lowerable IR — `
      + 'its choices cannot be examined. Recompile the contributing grammar so it carries IR '
      + '(the macro emits IR by default) to bring it back into analysis.',
  }))
  return fromOpaque.length === 0 ? report : { ...report, unanalysable: [...report.unanalysable, ...fromOpaque] }
}
