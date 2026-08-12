import type { ParserDef } from '../types.ts'

/** Authoritative direct-terminal failure spelling (not composite derivation). */
export function directTerminalFailureExpected(
  def: Extract<ParserDef, { tag: 'literal' | 'regex' | 'keywords' }>,
): string[] {
  switch (def.tag) {
    case 'literal': return [JSON.stringify(def.value)]
    case 'regex': return [`/${def.source}/`]
    case 'keywords': return ['keyword']
  }
}

/** Authoritative zero-width assertion failure spelling. */
export function assertionFailureExpected(positive: boolean, childTag: string): string[] {
  return [`${positive ? 'peek' : 'not'}(${childTag})`]
}
