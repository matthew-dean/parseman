/**
 * A grammar authored FOR THE MACRO — the shape every real parseman grammar ships in.
 *
 * The `with { type: 'macro' }` attribute is what the build-time macro keys on. Node's
 * own loader rejects any `type` it does not recognise, so importing this module without
 * help fails with
 *
 *   TypeError: Import attribute "type" with value "macro" is not supported
 *
 * which is how `parseman diagnose` failed on every macro-authored grammar. Dropping the
 * attribute degrades the import to a plain runtime one and the combinators build
 * normally — the CLI's `MACRO_ATTR_HOOK` is what does that here.
 */
import { choice, literal, regex } from '../../../src/index.ts' with { type: 'macro' }

export const macroAttrGrammar = choice(literal('a'), regex(/[\s\S]*/))
