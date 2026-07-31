/**
 * A rule MAP as the default export: no `_def`, so `fix` has no root to re-parse with.
 * `Item` is exported separately so the same module can also be reached through --export.
 */
import { choice, literal, many, rules } from '../../../src/index.ts'

const grammar = rules(r => ({
  Doc: many(r.Item),
  Item: choice(literal('a'), literal('b')),
}))

export default grammar
export const Item = grammar.Item
