/* A tree that violates nothing. Every rule must stay silent here — a gate that
 * fires on clean input is worse than no gate. */
export type CleanOptions = { readonly loud?: boolean }
export const shout = (o: CleanOptions): string => (o.loud === true ? 'HI' : 'hi')
export const shape = (n: number): { n: number; label: string } => ({ n, label: String(n) })
/** A LITERAL getter is deliberately legal: it is part of the shape from birth. */
export const lazy = (make: () => number): { readonly v: number } => ({ get v() { return make() } })
