/** Import-free keys shared by grammar construction and public metadata readers. */
export const GRAMMAR_COVERAGE_DEFINITIONS: symbol = Symbol.for('parseman.grammarCoverageDefinitions')
/** A build-compiled composed grammar's carried pieces (serialized IR). */
export const COMPOSED_PIECES: unique symbol = Symbol.for('parseman.composedPieces')
/** Marks a terminal composition, which cannot be composed again. */
export const LEAF_COMPOSED: unique symbol = Symbol.for('parseman.leafComposed')
