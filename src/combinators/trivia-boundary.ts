import type { Combinator, ParserDef } from '../types.ts'

/** Wrapper nesting this walk will look through before giving up and saying yes. */
const MAX_DEPTH = 12

/**
 * Does this rule body have a position OF ITS OWN at which ambient trivia is
 * consulted?
 *
 * This is the gate on re-establishing a rule's ambient trivia when it is
 * referenced from a region that CLEARED it (`ref.ts` in the interpreter,
 * `Encoder.scopedRef` in the table — both must ask the same question, or the two
 * engines parse different languages again).
 *
 * A body with no such position — a bare alternation, a dispatch, a single
 * terminal — cannot be repaired by installing a scanner, because it never
 * consults one. Installing it there changes nothing about the rule and
 * everything about what its arms delegate to, which is how a `noTrivia(...)`
 * region stopped meaning anything two references down.
 *
 * `lazy` is deliberately false and is never followed: a reference is the
 * delegation this question is about, so following it would both loop and answer
 * for a different rule. `grammar` is false because it declares its own scope, so
 * an outer install never reaches its body. `dispatch` is false because it is a
 * ROUTE: its arms re-enter from the routed token and spell their own padding.
 *
 * Structural and pure — callers resolve it ONCE, not per parse.
 */
export function hasOwnTriviaBoundary(p: Combinator<unknown>, depth: number = MAX_DEPTH): boolean {
  // Out of budget: assume yes. The gate exists to REMOVE a scope install that
  // cannot help, and a wrapper stack this deep is not a case it was measured on.
  if (depth === 0) return true
  const d = p._def as ParserDef
  switch (d.tag) {
    // Multi-term forms: the gaps BETWEEN terms are the ambient-trivia positions.
    case 'sequence': return d.parsers.length > 1
    case 'many': case 'oneOrMore': case 'sepBy': return true
    // Transparent wrappers — they add no position, so ask what they wrap.
    case 'node': case 'transform': case 'leaf': case 'label': case 'field':
    case 'token': case 'attempt': case 'optional': case 'expect': case 'withCtx':
    case 'recover': case 'trivia':
      return hasOwnTriviaBoundary(d.parser, depth - 1)
    // An alternation adds no position either, but ONE arm that has one is enough
    // to make the scope meaningful for this rule.
    case 'choice': return d.parsers.some(a => hasOwnTriviaBoundary(a, depth - 1))
    default: return false
  }
}
