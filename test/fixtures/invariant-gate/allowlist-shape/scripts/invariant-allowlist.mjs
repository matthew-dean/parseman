/**
 * FIXTURE — allowlist entries that lack the structure the gate requires.
 *
 * The count is correct, so this isolates the STRUCTURE check. Three ways an
 * entry can be unaccountable, one per entry:
 *
 *   1. no category at all — the pre-ratchet shape, a bare free-text excuse
 *   2. a category nobody agreed to — "TEMPORARY" is not one of the three
 *   3. DEBT with no `ref` — a promise to fix with nobody named
 *
 * Each of the three is an entry with no owner and no expiry, which is the
 * defect the categories exist to make impossible to write.
 */
export const CATEGORIES = ['RULE-BUG', 'BY-DESIGN', 'DEBT']

export const ALLOW_COUNT = 3

export const ALLOW = new Map([
  ['INV-3:src/uncategorized.ts', { why: 'no category — just a sentence' }],
  ['INV-3:src/invented.ts', { category: 'TEMPORARY', why: 'a category nobody agreed to' }],
  ['INV-3:src/unowned.ts', { category: 'DEBT', why: 'DEBT with nobody named to pay it' }],
])
