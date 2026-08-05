/**
 * FIXTURE — the SANCTIONED ADD.
 *
 * A ratchet that cannot be raised is not a ratchet, it is a hard block, and a
 * hard block gets bypassed — taking the rules that matter with it. An
 * architectural change that deliberately retires modules from the export graph
 * (reference code the measurement harness reaches and the product path does
 * not) legitimately needs new `BY-DESIGN` entries.
 *
 * Two entries, `ALLOW_COUNT` raised to 2 in the same file, both matching a real
 * INV-3 finding in this tree: the gate must go GREEN. That is the whole cost of
 * adding an entry — one deliberate edit to a numbered line, which a reviewer
 * sees as its own hunk instead of one more line in a list.
 */
export const CATEGORIES = ['RULE-BUG', 'BY-DESIGN', 'DEBT']

export const ALLOW_COUNT = 2

export const ALLOW = new Map([
  ['INV-3:src/reference-a.ts', { category: 'BY-DESIGN', why: 'retained reference code, off the product path by design' }],
  ['INV-3:src/reference-b.ts', { category: 'BY-DESIGN', why: 'retained reference code, off the product path by design' }],
])
