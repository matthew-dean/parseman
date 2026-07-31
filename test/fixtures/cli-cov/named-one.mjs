/** Exactly one named export and no default — `loadGrammar` must pick it without --export. */
import { choice, literal } from '../../../src/index.ts'

export const onlyRule = choice(literal('a'), literal('b'))
