/**
 * Static grammar-duplication / overlap / rewrite diagnostic.
 *
 * A parseman grammar is a COMBINATOR TREE, not source text — so the question
 * "did I write this production twice?" is a structural one a machine answers
 * exactly, and a reviewer answers badly. A few hundred productions is tens of
 * thousands of pairs; nobody reads that. This module walks the same tree
 * `analyzeGating` walks and reports eight families:
 *
 *   1. `duplicates`     — subtrees that are structurally IDENTICAL, in ≥2 places.
 *   2. `nearDuplicates` — subtrees identical except at ONE slot. This is the
 *                          high-value case: a general rule cloned with one term
 *                          swapped, where the fix is one production whose varying
 *                          slot is a `choice`, not N copies of the scaffolding.
 *   3. `regexFragments` — alternation runs re-spelled across several `regex()`
 *                          terminals. Structural hashing cannot see inside a
 *                          regex, so this is its own pass.
 *   4. `regexClasses`   — character classes re-spelled across terminals, and, more
 *                          usefully, NEAR-identical ones with the drift shown side
 *                          by side.
 *   5. `overlaps`       — `choice` arms whose first-sets intersect, reported as
 *                          "these two arms, on these chars, sharing these leading
 *                          terms" rather than gating's "dispatch failed".
 *   6. `rewrites`       — ALGEBRAIC simplifications: mechanically-derived exact
 *                          rewrites (`choice(sequence(A,B), B)` → `sequence(
 *                          optional(A), B)`), plus the dead-arm cases that are
 *                          outright bugs.
 *   7. `divergentNodes` — ONE `node()` type built by several structurally different
 *                          productions that are nonetheless variants of one shape.
 *   8. `keywordRegexes` — hand-rolled keyword regexes (`regex(/not(?![-\w])/i)`)
 *                          that should be `word()`/`keywords()`. Not a style note:
 *                          `/i` without `/u` gets non-ASCII case folding wrong,
 *                          and the fix that lives inside `keywords()` (see
 *                          `combinators/case-fold.ts`) never reached the copies.
 *
 * ## What this CANNOT see
 *
 * Structural hashing is exactly that: STRUCTURAL. Two productions that accept the
 * same language but are shaped differently — `many(x)` vs `optional(oneOrMore(x))`,
 * a `regex` spelling of what another rule builds from combinators, a rule inlined
 * once and referenced once — are invisible to `duplicates`/`nearDuplicates` unless
 * they happen to fall into the `rewrites` algebra below. Equally, two subtrees that
 * differ only in a `transform`/`node` CALLBACK are reported as distinct when the
 * callbacks' source text differs, even if the functions are equivalent. This finds
 * COPY-PASTE and mechanical redundancy. It does not find semantic redundancy, and a
 * clean report is not a proof that a grammar has none.
 *
 * `analyzeDuplication()` / `analyzeDuplicationRules()` are the programmatic
 * surface, mirroring `analyzeGating` / `analyzeGatingRules`. The compile-time
 * wiring is OPT-IN (`compile(g, { duplication: 'warn' })` /
 * `PARSEMAN_DUPLICATION=warn`) and runs on ALL THREE lowering paths — `compile`,
 * `compileRuleMap` and `compileLinkable` — because the macro build takes the
 * latter two and a diagnostic that only runs on the first is a diagnostic that
 * reports zero findings forever.
 */
import type { Combinator, FirstSet, ParserDef } from '../types.ts'
import { firstSetOf, type RefResolver } from '../combinators/first-set.ts'
import { firstSetToString } from './gating.ts'

// ── public shapes ────────────────────────────────────────────────────────────

/** Where a combinator sits: its owning rule, and the accessor path within it. */
export type Site = {
  /** Nearest enclosing `_ruleName`, or the seed name it was reached under. */
  rule: string
  /** Structural path inside that rule, e.g. `choice[0] › node(Declaration) › seq[4]`. */
  path: string
}

export const siteToString = (s: Site): string => (s.path === '' ? s.rule : `${s.rule} › ${s.path}`)

/** N structurally identical copies of one subtree. */
export type DuplicateFinding = {
  kind: 'exact-duplicate'
  id: string
  /** Node count of the repeated subtree. */
  size: number
  /** How many DISTINCT combinator instances share the shape (shared-by-reference
   *  reuse is not duplication and is never counted here). */
  count: number
  /** Nodes removed by hoisting the shape to one shared const: `(count - 1) * size`. */
  savings: number
  /** One-line rendering of the repeated shape. */
  shape: string
  sites: Site[]
  suggestion: string
}

/** N subtrees identical except at ONE slot. */
export type NearDuplicateFinding = {
  kind: 'near-duplicate'
  id: string
  /** Node count shared by every member (the scaffolding). */
  sharedSize: number
  count: number
  savings: number
  /** The scaffolding with the varying slot rendered as `‹slot›`. */
  shape: string
  /** Path to the varying slot, relative to the members' root. */
  slotPath: string
  /** What each member puts in that slot, aligned with `sites`. */
  variants: string[]
  sites: Site[]
  suggestion: string
}

/** An alternation run re-spelled across several `regex()` terminals. */
export type RegexFragmentFinding = {
  kind: 'regex-fragment'
  id: string
  /** The shared run, as it appears in the sources (`>=|<=|=>|=<|=~|[<>=]`). */
  fragment: string
  /** Number of alternation branches in the run. */
  branches: number
  count: number
  /** Characters removed by hoisting: `(count - 1) * fragment.length`. */
  savings: number
  /** The full source of each regex that carries it, aligned with `sites`. */
  sources: string[]
  sites: Site[]
  suggestion: string
}

/** One spelling of a character class, and where it appears. */
export type RegexClassVariant = {
  /** The class as written, including any `^`: `-_a-zA-Z0-9-￿`. */
  source: string
  /** Members this spelling has that the cluster's most common spelling does not,
   *  and vice versa — the DRIFT, rendered `+a-f / -0-9`. */
  delta: string
  count: number
  sites: Site[]
}

/**
 * A character class (or boundary lookahead class) re-spelled across several
 * `regex()` terminals — and, when the spellings are not identical, the drift
 * between them.
 */
export type RegexClassFinding = {
  kind: 'regex-class'
  id: string
  /** The cluster's most common spelling. */
  canonical: string
  /** Every spelling in the cluster, most common first. Two variants side by side
   *  IS the finding: one of them is wrong and reading cannot tell you which. */
  variants: RegexClassVariant[]
  /** Distinct `regex()` terminals across the whole cluster. */
  count: number
  /** True when the cluster holds more than one spelling. */
  drifted: boolean
  /** The class's highest code point is U+FFFF and it was written as an explicit
   *  range — astral-plane characters fall outside it. */
  bmpCeiling: boolean
  suggestion: string
}

/** Two arms of one `choice` whose first-sets intersect. */
export type ArmOverlapFinding = {
  kind: 'arm-overlap'
  id: string
  site: Site
  a: number
  b: number
  /** The SHARED first characters (not the union). */
  on: FirstSet
  /** How many leading terms the two arms spell identically. */
  sharedLeadingTerms: number
  /** Rendering of those shared leading terms, when there are any. */
  sharedPrefix: string | null
  /** True when parseman's `sharedPrefix` choice strategy already recognizes the
   *  common prefix once at runtime — the finding is then about READABILITY, not
   *  speed. */
  handledByStrategy: boolean
  /** Both arms lead with a `regex()` whose character classes intersect — usually
   *  a sign the two arms want to be one terminal. */
  regexPair: boolean
  suggestion: string
}

export type RewriteKind =
  | 'optional-prefix'      // choice(sequence(A, R…), sequence(R…)) → sequence(optional(A), R…)
  | 'optional-suffix'      // choice(sequence(R…, A), sequence(R…)) → sequence(R…, optional(A))
  | 'left-factor'          // choice(sequence(A, B…), sequence(A, C…)) → sequence(A, choice(B…, C…))
  | 'hand-rolled-sepby'    // sequence(X, many(sequence(S, X))) → sepBy(X, S)
  | 'idempotent-nesting'   // optional(optional(X)), many(many(X)), …
  | 'single-element'       // choice(X) / sequence(X)
  | 'duplicate-arm'        // choice(…, X, …, X, …) — the later arm is dead
  | 'shadowed-arm'         // choice(…, X, …, sequence(X, …), …) — the later arm is dead

/** A mechanically-derived rewrite. */
export type RewriteFinding = {
  kind: 'rewrite'
  id: string
  rewrite: RewriteKind
  site: Site
  /** What is there now. */
  from: string
  /** What it is equal to. */
  to: string
  /**
   * `true` only when the rewrite provably cannot move the parse VALUE — which,
   * here, means it only deletes an arm that can never be selected. Every other
   * rewrite in this family changes the child arity or nesting of the value the
   * site produces, so a `node()` build / `transform` / downstream consumer that
   * reads positionally WILL see a different tree. Those are reported as
   * CANDIDATES to verify, never as "fix this".
   */
  astNeutral: boolean
  /** Non-empty when the rewrite removes speculative work at parse time. */
  perf: string
  /** Only on `hand-rolled-sepby`: whether this SITE can actually take `sepBy`. A
   *  count of matches is not a worklist — in a real grammar most matches are
   *  blocked, and reporting them all as convertible generates false work. */
  sepByVerdict?: SepByVerdict
  /** True when this is a latent BUG (an unreachable arm), not a verbosity smell. */
  bug: boolean
  suggestion: string
}

/**
 * One AST node type built by two or more STRUCTURALLY DIFFERENT productions that
 * are nonetheless variants of a single shape (they spell several of the same
 * terms). This is the clone family near-duplicate detection cannot see: the copies
 * diverge in more than one slot — extra scaffolding, a hand-rolled whitespace run,
 * a terminal guard — so no single hole explains them, yet every edit to "the
 * declaration shape" still has to land in all of them, and nothing checks that it did.
 */
export type DivergentNodeFinding = {
  kind: 'divergent-node'
  id: string
  /** The `node()` type every member produces. */
  nodeType: string
  /** Number of structurally distinct productions building it. */
  count: number
  /** Terms every member spells identically — the evidence they are one shape. */
  sharedTerms: string[]
  productions: {
    shape: string
    site: Site
    /** Terms this production has that at least one sibling does not. */
    distinctTerms: string[]
  }[]
  suggestion: string
}

/** A `regex()` that hand-rolls a keyword + word boundary. */
export type KeywordRegexFinding = {
  kind: 'keyword-regex'
  id: string
  site: Site
  source: string
  flags: string
  words: string[]
  /** The boundary character class, as a `word()`/`keywords()` `boundary` argument.
   *  `null` when the regex enumerates a vocabulary with no guard at all. */
  boundary: string | null
  /** `/i` without `/u`: the fold class is NOT `{c, upper(c), lower(c)}`. */
  caseFoldRisk: boolean
  /** Sibling arm indices in the same `choice` that are also hand-rolled keywords. */
  siblingArms: number[]
  /**
   * >= 3 literal alternatives: a fixed VOCABULARY enumerated by hand rather than a
   * keyword with a guard. The interesting sub-case, because ordering starts to matter
   * and the list is usually long enough that nobody re-reads it.
   */
  vocabulary: boolean
  /**
   * Alternatives are in non-increasing length order. `keywords()` sorts longest-first
   * by construction; a hand-written alternation does not, and nothing checks it.
   */
  longestFirst: boolean
  /**
   * Earlier alternatives that are strict PREFIXES of later ones. Regex alternation is
   * first-match, so the longer branch is reachable only when a trailing boundary guard
   * rejects the following character and forces a backtrack (`rescuedByBoundary`).
   */
  hazards: { shorter: string; longer: string; at: string; rescuedByBoundary: boolean }[]
  /**
   * At least one hazard is NOT rescued by a boundary guard — a later alternative can
   * never match. That is a live bug, not a cleanup.
   */
  bug: boolean
  suggestion: string
}

export type DuplicationReport = {
  duplicates: DuplicateFinding[]
  nearDuplicates: NearDuplicateFinding[]
  regexFragments: RegexFragmentFinding[]
  regexClasses: RegexClassFinding[]
  overlaps: ArmOverlapFinding[]
  rewrites: RewriteFinding[]
  divergentNodes: DivergentNodeFinding[]
  keywordRegexes: KeywordRegexFinding[]
  /** Ids listed in `accept` that matched no finding — stale entries to prune. */
  acceptedUnused: string[]
  stats: {
    rules: number
    /** Distinct combinator INSTANCES reached. */
    nodes: number
    /** Distinct structural shapes among them. */
    shapes: number
  }
}

export type AnalyzeDuplicationOptions = {
  /** Smallest repeated subtree worth reporting, in nodes. Default 3 — which is
   *  what keeps `optional(ws)` (2 nodes) out of the ranking. */
  minSize?: number
  /** Cap per category, applied AFTER ranking. Default 25. */
  maxFindings?: number
  /** Finding `id`s to suppress — the single per-finding acknowledgement channel,
   *  mirroring the gating snapshot allowlist. */
  accept?: Iterable<string>
  /** Bind cross-artifact `g.Foo` holes when computing first-sets for `overlaps`. */
  resolveRef?: RefResolver
  /** Name to attribute an unnamed entry to, instead of `<entry>`. */
  entryName?: string
}

// ── canonical structural hashing ─────────────────────────────────────────────

/**
 * Ordered structural children per def tag. Explicit rather than "every key that
 * holds a Combinator" because a SLOT's position is what near-duplicate detection
 * varies — a stable, meaningful order is load-bearing, not cosmetic.
 */
function childrenOf(d: ParserDef): readonly Combinator<unknown>[] {
  switch (d.tag) {
    case 'sequence': case 'choice': return d.parsers
    case 'skip': return [d.main, d.skipped]
    case 'sepBy': return [d.parser, d.separator]
    case 'recover': return [d.parser, d.sentinel]
    case 'scanTo': return [d.sentinel, ...d.skip]
    case 'grammar': return d.triviaParser ? [d.parser, d.triviaParser] : [d.parser]
    // A `lazy` is a REFERENCE, not a subtree: hashing through it would make every
    // rule's shape include the whole reachable grammar. Treated as a leaf, keyed
    // by the rule name it refers to — which is also the right semantics, since two
    // productions referencing `g.Ident` really do fill that slot the same way.
    case 'lazy': case 'literal': case 'regex': case 'keywords': case 'guard': case 'unknown':
      return []
    default: {
      const rec = d as unknown as { parser?: Combinator<unknown> }
      return rec.parser ? [rec.parser] : []
    }
  }
}

const ruleNameOf = (p: Combinator<unknown>): string | undefined =>
  (p as unknown as { _ruleName?: string })._ruleName

/** Source text of a callback, so two COPY-PASTED lambdas hash alike (identity
 *  would make every copy distinct and defeat the whole diagnostic). */
const fnKey = (src: string | undefined, fn: unknown): string =>
  src ?? (typeof fn === 'function' ? String(fn) : '')

/** The discriminating payload of a node, excluding its children. */
function payloadKey(p: Combinator<unknown>, d: ParserDef): string {
  switch (d.tag) {
    case 'literal':   return `literal ${d.value} ${d.caseInsensitive}`
    case 'regex':     return `regex ${d.source} ${d.flags}`
    case 'keywords':  return `keywords ${[...d.words].join('')} ${d.caseInsensitive} ${d.boundary ?? ''}`
    case 'lazy': {
      const n = ruleNameOf(p)
      return n === undefined ? `ref #${anonId(p)}` : `ref ${n}`
    }
    case 'label':     return `label ${d.label}`
    case 'field':     return `field ${d.name}`
    case 'node':      return `node ${d.type ?? ''} ${d.unwrap === true} ${d.collapse === true} ${fnKey(d.buildSrc, d.build)}`
    case 'transform': return `transform ${fnKey(d.fnSrc, d.fn)} ${d.recognitionOnly === true}`
    case 'leaf':      return `leaf ${fnKey(d.fnSrc, d.fn)}`
    case 'many': case 'oneOrMore': return `${d.tag} ${d.min} ${d.max ?? ''}`
    case 'sepBy':     return `sepBy ${d.min} ${d.max ?? ''} ${d.trailing ?? ''}`
    case 'expect':    return `expect ${d.label ?? ''} ${d.expected.join('')}`
    case 'scanTo':    return `scanTo ${d.raw} ${d.orEOF}`
    case 'guard':     return `guard ${fnKey(d.predSrc, d.predicate)}`
    case 'withCtx':   return `withCtx ${d.extraSrc ?? safeJson(d.extra)}`
    case 'grammar':   return `grammar ${d.clearTrivia === true} ${d.captureTrivia === true} ${d.trackLines}`
    default:          return d.tag
  }
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v) } catch { return '?' }
}

let anonCounter = 0
const anonIds = new WeakMap<object, number>()
/** Identity key for an UNNAMED unresolvable ref: nothing can bind it by name, so
 *  two of them are the same slot only when they are the same object. */
function anonId(p: object): number {
  let id = anonIds.get(p)
  if (id === undefined) { id = ++anonCounter; anonIds.set(p, id) }
  return id
}

/**
 * Interning gives EXACT structural equality with short keys: a node's key is its
 * payload plus the interned ids of its children, so equal ids ⇔ equal subtrees,
 * with no hash collisions to reason about.
 */
class Interner {
  private readonly ids = new Map<string, number>()
  readonly hole: number
  constructor() { this.hole = this.of(' HOLE ') }
  of(key: string): number {
    let id = this.ids.get(key)
    if (id === undefined) { id = this.ids.size; this.ids.set(key, id) }
    return id
  }
}

// ── rendering ────────────────────────────────────────────────────────────────

const MAX_RENDER = 160

/** A compact one-line rendering of a subtree, for the finding text. */
function render(p: Combinator<unknown>, depth = 3): string {
  const d = p._def as ParserDef
  const name = ruleNameOf(p)
  switch (d.tag) {
    case 'literal': return `literal('${d.value}')`
    case 'regex': return `regex(/${d.source}/${d.flags})`
    case 'keywords': return `keywords([${[...d.words].slice(0, 4).map(w => `'${w}'`).join(', ')}${d.words.length > 4 ? ', …' : ''}])`
    case 'lazy': return `g.${name ?? '?'}`
    case 'guard': return 'gate(…)'
    default: break
  }
  if (depth <= 0) return `${d.tag}(…)`
  const kids = childrenOf(d).map(k => render(k, depth - 1))
  switch (d.tag) {
    case 'sequence': return `sequence(${kids.join(', ')})`
    case 'choice': return `choice(${kids.join(', ')})`
    case 'node': return `node(${d.type ? `'${d.type}', ` : ''}${kids[0] ?? ''})`
    case 'label': return `label('${d.label}', ${kids[0] ?? ''})`
    case 'field': return `field('${d.name}', ${kids[0] ?? ''})`
    case 'many': return `many(${kids[0] ?? ''}${d.min === 0 && d.max === undefined ? '' : `, { min: ${d.min}${d.max === undefined ? '' : `, max: ${d.max}`} }`})`
    case 'oneOrMore': return `oneOrMore(${kids[0] ?? ''}${d.min === 1 && d.max === undefined ? '' : `, { min: ${d.min}${d.max === undefined ? '' : `, max: ${d.max}`} }`})`
    case 'sepBy': return `sepBy(${kids[0] ?? ''}, ${kids[1] ?? ''})`
    default: return `${d.tag}(${kids.join(', ')})`
  }
}

const clamp = (s: string): string => (s.length <= MAX_RENDER ? s : `${s.slice(0, MAX_RENDER - 1)}…`)

/** Path segment for a child index, used to build `Site.path` and slot paths. */
function segment(d: ParserDef, index: number): string {
  switch (d.tag) {
    case 'sequence': return `seq[${index}]`
    case 'choice': return `choice[${index}]`
    case 'node': return `node(${d.type ?? ''})`
    case 'label': return `label(${d.label})`
    case 'field': return `field(${d.name})`
    case 'sepBy': return index === 0 ? 'sepBy.item' : 'sepBy.sep'
    case 'skip': return index === 0 ? 'skip.main' : 'skip.skipped'
    case 'recover': return index === 0 ? 'recover.body' : 'recover.sentinel'
    case 'scanTo': return index === 0 ? 'scanTo.sentinel' : `scanTo.skip[${index - 1}]`
    default: return d.tag
  }
}

// ── regex source: alternation runs + keyword shape ───────────────────────────

/**
 * Every alternation branch list in a regex source, at ANY nesting depth. Depth
 * matters: `/a|b/` and `/x(?:a|b)y/` re-spell the same run, and only one of them
 * has it at top level.
 */
export function alternationGroups(src: string): string[][] {
  const out: string[][] = []
  type Frame = { branches: string[]; last: number }
  const stack: Frame[] = [{ branches: [], last: 0 }]
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '\\') { i += 2; continue }
    if (c === '[') {
      let j = i + 1
      if (src[j] === '^') j++
      if (src[j] === ']') j++
      while (j < src.length && src[j] !== ']') { if (src[j] === '\\') j++; j++ }
      i = j + 1
      continue
    }
    if (c === '(') {
      let open = i + 1
      if (src[open] === '?') {
        const rest = src.slice(open)
        const m = /^\?(?::|=|!|<=|<!|<[^>]*>)/.exec(rest)
        open += m ? m[0].length : 1
      }
      stack.push({ branches: [], last: open })
      i = open
      continue
    }
    if (c === ')') {
      const top = stack.pop()
      if (top !== undefined) {
        top.branches.push(src.slice(top.last, i))
        if (top.branches.length >= 2) out.push(top.branches)
      }
      i++
      continue
    }
    if (c === '|') {
      const top = stack[stack.length - 1]!
      top.branches.push(src.slice(top.last, i))
      top.last = i + 1
      i++
      continue
    }
    i++
  }
  const root = stack[0]!
  root.branches.push(src.slice(root.last))
  if (root.branches.length >= 2) out.push(root.branches)
  return out
}

/**
 * A LITERAL word: letters, digits, `_`, `-`, optionally vendor-prefixed. No
 * character class, no quantifier, no escape, no group — anything with regex
 * machinery in it is a pattern, not a vocabulary entry, and is left alone.
 */
const WORD_RE_SRC = '-?[A-Za-z][A-Za-z0-9_-]*'
const WORDS_RE = new RegExp(`^${WORD_RE_SRC}(?:\\|${WORD_RE_SRC})*$`)

/**
 * How many literal alternatives make a regex a VOCABULARY rather than a pattern,
 * when there is no boundary guard to mark it as a keyword. With a guard, one word
 * is already enough (`regex(/not(?![-\w])/)`); without one, two alternatives are
 * as likely to be an ordinary either/or as a keyword set, so the bar is three.
 */
const VOCABULARY_MIN_WORDS = 3

/**
 * Recognize a `regex()` that hand-rolls what `word()`/`keywords()` owns.
 *
 * TWO shapes, because they fail differently:
 *
 *  - a word (or word alternation) plus a trailing word-boundary guard —
 *    `regex(/not(?![-\w])/i)`;
 *  - a bare alternation of >= 3 literal words with NO guard — a fixed vocabulary
 *    enumerated by hand. A regex enumerating a fixed vocabulary is a keyword set
 *    written the hard way: it loses first-set gating, it hand-maintains an ordering
 *    the combinator guarantees, and with `/i` and no `/u` it inherits the non-ASCII
 *    case-folding bug `keywords()` fixes internally. The no-guard form is also where
 *    ordering is load-bearing, since nothing backtracks past a shorter match.
 *
 * Returns the words and the boundary CLASS in the exact form `word(str, boundary)` /
 * `keywords(words, { boundary })` take, so the suggestion names a real call rather
 * than describing one.
 */
export function keywordRegexShape(source: string): { words: string[]; boundary: string | null } | null {
  let s = source
  if (s.startsWith('^')) s = s.slice(1)
  // A leading `(?<![-\w])` is the same boundary on the other side — word()/keywords()
  // do not emit it, but its presence does not stop the body from being a keyword.
  s = s.replace(/^\(\?<!\[[^\]]+\]\)/, '')
  let boundary: string | null = null
  // Peel a trailing boundary guard.
  const tail = /(?:\(\?!\[([^\]]+)\]\)|\\b)$/.exec(s)
  if (tail !== null) {
    const cls = tail[1]
    // `(?![^-\w])` is NOT a boundary guard — a negative lookahead of a NEGATED
    // class asserts the opposite, that the next char IS in the class. The capture
    // keeps the leading `^`, so passing it on would hand `word(str, boundary)` a
    // class meaning the reverse, and `boundaryMatches` would read `^` as a literal
    // member and return the inverted verdict. `bug` is derived from unrescued
    // hazards, so that inversion can invent or hide a BUG in error mode. The shape
    // is simply not expressible as a `boundary` argument: reject it.
    if (cls !== undefined && cls.startsWith('^')) return null
    boundary = cls ?? '_0-9A-Za-z'
    s = s.slice(0, tail.index)
  }
  // Unwrap one redundant non-capturing group around the word set.
  const grouped = /^\(\?:([^()]*)\)$/.exec(s)
  if (grouped !== null) s = grouped[1]!
  if (s.endsWith('$')) s = s.slice(0, -1)
  if (!WORDS_RE.test(s)) return null
  const words = s.split('|')
  if (boundary === null && words.length < VOCABULARY_MIN_WORDS) return null
  return { words, boundary }
}

/** Does a boundary class (`-\w`, `_0-9A-Za-z`, …) match this character? */
function boundaryMatches(boundary: string, ch: string): boolean {
  const cp = ch.codePointAt(0)!
  for (const m of charClassMembers(boundary)) {
    if (m === '\\w') { if (/[A-Za-z0-9_]/.test(ch)) return true; continue }
    if (m === '\\d') { if (/[0-9]/.test(ch)) return true; continue }
    if (m === '\\s') { if (/\s/.test(ch)) return true; continue }
    const range = /^(.|\\u[0-9a-f]{4})-(.|\\u[0-9a-f]{4})$/.exec(m)
    if (range !== null) {
      const dec = (t: string): number => (t.startsWith('\\u') ? parseInt(t.slice(2), 16) : t.codePointAt(0)!)
      if (cp >= dec(range[1]!) && cp <= dec(range[2]!)) return true
      continue
    }
    if (m === ch) return true
  }
  return false
}

/**
 * Ordering hazards in a hand-written alternation: an EARLIER alternative that is a
 * strict prefix of a LATER one. Regex alternation is first-match, not longest-match,
 * so `red|redish` matches only `red` — unless a trailing boundary guard rejects the
 * character that follows, which makes the engine backtrack into the longer branch.
 *
 * That distinction is the whole point of reporting this: without a rescuing guard the
 * longer word is UNREACHABLE, which is a live bug, not a style finding. `keywords()`
 * sorts longest-first by construction and the hazard cannot exist there at all.
 */
export function keywordAlternationHazards(
  words: readonly string[],
  boundary: string | null,
): { shorter: string; longer: string; at: string; rescuedByBoundary: boolean }[] {
  const out: { shorter: string; longer: string; at: string; rescuedByBoundary: boolean }[] = []
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      const a = words[i]!, b = words[j]!
      if (a.length >= b.length || !b.startsWith(a)) continue
      const at = b[a.length]!
      out.push({ shorter: a, longer: b, at, rescuedByBoundary: boundary !== null && boundaryMatches(boundary, at) })
    }
  }
  return out
}

// ── the walk ─────────────────────────────────────────────────────────────────

export function analyzeDuplication(
  entry: Combinator<unknown>,
  opts?: AnalyzeDuplicationOptions,
): DuplicationReport {
  return analyzeDuplicationRules([[ruleNameOf(entry) ?? opts?.entryName ?? '<entry>', entry]], opts)
}

type Visited = {
  p: Combinator<unknown>
  d: ParserDef
  site: Site
  shape: number
  size: number
  /** Nearest enclosing `node()` type, if any. A rewrite under one changes the
   *  children that node's build fn sees, which is the AST-neutrality question. */
  enclosingNode: string | null
  /** An enclosing `node()`/`transform()`/`leaf()` carries a REDUCER — a callback
   *  that reads the children array. Any rewrite changing that array's length or
   *  stride changes what the callback sees. */
  enclosingReducer: boolean
}

/**
 * The analysis input is the COMBINATOR TREE — a `rules()` map, or the map handed to
 * `compileRuleMap`/`compileLinkable`. It is NOT the value `compose()` returns: that
 * is a fused, already-compiled artifact whose entries are emitted parse FUNCTIONS
 * with no `_def` to walk.
 *
 * This is checked, loudly, because the alternative failure mode is the one that
 * matters. `analyzeGating()` handed a composed artifact throws deep inside its
 * walker on the first descriptor-less node — and a diagnostic that can throw or
 * silently report zero on exactly the grammars it exists to serve is worse than no
 * diagnostic, because a clean run reads as "no findings" instead of "saw nothing".
 * Silence is not a permitted outcome here.
 */
function assertAnalyzable(ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>): void {
  for (const [name, rule] of ruleMap) {
    const def = (rule as { _def?: unknown } | null | undefined)?._def
    if (def !== null && typeof def === 'object' && typeof (def as { tag?: unknown }).tag === 'string') continue
    throw new TypeError(
      `analyzeDuplicationRules: rule '${name}' is not a combinator (no _def). ` +
      `This analysis walks the COMBINATOR TREE; the value returned by compose()/composeLeaf() is a ` +
      `fused, already-compiled artifact whose entries are parse functions. Pass the rules() map itself ` +
      `(or the map given to compileRuleMap/compileLinkable) instead — for a composed grammar, analyze ` +
      `each piece's own rules() map.`,
    )
  }
}

export function analyzeDuplicationRules(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opts?: AnalyzeDuplicationOptions,
): DuplicationReport {
  assertAnalyzable(ruleMap)
  const minSize = opts?.minSize ?? 3
  const maxFindings = opts?.maxFindings ?? 25
  const interner = new Interner()

  const shapeCache = new Map<Combinator<unknown>, number>()
  const sizeCache = new Map<Combinator<unknown>, number>()

  const shapeOf = (p: Combinator<unknown>): number => {
    const hit = shapeCache.get(p)
    if (hit !== undefined) return hit
    const d = p._def as ParserDef
    // Seed against self-reference before recursing (a `lazy` is a leaf, so a true
    // cycle cannot form here — but a defensive seed keeps a malformed def finite).
    shapeCache.set(p, interner.hole)
    const kids = childrenOf(d)
    const id = interner.of(`${payloadKey(p, d)}|${kids.map(shapeOf).join(',')}`)
    shapeCache.set(p, id)
    return id
  }
  const sizeOf = (p: Combinator<unknown>): number => {
    const hit = sizeCache.get(p)
    if (hit !== undefined) return hit
    sizeCache.set(p, 1)
    let n = 1
    for (const k of childrenOf(p._def as ParserDef)) n += sizeOf(k)
    sizeCache.set(p, n)
    return n
  }

  // ── traverse: one entry per distinct combinator INSTANCE ──
  const visited = new Map<Combinator<unknown>, Visited>()
  const visit = (p: Combinator<unknown>, rule: string, path: string, enclosingNode: string | null, enclosingReducer: boolean): void => {
    if (visited.has(p)) return
    const d = p._def as ParserDef
    const own = ruleNameOf(p)
    const here = own !== undefined && own !== rule ? { rule: own, path: '' } : { rule, path }
    visited.set(p, { p, d, site: here, shape: shapeOf(p), size: sizeOf(p), enclosingNode, enclosingReducer })
    const inner = d.tag === 'node' ? d.type ?? '(anonymous)' : enclosingNode
    const innerReducer = enclosingReducer
      || (d.tag === 'node' && (d.build !== undefined || d.buildSrc !== undefined))
      || d.tag === 'transform' || d.tag === 'leaf'
    const kids = childrenOf(d)
    kids.forEach((k, i) => {
      const seg = segment(d, i)
      visit(k, here.rule, here.path === '' ? seg : `${here.path} › ${seg}`, inner, innerReducer)
    })
    // Follow refs so a rule reachable only through one is still attributed — under
    // its OWN name, because the ref carries `_ruleName`.
    if (d.tag === 'lazy') {
      try {
        const target = (d as { thunk(): Combinator<unknown> }).thunk()
        visit(target, ruleNameOf(target) ?? ruleNameOf(p) ?? here.rule, '', null, false)
      } catch { /* unresolved cross-artifact hole */ }
    }
  }
  for (const [name, root] of ruleMap) visit(root, ruleNameOf(root) ?? name, '', null, false)

  const accept = new Set(opts?.accept ?? [])
  const used = new Set<string>()
  const keep = <T extends { id: string }>(f: T): boolean => {
    if (!accept.has(f.id)) return true
    used.add(f.id)
    return false
  }

  const duplicates = findExactDuplicates(visited, minSize)
  const nearDuplicates = findNearDuplicates(visited, interner, shapeOf, minSize)
  const regexFragments = findRegexFragments(visited)
  const regexClasses = findRegexClasses(visited)
  const overlaps = findOverlaps(visited, shapeOf, opts?.resolveRef)
  const rewrites = findRewrites(visited, shapeOf)
  const divergentNodes = findDivergentNodes(visited, shapeOf)
  const keywordRegexes = findKeywordRegexes(visited)

  // Subsumption, WITHIN each category: a 40-node clone family otherwise reports
  // once at its root and again at every internal node, since each of those is
  // repeated exactly as often. Deliberately NOT applied across categories — a
  // near-duplicate family and an exact duplicate inside it are two different facts
  // about the same code, and suppressing the second because the first happens to
  // rank higher hides a real repetition behind a maybe-refactor.
  const subsume = <T extends { id: string; savings: number; _members: Combinator<unknown>[] }>(fs: T[]): Set<string> => {
    const covered = new Set<Combinator<unknown>>()
    const surviving = new Set<string>()
    for (const f of [...fs].sort((a, b) => b.savings - a.savings)) {
      if (f._members.every(m => covered.has(m))) continue
      surviving.add(f.id)
      for (const m of f._members) markSubtree(m, covered)
    }
    return surviving
  }
  const survivingExact = subsume(duplicates)
  const survivingNear = subsume(nearDuplicates)

  const report: DuplicationReport = {
    duplicates: duplicates.filter(f => survivingExact.has(f.id)).filter(keep).slice(0, maxFindings).map(stripMembers),
    nearDuplicates: nearDuplicates.filter(f => survivingNear.has(f.id)).filter(keep).slice(0, maxFindings).map(stripMembers),
    regexFragments: regexFragments.filter(keep).slice(0, maxFindings),
    regexClasses: regexClasses.filter(keep).slice(0, maxFindings),
    overlaps: overlaps.filter(keep).slice(0, maxFindings),
    rewrites: rewrites.filter(keep).slice(0, maxFindings),
    divergentNodes: divergentNodes.filter(keep).slice(0, maxFindings),
    keywordRegexes: keywordRegexes.filter(keep).slice(0, maxFindings),
    acceptedUnused: [...accept].filter(id => !used.has(id)),
    stats: { rules: ruleMap.length, nodes: visited.size, shapes: new Set([...visited.values()].map(v => v.shape)).size },
  }
  return report
}

function markSubtree(p: Combinator<unknown>, into: Set<Combinator<unknown>>): void {
  if (into.has(p)) return
  into.add(p)
  for (const k of childrenOf(p._def as ParserDef)) markSubtree(k, into)
}

type WithMembers<T> = T & { _members: Combinator<unknown>[] }
const stripMembers = <T extends object>(f: WithMembers<T>): T => {
  const { _members, ...rest } = f
  void _members
  return rest as T
}

// ── 1. exact duplicates ──────────────────────────────────────────────────────

function findExactDuplicates(
  visited: Map<Combinator<unknown>, Visited>,
  minSize: number,
): WithMembers<DuplicateFinding>[] {
  const byShape = new Map<number, Visited[]>()
  for (const v of visited.values()) {
    if (v.size < minSize) continue
    const list = byShape.get(v.shape)
    if (list === undefined) byShape.set(v.shape, [v]); else list.push(v)
  }
  const out: WithMembers<DuplicateFinding>[] = []
  for (const group of byShape.values()) {
    if (group.length < 2) continue
    const size = group[0]!.size
    out.push({
      kind: 'exact-duplicate',
      id: `exact-duplicate:${siteToString(group[0]!.site)}`,
      size,
      count: group.length,
      savings: (group.length - 1) * size,
      shape: clamp(render(group[0]!.p)),
      sites: group.map(g => g.site),
      suggestion: `${group.length} DISTINCT instances build this identical ${size}-node shape. Bind it to one const and reference that — hoisting removes ${(group.length - 1) * size} nodes and makes a future edit land in one place instead of ${group.length}.`,
      _members: group.map(g => g.p),
    })
  }
  return out.sort((a, b) => b.savings - a.savings)
}

// ── 2. near duplicates (identical but for one slot) ──────────────────────────

/**
 * "Same shape, one differing slot" is decided by HOLE KEYS: the key of a subtree
 * with one descendant position blanked. Two subtrees that differ at exactly one
 * position share exactly the hole key that blanks it, so grouping by hole key and
 * keeping the groups whose members' full shapes DIFFER is precisely the family.
 *
 * The root hole is excluded — blanking the root makes every subtree in the grammar
 * a "near duplicate" of every other.
 */
function findNearDuplicates(
  visited: Map<Combinator<unknown>, Visited>,
  interner: Interner,
  shapeOf: (p: Combinator<unknown>) => number,
  minSize: number,
): WithMembers<NearDuplicateFinding>[] {
  const holeCache = new Map<Combinator<unknown>, number[]>()
  const holesOf = (p: Combinator<unknown>): number[] => {
    const hit = holeCache.get(p)
    if (hit !== undefined) return hit
    holeCache.set(p, [])
    const d = p._def as ParserDef
    const kids = childrenOf(d)
    const kidShapes = kids.map(shapeOf)
    const payload = payloadKey(p, d)
    const out: number[] = []
    kids.forEach((k, i) => {
      for (const inner of [interner.hole, ...holesOf(k)]) {
        const arr = kidShapes.slice()
        arr[i] = inner
        out.push(interner.of(`${payload}|${arr.join(',')}`))
      }
    })
    holeCache.set(p, out)
    return out
  }

  const byHole = new Map<number, Visited[]>()
  for (const v of visited.values()) {
    if (v.size < minSize) continue
    for (const h of holesOf(v.p)) {
      const list = byHole.get(h)
      if (list === undefined) byHole.set(h, [v]); else list.push(v)
    }
  }

  const out: WithMembers<NearDuplicateFinding>[] = []
  const seenGroups = new Set<string>()
  for (const group of byHole.values()) {
    if (group.length < 2) continue
    // Exact duplicates share every hole key — they are the OTHER family.
    const shapes = new Set(group.map(g => g.shape))
    if (shapes.size < 2) continue
    // One representative per distinct shape: N copies of variant A and M of variant
    // B is one clone family with two variants, not N×M findings.
    const perShape = new Map<number, Visited>()
    for (const g of group) if (!perShape.has(g.shape)) perShape.set(g.shape, g)
    const members = [...perShape.values()]
    const key = members.map(m => m.shape).sort((a, b) => a - b).join(',')
    if (seenGroups.has(key)) continue
    seenGroups.add(key)
    const slot = findDivergentSlot(members.map(m => m.p), shapeOf)
    if (slot === null) continue
    const sharedSize = Math.min(...members.map(m => m.size)) - slot.slotSize
    if (sharedSize < minSize) continue
    out.push({
      kind: 'near-duplicate',
      id: `near-duplicate:${siteToString(members[0]!.site)}`,
      sharedSize,
      count: members.length,
      savings: (members.length - 1) * sharedSize,
      shape: clamp(renderWithHole(members[0]!.p, slot.path)),
      slotPath: slot.path.map((i, k) => segment(slot.defs[k]!, i)).join(' › '),
      variants: slot.variants.map(v => clamp(render(v))),
      sites: members.map(m => m.site),
      suggestion: `${members.length} productions share this ${sharedSize}-node scaffolding and differ ONLY at \`${slot.path.map((i, k) => segment(slot.defs[k]!, i)).join(' › ')}\`. That is one production whose varying slot is a \`choice(${slot.variants.map(v => clamp(render(v, 1))).join(', ')})\` — not ${members.length} copies of the scaffolding. Re-check the AST: a single production emits one node type where the clones may emit several.`,
      _members: members.map(m => m.p),
    })
  }
  return out.sort((a, b) => b.savings - a.savings)
}

/** The single child position at which the given subtrees diverge, if there is one. */
function findDivergentSlot(
  members: readonly Combinator<unknown>[],
  shapeOf: (p: Combinator<unknown>) => number,
): { path: number[]; defs: ParserDef[]; variants: Combinator<unknown>[]; slotSize: number } | null {
  const path: number[] = []
  const defs: ParserDef[] = []
  let cur = [...members]
  for (let guard = 0; guard < 64; guard++) {
    const d0 = cur[0]!._def as ParserDef
    const kidLists = cur.map(c => childrenOf(c._def as ParserDef))
    const arity = kidLists[0]!.length
    if (kidLists.some(k => k.length !== arity) || arity === 0) break
    const diff: number[] = []
    for (let i = 0; i < arity; i++) {
      const s = shapeOf(kidLists[0]![i]!)
      if (kidLists.some(k => shapeOf(k[i]!) !== s)) diff.push(i)
    }
    if (diff.length !== 1) break
    const i = diff[0]!
    path.push(i)
    defs.push(d0)
    cur = kidLists.map(k => k[i]!)
    // Descend while the divergence is still a single slot; stop when the subtrees
    // are wholly different (that IS the varying slot).
    const nextArity = childrenOf(cur[0]!._def as ParserDef).length
    const samePayload = cur.every(c => payloadKey(c, c._def as ParserDef) === payloadKey(cur[0]!, cur[0]!._def as ParserDef))
    if (!samePayload || nextArity === 0) break
  }
  if (path.length === 0) return null
  let slotSize = 0
  const sizeOf = (p: Combinator<unknown>): number => {
    let n = 1
    for (const k of childrenOf(p._def as ParserDef)) n += sizeOf(k)
    return n
  }
  for (const c of cur) slotSize = Math.max(slotSize, sizeOf(c))
  return { path, defs, variants: cur, slotSize }
}

function renderWithHole(p: Combinator<unknown>, path: readonly number[], depth = 0): string {
  if (depth === path.length) return '\u2039slot\u203a'
  const d = p._def as ParserDef
  const kids = childrenOf(d)
  const idx = path[depth]!
  const parts = kids.map((k, i) => (i === idx ? renderWithHole(k, path, depth + 1) : render(k, 2)))
  switch (d.tag) {
    case 'sequence': return `sequence(${parts.join(', ')})`
    case 'choice': return `choice(${parts.join(', ')})`
    case 'node': return `node(${d.type ? `'${d.type}', ` : ''}${parts[0] ?? ''})`
    default: return `${d.tag}(${parts.join(', ')})`
  }
}

// ── 3. regex alternation fragments ───────────────────────────────────────────

/** Longest contiguous branch window compared across regexes. Windows shorter than
 *  the true maximal shared run are dropped by the containment pass below, so this
 *  only has to be long enough to REACH the maximal run — a whole shared alternation
 *  list is additionally offered as one candidate, however long it is. */
const MAX_RUN = 32

function findRegexFragments(visited: Map<Combinator<unknown>, Visited>): RegexFragmentFinding[] {
  type Occurrence = { site: Site; source: string }
  const byRun = new Map<string, { occ: Occurrence[]; nodes: Set<Combinator<unknown>>; branches: number }>()
  for (const v of visited.values()) {
    const d = v.d
    if (d.tag !== 'regex') continue
    const runs = new Set<string>()
    for (const branches of alternationGroups(d.source)) {
      if (branches.length >= 2) runs.add(branches.join('|'))
      for (let i = 0; i < branches.length; i++) {
        for (let n = 2; n <= Math.min(MAX_RUN, branches.length - i); n++) {
          const run = branches.slice(i, i + n).join('|')
          if (run.length < 4) continue
          runs.add(run)
        }
      }
    }
    for (const run of runs) {
      let e = byRun.get(run)
      if (e === undefined) { e = { occ: [], nodes: new Set(), branches: run.split('|').length }; byRun.set(run, e) }
      if (e.nodes.has(v.p)) continue
      e.nodes.add(v.p)
      e.occ.push({ site: v.site, source: d.source })
    }
  }
  const candidates = [...byRun.entries()]
    .filter(([, e]) => e.occ.length >= 2)
    .map(([run, e]) => ({ run, e, savings: (e.occ.length - 1) * run.length }))
    // COUNT first: "re-spelled in 7 terminals" is the headline — it is the number
    // of places an edit has to land, and the number of chances for one of them to
    // drift. Length only breaks ties.
    .sort((a, b) => b.e.occ.length - a.e.occ.length || b.savings - a.savings || b.run.length - a.run.length)

  // Keep only MAXIMAL runs: a 6-branch run that occurs 7× makes its own 5-branch
  // sub-runs (also 7×) noise.
  const kept: typeof candidates = []
  for (const c of candidates) {
    if (kept.some(k => k.e.occ.length >= c.e.occ.length && (`|${k.run}|`).includes(`|${c.run}|`))) continue
    kept.push(c)
  }
  return kept.map(({ run, e }) => ({
    kind: 'regex-fragment' as const,
    id: `regex-fragment:${run}`,
    fragment: run,
    branches: e.branches,
    count: e.occ.length,
    savings: (e.occ.length - 1) * run.length,
    sources: e.occ.map(o => `/${o.source}/`),
    sites: e.occ.map(o => o.site),
    suggestion: `this ${e.branches}-branch alternation is re-spelled in ${e.occ.length} DISTINCT regex() terminals. Hoist it to one shared source string and interpolate it (\`new RegExp(\\\`…\\\${OP}…\\\`)\`) or lift the shared part into its own terminal — an edit to the operator set currently has to land in ${e.occ.length} places, and the analysis cannot tell you when one of them drifts.`,
  }))
}

// ── 3b. character classes across regexes (and their DRIFT) ───────────────────

/**
 * Every `[...]` in a regex source, INCLUDING the ones inside boundary lookaheads
 * (`(?![-\w])` yields `-\w`) — those are the same duplication in a different
 * costume, and the same drift risk.
 */
export function extractCharClasses(src: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '\\') { i += 2; continue }
    if (c !== '[') { i++; continue }
    let j = i + 1
    if (src[j] === '^') j++
    if (src[j] === ']') j++
    while (j < src.length && src[j] !== ']') { if (src[j] === '\\') j++; j++ }
    out.push(src.slice(i + 1, j))
    i = j + 1
  }
  return out
}

/**
 * Split a class body into normalized MEMBERS (`a-z`, `\w`, `-`, `-￿`).
 * Non-ASCII literals are rewritten to `\uXXXX` so a class typed with a raw `￿`
 * and one typed with `￿` compare equal — otherwise the diagnostic reports
 * drift that is only an editor's.
 */
export function charClassMembers(body: string): string[] {
  const esc = (ch: string): string => {
    const cp = ch.codePointAt(0)!
    return cp >= 0x80 ? `\\u${cp.toString(16).padStart(4, '0')}` : ch
  }
  const atoms: string[] = []
  let i = 0
  while (i < body.length) {
    if (body[i] === '\\') {
      // A code-point escape and the RAW character it denotes are the same member.
      // Missing this is not cosmetic: it splits one drifting family into two
      // clusters purely by which file's author typed the escape.
      const m = /^\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/.exec(body.slice(i))
      if (m !== null) {
        const cp = parseInt(m[1] ?? m[2] ?? m[3]!, 16)
        atoms.push(cp >= 0x80 ? `\\u${cp.toString(16).padStart(4, '0')}` : String.fromCodePoint(cp))
        i += m[0].length
        continue
      }
      atoms.push(body.slice(i, i + 2)); i += 2; continue
    }
    atoms.push(esc(body[i]!)); i++
  }
  const members: string[] = []
  for (let k = 0; k < atoms.length; k++) {
    if (k + 2 < atoms.length && atoms[k + 1] === '-' && atoms[k + 2] !== undefined) {
      members.push(`${atoms[k]}-${atoms[k + 2]}`)
      k += 2
      continue
    }
    members.push(atoms[k]!)
  }
  return members
}

const CLASS_MIN_MEMBERS = 2

function findRegexClasses(visited: Map<Combinator<unknown>, Visited>): RegexClassFinding[] {
  type Spelling = { source: string; members: string[]; key: string; nodes: Set<Combinator<unknown>>; sites: Site[] }
  const spellings = new Map<string, Spelling>()
  for (const v of visited.values()) {
    if (v.d.tag !== 'regex') continue
    for (const body of new Set(extractCharClasses(v.d.source))) {
      const members = charClassMembers(body)
      if (members.length < CLASS_MIN_MEMBERS) continue
      const key = [...new Set(members)].sort().join('')
      let s = spellings.get(key)
      if (s === undefined) { s = { source: body, members, key, nodes: new Set(), sites: [] }; spellings.set(key, s) }
      if (s.nodes.has(v.p)) continue
      s.nodes.add(v.p)
      s.sites.push(v.site)
    }
  }

  // Cluster spellings that differ by at most `MAX_DELTA` members while sharing a
  // clear majority — that relation is what makes DRIFT visible: two classes nobody
  // can tell apart by reading, one of which is wrong.
  const MAX_DELTA = 3
  /** Members shared / members in either. Below this the two classes are simply
   *  different classes that happen to share a couple of characters — clustering
   *  them would bury the real drift under coincidence. */
  const MIN_JACCARD = 0.6
  const all = [...spellings.values()]
  const parent = all.map((_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]! } return i }
  const union = (a: number, b: number): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    // A negated class and a positive one are opposites, never drift of each other.
    if (all[i]!.members.includes('^') !== all[j]!.members.includes('^')) continue
    const A = new Set(all[i]!.members), B = new Set(all[j]!.members)
    let shared = 0
    for (const m of A) if (B.has(m)) shared++
    const delta = (A.size - shared) + (B.size - shared)
    const jaccard = shared / (shared + delta)
    if (shared >= 2 && delta > 0 && delta <= MAX_DELTA && jaccard >= MIN_JACCARD) union(i, j)
  }
  const clusters = new Map<number, number[]>()
  all.forEach((_, i) => {
    const r = find(i)
    const list = clusters.get(r)
    if (list === undefined) clusters.set(r, [i]); else list.push(i)
  })

  const out: RegexClassFinding[] = []
  for (const idxs of clusters.values()) {
    const members = idxs.map(i => all[i]!).sort((a, b) => b.nodes.size - a.nodes.size)
    const total = members.reduce((n, m) => n + m.nodes.size, 0)
    const drifted = members.length > 1
    if (!drifted && total < 2) continue
    const base = new Set(members[0]!.members)
    const variants: RegexClassVariant[] = members.map(m => {
      const mine = new Set(m.members)
      const plus = [...mine].filter(x => !base.has(x))
      const minus = [...base].filter(x => !mine.has(x))
      return {
        source: m.source,
        delta: m === members[0]
          ? '(reference)'
          : `${plus.map(p => `+\`${p}\``).join(' ')}${plus.length > 0 && minus.length > 0 ? ' ' : ''}${minus.map(p => `-\`${p}\``).join(' ')}` || '(same members, different spelling)',
        count: m.nodes.size,
        sites: m.sites,
      }
    })
    const bmpCeiling = members.some(m => m.members.some(x => x.endsWith('-\\uffff')))
    out.push({
      kind: 'regex-class',
      id: `regex-class:${members[0]!.key}`,
      canonical: members[0]!.source,
      variants,
      count: total,
      drifted,
      bmpCeiling,
      suggestion: [
        drifted
          ? `${members.length} NEARLY-identical spellings of one class, across ${total} regex() terminals. They differ by ${variants.slice(1).map(v => v.delta).join('; ')} — which is drift, not intent, unless every difference is deliberate. Two classes this close cannot be told apart by reading, so one of them is probably wrong and the tests cannot say which.`
          : `this class is re-spelled in ${total} DISTINCT regex() terminals. Extract it once — a named sub-leaf, or an interpolated source constant — so a range fix lands in one place. Re-spelling is how the near-identical variants elsewhere in this report came to exist.`,
        `Prefer the shared recognition surface where one already covers this class rather than a local extraction.`,
        bmpCeiling
          ? `The class tops out at U+FFFF, so astral-plane characters (emoji, many CJK extensions) fall OUTSIDE it. Widening the ceiling is exactly the kind of edit that has to reach every spelling.`
          : '',
        `Single-regex hygiene (duplicate class members, obscure ranges, a missing \`u\` flag) is \`eslint-plugin-regexp\`'s job and is not duplicated here — it sees one regex at a time, which is why it cannot see this.`,
      ].filter(s => s !== '').join(' '),
    })
  }
  // Drift first: an exact re-spelling is a tidy-up, a near-match is a latent bug.
  return out.sort((a, b) => Number(b.drifted) - Number(a.drifted) || b.count - a.count)
}

// ── 4. choice-arm overlap ────────────────────────────────────────────────────

function intersects(a: FirstSet, b: FirstSet): boolean {
  if (a.kind === 'any' || b.kind === 'any') return true
  if (a.kind === 'empty' || b.kind === 'empty') return false
  for (const ra of a.ranges) for (const rb of b.ranges) if (ra.lo <= rb.hi && rb.lo <= ra.hi) return true
  return false
}

function intersection(a: FirstSet, b: FirstSet): FirstSet {
  if (a.kind === 'any') return b
  if (b.kind === 'any') return a
  if (a.kind === 'empty' || b.kind === 'empty') return { kind: 'empty' }
  const ranges: { lo: number; hi: number }[] = []
  for (const ra of a.ranges) for (const rb of b.ranges) {
    const lo = Math.max(ra.lo, rb.lo)
    const hi = Math.min(ra.hi, rb.hi)
    if (lo <= hi) ranges.push({ lo, hi })
  }
  return ranges.length === 0 ? { kind: 'empty' } : { kind: 'ranges', ranges }
}

/** The arm's term list, for shared-prefix comparison (a non-sequence arm is one term). */
function termsOf(arm: Combinator<unknown>): readonly Combinator<unknown>[] {
  let cur = arm
  for (;;) {
    const d = cur._def as ParserDef
    if (d.tag === 'node' || d.tag === 'transform' || d.tag === 'label' || d.tag === 'attempt' || d.tag === 'leaf') {
      cur = (d as { parser: Combinator<unknown> }).parser
      continue
    }
    break
  }
  const d = cur._def as ParserDef
  return d.tag === 'sequence' ? d.parsers : [cur]
}

function leadingRegex(arm: Combinator<unknown>): boolean {
  const t = termsOf(arm)[0]
  return t !== undefined && (t._def as ParserDef).tag === 'regex'
}

function findOverlaps(
  visited: Map<Combinator<unknown>, Visited>,
  shapeOf: (p: Combinator<unknown>) => number,
  resolve?: RefResolver,
): ArmOverlapFinding[] {
  const out: ArmOverlapFinding[] = []
  for (const v of visited.values()) {
    const d = v.d
    if (d.tag !== 'choice') continue
    const arms = d.parsers
    const fs = arms.map(a => firstSetOf(a, new Set(), resolve))
    const strategy = d.strategy as { tag: string; members?: number[] } | undefined
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const A = fs[i]!, B = fs[j]!
        if (A.kind === 'any' || B.kind === 'any') continue   // gating's `anyArms` owns that
        if (!intersects(A, B)) continue
        const ta = termsOf(arms[i]!), tb = termsOf(arms[j]!)
        let shared = 0
        while (shared < ta.length && shared < tb.length && shapeOf(ta[shared]!) === shapeOf(tb[shared]!)) shared++
        const handled = strategy?.tag === 'sharedPrefix'
          && Array.isArray(strategy.members) && strategy.members.includes(i) && strategy.members.includes(j)
        const regexPair = leadingRegex(arms[i]!) && leadingRegex(arms[j]!)
        out.push({
          kind: 'arm-overlap',
          id: `arm-overlap:${siteToString(v.site)}:${i}-${j}`,
          site: v.site,
          a: i, b: j,
          on: intersection(A, B),
          sharedLeadingTerms: shared,
          sharedPrefix: shared > 0 ? clamp(ta.slice(0, shared).map(t => render(t, 2)).join(', ')) : null,
          handledByStrategy: handled,
          regexPair,
          suggestion: overlapSuggestion(shared, handled, regexPair),
        })
      }
    }
  }
  return out.sort((a, b) => b.sharedLeadingTerms - a.sharedLeadingTerms)
}

function overlapSuggestion(shared: number, handled: boolean, regexPair: boolean): string {
  if (shared > 0 && handled)
    return `the arms spell ${shared} identical leading term(s). parseman's \`sharedPrefix\` strategy already recognizes that prefix ONCE at runtime, so this costs nothing at parse time — it is a READABILITY finding: left-factoring into \`sequence(prefix, choice(…))\` says in the grammar what the compiler had to infer.`
  if (shared > 0)
    return `the arms spell ${shared} identical leading term(s) but do NOT qualify for the \`sharedPrefix\` strategy (it needs every arm to be a bare \`sequence\` starting with the same concrete terminal). Left-factor into \`sequence(prefix, choice(…))\` — that both removes the re-spelling and lets the inner choice dispatch on its own first char.`
  if (regexPair)
    return `two regex() arms whose character classes intersect. Nothing dispatches between them: the first is tried, and on failure the second re-scans the same position. Two regexes that can start on the same char are usually one terminal — merge them, or make the distinction explicit with a leading literal.`
  return `the arms can start on the same character, so the choice cannot dispatch between them: on those chars the first arm is entered speculatively and rolled back before the second is tried. Give the arms disjoint leading terminals, or left-factor the common part out.`
}

// ── 5. algebraic rewrites ────────────────────────────────────────────────────

const PERF_ARM = 'removes a speculative arm: on every input position reaching this choice, the deleted arm no longer costs a ctx save, a child-array push and a rollback before the surviving arm is tried. The saving scales with how often the choice is reached and how much the doomed arm consumes before failing.'
const PERF_NONE = ''

function findRewrites(
  visited: Map<Combinator<unknown>, Visited>,
  shapeOf: (p: Combinator<unknown>) => number,
): RewriteFinding[] {
  const out: RewriteFinding[] = []
  // `at` discriminates findings that a single site can produce MORE than one of.
  // Without it every `duplicate-arm`/`shadowed-arm` pair at one choice shares an
  // id, so accepting one pair silently suppresses the rest — and these are
  // `bug: true` findings that error mode is supposed to hold.
  const push = (f: Omit<RewriteFinding, 'kind' | 'id'>, at?: string): void => {
    const site = siteToString(f.site)
    out.push({ kind: 'rewrite', id: `rewrite:${f.rewrite}:${site}${at === undefined ? '' : `:${at}`}`, ...f })
  }

  for (const v of visited.values()) {
    const d = v.d
    const site = v.site

    // (a) idempotent nesting.
    if (d.tag === 'optional' || d.tag === 'many' || d.tag === 'oneOrMore') {
      const inner = (d as { parser: Combinator<unknown> }).parser
      const id = inner._def as ParserDef
      const collapsed = collapseRepeat(d, id)
      if (collapsed !== null) {
        push({
          rewrite: 'idempotent-nesting', site,
          from: clamp(render(v.p, 2)), to: collapsed,
          astNeutral: false,
          perf: 'the outer wrapper still runs its own bookkeeping (and, for `many(optional(X))`, guards a zero-width iteration on every pass) for a nullability the inner combinator already has.',
          bug: id.tag === 'optional' && d.tag === 'many',
          suggestion: `\`${clamp(render(v.p, 2))}\` is exactly \`${collapsed}\`. ${id.tag === 'optional' && d.tag === 'many' ? 'The nested form is also a zero-width-iteration hazard: the inner `optional` succeeds consuming nothing, which the repeat has to detect and break on every pass.' : ''} Candidate — verify AST identity: the collapsed form produces ONE level of array/undefined where the nested form produces two.`,
        })
      }
    }

    // (b) single-element choice/sequence.
    if ((d.tag === 'choice' || d.tag === 'sequence') && d.parsers.length === 1) {
      push({
        rewrite: 'single-element', site,
        from: clamp(render(v.p, 2)),
        to: d.tag === 'choice' ? clamp(render(d.parsers[0]!, 2)) : `${clamp(render(d.parsers[0]!, 2))} (note: sequence() of one still wraps its value in a 1-tuple)`,
        astNeutral: d.tag === 'choice',
        perf: d.tag === 'choice' ? 'a one-arm choice still emits its dispatch scaffolding.' : PERF_NONE,
        bug: false,
        suggestion: d.tag === 'choice'
          ? 'a `choice` with one arm IS that arm — the wrapper only adds dispatch scaffolding. Safe to unwrap (choice forwards its arm value unchanged).'
          : 'a `sequence` with one element only exists to build a 1-tuple. If nothing reads that tuple, drop the wrapper — CANDIDATE, verify AST identity first.',
      })
    }

    if (d.tag !== 'choice') continue
    const arms = d.parsers
    const armShapes = arms.map(shapeOf)
    const strategy = d.strategy as { tag: string; members?: number[] } | undefined

    // (c) duplicate arms — the later one is dead.
    for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
      if (armShapes[i] !== armShapes[j]) continue
      push({
        rewrite: 'duplicate-arm', site,
        from: `choice(… arm[${i}] …, arm[${j}] …)`,
        to: `delete arm[${j}]`,
        astNeutral: true,
        perf: PERF_ARM,
        bug: true,
        suggestion: `arm[${i}] and arm[${j}] are the SAME shape (\`${clamp(render(arms[i]!, 2))}\`). Under ordered choice arm[${i}] always wins, so arm[${j}] is unreachable — delete it. This is AST-neutral by construction: an arm that can never be selected contributes nothing to any parse.`,
      }, `${i}-${j}`)
    }

    // (d) shadowed arm: an earlier arm is a strict TERM-PREFIX of a later one.
    for (let i = 0; i < arms.length; i++) for (let j = 0; j < arms.length; j++) {
      if (i >= j) continue
      if (armShapes[i] === armShapes[j]) continue
      const ta = termsOf(arms[i]!), tb = termsOf(arms[j]!)
      if (ta.length === 0 || ta.length >= tb.length) continue
      let k = 0
      while (k < ta.length && shapeOf(ta[k]!) === shapeOf(tb[k]!)) k++
      if (k !== ta.length) continue
      push({
        rewrite: 'shadowed-arm', site,
        from: `choice(… arm[${i}]=${clamp(render(arms[i]!, 2))}, … arm[${j}]=${clamp(render(arms[j]!, 2))} …)`,
        to: `arm[${j}] is unreachable`,
        astNeutral: true,
        perf: PERF_ARM,
        bug: true,
        suggestion: `arm[${i}] is a strict prefix of arm[${j}] and comes FIRST. Whenever arm[${j}] would match, arm[${i}] also matches, and ordered choice commits to it — so arm[${j}] can never be selected. Either swap them (longest first) or fold arm[${j}]'s extra terms into arm[${i}] as \`optional(…)\`. Verify by hand where a \`not()\`/\`gate()\` in arm[${i}] makes its success input-dependent in a way this static check cannot see.`,
      }, `${i}-${j}`)
    }

    // (e) optional prefix / suffix — `choice(sequence(A, R…), R…)` is `sequence(optional(A), R…)`.
    for (let i = 0; i + 1 < arms.length; i++) {
      const j = i + 1
      const longer = termsOf(arms[i]!), shorter = termsOf(arms[j]!)
      const ordered = detectOptionalTerm(longer, shorter, shapeOf)
      const reversed = ordered === null ? detectOptionalTerm(shorter, longer, shapeOf) : null
      const hit = ordered ?? reversed
      if (hit === null) continue
      const nodeWrapped = v.enclosingNode ?? wrappingNodeType(arms[i]!) ?? wrappingNodeType(arms[j]!)
      const rest = hit.rest.map(t => render(t, 2)).join(', ')
      const to = hit.where === 'prefix'
        ? `sequence(optional(${render(hit.term, 2)}), ${rest})`
        : `sequence(${rest}, optional(${render(hit.term, 2)}))`
      push({
        rewrite: hit.where === 'prefix' ? 'optional-prefix' : 'optional-suffix',
        site,
        from: clamp(render(v.p, 2)),
        to: clamp(to),
        astNeutral: false,
        perf: PERF_ARM,
        bug: false,
        suggestion: `these two arms differ only by a ${hit.where === 'prefix' ? 'leading' : 'trailing'} \`${clamp(render(hit.term, 2))}\`, so the choice is exactly \`${clamp(to)}\` — same language, one arm instead of two.${reversed !== null ? ` NOTE THE ORDER: the shorter arm is FIRST, so under ordered choice the longer arm is only reachable when the shorter one fails — check that is what you meant.` : ''} CANDIDATE — verify AST identity before applying:${nodeWrapped === null ? '' : ` this sits under \`node('${nodeWrapped}')\`, and`} the two forms produce different child arrays (two children vs. one child plus an absent optional). If a build fn or a downstream consumer reads children positionally, the rewrite MOVES the tree.`,
      }, `${i}-${j}`)
    }

    // (f) left-factoring.
    for (let i = 0; i + 1 < arms.length; i++) {
      const j = i + 1
      const ta = termsOf(arms[i]!), tb = termsOf(arms[j]!)
      if (ta.length < 2 || tb.length < 2) continue
      let k = 0
      while (k < ta.length - 1 && k < tb.length - 1 && shapeOf(ta[k]!) === shapeOf(tb[k]!)) k++
      if (k === 0) continue
      const handled = strategy?.tag === 'sharedPrefix'
        && Array.isArray(strategy.members) && strategy.members.includes(i) && strategy.members.includes(j)
      push({
        rewrite: 'left-factor', site,
        from: `choice(sequence(${ta.map(t => render(t, 1)).join(', ')}), sequence(${tb.map(t => render(t, 1)).join(', ')}))`,
        to: clamp(`sequence(${ta.slice(0, k).map(t => render(t, 2)).join(', ')}, choice(sequence(${ta.slice(k).map(t => render(t, 1)).join(', ')}), sequence(${tb.slice(k).map(t => render(t, 1)).join(', ')})))`),
        astNeutral: false,
        perf: handled
          ? 'NONE — parseman\'s `sharedPrefix` choice strategy already recognizes this prefix once and replays it, so the runtime cost is identical. This is a readability finding.'
          : PERF_ARM,
        bug: false,
        suggestion: `arm[${i}] and arm[${j}] spell the same ${k} leading term(s). ${handled ? 'The `sharedPrefix` strategy already collapses this AT RUNTIME, so left-factoring buys readability, not speed — but writing it out means the next reader does not have to trust the optimizer.' : 'Left-factor to `sequence(prefix, choice(tailA, tailB))`: the prefix is then recognized once and the inner choice dispatches on its own first char.'} CANDIDATE — verify AST identity: factoring nests the tails one level deeper in the value.`,
      }, `${i}-${j}`)
    }
  }

  // (g) hand-rolled sepBy — sequence(X, many(sequence(S, X))).
  for (const v of visited.values()) {
    if (v.d.tag !== 'sequence') continue
    const hit = detectHandRolledSepBy(v.d.parsers, shapeOf)
    if (hit === null) continue
    // Anywhere in the REPETITION, not just on the separator itself: a `field()`
    // wrapping the whole `sequence(sep, item)` is the same blocker.
    const captured = v.d.parsers.some(t => capturesPositionally(t))
    const verdict: SepByVerdict = captured ? 'blocked-by-capture' : v.enclosingReducer ? 'reducer-stride-review' : 'convertible'
    const to = `sepBy(${clamp(render(hit.item, 2))}, ${clamp(render(hit.sep, 2))}${hit.trailing ? `, { trailing: 'allow' }` : ''}, { min: ${hit.min} })`
    out.push({
      kind: 'rewrite',
      id: `rewrite:hand-rolled-sepby:${siteToString(v.site)}`,
      rewrite: 'hand-rolled-sepby',
      site: v.site,
      sepByVerdict: verdict,
      from: clamp(render(v.p, 3)),
      to: verdict === 'convertible' ? to : `${to}   — NOT APPLICABLE HERE (${verdict})`,
      astNeutral: false,
      perf: verdict === 'convertible'
        ? 'the hand-rolled form allocates a tuple per repetition (`sequence(sep, item)`) and a wrapper array around them; `sepBy` builds the item list directly.'
        : PERF_NONE,
      bug: false,
      suggestion: `${SEPBY_SPELLED_OUT(hit.trailing)} ${SEPBY_VERDICT_TEXT[verdict](hit.trailing)}`,
    })
  }

  return out
}

function collapseRepeat(outer: ParserDef, inner: ParserDef): string | null {
  const o = outer.tag, i = inner.tag
  if (o === 'optional' && i === 'optional') return 'optional(X)'
  if (o === 'optional' && i === 'many') return 'many(X)'
  if (o === 'many' && i === 'many') return 'many(X)'
  if (o === 'many' && i === 'optional') return 'many(X)'
  if (o === 'optional' && i === 'oneOrMore' && inner.min === 1 && inner.max === undefined) return 'many(X)'
  if (o === 'many' && i === 'oneOrMore' && inner.min === 1 && inner.max === undefined) return 'many(X)'
  return null
}

/** `node()` type wrapping an arm, for the AST-neutrality caveat. */
function wrappingNodeType(arm: Combinator<unknown>): string | null {
  const d = arm._def as ParserDef
  return d.tag === 'node' ? d.type ?? '(anonymous)' : null
}

/**
 * `longer` = `shorter` plus ONE extra term at the front or the back. That extra
 * term is exactly an `optional()`.
 */
function detectOptionalTerm(
  longer: readonly Combinator<unknown>[],
  shorter: readonly Combinator<unknown>[],
  shapeOf: (p: Combinator<unknown>) => number,
): { where: 'prefix' | 'suffix'; term: Combinator<unknown>; rest: readonly Combinator<unknown>[] } | null {
  if (longer.length !== shorter.length + 1 || shorter.length === 0) return null
  const same = (a: readonly Combinator<unknown>[], b: readonly Combinator<unknown>[]): boolean =>
    a.length === b.length && a.every((x, i) => shapeOf(x) === shapeOf(b[i]!))
  if (same(longer.slice(1), shorter)) return { where: 'prefix', term: longer[0]!, rest: shorter }
  if (same(longer.slice(0, -1), shorter)) return { where: 'suffix', term: longer[longer.length - 1]!, rest: shorter }
  return null
}

const SEPBY_SPELLED_OUT = (trailing: boolean): string =>
  `this is \`sepBy(item, sep${trailing ? ", { trailing: 'allow' }" : ''})\` spelled out.`

/** The verdict text. Each says what to DO, and the blocked ones say why not. */
const SEPBY_VERDICT_TEXT: Record<SepByVerdict, (trailing: boolean) => string> = {
  'blocked-by-capture': () =>
    'BLOCKED: the repetition CAPTURES its separator (`field`/`label`), which `sepBy` cannot express — it yields items and discards separators, so byte-faithful layout replay is lost. Leave this site alone; read it as a parseman gap (a separator-capturing repeat), not as work.',
  'reducer-stride-review': () =>
    'NEEDS REVIEW, not conversion: an enclosing `node()`/`transform()` reducer reads this repetition\'s children, and a left-associating reducer typically STRIDES BY TWO over `[item, sep, item, sep, …]` and re-emits the operator text. `sepBy` yields a FLAT ITEM list with the separators gone, so the reducer has to be rewritten in the same change or the tree moves. Convert only together with the reducer.',
  convertible: (trailing: boolean) =>
    `No separator capture, and no enclosing reducer reads these children — this site is convertible. Beyond the ${trailing ? 'four' : 'three'} combinators it replaces, \`sepBy\` carries the right NULLABILITY: \`min: 0\` (the default) matches empty and does NOT gate as a choice arm, \`min: 1\` does — a distinction the hand-rolled shape leaves implicit and gets wrong silently. Still check the consumer: \`sepBy\` yields a flat item list where the hand-rolled form yields \`[first, [[sep, item], …]]\`.`,
}

/**
 * Whether a hand-rolled separated list can ACTUALLY become `sepBy` — a verdict per
 * site, not a count. Reporting every match as convertible generates false work: on
 * the reference Less grammar only a minority are, and the rest are blocked for two
 * concrete, detectable reasons.
 */
export type SepByVerdict = 'convertible' | 'blocked-by-capture' | 'reducer-stride-review'

/** Does this subtree capture anything positionally (`field`/`label`)? */
function capturesPositionally(p: Combinator<unknown>, seen = new Set<Combinator<unknown>>()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def as ParserDef
  if (d.tag === 'field' || d.tag === 'label') return true
  for (const k of childrenOf(d)) if (capturesPositionally(k, seen)) return true
  return false
}

/** `sequence(X, many(sequence(S, X)) [, optional(S)])` — a `sepBy` written out. */
function detectHandRolledSepBy(
  terms: readonly Combinator<unknown>[],
  shapeOf: (p: Combinator<unknown>) => number,
): { item: Combinator<unknown>; sep: Combinator<unknown>; trailing: boolean; min: number } | null {
  if (terms.length < 2 || terms.length > 3) return null
  const item = terms[0]!
  const rep = terms[1]!._def as ParserDef
  if (rep.tag !== 'many' && rep.tag !== 'oneOrMore') return null
  if (rep.max !== undefined) return null
  const innerDef = rep.parser._def as ParserDef
  if (innerDef.tag !== 'sequence' || innerDef.parsers.length !== 2) return null
  const [sep, repeated] = innerDef.parsers as [Combinator<unknown>, Combinator<unknown>]
  if (shapeOf(repeated) !== shapeOf(item)) return null
  let trailing = false
  if (terms.length === 3) {
    const t = terms[2]!._def as ParserDef
    if (t.tag !== 'optional' || shapeOf(t.parser) !== shapeOf(sep)) return null
    trailing = true
  }
  // The leading item plus whatever the repetition itself requires. `rep.min` is
  // already RESOLVED for both tags (`many` defaults it to 0, `oneOrMore` to 1), so
  // one expression covers both — special-casing the tag dropped an explicit
  // `many(…, { min: n })` back to 1 and under-reported the rewrite's bound.
  return { item, sep, trailing, min: 1 + rep.min }
}

// ── 5b. one node type, several divergent productions ─────────────────────────

/**
 * The term list of a `node()`'s BODY. Peels more wrappers than `termsOf` — a
 * clone typically differs from its original by exactly such a wrapper
 * (`noTrivia(…)` around the sequence), and that difference is the thing to see
 * through, not the thing to report.
 */
function bodyTermsOf(p: Combinator<unknown>): readonly Combinator<unknown>[] {
  let cur = p
  for (;;) {
    const d = cur._def as ParserDef
    if (d.tag === 'node' || d.tag === 'grammar' || d.tag === 'transform' || d.tag === 'label'
      || d.tag === 'attempt' || d.tag === 'leaf' || d.tag === 'token' || d.tag === 'expect' || d.tag === 'field') {
      cur = (d as { parser: Combinator<unknown> }).parser
      continue
    }
    break
  }
  const d = cur._def as ParserDef
  return d.tag === 'sequence' ? d.parsers : [cur]
}

/** Terms must overlap this much before two productions count as variants of one
 *  shape rather than two genuinely different constructs that share a node type. */
const MIN_SHARED_TERMS = 2

function findDivergentNodes(
  visited: Map<Combinator<unknown>, Visited>,
  shapeOf: (p: Combinator<unknown>) => number,
): DivergentNodeFinding[] {
  const byType = new Map<string, Map<number, Visited>>()
  for (const v of visited.values()) {
    if (v.d.tag !== 'node' || v.d.type === undefined) continue
    let m = byType.get(v.d.type)
    if (m === undefined) { m = new Map(); byType.set(v.d.type, m) }
    if (!m.has(v.shape)) m.set(v.shape, v)
  }

  const out: DivergentNodeFinding[] = []
  for (const [type, m] of byType) {
    if (m.size < 2) continue
    const members = [...m.values()]
    const termSets = members.map(v => bodyTermsOf(v.p).map(t => ({ id: shapeOf(t), text: clamp(render(t, 2)) })))
    // Shared = spelled by EVERY production. That is what makes them one shape.
    const shared = termSets[0]!.filter(t => termSets.every(set => set.some(x => x.id === t.id)))
    const uniqueShared = [...new Map(shared.map(t => [t.id, t])).values()]
    if (uniqueShared.length < MIN_SHARED_TERMS) continue
    const sharedIds = new Set(uniqueShared.map(t => t.id))
    out.push({
      kind: 'divergent-node',
      id: `divergent-node:${type}`,
      nodeType: type,
      count: members.length,
      sharedTerms: uniqueShared.map(t => t.text),
      productions: members.map((v, i) => ({
        shape: clamp(render(v.p, 3)),
        site: v.site,
        distinctTerms: termSets[i]!.filter(t => !sharedIds.has(t.id)).map(t => t.text),
      })),
      suggestion: `\`${type}\` is built by ${members.length} structurally different productions that nevertheless spell ${uniqueShared.length} identical term(s) (${uniqueShared.map(t => `\`${t.text}\``).join(', ')}) — they are variants of ONE shape, not ${members.length} constructs. Nothing keeps them in sync: an edit to the ${type} shape has to land in all ${members.length}, and no test fails when it lands in one. Fold them into a single production whose varying part is a \`choice\`, or, if the variants exist for a parse-order reason (a fast path tried first), say so at the definition — the cost of the split is that a reader cannot tell which it is.`,
    })
  }
  return out.sort((a, b) => b.sharedTerms.length * b.count - a.sharedTerms.length * a.count)
}

// ── 6. hand-rolled keyword regexes ───────────────────────────────────────────

function findKeywordRegexes(visited: Map<Combinator<unknown>, Visited>): KeywordRegexFinding[] {
  // Sibling map: which choice arms are themselves hand-rolled keywords.
  const armIndexOf = new Map<Combinator<unknown>, { owner: Combinator<unknown>; index: number }>()
  for (const v of visited.values()) {
    if (v.d.tag !== 'choice') continue
    v.d.parsers.forEach((a, i) => {
      let cur = a
      for (;;) {
        const cd = cur._def as ParserDef
        if (cd.tag === 'node' || cd.tag === 'label' || cd.tag === 'transform' || cd.tag === 'leaf' || cd.tag === 'attempt') { cur = cd.parser; continue }
        break
      }
      armIndexOf.set(cur, { owner: v.p, index: i })
    })
  }
  const keywordArms = new Map<Combinator<unknown>, number[]>()
  for (const [arm, { owner }] of armIndexOf) {
    const d = arm._def as ParserDef
    if (d.tag !== 'regex' || keywordRegexShape(d.source) === null) continue
    const list = keywordArms.get(owner) ?? []
    list.push(armIndexOf.get(arm)!.index)
    keywordArms.set(owner, list)
  }

  const out: KeywordRegexFinding[] = []
  for (const v of visited.values()) {
    const d = v.d
    if (d.tag !== 'regex') continue
    const shape = keywordRegexShape(d.source)
    if (shape === null) continue
    const ci = d.flags.includes('i')
    const unicode = d.flags.includes('u') || d.flags.includes('v')
    const own = armIndexOf.get(v.p)
    const siblings = own === undefined ? [] : (keywordArms.get(own.owner) ?? []).filter(i => i !== own.index)
    const bq = (s: string): string => `'${s.replace(/\\/g, '\\\\')}'`
    const vocabulary = shape.words.length >= VOCABULARY_MIN_WORDS
    const hazards = keywordAlternationHazards(shape.words, shape.boundary)
    const unrescued = hazards.filter(h => !h.rescuedByBoundary)
    const longestFirst = shape.words.every((w, i) => i === 0 || shape.words[i - 1]!.length >= w.length)
    const shown = shape.words.length > 8 ? [...shape.words.slice(0, 6), '/* … */', shape.words[shape.words.length - 1]!] : shape.words
    const call = shape.words.length === 1
      ? `word(${bq(shape.words[0]!)}, ${bq(shape.boundary ?? '_0-9A-Za-z')}${ci ? ', { caseInsensitive: true }' : ''})`
      : `keywords([${shown.map(w => (w === '/* … */' ? w : bq(w))).join(', ')}], { boundary: ${bq(shape.boundary ?? '_0-9A-Za-z')}${ci ? ', caseInsensitive: true' : ''} })`
    out.push({
      kind: 'keyword-regex',
      id: `keyword-regex:${siteToString(v.site)}`,
      site: v.site,
      source: d.source,
      flags: d.flags,
      words: shape.words,
      boundary: shape.boundary,
      caseFoldRisk: ci && !unicode,
      siblingArms: siblings,
      vocabulary,
      longestFirst,
      hazards,
      bug: unrescued.length > 0,
      suggestion: [
        vocabulary
          ? `this regex enumerates a FIXED VOCABULARY of ${shape.words.length} literal words${shape.words.length > 20 ? ' — the alternation is long enough that nobody re-reads it' : ''}. A regex enumerating a fixed vocabulary is a keyword set written the hard way. Use \`${call}\` — it exposes an EXACT first-set that \`choice\` can dispatch on (the alternation exposes none), it owns the boundary so it is not re-spelled per word, it sorts LONGEST-FIRST by construction, and it lowers to a single charCodeAt scan.`
          : `\`regex(/${d.source}/${d.flags})\` hand-rolls a keyword and its word boundary. Use \`${call}\` — it owns the boundary (so \`${shape.boundary ?? ''}\` is not re-spelled per keyword), exposes an EXACT first-set that \`choice\` can dispatch on, and lowers to the same charCodeAt scan.`,
        unrescued.length > 0
          ? `LIVE BUG — the alternation is ordered so ${unrescued.length} later alternative(s) can NEVER match: ${unrescued.slice(0, 3).map(h => `\`${h.shorter}\` precedes \`${h.longer}\` and nothing rejects the following \`${h.at}\``).join('; ')}${unrescued.length > 3 ? `, and ${unrescued.length - 3} more` : ''}. Regex alternation is FIRST-match, not longest-match, and with no boundary guard to force a backtrack the shorter branch wins outright. \`keywords()\` cannot express this bug: it sorts longest-first.`
          : hazards.length > 0
            ? `ORDERING HAZARD (currently harmless): ${hazards.length} earlier alternative(s) are strict prefixes of later ones — e.g. \`${hazards[0]!.shorter}\` before \`${hazards[0]!.longer}\`. Regex alternation is first-match, so these work ONLY because the trailing boundary guard rejects the next character and the engine backtracks into the longer branch. That correctness rests on a hand-maintained order plus a guard that happens to cover the right characters; \`keywords()\` sorts longest-first by construction and does not depend on either.`
            : !longestFirst && vocabulary
              ? `The alternation is not in longest-first order. It is correct today${shape.boundary === null ? '' : ' (the boundary guard forces a backtrack where it matters)'}, but the ordering is hand-maintained and nothing checks it — adding a word that extends an existing one is a silent bug. \`keywords()\` sorts longest-first by construction.`
              : '',
        ci && !unicode
          ? `CORRECTNESS, not style: \`/i\` without \`/u\` does NOT fold case the way \`{c, toUpperCase(c), toLowerCase(c)}\` suggests — 67 BMP code points fold in ways those three miss (ς/σ, µ/μ, the Ǆǅǆ digraphs, combining iota subscript). parseman fixed exactly this INSIDE \`keywords()\` (see combinators/case-fold.ts); a hand-rolled copy never received the fix, so its first-set is unsound for those inputs.`
          : '',
        siblings.length > 0
          ? `arm[${own?.index}] here sits alongside arm(s) [${siblings.join(', ')}] in the same \`choice\`, which are also hand-rolled keywords. A single \`keywords([…])\` replaces the whole group and gives longest-match dispatch across it — which is what that combinator exists for.`
          : '',
      ].filter(s => s !== '').join(' '),
    })
  }
  // Bugs first, then the biggest vocabularies: a 150-word alternation is both the
  // most valuable conversion and the least likely to be spotted by reading.
  return out.sort((a, b) =>
    Number(b.bug) - Number(a.bug)
    || b.hazards.length - a.hazards.length
    || b.words.length - a.words.length
    || b.siblingArms.length - a.siblingArms.length)
}

// ── formatting ───────────────────────────────────────────────────────────────

export type DuplicationWarnLevel = 'off' | 'warn' | 'error'

const sitesLine = (sites: readonly Site[]): string =>
  sites.slice(0, 6).map(siteToString).join('\n      ') + (sites.length > 6 ? `\n      … and ${sites.length - 6} more` : '')

/**
 * Ranked, actionable lines — same tone and shape as `formatGatingWarnings`: what
 * it is, where it is, and one concrete thing to do about it.
 */
export function formatDuplicationFindings(report: DuplicationReport): string[] {
  const lines: string[] = []
  for (const f of report.rewrites) {
    lines.push(`parseman ${f.bug ? 'BUG' : 'rewrite'} [${f.rewrite}${f.sepByVerdict === undefined ? '' : `/${f.sepByVerdict}`}] @ ${siteToString(f.site)}${f.astNeutral ? '' : ' (candidate — verify AST identity)'}`)
    lines.push(`  from: ${f.from}`)
    lines.push(`    to: ${f.to}`)
    lines.push(`   fix: ${f.suggestion}`)
    if (f.perf !== '') lines.push(`  perf: ${f.perf}`)
  }
  for (const f of report.divergentNodes) {
    lines.push(`parseman divergent-node: \`${f.nodeType}\` is built by ${f.count} different productions sharing ${f.sharedTerms.length} term(s): ${f.sharedTerms.map(t => `\`${t}\``).join(', ')}`)
    for (const p of f.productions) lines.push(`      ${siteToString(p.site)}\n        ${p.shape}\n        unique to it: ${p.distinctTerms.length === 0 ? '(none)' : p.distinctTerms.map(t => `\`${t}\``).join(', ')}`)
    lines.push(`   fix: ${f.suggestion}`)
  }
  for (const f of report.keywordRegexes) {
    const src = f.source.length > 90 ? `${f.source.slice(0, 88)}…` : f.source
    lines.push(`parseman ${f.bug ? 'BUG ' : ''}keyword-regex @ ${siteToString(f.site)}: /${src}/${f.flags}${f.vocabulary ? `  [${f.words.length} literal words${f.longestFirst ? '' : ', NOT longest-first'}]` : ''}${f.hazards.length > 0 ? `  [${f.hazards.length} prefix hazard(s)${f.bug ? ', UNRESCUED' : ''}]` : ''}${f.caseFoldRisk ? '  [CASE-FOLD RISK]' : ''}`)
    lines.push(`   fix: ${f.suggestion}`)
  }
  for (const f of report.duplicates) {
    lines.push(`parseman duplication: ${f.count}× identical ${f.size}-node shape (saves ${f.savings} nodes) — ${f.shape}`)
    lines.push(`     at: ${sitesLine(f.sites)}`)
    lines.push(`   fix: ${f.suggestion}`)
  }
  for (const f of report.nearDuplicates) {
    lines.push(`parseman near-duplication: ${f.count} clones of a ${f.sharedSize}-node shape differing at ONE slot (saves ${f.savings} nodes) — ${f.shape}`)
    lines.push(`   slot: ${f.slotPath} ∈ { ${f.variants.join(' | ')} }`)
    lines.push(`     at: ${sitesLine(f.sites)}`)
    lines.push(`   fix: ${f.suggestion}`)
  }
  for (const f of report.regexFragments) {
    lines.push(`parseman regex-fragment: \`${f.fragment}\` (${f.branches} branches) re-spelled in ${f.count} regex() terminals`)
    lines.push(`     at: ${sitesLine(f.sites)}`)
    lines.push(`   fix: ${f.suggestion}`)
  }
  for (const f of report.regexClasses) {
    lines.push(`parseman regex-class${f.drifted ? ' DRIFT' : ''}: [${f.canonical}] across ${f.count} regex() terminals${f.bmpCeiling ? '  [BMP ceiling]' : ''}`)
    for (const v of f.variants) lines.push(`      [${v.source}]  ×${v.count}  ${v.delta}\n        ${sitesLine(v.sites)}`)
    lines.push(`   fix: ${f.suggestion}`)
  }
  for (const f of report.overlaps) {
    lines.push(`parseman overlap @ ${siteToString(f.site)}: arm[${f.a}] ∩ arm[${f.b}] on ${firstSetToString(f.on)}${f.sharedPrefix === null ? '' : ` — shared prefix: ${f.sharedPrefix}`}${f.handledByStrategy ? ' [sharedPrefix strategy already handles this]' : ''}`)
    lines.push(`   fix: ${f.suggestion}`)
  }
  return lines
}

/** Total findings across every category — the number the `'error'` gate keys on. */
export function duplicationFindingCount(report: DuplicationReport): number {
  return report.duplicates.length + report.nearDuplicates.length + report.regexFragments.length
    + report.regexClasses.length + report.overlaps.length + report.rewrites.length
    + report.divergentNodes.length + report.keywordRegexes.length
}
