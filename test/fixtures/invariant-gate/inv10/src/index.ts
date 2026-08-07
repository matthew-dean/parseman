/**
 * The planted violation is the last line of this comment: it points at a module
 * that does not exist in this tree. A comment that points at deleted code does
 * not fail — it misleads, which is how a bench column kept a name for months
 * after the module it named was gone.
 *
 * `src/helper.ts` DOES exist and must stay silent, so the rule is shown here not
 * to fire on a live reference.
 *
 * See `src/lowering.ts` for how this used to be emitted.
 */
import { help } from './helper.ts'
export const emit = (n: number): string => help(n)
