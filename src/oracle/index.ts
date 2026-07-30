/**
 * `parseman/oracle` — an AST-identity oracle for grammar refactors.
 *
 * Turns "is this rule collapse safe?" from a judgement call into an accept/reject:
 * digest a corpus through your parse entry points before and after the change,
 * and compare.
 *
 *     import { loadCorpus, digestCorpus, compareReports, formatComparison } from 'parseman/oracle'
 *
 *     const { entries } = loadCorpus({
 *       base: repoRoot,
 *       roots: ['test/fixtures', 'corpus'],
 *       extensions: ['.less', '.css'],
 *     })
 *     const report = digestCorpus(
 *       [
 *         { name: 'ast', parse: source => parse(source) },
 *         { name: 'cst', parse: source => parseCst(source) },
 *       ],
 *       entries,
 *     )
 *     // …edit the grammar, REBUILD, run again…
 *     console.log(formatComparison(compareReports(before, after)))
 *
 * Node-only: it hashes with `node:crypto` and reads files with `node:fs`. It is a
 * development gate, so it is a separate entry point and nothing in it reaches the
 * browser-capable `parseman` bundle.
 *
 * See `docs/guide/identity-oracle.md` for the operating discipline — in
 * particular why you must digest the BUILT artifact and rebuild between edits.
 */
export { digestCorpus, compareReports, formatComparison, HARNESS_DIGEST } from './identity.ts'
export type {
  Surface,
  CorpusEntry,
  SurfaceReport,
  IdentityReport,
  DigestOptions,
  SurfaceComparison,
  IdentityComparison,
} from './identity.ts'
export { loadCorpus } from './corpus.ts'
export type { LoadCorpusOptions, LoadedCorpus } from './corpus.ts'
export {
  canonicalize,
  digestInto,
  digestValue,
  CanonicalBudgetError,
  DEFAULT_MAX_VISITS,
  DIGEST_FORMAT,
} from './digest.ts'
export type { CanonicalOptions, DigestTarget } from './digest.ts'
