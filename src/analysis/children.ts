import type { Combinator, ParserDef } from '../types.ts'

/**
 * Ordered structural children per def tag. Explicit rather than "every key that
 * holds a Combinator" because a SLOT's position is what near-duplicate detection
 * varies — a stable, meaningful order is load-bearing, not cosmetic.
 *
 * One definition: `./gating.ts` re-exports it for the analysis passes, and it is
 * import-free so `run()`'s minimal closure can read a grammar's trivia scopes with it.
 */
export function childrenOf(d: ParserDef): readonly Combinator<unknown>[] {
  switch (d.tag) {
    case 'sequence': case 'choice': return d.parsers
    case 'dispatch': return [
      d.selector,
      ...d.cases.map(c => c.parser),
      ...(d.matchers ? d.matchers.map(c => c.parser) : []),
      ...(d.otherwise === undefined ? [] : [d.otherwise]),
    ]
    case 'sepBy': return [d.parser, d.separator]
    case 'recover': return [d.parser, d.sentinel]
    case 'scanTo': return [
      d.sentinel,
      ...d.skip,
      ...(d.recoverAt === undefined ? [] : [d.recoverAt]),
      ...(d.stopAt === undefined ? [] : [d.stopAt]),
    ]
    case 'grammar': return d.triviaParser ? [d.parser, d.triviaParser] : [d.parser]
    case 'routed': return d.fallback ? [d.fallback] : []
    case 'lines': return [d.prefix, d.body, ...(d.first === undefined ? [] : [d.first]), ...(d.lazy === undefined ? [] : [d.lazy])]
    case 'columns': return []
    // A `lazy` is a REFERENCE, not a subtree. Descending through it would make
    // every rule's walk cover the whole reachable grammar — site paths become
    // nonsense, and a structural hash includes half the grammar. Treated as a
    // leaf, keyed by the rule name it refers to, which is also the right
    // semantics: two productions referencing `g.Ident` really do fill that slot
    // the same way.
    case 'lazy': case 'literal': case 'regex': case 'keywords': case 'guard': case 'adjacency': case 'unknown':
      return []
    default: {
      const rec = d as unknown as { parser?: Combinator<unknown> }
      return rec.parser ? [rec.parser] : []
    }
  }
}

/**
 * Every combinator a walk steps to from `p`: its structural children, then, for a `lazy`,
 * the rule it refers to. A reference that does not resolve yet (a rule the map has not
 * defined) has no target, so a walk over a grammar with a hole still finishes.
 */
export function edgesOf(p: Combinator<unknown>): Combinator<unknown>[] {
  const kids = [...childrenOf(p._def)]
  if (p._def.tag === 'lazy') { try { kids.push(p._def.thunk()) } catch { /* unresolved */ } }
  return kids
}
