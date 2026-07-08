import type { Combinator, FieldMap, ParserDef } from '../types.ts'
import { confirmedBuildArity } from './build-arity.ts'

type NodeDef = Extract<ParserDef, { tag: 'node' }>

export function buildReadsFields(def: NodeDef): boolean {
  if (!def.build) return true
  const src = def.buildSrc ?? def.build.toString()
  const arity = confirmedBuildArity(src)
  if (arity === null) return true
  return arity >= 2
}

export function parserHasOwnFields(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'field': return true
    case 'node': return false
    case 'lazy': {
      try { return parserHasOwnFields(d.thunk(), seen) } catch { return false }
    }
    case 'sequence':
    case 'choice': return d.parsers.some(x => parserHasOwnFields(x, seen))
    case 'sepBy': return parserHasOwnFields(d.parser, seen) || parserHasOwnFields(d.separator, seen)
    case 'skip': return parserHasOwnFields(d.main, seen) || parserHasOwnFields(d.skipped, seen)
    case 'grammar': return parserHasOwnFields(d.parser, seen) || (d.triviaParser ? parserHasOwnFields(d.triviaParser, seen) : false)
    case 'scanTo': return parserHasOwnFields(d.sentinel, seen) || d.skip.some(x => parserHasOwnFields(x, seen))
    case 'recover': return parserHasOwnFields(d.parser, seen) || parserHasOwnFields(d.sentinel, seen)
    case 'many':
    case 'oneOrMore':
    case 'optional':
    case 'transform':
    case 'trivia':
    case 'token':
    case 'label':
    case 'expect':
    case 'withCtx':
    case 'not':
      return parserHasOwnFields(d.parser, seen)
    default:
      return false
  }
}

export function buildFieldMap(captures: ReadonlyArray<{ name: string; value: unknown; span: { start: number; end: number } }> | undefined): FieldMap | undefined {
  if (!captures?.length) return undefined
  const out: FieldMap = {}
  for (const cap of captures) {
    const entry = { value: cap.value, span: cap.span }
    const current = out[cap.name]
    if (current === undefined) out[cap.name] = entry
    else if (Array.isArray(current)) current.push(entry)
    else out[cap.name] = [current, entry]
  }
  return out
}
