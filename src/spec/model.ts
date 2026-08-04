/**
 * Grammar spec model — a small, notation-agnostic tree that both the EBNF
 * emitter and the railroad-diagram emitter consume.
 *
 * The model is produced by walking the SAME `_def` structure the interpreter
 * and macro compiler consume, so a generated spec cannot drift from what
 * actually parses. See `docs/proposals/grammar-spec-generation.md`.
 */
import type { Combinator, ParserDef } from '../types.ts'
import type { BalancedMarked } from '../combinators/scanTo.ts'
import { RULE_ORDER } from '../combinators/parser.ts'
import { recoverComposedRules } from '../compiler/linker.ts'

// ---------------------------------------------------------------------------
// Spec node tree
// ---------------------------------------------------------------------------

/** A node in the grammar spec tree — one per syntactic construct. */
export type SpecNode =
  | { kind: 'seq'; items: SpecNode[] }
  | { kind: 'choice'; items: SpecNode[] }
  /** `item*`, or `item{0,max}` when `many(…, { max })` bounded it. */
  | { kind: 'star'; item: SpecNode; max?: number }
  /** `item+`, or `item{min,max}` when `many(…, { min, max })` bounded it. `min`
   *  defaults to 1 and is always >= 1 (a min-0 repeat is a `star`). */
  | { kind: 'plus'; item: SpecNode; min?: number; max?: number }
  | { kind: 'opt'; item: SpecNode }
  /**
   * Separated repetition. `min`/`max` count ITEMS, not separators: `min: 0` is
   * `(item (sep item)*)?` — NULLABLE — and any `min >= 1` requires that many
   * items, so it is not. `trailing` mirrors `sepBy`'s option of the same name.
   */
  | { kind: 'sepBy'; item: SpecNode; sep: SpecNode; min: number; max?: number; trailing?: 'allow' }
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
  /** Positive lookahead (`ahead`). Zero-width, like `not`. */
  | { kind: 'peek'; item: SpecNode }
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
   * How to order the emitted productions when neither `order` nor `root` is given:
   *   - `'source'` (default) — the order the rules were **declared** in the
   *     `rules()` factory. Predictable, includes every rule, and leads with the
   *     entry rule (authors write it first). Internal-but-referenced helper rules
   *     follow, in first-reference order.
   *   - `'reachable'` — BFS from the entry rule: the first-declared rule leads,
   *     then each rule appears the first time it is referenced; any rules not
   *     reachable from the entry are appended in declaration order.
   * Ignored when `order` or `root` is set.
   */
  sort?: 'source' | 'reachable'
  /**
   * Explicit rule order (and subset). When given, only these rules are emitted,
   * in this order, plus any rules they reach. Overrides `sort`.
   */
  order?: string[]
  /**
   * Start rule(s). When given, only these and the rules they reach are emitted
   * (a pruned, reachability-ordered spec). Overrides `sort`.
   */
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

// ---------------------------------------------------------------------------
// Authored terminals behind a regex
// ---------------------------------------------------------------------------
//
// A spec reader's vocabulary is the LANGUAGE's: MDN and the CSS specs draw
// `@import`, not `/@import(?![-_a-zA-Z0-9\u0080-\uFFFF])/`. The trailing
// lookahead is a word-boundary assertion — an implementation detail of how a
// keyword is recognised, not part of the language — and printing it drowns the
// grammar in emitter noise. It also broke the diagrams as a complexity metric:
// a rule made of keywords scored worse than a genuinely tangled one.
//
// So when a `regex()` terminal IS a fixed string (optionally guarded by a word
// boundary, optionally a set of fixed strings), render the string(s). This is
// not simplification — nothing is collapsed, hidden, or elided; the terminal is
// shown as the text it matches, which is strictly MORE information than its
// compiled pattern. Anything with real regex structure still prints raw.

/**
 * Start index of the top-level group that closes at the very end of `src`, or
 * `-1`. Character classes and escapes are skipped so `[)]` and `\)` don't lie.
 */
function trailingGroupStart(src: string): number {
  let depth = 0
  let open = -1
  let lastStart = -1
  let lastEnd = -1
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (ch === '\\') { i++; continue }
    if (ch === '[') {
      // Skip the class body.
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') i++
        else if (src[i] === ']') break
      }
      continue
    }
    if (ch === '(') { if (depth === 0) open = i; depth++ }
    else if (ch === ')') { depth--; if (depth === 0) { lastStart = open; lastEnd = i } }
  }
  return lastEnd === src.length - 1 ? lastStart : -1
}

/** `(?![…])` — a negative lookahead over a single character class. */
const BOUNDARY_GUARD = /^\(\?!\[(?:[^\\\]]|\\[\s\S])*\]\)$/

/** Split on top-level `|`, skipping escapes, classes and groups. */
function topLevelAlternatives(src: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (ch === '\\') { i++; continue }
    if (ch === '[') {
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') i++
        else if (src[i] === ']') break
      }
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === '|' && depth === 0) { parts.push(src.slice(start, i)); start = i + 1 }
  }
  parts.push(src.slice(start))
  return parts
}

/** Regex metacharacters an escape may legitimately spell as a literal. */
const ESCAPABLE = '\\^$.|?*+()[]{}/-'

/**
 * Decode one alternative to the exact string it matches, or `undefined` when it
 * is not a fixed string. Deliberately strict: any quantifier, class, group,
 * anchor, class shorthand or control escape disqualifies it, because rendering
 * those as text would state something the grammar does not say.
 */
function fixedString(alt: string): string | undefined {
  if (alt.length === 0) return undefined
  let out = ''
  for (let i = 0; i < alt.length; i++) {
    const ch = alt[i]!
    if (ch === '\\') {
      const next = alt[i + 1]
      if (next === undefined) return undefined
      if (next === 'u' || next === 'x') {
        const hex = next === 'u'
          ? (alt[i + 2] === '{' ? /^\\u\{([0-9a-fA-F]+)\}/.exec(alt.slice(i)) : /^\\u([0-9a-fA-F]{4})/.exec(alt.slice(i)))
          : /^\\x([0-9a-fA-F]{2})/.exec(alt.slice(i))
        if (hex === null) return undefined
        const cp = parseInt(hex[1]!, 16)
        // Control and non-printable code points have no honest text form.
        if (cp < 0x20 || cp === 0x7f) return undefined
        out += String.fromCodePoint(cp)
        i += hex[0]!.length - 1
        continue
      }
      if (!ESCAPABLE.includes(next)) return undefined
      out += next
      i++
      continue
    }
    // Unescaped metacharacter → real structure, not a fixed string.
    if ('^$.|?*+()[]{}'.includes(ch)) return undefined
    // Literal control characters likewise have no honest text form.
    if (ch.codePointAt(0)! < 0x20) return undefined
    out += ch
  }
  return out.length > 0 ? out : undefined
}

/**
 * The fixed string(s) a regex matches — the terminal its author actually wrote —
 * or `undefined` when the pattern has real structure. Handles the three shapes
 * that spell a keyword: a bare literal, a literal guarded by a trailing word
 * boundary (`word()` / `keywords()` and every hand-written copy of them), and a
 * `\b…\b`-anchored word.
 */
export function fixedStringsOfRegex(source: string): string[] | undefined {
  let src = source
  // `\b` anchors assert a boundary, exactly like the `(?![…])` guard.
  if (src.startsWith('\\b')) src = src.slice(2)
  if (src.endsWith('\\b') && !src.endsWith('\\\\b')) src = src.slice(0, -2)

  const g = trailingGroupStart(src)
  if (g >= 0 && BOUNDARY_GUARD.test(src.slice(g))) src = src.slice(0, g)

  // `keywords()` compiles to `(?:a|b|c)` plus the guard; unwrap that hull.
  const outer = trailingGroupStart(src)
  if (outer === 0 && src.startsWith('(?:')) src = src.slice(3, -1)

  const alts = topLevelAlternatives(src)
  const out: string[] = []
  for (const alt of alts) {
    const fixed = fixedString(alt)
    if (fixed === undefined) return undefined
    out.push(fixed)
  }
  return out.length > 0 ? out : undefined
}

class Builder {
  private seen = new Set<string>()
  /** Combinators on the CURRENT walk path — the anonymous-cycle guard. */
  private walking = new Set<Combinator<unknown>>()
  private pending: Array<{ name: string; comb: Combinator<unknown> }> = []
  private pendingNames = new Set<string>()
  private record: Record<string, Combinator<unknown>>
  private opts: SpecOptions
  productions: Production[] = []

  constructor(record: Record<string, Combinator<unknown>>, opts: SpecOptions) {
    this.record = record
    this.opts = opts
  }

  enqueue(name: string, comb: Combinator<unknown>): void {
    if (this.seen.has(name)) return
    if (this.pendingNames.has(name)) return
    this.pendingNames.add(name)
    this.pending.push({ name, comb })
  }

  /**
   * Seed and drain in phases. Each phase seeds its names, then BFS-drains the
   * queue (following references) before the next phase seeds. This lets callers
   * express "entry first, then its reachable closure, then any leftovers" by
   * splitting the seed across phases; a single phase with every rule yields plain
   * declaration order (references, already queued, keep their declared slot).
   */
  run(phases: string[][]): SpecModel {
    for (const phase of phases) {
      for (const name of phase) {
        const comb = this.record[name]
        if (comb) this.enqueue(name, comb)
      }
      this.drain()
    }
    return { productions: this.productions }
  }

  private drain(): void {
    while (this.pending.length > 0) {
      const { name, comb } = this.pending.shift()!
      this.pendingNames.delete(name)
      if (this.seen.has(name)) continue
      this.seen.add(name)
      const expr = this.ruleBody(comb, name)
      this.productions.push({ name, expr, trivia: comb._meta.isTrivia === true })
    }
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

    // A balanced() is a delimiter scan, so render the delimiters and mark the
    // interior opaque — see `BalancedMarked`. Checked before the cycle guard
    // because it is the honest rendering, not merely a way to terminate.
    const bal = (c as BalancedMarked)._balanced
    if (bal !== undefined) {
      return {
        kind: 'seq',
        items: [
          { kind: 'terminal', text: bal.open, literal: true },
          { kind: 'annotation', text: 'balanced …' },
          { kind: 'terminal', text: bal.close, literal: true },
        ],
      }
    }

    // CYCLE CUT ON OBJECT IDENTITY.
    //
    // The walk used to cut only at `_ruleName`, which assumes every cycle passes
    // through a named rule. A combinator whose interior refers back to ITSELF
    // through an anonymous `ref()` — what `balanced()` builds, and what any caller
    // of the public `ref()` can build — closes a cycle carrying no name, and the
    // walk went around it until the process died (RangeError at the default stack,
    // SIGSEGV at a raised one: a true cycle, not deep-but-finite recursion).
    //
    // `walking` is a PATH set, added on entry and removed on exit — not a global
    // visited set. A combinator shared by two sibling positions is real structure
    // that must be drawn twice; only a combinator that contains ITSELF is a cycle.
    if (this.walking.has(c)) return { kind: 'annotation', text: '(recursive)' }
    this.walking.add(c)
    try {
      return this.walkDef(c._def, c)
    } finally {
      this.walking.delete(c)
    }
  }

  private walkDef(def: ParserDef, self: Combinator<unknown>): SpecNode {
    switch (def.tag) {
      case 'literal':
        return { kind: 'terminal', text: def.value, literal: true }

      case 'regex': {
        // A caller-supplied display name always wins — it is the most specific
        // statement of intent available.
        const shown = this.opts.regexDisplay?.(def.source, def.flags)
        if (shown !== undefined) return { kind: 'terminal', text: shown, literal: false }
        const fixed = fixedStringsOfRegex(def.source)
        if (fixed !== undefined) return literalTerminals(fixed)
        return { kind: 'terminal', text: defaultRegexDisplay(def.source), literal: false }
      }

      case 'keywords':
        return literalTerminals(def.words)

      case 'sequence': {
        const items = def.parsers.map(p => this.walk(p)).filter(nonEmpty)
        return flattenSeq(items)
      }

      case 'choice': {
        const items = def.parsers.map(p => this.walk(p)).filter(nonEmpty)
        return flattenChoice(items)
      }

      case 'dispatch': {
        const selector = this.walk(def.selector)
        const tails = [
          ...def.cases.map(entry => this.walk(entry.parser)),
          ...(def.matchers ? def.matchers.map(entry => this.walk(entry.parser)) : []),
          ...(def.otherwise ? [this.walk(def.otherwise)] : []),
        ]
        return flattenSeq([selector, flattenChoice(tails)])
      }

      // `max`/`min` are carried through so a BOUNDED repeat does not render as an
      // unbounded one — the spec is generated to be read as the truth about what
      // parses, and `many(x, { min: 3, max: 8 })` is not `x+`.
      case 'many':
        return { kind: 'star', item: this.walk(def.parser), ...(def.max === undefined ? {} : { max: def.max }) }
      case 'oneOrMore':
        return {
          kind: 'plus', item: this.walk(def.parser),
          ...(def.min === 1 ? {} : { min: def.min }),
          ...(def.max === undefined ? {} : { max: def.max }),
        }
      case 'optional':
        return { kind: 'opt', item: this.walk(def.parser) }
      case 'attempt':
        return this.walk(def.parser)
      case 'sepBy':
        return {
          kind: 'sepBy', item: this.walk(def.parser), sep: this.walk(def.separator), min: def.min,
          ...(def.max === undefined ? {} : { max: def.max }),
          ...(def.trailing === undefined ? {} : { trailing: def.trailing }),
        }

      case 'not':
        return { kind: 'not', item: this.walk(def.parser) }
      case 'peek':
        return { kind: 'peek', item: this.walk(def.parser) }
      case 'routed':
        // The routed token is spelled by the dispatch selector, so it contributes
        // nothing here; a fallback IS spelled in place, so render it.
        return def.fallback === undefined ? { kind: 'empty' } : this.walk(def.fallback)

      // Transparent semantic wrappers — render the inner syntax.
      case 'transform':
      case 'token':
      case 'leaf':
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

      // Zero-width, but — unlike a state guard — it is a statement ABOUT THE SOURCE
      // TEXT, so a grammar spec that elided it would document a different language.
      case 'adjacency':
        return { kind: 'annotation', text: def.polarity === 'adjacent' ? '(adjacent)' : def.kinds ? `(separated: ${def.kinds.join('|')})` : '(separated)' }

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

/**
 * One or more fixed strings as terminal node(s). A ONE-word set is a terminal,
 * not a one-arm alternation: `word('@import')` used to render `("@import")`,
 * and drew a branch box in the diagram, purely because a keyword set is
 * internally a set. That paren and that box are emitter artifacts — there is no
 * alternative to choose between.
 */
function literalTerminals(words: readonly string[]): SpecNode {
  const items = words.map(w => ({ kind: 'terminal', text: w, literal: true }) as SpecNode)
  return flattenChoice(items)
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
  // A `compose()` result is a map of FUSED rule FUNCTIONS, not combinators — walking
  // it read `_def` off a function and threw a bare `TypeError: Cannot read properties
  // of undefined (reading 'tag')`. The combinator graph is recoverable from the
  // carried IR, so recover it rather than fail. (Same recovery the gating analysis
  // uses — see `recoverComposedRules`.)
  const recovered = recoverComposedRules(grammar as Record<string, unknown>)
  if (recovered !== undefined) {
    if (recovered.opaque.length > 0) {
      // Fail LOUDLY and specifically. A partial spec is worse than none: it renders a
      // grammar that looks complete while silently omitting whole artifacts.
      const named = recovered.opaque.map(o => `"${o.ns}"${o.ruleNames.length > 0 ? ` (${o.ruleNames.length} rule(s))` : ''}`).join(', ')
      throw new TypeError(
        `parseman spec: this composed grammar includes opaque precompiled artifact(s) ${named} that carry compiled rule `
        + 'functions rather than re-lowerable IR. Their rules cannot be rendered, and emitting a spec without them would '
        + 'silently understate the grammar. Recompile the contributing grammar(s) so they carry IR.',
      )
    }
    return Object.fromEntries(recovered.rules)
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

/** Declaration order recorded by `rules()`; falls back to the record's key order. */
function declarationOrder(record: Record<string, Combinator<unknown>>): string[] {
  const declared = (record as Record<string, unknown>)[RULE_ORDER]
  if (Array.isArray(declared)) return declared.filter(k => k in record)
  return Object.keys(record)
}

/**
 * Build the notation-agnostic spec model from a `rules()` grammar (or a single
 * combinator). Following every referenced named rule keeps the closure complete;
 * ordering is controlled by `order` / `root` / `sort` (see {@link SpecOptions}).
 */
export function buildSpecModel(grammar: GrammarInput, options: SpecOptions = {}): SpecModel {
  const record = toRecord(grammar)
  const decl = declarationOrder(record)

  // Validate rule names in `order` / `root` up front. Left unchecked, an unknown
  // name (or a stray string like `order: 'source'` where a `string[]` is meant)
  // seeds a phase that reaches nothing and silently yields an EMPTY model — a
  // confusing footgun. Fail loudly with the offending names and the known rules.
  const known = new Set(decl)
  const asList = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v])
  const requireKnown = (names: string[], opt: string): void => {
    const bad = names.filter(n => !known.has(n))
    if (bad.length > 0) {
      throw new Error(
        `buildSpecModel: unknown rule name(s) in \`${opt}\`: ${bad.map(n => JSON.stringify(n)).join(', ')}. ` +
        `Known rules: ${decl.map(n => JSON.stringify(n)).join(', ')}.`,
      )
    }
  }

  // Seed phases (see Builder.run). Priority: explicit `order` > `root` (pruned) >
  // `sort`. Default `sort` = 'source' (declaration order, every rule).
  let phases: string[][]
  if (options.order !== undefined) {
    const order = asList(options.order as string | string[])
    requireKnown(order, 'order')
    phases = [order]
  } else if (options.root !== undefined) {
    const root = asList(options.root)
    requireKnown(root, 'root')
    phases = [root]
  } else if (options.sort === 'reachable') {
    // Entry (first-declared) leads; BFS discovers the rest in first-reference
    // order; unreachable rules trail in declaration order.
    phases = decl.length > 0 ? [[decl[0]!], decl.slice(1)] : [decl]
  } else {
    phases = [decl]
  }

  const model = new Builder({ ...record }, options).run(phases)
  if (!options.includeTrivia) {
    model.productions = model.productions.filter(p => !p.trivia)
  }
  return model
}
