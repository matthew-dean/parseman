/**
 * A grammar in the shape that ACTUALLY ships: fused rule functions with no combinator
 * graph left to read. This is what `parseman diagnose` gets when it is pointed at a
 * built artifact, and it is the input that used to produce
 *
 *   ✗ 176 problems, 176 failing the check, 1 cause  ·  exiting 1 (problems found)
 *
 * over zero examined choices. Nothing here is a defect; there is simply nothing to see.
 */
export const fusedGrammar = {
  Alpha: () => undefined,
  Beta: () => undefined,
  Gamma: () => undefined,
}
