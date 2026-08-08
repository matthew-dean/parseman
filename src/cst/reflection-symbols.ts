/**
 * Type-level CST identity lives on the hot table-runtime import graph.  Keep the
 * symbols separate from reflection collection/attachment: the latter is a
 * grammar-construction concern and must not make every emitted parser load its
 * descriptor-based legacy helper.
 */
export const GRAMMAR_REFLECTION: unique symbol = Symbol.for('parseman.grammarReflection') as never
export const NODE_TYPE: unique symbol = Symbol.for('parseman.type.nodeType') as never
export const NODE_TAG: unique symbol = Symbol.for('parseman.type.nodeTag') as never
