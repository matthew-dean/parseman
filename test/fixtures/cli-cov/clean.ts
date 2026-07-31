/** A TypeScript grammar module — the `registerTsIfNeeded` path — with nothing to report. */
import { choice, literal, type Combinator } from '../../../src/index.ts'

const rule: Combinator<string> = choice(literal('yes'), literal('no'))

export default rule
