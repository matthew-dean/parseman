/**
 * FIXTURE — an allowlist that GREW without its committed count being raised.
 *
 * Two well-formed entries against a committed `ALLOW_COUNT` of 1: exactly the
 * shape of someone appending a line to unblock new code. The gate must go red
 * on the count alone, before it looks at a single source file — which is the
 * whole point of the ratchet, and the thing the old "THIS LIST MAY ONLY GET
 * SHORTER" comment could not do.
 */
export const CATEGORIES = ['RULE-BUG', 'BY-DESIGN', 'DEBT']

export const ALLOW_COUNT = 1

export const ALLOW = new Map([
  ['INV-3:src/first.ts', { category: 'BY-DESIGN', why: 'the entry that was already committed' }],
  ['INV-3:src/second.ts', { category: 'BY-DESIGN', why: 'the entry someone appended without touching the count' }],
])
