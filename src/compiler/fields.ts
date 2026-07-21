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
    case 'attempt':
    case 'transform':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'label':
    case 'expect':
    case 'withCtx':
    case 'not':
      return parserHasOwnFields(d.parser, seen)
    default:
      return false
  }
}

/**
 * Does the node's OWN parse frame ever have a trivia run logged into it?
 * Trivia is logged only by the trivia-skip fn, which runs at `sequence`/`many`/
 * repeat boundaries. A bare terminal (regex/literal/keywords/…) has NO trivia
 * site, so its `_cstTriviaLog` stays empty and its `captureTrivia`/`_cstTriviaLog`/
 * `_triviaCaptureMask` save+install+restore is dead work — the per-node scope
 * trivia frame can be elided for it (see emitNode `needsTriviaFrame`).
 *
 * Stops at a nested `node()` (it manages its OWN trivia frame; trivia inside it
 * never logs to THIS node's frame). CONSERVATIVE: any unknown / trivia-bearing
 * shape returns `true` (keep the frame) — we only elide when provably safe.
 */
export function parserHasTriviaSite(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return true // cycle → conservative (keep the frame)
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    // Trivia is skipped between/around elements or iterations → a site.
    case 'sequence':
    case 'many':
    case 'oneOrMore':
    case 'sepBy':
    case 'scanTo':
    case 'recover':
    case 'skip':
      return true
    // Nested node manages its own trivia frame; none logs here.
    case 'node': return false
    // Pure terminals + trivia-suppressing token: no site.
    case 'regex':
    case 'literal':
    case 'keywords':
    case 'guard':
    case 'token':
    case 'leaf':
      return false
    // Transparent single-child wrappers: recurse.
    case 'optional':
    case 'attempt':
    case 'transform':
    case 'trivia':
    case 'label':
    case 'expect':
    case 'withCtx':
    case 'not':
    case 'field':
      return parserHasTriviaSite(d.parser, seen)
    case 'choice': return d.parsers.some(x => parserHasTriviaSite(x, seen))
    case 'grammar': return parserHasTriviaSite(d.parser, seen)
    case 'lazy': {
      try { return parserHasTriviaSite(d.thunk(), seen) } catch { return true }
    }
    default: return true // unknown shape → conservative
  }
}

/**
 * Can this node's inner grammar explicitly enable trivia capture? A surrounding
 * node owns the collector, so a nested `parser({ captureTrivia: true })` must
 * allocate that collector before it enters the grammar scope. Nested node()
 * rules own their separate collector and therefore do not contribute here.
 */
export function parserEnablesTriviaCapture(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'grammar': return d.captureTrivia === true || parserEnablesTriviaCapture(d.parser, seen)
    case 'node': return false
    case 'sequence':
    case 'choice': return d.parsers.some(x => parserEnablesTriviaCapture(x, seen))
    case 'sepBy': return parserEnablesTriviaCapture(d.parser, seen) || parserEnablesTriviaCapture(d.separator, seen)
    case 'skip': return parserEnablesTriviaCapture(d.main, seen) || parserEnablesTriviaCapture(d.skipped, seen)
    case 'scanTo': return parserEnablesTriviaCapture(d.sentinel, seen) || d.skip.some(x => parserEnablesTriviaCapture(x, seen))
    case 'recover': return parserEnablesTriviaCapture(d.parser, seen) || parserEnablesTriviaCapture(d.sentinel, seen)
    case 'many':
    case 'oneOrMore':
    case 'optional':
    case 'attempt':
    case 'transform':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'label':
    case 'field':
    case 'expect':
    case 'withCtx':
    case 'not': return parserEnablesTriviaCapture(d.parser, seen)
    case 'lazy': {
      try { return parserEnablesTriviaCapture(d.thunk(), seen) } catch { return false }
    }
    default: return false
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
