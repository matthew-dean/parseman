/**
 * `parseman/spec` — generate a formal grammar specification directly from a
 * Parséman `rules()` grammar.
 *
 * Because the emitter walks the SAME `_def` combinator tree the interpreter and
 * macro compiler consume, a generated spec is a single source of truth: it
 * cannot disagree with what actually parses.
 *
 *   import { toEBNF, toRailroadHtml } from 'parseman/spec'
 *
 *   const grammar = rules(g => ({ ... }))   // your grammar
 *   const ebnf = toEBNF(grammar)            // EBNF text
 *   const html = toRailroadHtml(grammar)    // self-contained syntax diagrams
 *
 * Scope: syntax only, not semantics. See docs/proposals/grammar-spec-generation.md.
 */
import { buildSpecModel } from './model.ts'
import type { GrammarInput, SpecModel, SpecOptions } from './model.ts'
import { renderEBNF } from './ebnf.ts'
import { renderRailroadHtml } from './railroad.ts'
import type { RailroadHtmlOptions } from './railroad.ts'

export { buildSpecModel } from './model.ts'
export type { GrammarInput, SpecModel, SpecOptions, SpecNode, Production } from './model.ts'
export { renderEBNF, renderExpr } from './ebnf.ts'
export { renderRailroadHtml } from './railroad.ts'
export type { RailroadHtmlOptions } from './railroad.ts'

/** Generate W3C-style EBNF text (one production per named rule). */
export function toEBNF(grammar: GrammarInput, options?: SpecOptions): string {
  return renderEBNF(buildSpecModel(grammar, options))
}

/**
 * Generate a self-contained HTML page of SVG railroad (syntax) diagrams — one
 * per production — with an EBNF caption under each. No external dependencies.
 */
export function toRailroadHtml(
  grammar: GrammarInput,
  options?: SpecOptions & RailroadHtmlOptions,
): string {
  const model: SpecModel = buildSpecModel(grammar, options)
  return renderRailroadHtml(model, options)
}
