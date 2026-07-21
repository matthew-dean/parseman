import type { Combinator, ParserDef } from '../types.ts'

/**
 * Dead-value analysis (shared by the interpreter and codegen). A container
 * combinator — `many` / `oneOrMore` / `optional` / `sequence` — builds an
 * aggregate value (array / tuple / nullable). Under a `node()`, the node builds
 * from the *captured children*, never from that aggregate, so the aggregate is
 * built and thrown away. This pass marks those containers `valueUnused`; the
 * interpreter and the emitter then skip building the aggregate entirely (the
 * elements still parse and self-capture, so trees are identical).
 *
 * Walks ONE combinator tree (a single rule body, or a standalone root), stopping
 * at `lazy`/ref boundaries — other rules are analyzed on their own root. Starts
 * `consumed = true` (a rule's own value is assumed read — conservative); `node()`
 * flips it to false for its inner parser; `transform` forces it true (its map fn
 * reads the value). Sharing-safe: any `consumed = true` visit wins and is sticky,
 * so a container reachable from BOTH a consuming and a non-consuming site keeps
 * its aggregate (never wrongly elided).
 *
 * Soundness: a container is marked ONLY when every path to it passes through a
 * `node()` (value-discarding) without an intervening value-reader — i.e. its
 * aggregate provably isn't observed. Idempotent; safe to re-run.
 */
export function markUnusedValues(root: Combinator<unknown>): void {
  const seenConsumed = new WeakSet<Combinator<unknown>>()
  const seenUnconsumed = new WeakSet<Combinator<unknown>>()

  const mark = (def: { valueUnused?: boolean }, consumed: boolean): void => {
    if (consumed) def.valueUnused = false
    else if (def.valueUnused !== false) def.valueUnused = true
  }

  const visit = (c: Combinator<unknown>, consumed: boolean): void => {
    const seen = consumed ? seenConsumed : seenUnconsumed
    if (seen.has(c)) return
    seen.add(c)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const def = c._def as ParserDef & { valueUnused?: boolean }

    switch (def.tag) {
      case 'many':
      case 'oneOrMore':
        mark(def, consumed)
        visit(def.parser, consumed)
        return
      case 'optional':
        // `optional` returns `inner | null` — no aggregate array/tuple to elide, so
        // it carries no valueUnused flag. Still descend so an inner many/sequence
        // under a node() is analyzed (it benefits even when its optional wrapper
        // doesn't).
        visit(def.parser, consumed)
        return
      case 'sequence':
        mark(def, consumed)
        for (const p of def.parsers) visit(p, consumed)
        return
      case 'choice':
        // value is the winning arm's value — propagate consumed to each arm.
        for (const p of def.parsers) visit(p, consumed)
        return
      case 'node':
        // builds from captured children, NOT the inner parser value.
        visit(def.parser, false)
        return
      case 'transform':
        // the map fn reads the value → always consumed.
        visit(def.parser, true)
        return
      case 'field':
        // the field capture records the parsed value → always consumed.
        visit(def.parser, true)
        return
      case 'skip':
        visit(def.main, consumed)   // returns main's value
        visit(def.skipped, false)   // skipped value is discarded
        return
      case 'sepBy':
        // sepBy is NOT elided (no valueUnused), so it always builds its array and
        // therefore always reads each item's value — regardless of whether sepBy's
        // OWN value is observed. Item parser is unconditionally consumed.
        visit(def.parser, true)
        visit(def.separator, false)
        return
      case 'not':
        visit(def.parser, false)    // lookahead — value never observed
        return
      case 'grammar':
        visit(def.parser, consumed)
        if (def.triviaParser) visit(def.triviaParser, false)
        return
      case 'recover':
        visit(def.parser, consumed)
        visit(def.sentinel, false)
        return
      case 'label':
      case 'trivia':
      case 'token':
      case 'attempt':
      case 'withCtx':
      case 'expect':
        visit(def.parser, consumed) // single-child pass-through wrappers
        return
      case 'leaf':
        // The reducer observes the complete inner value even when its own result
        // is immediately captured by a node().
        visit(def.parser, true)
        return
      case 'lazy':
        // An INNER ref boundary — a distinct rule, analyzed on its own root. Don't
        // descend (and never call thunk(): an external ref would throw). A ref at
        // the ROOT of a rule is different — it wraps this rule's own body — and is
        // resolved by resolveRoot() before the walk starts.
        return
      default:
        // literal / regex / keywords / guard / scanTo / unknown — no container child.
        return
    }
  }

  // A rule's root is often a `ref()`/`lazy` wrapping the real body — that is how
  // rules() and compose() store forward-referenced and composed rules. Walking
  // that lazy directly hits the boundary case and marks nothing, so resolve a
  // ROOT lazy to its defined body first. Inner lazies (references to OTHER rules)
  // stay boundaries — each rule is analyzed from its own resolved root.
  const resolveRoot = (c: Combinator<unknown>): Combinator<unknown> => {
    const guard = new Set<Combinator<unknown>>()
    let cur = c
    while (!guard.has(cur)) {
      const d = cur._def as ParserDef
      if (d.tag !== 'lazy') return cur
      guard.add(cur)
      try { cur = d.thunk() } catch { return c }  // undefined ref → leave as-is
    }
    return cur
  }

  visit(resolveRoot(root), true)
}
