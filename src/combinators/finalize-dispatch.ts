import type { Combinator, ParserDef } from '../types.ts'

/**
 * Re-decide every reachable choice's dispatch once a grammar's refs are defined.
 *
 * `choice()` must answer "are these arms disjoint?" when it is constructed, but inside
 * a `rules()` factory a `g.X` arm is an unresolved ref whose first-set is `any`. `any`
 * overlaps everything, so the answer is forced to "no" for every choice over rule
 * references — which is every choice in a recursive grammar. The verdict describes the
 * SPELLING, not the grammar: the same three arms written without `g.` come out
 * disjoint and dispatch in O(1), while the recursive spelling falls back to trying arms
 * in order, on BOTH engines (the interpreter gates on the flag directly; codegen reads
 * `_def.disjoint`).
 *
 * Refresh is monotone — it only ever moves non-disjoint -> disjoint, because an
 * unresolved arm's `any` is the pessimistic input — so iterating to a fixpoint
 * terminates. It needs to be a fixpoint rather than one pass because a choice's own
 * first-set is an input to any choice wrapping it.
 */
function childrenOf(def: ParserDef): readonly Combinator<unknown>[] {
  switch (def.tag) {
    case 'sequence':
    case 'choice':    return def.parsers
    case 'dispatch':  return [
      def.selector,
      ...def.cases.map(c => c.parser),
      ...(def.matchers ? def.matchers.map(m => m.parser) : []),
      ...(def.otherwise ? [def.otherwise] : []),
    ]
    case 'many':
    case 'oneOrMore':
    case 'optional':
    case 'attempt':
    case 'transform':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'label':
    case 'field':
    case 'not':
    case 'peek':
    case 'node':
    case 'withCtx':
    case 'expect':    return [def.parser]
    case 'grammar':   return def.triviaParser ? [def.parser, def.triviaParser] : [def.parser]
    case 'sepBy':     return [def.parser, def.separator]
    case 'skip':      return [def.main, def.skipped]
    case 'scanTo':    return [def.sentinel, ...def.skip]
    case 'routed':    return def.fallback ? [def.fallback] : []
    // A `lazy` is followed through its thunk below, not here: resolving it may throw
    // for a ref that is deliberately left undefined (an external/composed rule).
    case 'lazy':
    case 'literal':
    case 'regex':
    case 'keywords':
    case 'guard':
    case 'unknown':
    // A zero-width trivia assertion; it has no sub-parser.
    case 'adjacency': return []
    case 'recover':   return [def.parser, def.sentinel]
  }
}

/** Guard only — the iteration is monotone, so it converges well before this. */
const MAX_PASSES = 20

export function finalizeDispatch(roots: readonly Combinator<unknown>[]): void {
  // Collect the reachable graph ONCE; the set of nodes cannot grow across passes.
  const seen = new Set<Combinator<unknown>>()
  const order: Combinator<unknown>[] = []
  const visit = (c: Combinator<unknown>): void => {
    if (seen.has(c)) return
    seen.add(c)
    order.push(c)
    if (c._def.tag === 'lazy') {
      // An UNDEFINED ref is legitimate here: a composed grammar references rules a base
      // provides. Skip it rather than letting the throw escape.
      let target: Combinator<unknown> | null = null
      try { target = c._def.thunk() } catch { target = null }
      if (target) visit(target)
      return
    }
    for (const child of childrenOf(c._def)) visit(child)
  }
  for (const r of roots) visit(r)

  // Deepest-first: refreshing an inner choice before its wrapper lets a single pass do
  // most of the work, so the fixpoint usually settles in two.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false
    for (let i = order.length - 1; i >= 0; i--) {
      const c = order[i]!
      // A lazy mirrors its target's first-set; refresh it so a wrapping choice sees
      // the resolved value on this same pass.
      if (c._def.tag === 'lazy') {
        let target: Combinator<unknown> | null = null
        try { target = c._def.thunk() } catch { target = null }
        if (target && c._meta.firstSet !== target._meta.firstSet) {
          ;(c._meta as { firstSet: unknown }).firstSet = target._meta.firstSet
          changed = true
        }
        continue
      }
      if (c._refreshDispatch?.() === true) changed = true
    }
    if (!changed) return
  }
}
