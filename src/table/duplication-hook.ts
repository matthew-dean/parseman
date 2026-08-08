import type { Combinator } from '../types.ts'
import { analyzeDuplication, analyzeDuplicationRules, formatDuplicationFindings, duplicationFindingCount, type DuplicationReport, type DuplicationWarnLevel } from '../analysis/duplication.ts'

/**
 * THE DUPLICATION DIAGNOSTIC'S LOWERING HOOK.
 *
 * This ran inside the source lowering, so deleting that lowering would have silently
 * taken it with it — the analysis in `analysis/duplication.ts` would survive and
 * nothing would call it, which reads exactly like a clean grammar. It is not a
 * property of how a grammar is lowered, so it lives with the lowering that remains.
 */
/**
 * The `duplication` compile option. A bare level is shorthand for `{ level }`; the
 * object form adds the `accept` allowlist (finding ids acknowledged as intentional)
 * and the ranking knobs.
 *
 * DEFAULT IS `'off'`, unlike gating. An ungated hot choice is a cliff with no other
 * symptom; a duplicated subtree is a maintenance cost the author may have chosen.
 * More to the point, most findings here are CANDIDATES that need an AST check
 * before they are applied — a diagnostic that prints "candidate, verify" on every
 * build teaches people to stop reading it. Run it deliberately (a lint script, a
 * review pass, `PARSEMAN_DUPLICATION=warn`), not on every compile.
 */
export type DuplicationOption =
  | DuplicationWarnLevel
  | { level?: DuplicationWarnLevel; accept?: Iterable<string>; minSize?: number; maxFindings?: number; entryName?: string }

function resolveDuplicationLevel(opt: DuplicationOption | undefined): DuplicationWarnLevel {
  const explicit = typeof opt === 'string' ? opt : opt?.level
  if (explicit !== undefined) return explicit
  const env = typeof process !== 'undefined' ? (process.env?.PARSEMAN_DUPLICATION as DuplicationWarnLevel | undefined) : undefined
  if (env === 'off' || env === 'warn' || env === 'error') return env
  return 'off'
}

/**
 * Run the duplication diagnostic and surface it per the resolved level. Never
 * throws from the analysis itself — only `'error'` deliberately throws on a real
 * finding. Shared by ALL THREE lowering paths (`compile`, `compileRuleMap`,
 * `compileLinkable`): the macro build never calls `compile()`, and a diagnostic
 * wired only there is a diagnostic that reports zero findings forever — which is
 * exactly what happened to the gating diagnostic for two minor versions.
 */
function reportDuplication(
  opt: DuplicationOption | undefined,
  analyze: (o: { accept?: Iterable<string>; minSize?: number; maxFindings?: number; entryName?: string } | undefined) => DuplicationReport,
): DuplicationReport | undefined {
  const level = resolveDuplicationLevel(opt)
  if (level === 'off') return undefined
  const obj = opt !== null && typeof opt === 'object' ? opt : undefined
  const analyzeOpts = obj === undefined ? undefined : {
    ...(obj.accept !== undefined ? { accept: obj.accept } : {}),
    ...(obj.minSize !== undefined ? { minSize: obj.minSize } : {}),
    ...(obj.maxFindings !== undefined ? { maxFindings: obj.maxFindings } : {}),
    ...(obj.entryName !== undefined ? { entryName: obj.entryName } : {}),
  }
  let report: DuplicationReport
  try { report = analyze(analyzeOpts) }
  catch (err) {
    // The analysis is ADVISORY — it must never break a compile that is otherwise
    // correct, so this does not rethrow even at `'error'`. But it must not be
    // SILENT either: `assertAnalyzable` throws a deliberately actionable TypeError
    // when handed a composed (already-fused) map, and swallowing that reported the
    // same "no findings" as a genuinely clean grammar. That is the exact failure
    // the gating diagnostic shipped for two minor versions.
    console.warn(
      `parseman: the duplication diagnostic could not run, so NOTHING was checked — `
      + `this is not a clean result.\n  ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }
  const lines = formatDuplicationFindings(report)
  if (lines.length > 0) {
    if (level === 'error') throw new Error(`parseman: ${duplicationFindingCount(report)} duplication/overlap finding(s)\n${lines.join('\n')}`)
    for (const l of lines) console.warn(l)
  }
  return report
}

export function runDuplicationDiagnostic<T>(combinator: Combinator<T>, opt: DuplicationOption | undefined): DuplicationReport | undefined {
  return reportDuplication(opt, o => analyzeDuplication(combinator as Combinator<unknown>, o))
}

export function runDuplicationDiagnosticRules(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opt: DuplicationOption | undefined,
): DuplicationReport | undefined {
  return reportDuplication(opt, o => analyzeDuplicationRules(ruleMap, o))
}
