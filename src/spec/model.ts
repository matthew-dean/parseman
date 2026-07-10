/**
 * Grammar spec model — a small, notation-agnostic tree that both the EBNF
 * emitter and the railroad-diagram emitter consume.
 *
 * The model is produced by walking the SAME `_def` structure the interpreter
 * and macro compiler consume, so a generated spec cannot drift from what
 * actually parses. See `docs/proposals/grammar-spec-generation.md`.
 */
import type { Combinator, ParserDef } from '../types.ts'

// ---------------------------------------------------------------------------
// Spec node tree
// ---------------------------------------------------------------------------

/** A node in the grammar spec tree — one per syntactic construct. */
export type SpecNode =
  | { kind: 'seq'; items: SpecNode[] }
  | { kind: 'choice'; items: SpecNode[] }
  | { kind: 'star'; item: SpecNode }
  | { kind: 'plus'; item: SpecNode }
  | { kind: 'opt'; item: SpecNode }
  /** Separated repetition (`sepBy`): `item (sep item)*` (min 0) or `item (sep item)+` — always ≥1 here. */
  | { kind: 'sepBy'; item: SpecNode; sep: SpecNode }
  /** Reference to a named production (non-terminal). */
  | { kind: 'ref'; name: string }
  /**
   * A terminal. `literal` terminals are exact strings (rendered quoted);
   * non-literal terminals are patterns/prose (rendered as-is, e.g. a regex
   * or a caller-supplied display name).
   */
  | { kind: 'terminal'; text: string; literal: boolean }
  /** Negative lookahead (`not`). Rendered as an annotation, not consumed input. */
  | { kind: 'not'; item: SpecNode }
  /** An out-of-band annotation (guards, error-recovery, unknowns). */
  | { kind: 'annotation'; text: string }
  /** Matches nothing (elided trivia / semantic-only wrappers). */
  | { kind: 'empty' }

/** One named production: `name ::= expr`. */
export type Production = {
  name: string
  expr: SpecNode
  /** True when the rule is trivia (whitespace/comment). Elided by default. */
  trivia: boolean
}

export type SpecModel = {
  productions: Production[]
}

export type SpecOptions = {
  /**
   * Explicit rule order (and subset). When given, only these rules are emitted,
   * in this order, plus any rules they reach. Defaults to the record's key order.
   */
  order?: string[]
  /** Start rule(s) for reachability. Defaults to every record key. */
  root?: string | string[]
  /** Include trivia rules (whitespace/comment) in the output. Default: false. */
  includeTrivia?: boolean
  /**
   * Display names for terminals, keyed by rule name. When a rule whose body is a
   * single terminal (regex/literal/keywords) has an entry here, that whole rule
   * renders as the given terminal name instead of expanding — e.g.
   * `{ Ident: 'identifier' }`.
   */
  terminals?: Record<string, string>
  /**
   * Best-effort rendering of a regex terminal to a readable form. Return
   * `undefined` to fall back to the default `/source/` rendering.
   */
  regexDisplay?: (source: string, flags: string) => string | undefined
}

export type GrammarInput =
  | Record<string, Combinator<unknown>>
  | Combinator<unknown>

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

type Tagged = Combinator<unknown> & { _ruleName?: string }

function ruleNameOf(c: Combinator<unknown>): string | undefined {
  return (c as Tagged)._ruleName
}

/** Resolve a `lazy`/`ref` combinator one hop to its defined body, if resolvable. */
function resolveLazy(c: Combinator<unknown>): Combinator<unknown> | undefined {
  const def = c._def
  if (def.tag !== 'lazy') return undefined
  try {
    return def.thunk() as Combinator<unknown>
  } catch {
    return undefined
  }
}

function defaultRegexDisplay(source: string): string {
  return `/${source}/`
}

class Builder {
  private seen = new Set<string>()
  private pending: Array<{ name: string; comb: Combinator<unknown> }> = []
  private record: Record<string, Combinator<unknown>>
  private opts: SpecOptions
  productions: Production[] = []

  constructor(record: Record<string, Combinator<unknown>>, opts: SpecOptions) {
    this.record = record
    this.opts = opts
  }

  enqueue(name: string, comb: Combinator<unknown>): void {
    if (this.seen.has(name)) return
    if (this.pending.some(p => p.name === name)) return
    this.pending.push({ name, comb })
  }

  run(seedOrder: string[]): SpecModel {
    for (const name of seedOrder) {
      const comb = this.record[name]
      if (comb) this.enqueue(name, comb)
    }
    while (this.pending.length > 0) {
      const { name, comb } = this.pending.shift()!
      if (this.seen.has(name)) continue
      this.seen.add(name)
      const expr = this.ruleBody(comb, name)
      this.productions.push({ name, expr, trivia: comb._meta.isTrivia === true })
    }
    return { productions: this.productions }
  }

  /** Walk a rule's top-level combinator, transparently unwrapping its own self-ref. */
  private ruleBody(comb: Combinator<unknown>, name: string): SpecNode {
    // A rule that IS a single terminal can be pinned to a caller display name.
    const pinned = this.opts.terminals?.[name]
    if (pinned !== undefined) return { kind: 'terminal', text: pinned, literal: false }

    let c = comb
    // Unwrap the rule's own placeholder ref(s) so we expand its body, not a
    // self-reference. Both the placeholder and the resolved body carry the same
    // `_ruleName`, so guard against cycles.
    const guard = new Set<Combinator<unknown>>()
    while (c._def.tag === 'lazy' && ruleNameOf(c) === name && !guard.has(c)) {
      guard.add(c)
      const next = resolveLazy(c)
      if (!next) break
      c = next
    }
    return this.walk(c, true)
  }

  /** Walk any combinator. `isRuleRoot` suppresses treating it as a self-reference. */
  private walk(c: Combinator<unknown>, isRuleRoot = false): SpecNode {
    // A reference to a named rule → non-terminal (unless this IS that rule's root).
    const rn = ruleNameOf(c)
    if (rn !== undefined && !isRuleRoot) {
      // Register the target so it gets its own production, even if it wasn't in
      // the returned record (internal-but-referenced helper rules).
      if (!this.record[rn]) this.record[rn] = c
      this.enqueue(rn, c)
      return { kind: 'ref', name: rn }
    }
    return this.walkDef(c._def, c)
  }

  private walkDef(def: ParserDef, self: Combinator<unknown>): SpecNode {
    switch (def.tag) {
      case 'literal':
        return { kind: 'terminal', text: def.value, literal: true }

      case 'regex': {
        const shown =
          this.opts.regexDisplay?.(def.source, def.flags) ??
          defaultRegexDisplay(def.source)
        return { kind: 'terminal', text: shown, literal: false }
      }

      case 'keywords':
        return {
          kind: 'choice',
          items: def.words.map(w => ({ kind: 'terminal', text: w, literal: true }) as SpecNode),
        }

      case 'sequence': {
        const items = def.parsers.map(p => this.walk(p)).filter(nonEmpty)
        return flattenSeq(items)
      }

      case 'choice': {
        const items = def.parsers.map(p => this.walk(p)).filter(nonEmpty)
        return flattenChoice(items)
      }

      case 'many':
        return { kind: 'star', item: this.walk(def.parser) }
      case 'oneOrMore':
        return { kind: 'plus', item: this.walk(def.parser) }
      case 'optional':
        return { kind: 'opt', item: this.walk(def.parser) }
      case 'sepBy':
        return { kind: 'sepBy', item: this.walk(def.parser), sep: this.walk(def.separator) }

      case 'not':
        return { kind: 'not', item: this.walk(def.parser) }

      // Transparent semantic wrappers — render the inner syntax.
      case 'transform':
      case 'token':
      case 'label':
      case 'field':
      case 'expect':
      case 'withCtx':
      case 'node':
        return this.walk((def as { parser: Combinator<unknown> }).parser)

      case 'skip':
        return this.walk(def.main)
      case 'grammar':
        return this.walk(def.parser)

      // Error recovery — render the intended sub-parser, drop the sentinel.
      case 'recover':
        return this.walk(def.parser)
      case 'scanTo':
        return { kind: 'annotation', text: '…' }

      // Trivia — elided by default; included as an annotation when asked.
      case 'trivia':
        return this.opts.includeTrivia ? this.walk(def.parser) : { kind: 'empty' }

      case 'guard':
        return { kind: 'empty' }

      case 'lazy': {
        const inner = resolveLazy(self)
        return inner ? this.walk(inner) : { kind: 'annotation', text: '?' }
      }

      case 'unknown':
      default:
        return { kind: 'annotation', text: '?' }
    }
  }
}

function nonEmpty(n: SpecNode): boolean {
  return n.kind !== 'empty'
}

function flattenSeq(items: SpecNode[]): SpecNode {
  const flat: SpecNode[] = []
  for (const it of items) {
    if (it.kind === 'seq') flat.push(...it.items)
    else flat.push(it)
  }
  if (flat.length === 0) return { kind: 'empty' }
  if (flat.length === 1) return flat[0]!
  return { kind: 'seq', items: flat }
}

function flattenChoice(items: SpecNode[]): SpecNode {
  const flat: SpecNode[] = []
  for (const it of items) {
    if (it.kind === 'choice') flat.push(...it.items)
    else flat.push(it)
  }
  if (flat.length === 0) return { kind: 'empty' }
  if (flat.length === 1) return flat[0]!
  return { kind: 'choice', items: flat }
}

function toRecord(grammar: GrammarInput): Record<string, Combinator<unknown>> {
  // A single combinator → a one-rule grammar keyed by its rule name or "start".
  if (isCombinator(grammar)) {
    const name = ruleNameOf(grammar) ?? 'start'
    return { [name]: grammar }
  }
  return grammar
}

function isCombinator(x: unknown): x is Combinator<unknown> {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { parse?: unknown }).parse === 'function' &&
    '_def' in (x as object)
  )
}

/**
 * Build the notation-agnostic spec model from a `rules()` grammar (or a single
 * combinator). Reachability starts from `root`/`order`/record keys and follows
 * every referenced named rule, so the closure is complete.
 */
export function buildSpecModel(grammar: GrammarInput, options: SpecOptions = {}): SpecModel {
  const record = toRecord(grammar)
  const keys = Object.keys(record)
  const seed =
    options.order ??
    (options.root ? (Array.isArray(options.root) ? options.root : [options.root]) : keys)
  const model = new Builder({ ...record }, options).run(seed)
  if (!options.includeTrivia) {
    model.productions = model.productions.filter(p => !p.trivia)
  }
  return model
}
