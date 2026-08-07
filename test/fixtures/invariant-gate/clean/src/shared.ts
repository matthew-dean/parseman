/* A normal module behind a barrel. INV-8 must stay silent when `src/index.ts`
 * re-exports this ONE declaration — a barrel resolves to a single origin, and a
 * rule that fired on barrels would be useless in a codebase built from them. */
export const widen = (n: number): number => n * 2
/* One mint, one module. INV-9 fires on a description spelled in TWO modules,
 * never on a module spelling its own key once. */
export const TAG = Symbol('clean.tag')
