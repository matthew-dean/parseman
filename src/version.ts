/**
 * Parseman's version — stamped into every generated-artifact banner and used as the
 * ARTIFACT VERSION LOCK (see `docs/design/artifact-format.md`).
 *
 * ── ARTIFACTS ARE VERSION-LOCKED ────────────────────────────────────────────────
 * A grammar is compiled AND fused/linked by the SAME parseman version. Parseman does
 * NOT read a compiled artifact produced by a different version. The compiled-artifact
 * format (`firstSetRecipes`, `LinkablePieces`, the fused-body shape, …) may therefore
 * change freely between versions and carries NO back-compat shim: `fusedBody` refuses
 * to link a serialized artifact stamped with a different version, and there is no
 * "legacy format" read path. If you find yourself adding one, STOP — it is dead code.
 *
 * Kept in sync with `package.json` by `test/unit/version-sync.test.ts`, which fails
 * the build if this constant drifts from the published version.
 */
export const PARSEMAN_VERSION = '0.32.0'
