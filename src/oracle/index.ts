/**
 * `parseman/oracle` — deterministic serialization of a parse result.
 *
 * Turns "is this rule collapse safe?" from a judgement call into an accept/reject.
 * Digest your parse output before and after the change and compare the two
 * digests: equal means the refactor is output-neutral and can land on its own
 * merits; different means it is not a refactor, it is a semantics change, and
 * needs the decision that goes with one.
 *
 *     import { digestInto } from 'parseman/oracle'
 *     import { createHash } from 'node:crypto'
 *
 *     const sha = createHash('sha256')
 *     digestInto(sha, parse(source))
 *     const digest = sha.digest('hex')
 *
 * It is a differential, not a correctness check. It says the output did not move;
 * it says nothing about whether the output was right to begin with.
 *
 * ## Why the projection is here and the harness is not
 *
 * Deciding what the canonical byte stream IS depends on parseman's node shapes
 * and on nothing else — which distinctions a refactor can move, and which are
 * bookkeeping no consumer observes. No consumer can get that right, so it lives
 * here, and every grammar author needs it whatever they are building.
 *
 * Walking a corpus, folding per-entry digests into an aggregate, three-way
 * verdicts and report formatting used to live here too, as `loadCorpus`,
 * `digestCorpus`, `compareReports` and `formatComparison`. Those do not help
 * anyone build or diagnose a grammar: they are one consumer's regression-suite
 * plumbing, and they only mean anything with that consumer's corpus roots and
 * committed baseline in hand. They now live with the suite that needs them —
 * jess's is `packages/syntax/less/less-parser/test/identity-oracle/`, a
 * reasonable model to copy. Two things are worth carrying over: keep an
 * `OK:`/`ERR:` prefix so a successful parse and a thrown error stay in disjoint
 * hash spaces, and keep "the grammar rejected this input" and "the digest could
 * not be computed" on separate channels — the second is a fact about the TOOL,
 * and reporting it as the first is how a gate lies.
 *
 * Node-only: it hashes with `node:crypto`. It is a development gate, so it is a
 * separate entry point and nothing in it reaches the browser-capable `parseman`
 * bundle.
 *
 * See `docs/guide/identity-oracle.md` for the operating discipline — in
 * particular why you must digest the BUILT artifact and rebuild between edits.
 */
export {
  canonicalize,
  digestInto,
  digestValue,
  CanonicalBudgetError,
  DEFAULT_MAX_VISITS,
  DIGEST_FORMAT,
} from './digest.ts'
export type { CanonicalOptions, DigestTarget } from './digest.ts'
