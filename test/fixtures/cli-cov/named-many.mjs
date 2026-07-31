/** Two named exports and no default — `loadGrammar` must refuse and NAME both. */
import { choice, literal } from '../../../src/index.ts'

export const alphaRule = choice(literal('a'), literal('b'))
export const betaRule = choice(literal('c'), literal('d'))
