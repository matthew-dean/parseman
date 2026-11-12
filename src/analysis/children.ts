import type { Combinator, ParserDef } from '../types.ts'

/** What a reference throws while its target does not exist yet: a `ref()` before `.define()`, or a
 * `prior.X` no earlier grammar composed. A walk catches this, and only this, as a hole. Defined
 * here, in an import-free module, so the walk can test for it without importing the combinators. */
export class UnresolvedReference extends Error {}

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
 * the rule it refers to. A reference that does not resolve yet (`UnresolvedReference`)
 * has no target, so a walk over a grammar with a hole still finishes; `onHole` hears of
 * it, for a walk whose result must not outlive the hole. Any other error is rethrown.
 */
export function edgesOf(p: Combinator<unknown>, onHole?: () => void): Combinator<unknown>[] {
  const kids = [...childrenOf(p._def)]
  if (p._def.tag === 'lazy') {
    try { kids.push(p._def.thunk()) }
    catch (e) {
      // Two copies of parseman each have their own class, so a grammar built with one and walked by the other rethrows here.
      if (!(e instanceof UnresolvedReference)) throw e
      onHole?.()
    }
  }
  return kids
}

/**
 * The labels of each trivia scope reachable from `entry`, for `select: 'all'`, and whether
 * the walk reached every reference. A walk that met a hole is `complete: false`: a rule
 * defined later can add scopes, so its caller must not keep the result.
 */
export function triviaScopesOf(entry: Combinator<unknown>): { scopes: Array<readonly string[] | undefined>; complete: boolean } {
  const seen = new Set<Combinator<unknown>>()
  const scopes: Array<readonly string[] | undefined> = []
  const stack: Array<Combinator<unknown>> = [entry]
  let complete = true
  const hole = (): void => { complete = false }
  while (stack.length > 0) {
    const c = stack.pop()!
    if (seen.has(c)) continue
    seen.add(c)
    scopes.push(c._meta.triviaKindLabels)
    const ambient = (c._meta as { grammarTrivia?: Combinator<unknown> }).grammarTrivia
    if (ambient !== undefined) stack.push(ambient)
    stack.push(...edgesOf(c, hole))
  }
  return { scopes, complete }
}
