/**
 * The compiled-artifact ↔ host contract, in ONE place.
 *
 * This lives on its own — rather than in `compiler/codegen.ts` where it started —
 * because the DRIVER has to enforce it too. `functional/run.ts` is the `parseman/run`
 * entry, whose whole purpose is to stay small (see `test/unit/run-entry-closure.test.ts`),
 * so it cannot import the compiler to reach an assertion. Neither can it carry its own
 * copy: two spellings of one contract is how the two engines drift, and this contract
 * exists precisely because the failure it prevents is silent.
 *
 * No imports, by design — that is what keeps it free for both sides to depend on.
 */

/**
 * Which consumer a compiled artifact was lowered FOR.
 *
 * - `'ast'` — the grammar's own `build` callbacks produce the result (the eval consumer).
 * - `'cst'` — a positioned-CST `ctx.build` host produces it (linter / IDE / language
 *   service), and every node's capture is sized for that host.
 *
 * ONE grammar source serves both; they are two COMPILATIONS of it, not two grammars.
 * Deciding at compile time is what keeps the eval-AST artifact free of per-node host
 * probing — see the `hostMode` note on the codegen Ctx.
 */
export type HostMode = 'ast' | 'cst'

/** Host mode a fused rule map (and each of its rule functions) was lowered for;
 * absent on hand-built maps → 'ast'. */
export const FUSED_HOST_MODE = Symbol.for('parseman.fusedHostMode')

/** Whether any fused piece omitted a direct builder's positioned-CST branch. */
export const FUSED_HOST_ELIDED = Symbol.for('parseman.fusedHostElided')

/**
 * A compiled artifact and the host it is driven with must agree — and when they do not,
 * that has to be an ERROR, never a quietly-degraded tree.
 *
 * An `'ast'` artifact does not emit the positioned-CST branch at all, so attaching a
 * `_parsemanCstOutput` host to one would silently get the grammar's own AST objects
 * where the caller asked for a CST. A `'cst'` artifact builds every node through the
 * host, so running one without a host would call `undefined`. Both are compile/run
 * mismatches with an obvious fix, so both say so.
 *
 * Called once per parse from the TypeScript entry points, never from generated code.
 */
export function assertHostModeCompatible(mode: HostMode, build: unknown, hostBranchElided = true): void {
  const isCstHost = (build as { _parsemanCstOutput?: true } | undefined)?._parsemanCstOutput === true
  // A purely STRUCTURAL artifact never had a direct-builder host branch to drop, so it
  // serves a CST host in either mode — that is the long-standing `node(parser)` contract
  // and this change does not touch it. The INTERPRETER passes `false` for the same
  // reason from the other direction: it re-decides per parse and never elides anything.
  if (mode === 'ast' && isCstHost && hostBranchElided) {
    throw new Error(
      'parseman: this parser was compiled for host mode "ast" (the default), so its nodes '
        + 'build through their own `build` callbacks and no positioned-CST branch was emitted. '
        + 'It cannot be driven with a positioned-CST host (cstBuildHost / a language-service '
        + 'host). Compile a second artifact from the SAME grammar with '
        + "`compile(grammar, { hostMode: 'cst' })` — or, under the macro, a second "
        + "`rules({ hostMode: 'cst' }, factory)` call site — and drive that one instead.",
    )
  }
  if (mode === 'cst' && !isCstHost) {
    throw new Error(
      'parseman: this parser was compiled for host mode "cst", so every node builds through '
        + 'a positioned-CST `ctx.build` host. Pass one (e.g. `{ build: cstBuildHost }`), or use '
        + 'an artifact compiled with the default `hostMode: "ast"` to get the grammar\'s own AST.',
    )
  }
}
