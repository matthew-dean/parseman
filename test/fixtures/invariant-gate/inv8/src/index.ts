/* The entry re-exports `assembled.ts`'s declaration UNDER THE OTHER MODULE'S
 * NAME. `rulesFor` now means one thing imported from here and a different thing
 * imported from `./engine.ts`, with nothing at either site saying so. That is
 * the planted violation. */
export { assembledRulesFor as rulesFor } from './assembled.ts'
export { rulesFor as interpretedRulesFor } from './engine.ts'
