/* One of the two declarations INV-8 must find. This is `tableRules`' shape:
 * a module that exports a name under its own definition, while a sibling
 * exports the SAME name for a different one. */
export const rulesFor = (n: number): string => `interpreted:${n}`
