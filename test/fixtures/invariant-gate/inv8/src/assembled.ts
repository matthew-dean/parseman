/* The other declaration. Same TYPE as `engine.ts`'s, so nothing in the type
 * system can distinguish an import of one from an import of the other — which
 * is exactly why INV-8 decides on the export graph and not on types. */
export const assembledRulesFor = (n: number): string => `assembled:${n}`
