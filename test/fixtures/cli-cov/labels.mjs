/**
 * A grammar whose sole job is to make `leadLabel` produce one of EVERY label it can:
 * a literal, a regex, a one-word `word()`, a multi-word `keywords()`, a named rule
 * reference, an anonymous `ref()` that resolves, an unbound `ref()` whose thunk throws,
 * and a shape that falls through to the bare tag.
 *
 * `.mjs` on purpose: it is the branch of `registerTsIfNeeded` that returns immediately.
 */
import { choice, literal, regex, word, keywords, many, ref, rules } from '../../../src/index.ts'

const named = rules(r => ({
  Named: literal('named'),
  Entry: r.Named,
}))

const resolves = ref()
resolves.define(literal('resolved'))

const refToNamed = ref()
refToNamed.define(named.Named)

const unbound = ref()

export default choice(
  literal('lit'),
  regex(/re[0-9]/),
  word('solo'),
  keywords(['alpha', 'beta']),
  named.Named,
  resolves,
  refToNamed,
  unbound,
  many(literal('m')),
)
