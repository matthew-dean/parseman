import type { Combinator, ParserDef } from '../types.ts'
import { recordDegradation } from './degradation.ts'

export type GrammarCoverageDefinition = { id: string; kind: 'rule' | 'choice-arm' | 'dispatch-arm' | 'label' }
export type GrammarCoveragePlan = {
  definitions: readonly GrammarCoverageDefinition[]
  choices: WeakMap<Combinator<unknown>, readonly string[]>
  dispatches: WeakMap<Combinator<unknown>, readonly string[]>
  /** Trace-only transaction identity. Attempts are not coverage definitions: a
   * rejected transaction must not create a semantic winner or denominator. */
  attempts: WeakMap<Combinator<unknown>, string>
  labels: WeakMap<Combinator<unknown>, readonly string[]>
  rules: WeakMap<Combinator<unknown>, string>
}

function idPart(value: string): string {
  return encodeURIComponent(value)
}

function dispatchArmIds(def: Extract<ParserDef, { tag: 'dispatch' }>, path: string): string[] {
  const ids: string[] = []
  for (const entry of def.cases) ids.push(`dispatch:${path}/when:${entry.keys.map(idPart).join('|')}`)
  for (const entry of def.matchers ?? []) {
    ids.push(`dispatch:${path}/matcher:${entry.kind}:${idPart(entry.value)}${entry.kind === 'matches' && entry.flags ? `:${idPart(entry.flags)}` : ''}`)
  }
  if (def.otherwise) ids.push(`dispatch:${path}/otherwise`)
  return ids
}

function children(def: ParserDef, winners?: Record<string, Combinator<unknown>>): Combinator<unknown>[] {
  switch (def.tag) {
    case 'sequence': case 'choice': return def.parsers
    case 'dispatch': return [def.selector, ...def.cases.map(entry => entry.parser), ...(def.matchers ? def.matchers.map(entry => entry.parser) : []), ...(def.otherwise ? [def.otherwise] : [])]
    case 'many': case 'oneOrMore': case 'optional': case 'attempt': case 'transform': case 'trivia': case 'token': case 'leaf': case 'label': case 'field': case 'grammar': case 'not': case 'peek': case 'node': case 'guard': case 'withCtx': case 'recover': case 'expect': return 'parser' in def ? [def.parser] : []
    case 'sepBy': return [def.parser, def.separator]
    case 'skip': return [def.main, def.skipped]
    case 'scanTo': return [def.sentinel, ...def.skip]
    case 'lazy': {
      let resolved: Combinator<unknown>
      try { resolved = def.thunk() } catch (e) {
        // An unresolvable `ref()` / cross-artifact hole truncates the walk, so every
        // definition beneath it is missing from the plan. That SHRINKS the coverage
        // denominator, which pushes the reported ratio UP — a blind spot that reads as
        // better coverage. `analyzeGatingRules` routes the same situation into
        // `unanalysable`; the coverage walk has no such field, so it reports here.
        recordDegradation({
          code: 'coverage-definitions-unavailable',
          severity: 'warn',
          where: '<lazy rule reference>',
          subject: `unresolvable reference (${(e as Error).message})`,
          fellBackTo: 'the coverage walk stopped at this reference, so every definition below '
            + 'it is ABSENT from the denominator — which raises the reported ratio rather than '
            + 'lowering it',
          otherwise: 'the referenced rule and its whole subtree would contribute definitions',
        })
        return []
      }
      const name = (resolved as Combinator<unknown> & { _ruleName?: string })._ruleName
      return name && winners?.[name] ? [winners[name]!] : [resolved]
    }
    default: return []
  }
}

/** Canonical deterministic IDs for one explicit entry closure, or every public
 * entry in a `rules()` map. Multiple roots share identity maps so a shared
 * subtree still has one stable owner. */
export function buildGrammarPlan(entry: Combinator<unknown> | readonly Combinator<unknown>[], winners?: Record<string, Combinator<unknown>>): GrammarCoveragePlan {
  const definitions = new Map<string, GrammarCoverageDefinition>()
  const choices = new WeakMap<Combinator<unknown>, readonly string[]>()
  const dispatches = new WeakMap<Combinator<unknown>, readonly string[]>()
  const attempts = new WeakMap<Combinator<unknown>, string>()
  const labels = new WeakMap<Combinator<unknown>, readonly string[]>()
  const rules = new WeakMap<Combinator<unknown>, string>()
  // A `rules()` map stores named lazy proxies while code generation may emit
  // either that proxy or its resolved body.  Final composed winners are the
  // authority for both identities; relying on `_ruleName` alone loses direct
  // local leaf rules and cross-piece references after IR hydration.
  const winnerNames = new Map<Combinator<unknown>, string>()
  if (winners) {
    for (const [name, winner] of Object.entries(winners)) {
      winnerNames.set(winner, name)
      if (winner._def.tag === 'lazy') {
        try { winnerNames.set(winner._def.thunk(), name) } catch { /* unresolved external stays absent */ }
      }
    }
  }
  const seen = new Set<Combinator<unknown>>()
  const visit = (parser: Combinator<unknown>, path: string): void => {
    if (seen.has(parser)) return
    seen.add(parser)
    const rule = winnerNames.get(parser) ?? (parser as Combinator<unknown> & { _ruleName?: string })._ruleName
    // `rules()` references are tagged too for linker naming, but only the final
    // rule definition owns execution coverage; otherwise ref + target double-hit.
    if (rule && (winnerNames.has(parser) || parser._def.tag !== 'lazy')) {
      const id = `rule:${rule}`
      definitions.set(id, { id, kind: 'rule' })
      rules.set(parser, id)
    }
    if (parser._def.tag === 'choice') {
      const ids = parser._def.parsers.map((_, index) => `choice:${path}/arm:${index}`)
      choices.set(parser, ids)
      ids.forEach(id => definitions.set(id, { id, kind: 'choice-arm' }))
    }
    if (parser._def.tag === 'dispatch') {
      const ids = dispatchArmIds(parser._def, path)
      dispatches.set(parser, ids)
      ids.forEach(id => definitions.set(id, { id, kind: 'dispatch-arm' }))
    }
    if (parser._def.tag === 'attempt') attempts.set(parser, `attempt:${path}`)
    if (parser._def.tag === 'label') {
      const id = `label:${path}`
      labels.set(parser, [id])
      definitions.set(id, { id, kind: 'label' })
    }
    children(parser._def, winners).forEach((child, index) => visit(child, `${path}/${parser._def.tag}:${index}`))
  }
  const roots = Array.isArray(entry) ? entry : [entry]
  for (const root of roots) {
    // Rule-map compilation can receive ordinary, unannotated combinators. The
    // caller's winner map is then the only durable public identity for each
    // root; using the generic `entry` path would merge separate roots' choice
    // IDs and omit their rule definitions.
    visit(root, winnerNames.get(root) ?? (root as Combinator<unknown> & { _ruleName?: string })._ruleName ?? 'entry')
  }
  return { definitions: [...definitions.values()].sort((a, b) => a.id.localeCompare(b.id)), choices, dispatches, attempts, labels, rules }
}
