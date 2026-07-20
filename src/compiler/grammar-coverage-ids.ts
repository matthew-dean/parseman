import type { Combinator, ParserDef } from '../types.ts'

export type GrammarCoverageDefinition = { id: string; kind: 'rule' | 'choice-arm' | 'label' }
export type GrammarCoveragePlan = {
  definitions: readonly GrammarCoverageDefinition[]
  choices: WeakMap<Combinator<unknown>, readonly string[]>
  labels: WeakMap<Combinator<unknown>, readonly string[]>
  rules: WeakMap<Combinator<unknown>, string>
}

function children(def: ParserDef, winners?: Record<string, Combinator<unknown>>): Combinator<unknown>[] {
  switch (def.tag) {
    case 'sequence': case 'choice': return def.parsers
    case 'many': case 'oneOrMore': case 'optional': case 'transform': case 'trivia': case 'token': case 'label': case 'field': case 'grammar': case 'not': case 'node': case 'guard': case 'withCtx': case 'recover': case 'expect': return 'parser' in def ? [def.parser] : []
    case 'sepBy': return [def.parser, def.separator]
    case 'skip': return [def.main, def.skipped]
    case 'scanTo': return [def.sentinel, ...def.skip]
    case 'lazy': {
      let resolved: Combinator<unknown>
      try { resolved = def.thunk() } catch { return [] }
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
    if (parser._def.tag === 'label') {
      const id = `label:${path}`
      labels.set(parser, [id])
      definitions.set(id, { id, kind: 'label' })
    }
    children(parser._def, winners).forEach((child, index) => visit(child, `${path}/${parser._def.tag}:${index}`))
  }
  const roots = Array.isArray(entry) ? entry : [entry]
  for (const root of roots) {
    visit(root, (root as Combinator<unknown> & { _ruleName?: string })._ruleName ?? 'entry')
  }
  return { definitions: [...definitions.values()].sort((a, b) => a.id.localeCompare(b.id)), choices, labels, rules }
}
