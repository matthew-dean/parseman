/**
 * Derived tokenization, part 1: the terminal ALPHABET.
 *
 * Parseman knows every terminal in the composed grammar at macro time — every
 * `literal`, `keywords`, and `regex`. This module walks the combinator graph
 * and assigns each distinct terminal a small integer TOKEN ID.
 *
 * Two things are deliberately separated, because conflating them is what makes
 * a naive derived scanner useless:
 *
 *  - The token ID SPACE is GLOBAL. One id per distinct terminal across the whole
 *    grammar, so an id can be compared, switched on, and indexed with.
 *  - The CANDIDATE SET is LOCAL, per decision point. Global maximal munch over
 *    the whole alphabet is wrong: a css alphabet contains construct-local
 *    long-run terminals (`[^()]+`, `[^{}/]+`, the `scanTo` raw-prelude runs)
 *    that swallow the document. Measured: global munch yields SEVEN tokens for a
 *    123 KB stylesheet. A decision point consults only the terminals that can
 *    actually start one of its arms.
 *
 * Nothing here decides HOW a token is recognized (see `token-scanner.ts`); this
 * module only decides WHAT the tokens are and WHICH ones each site may see.
 */
import type { Combinator, ParserDef } from '../types.ts'

/** A terminal in the derived alphabet, with its globally assigned id. */
export type TokenTerminal =
  | { kind: 'literal'; id: number; value: string; caseInsensitive: boolean }
  | { kind: 'keywords'; id: number; words: readonly string[]; caseInsensitive: boolean; boundary: string | undefined }
  | { kind: 'regex'; id: number; source: string; flags: string }

/** Reserved ids. Real terminals start at `FIRST_TERMINAL_ID`. */
export const TOK_EOF = 0
export const TOK_UNKNOWN = 1
export const TOK_WS = 2
export const FIRST_TERMINAL_ID = 3

export type Alphabet = {
  terminals: TokenTerminal[]
  /** Dedup key → id, so the same terminal spelled twice gets ONE id. */
  byKey: Map<string, number>
  /** The combinator that contributed each id (first one wins), for candidate sets. */
  originOf: Map<number, Combinator<unknown>>
}

function keyOf(def: ParserDef): string | undefined {
  switch (def.tag) {
    case 'literal': return `L\u0000${def.value}\u0000${def.caseInsensitive ? 'i' : ''}`
    case 'keywords': return `K\u0000${def.words.join('\u0001')}\u0000${def.caseInsensitive ? 'i' : ''}\u0000${def.boundary ?? ''}`
    case 'regex': return `R\u0000${def.source}\u0000${def.flags}`
    default: return undefined
  }
}

function terminalOf(def: ParserDef, id: number): TokenTerminal | undefined {
  switch (def.tag) {
    case 'literal': return { kind: 'literal', id, value: def.value, caseInsensitive: def.caseInsensitive }
    case 'keywords': return { kind: 'keywords', id, words: def.words, caseInsensitive: def.caseInsensitive, boundary: def.boundary }
    case 'regex': return { kind: 'regex', id, source: def.source, flags: def.flags }
    default: return undefined
  }
}

/** Direct sub-parsers of a def, resolving a lazy through `resolve` when its own thunk is a hole. */
export function tokenChildren(
  p: Combinator<unknown>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): Combinator<unknown>[] {
  const d = p._def
  const out: Combinator<unknown>[] = []
  const push = (v: Combinator<unknown> | undefined): void => { if (v !== undefined) out.push(v) }
  const rec = d as unknown as Record<string, unknown>
  for (const k of ['parser', 'main', 'skipped', 'separator', 'selector', 'sentinel', 'fallback', 'otherwise', 'triviaParser']) {
    const v = rec[k]
    if (v !== null && typeof v === 'object' && '_def' in (v as object)) push(v as Combinator<unknown>)
  }
  if (Array.isArray(rec.parsers)) for (const c of rec.parsers as Combinator<unknown>[]) push(c)
  if (Array.isArray(rec.skip)) for (const c of rec.skip as Combinator<unknown>[]) push(c)
  if (Array.isArray(rec.cases)) for (const c of rec.cases as Array<{ parser: Combinator<unknown> }>) push(c.parser)
  if (Array.isArray(rec.matchers)) for (const c of rec.matchers as Array<{ parser: Combinator<unknown> }>) push(c.parser)
  if (d.tag === 'lazy') {
    let target: Combinator<unknown> | undefined
    try { target = d.thunk() } catch { target = undefined }
    if (target === undefined && resolve !== undefined) {
      const name = (p as unknown as { _ruleName?: string })._ruleName
      if (name !== undefined) target = resolve(name)
    }
    push(target)
  }
  return out
}

/**
 * Collect the alphabet over `roots`. Ids are assigned in first-encounter order,
 * which is stable for a given grammar and therefore safe to switch on.
 */
export function collectAlphabet(
  roots: ReadonlyArray<Combinator<unknown>>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): Alphabet {
  const terminals: TokenTerminal[] = []
  const byKey = new Map<string, number>()
  const originOf = new Map<number, Combinator<unknown>>()
  const seen = new Set<Combinator<unknown>>()

  const walk = (p: Combinator<unknown>): void => {
    if (seen.has(p)) return
    seen.add(p)
    const key = keyOf(p._def)
    if (key !== undefined && !byKey.has(key)) {
      const id = FIRST_TERMINAL_ID + terminals.length
      const t = terminalOf(p._def, id)
      if (t !== undefined) {
        byKey.set(key, id)
        terminals.push(t)
        originOf.set(id, p)
      }
    }
    for (const c of tokenChildren(p, resolve)) walk(c)
  }
  for (const r of roots) walk(r)
  return { terminals, byKey, originOf }
}

/** The id already assigned to this terminal, if it is one. */
export function terminalId(alphabet: Alphabet, p: Combinator<unknown>): number | undefined {
  const key = keyOf(p._def)
  return key === undefined ? undefined : alphabet.byKey.get(key)
}

/**
 * The LEADING terminal of an arm — the one a decision point would consult. Walks
 * through the wrappers that do not consume input, and through a sequence's
 * nullable/zero-width prefix. Returns undefined when the lead is not a single
 * derived terminal, which is the signal to stay scannerless at that site.
 */
export function leadTerminal(
  p: Combinator<unknown>,
  alphabet: Alphabet,
  resolve?: (name: string) => Combinator<unknown> | undefined,
  depth = 0,
): number | undefined {
  if (depth > 24) return undefined
  const direct = terminalId(alphabet, p)
  if (direct !== undefined) return direct
  const d = p._def
  switch (d.tag) {
    case 'sequence': {
      for (const c of d.parsers) {
        // CLASSIFY FIRST. The old order asked for the inner terminal and returned
        // it before checking whether the term could consume anything, so:
        //
        //   sequence(optional(X), Y)  yielded X's terminal as THE lead -- but the
        //                             input may legally start with Y's instead
        //   sequence(not(X), Y)       yielded X's terminal -- from a NEGATIVE
        //                             lookahead, which never consumes
        //
        // A single lead terminal cannot express "X's first set OR Y's", so a
        // nullable prefix has no direct lead and the site must be REJECTED --
        // scannerless gating handles it correctly. Zero-width prefixes are
        // different: they consume nothing, so the next term genuinely leads.
        const cd = c._def.tag
        if (cd === 'not' || cd === 'peek' || cd === 'guard') continue
        if (cd === 'optional' || cd === 'many') return undefined
        return leadTerminal(c, alphabet, resolve, depth + 1)
      }
      return undefined
    }
    case 'sepBy':
      return leadTerminal(d.parser, alphabet, resolve, depth + 1)
    case 'lazy': {
      let target: Combinator<unknown> | undefined
      try { target = d.thunk() } catch { target = undefined }
      if (target === undefined && resolve !== undefined) {
        const name = (p as unknown as { _ruleName?: string })._ruleName
        if (name !== undefined) target = resolve(name)
      }
      return target === undefined ? undefined : leadTerminal(target, alphabet, resolve, depth + 1)
    }
    case 'node': case 'field': case 'label': case 'transform': case 'leaf':
    case 'token': case 'grammar': case 'attempt': case 'expect': case 'withCtx':
    case 'oneOrMore': case 'trivia': case 'recover':
      return leadTerminal(d.parser, alphabet, resolve, depth + 1)
    default:
      return undefined
  }
}

/**
 * The CANDIDATE SET for one decision point: the leading terminals of its arms.
 * `complete` is false when any arm's lead is not a derived terminal — that site
 * must stay scannerless, per-construct, exactly as `scanSkip` and first-set
 * gating already apply per region rather than globally.
 */
export type CandidateSet = { ids: number[]; complete: boolean }

export function candidateSet(
  arms: ReadonlyArray<Combinator<unknown>>,
  alphabet: Alphabet,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): CandidateSet {
  const ids: number[] = []
  let complete = true
  for (const a of arms) {
    const t = leadTerminal(a, alphabet, resolve)
    if (t === undefined) { complete = false; continue }
    if (!ids.includes(t)) ids.push(t)
  }
  return { ids, complete }
}
