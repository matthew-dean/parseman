/**
 * Where the interpreter and a compiled table would bind one reference differently.
 *
 * A rule reference (`g.X`) is a slot object. The interpreter follows the slot it
 * holds. The table encoder binds a reference to the map's rule of the same NAME
 * (`encode.ts`, `winners`). Within one linked map the two are the same rule. They
 * differ only for a rule object BORROWED from another grammar (`Entry: base.Entry`):
 * its graph holds `base`'s own slots, so the interpreter keeps `base`'s `Atom` while
 * the encoder binds this map's `Atom`. Both parse, and they accept different input.
 *
 * ponytail: refuses the pattern instead of rebinding borrowed graphs, which is the
 * planned follow-up that lets both engines agree.
 */
import type { Combinator } from '../types.ts'
import { childrenOf } from '../analysis/gating.ts'
import { winnerWrapsReference } from './token-alphabet.ts'

type Comb = Combinator<unknown>

const nameOf = (c: Comb): string | undefined => (c as unknown as { _ruleName?: string })._ruleName

/** Follow a slot to the combinator it resolves to, or `undefined` for a hole. */
function deref(c: Comb): Comb | undefined {
  const seen = new Set<Comb>()
  let current: Comb = c
  while (current._def.tag === 'lazy' && !seen.has(current)) {
    seen.add(current)
    try { current = current._def.thunk() } catch { return undefined }
  }
  return current
}

/**
 * The first rule of `map` whose graph reaches another grammar's slot for a rule
 * `map` also defines — the rule, and the name it references — or `undefined`.
 */
export function borrowedRuleReference(
  map: Readonly<Record<string, Comb>>,
): { rule: string; reference: string } | undefined {
  const seen = new Set<Comb>()
  for (const [rule, self] of Object.entries(map)) {
    let found: string | undefined
    const visit = (c: Comb): void => {
      if (found !== undefined) return
      if (c._def.tag === 'lazy') {
        // The root's own slot leads to this rule's body; any other named slot is a
        // reference, judged before it is ever marked seen (another root's own slot
        // is that root's body, which its own walk covers).
        if (!winnerWrapsReference(self, c)) {
          const name = nameOf(c)
          const winner = name === undefined ? undefined : map[name]
          if (winner !== undefined) {
            // This map's own reference, or another slot to the very same rule.
            if (winnerWrapsReference(winner, c) || deref(c) === deref(winner)) return
            found = name
            return
          }
        }
        // The root's body, or a rule this map does not define: both engines follow
        // the slot, so its body matters only for what IT references.
        if (seen.has(c)) return
        seen.add(c)
        const body = deref(c)
        if (body !== undefined) visit(body)
        return
      }
      if (seen.has(c)) return
      seen.add(c)
      for (const child of childrenOf(c._def)) visit(child)
    }
    visit(self)
    if (found !== undefined) return { rule, reference: found }
  }
  return undefined
}

/** The refusal, worded for the API that refused. */
export function borrowedRuleMessage(api: string, hit: { rule: string; reference: string }): string {
  return `${api}: rule "${hit.rule}" is a rule object borrowed from another grammar, and its graph references `
    + `"${hit.reference}", which this grammar also defines. The interpreter would keep the other grammar's `
    + `"${hit.reference}" while a compiled table binds this grammar's, so the two would accept different input. `
    + `Compose the grammar that defines "${hit.rule}" instead of borrowing its rule object, so its `
    + `references resolve to this grammar's rules.`
}
