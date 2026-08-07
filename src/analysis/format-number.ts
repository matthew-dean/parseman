/**
 * Deterministic number formatting, with NO dependencies — not even on the
 * terminal layer.
 *
 * This module exists because the obvious home was wrong. `groupDigits` was
 * declared twice, byte for byte, in `./terminal.ts` and `./choice-cost-render.ts`,
 * and collapsing it onto `./terminal.ts` — the module that owns the formatting
 * primitives — pulled `linecraft` into `choice-cost-render.ts`'s import closure
 * and from there into the main entry, which `test/unit/run-entry-closure.test.ts`
 * caught immediately.
 *
 * That is the useful lesson, and it is why this is a leaf: a shared definition has
 * to live at or below the LOWEST level that needs it. Hoisting a duplicate up to
 * whichever module looks like the owner trades a correctness hazard for a bundle
 * one. Digit grouping needs nothing, so it depends on nothing.
 */

/**
 * Deterministic thousands grouping. `toLocaleString()` is locale-dependent and
 * would make output differ between machines — the one thing a gateable rendering
 * cannot do.
 */
export function groupDigits(n: number): string {
  const s = String(Math.trunc(Math.abs(n)))
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ','
    out += s[i]
  }
  return (n < 0 ? '-' : '') + out
}
