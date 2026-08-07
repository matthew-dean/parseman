import { GRAMMAR_REFLECTION, type GrammarReflection } from './reflection.ts'

/**
 * Legacy interpreted-rule-map attachment. It is deliberately outside the shared
 * table runtime graph: macro/table artifacts construct reflection in their
 * metadata prototype instead of mutating an already-built map.
 */
export function attachGrammarReflection<T extends object>(grammar: T, reflection: GrammarReflection): T {
  Object.defineProperty(grammar, GRAMMAR_REFLECTION, { value: reflection, enumerable: false, configurable: true })
  return grammar
}
