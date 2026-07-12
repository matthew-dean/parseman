/**
 * `parseman/language-service` — the external, grammar-agnostic IDE layer.
 *
 * A grammar is pure structure (it carries no recovery/completion/lint config).
 * `languageService(grammar, config)` layers editor behaviour ON TOP, keyed by rule
 * name = node type, without ever modifying the grammar:
 *
 *   - `parse(src, { tolerant })` → CST + `ParseError[]` (recovers on the compiled
 *     fast path when `grammar` is a `compile(g, { recovery: true })` grammar).
 *   - `diagnostics(src)` → structural parse errors + your per-node-type lint rules.
 *   - `completionsAt(src, offset)` → the grammar's expected-token set at the cursor,
 *     mapped through your per-rule semantic completion handlers.
 *
 * The grammar can be the interpreter combinator OR a compiled grammar — the domain
 * knowledge (what to suggest after `color:`, which nodes to lint) lives here, in the
 * consumer's config, never in the grammar.
 */
import type { Combinator, ParseContext, ParseResult, Span, ParseError } from '../types.ts'
import { run } from '../functional/run.ts'
import { completionsAt as coreCompletionsAt } from '../combinators/completions.ts'
import { cstBuildHost } from '../compiler/linker.ts'
import { walk, type Walkable } from '../cst/walk.ts'
import { parseDoc, type Registry } from '../functional/doc.ts'
import { absolutizeCST } from '../cst/relative-spans.ts'
import type { NodeLike } from '../cst/types.ts'

export type Severity = 'error' | 'warning' | 'info'
export type Diagnostic = { severity: Severity; message: string; span: Span }
export type CompletionItem = { label: string; detail?: string }

/** A CST node/leaf as a diagnostics handler sees it: the walk shape plus span/value. */
export type LsNode = Walkable & { readonly span: Span; readonly value?: string }

/** Context handed to a completion handler: which rule the cursor sits in and the
 * grammar's raw expected-token labels there. */
export type CompletionContext = { rule: string | null; expected: string[]; offset: number }

export type LanguageServiceConfig = {
  /** Lint/diagnostic rules keyed by node type (rule name). Return zero or more
   * Diagnostics for each matching node. */
  diagnostics?: Record<string, (node: LsNode) => Diagnostic | Diagnostic[] | null | undefined | void>
  /** Semantic completion handlers keyed by the rule the cursor is in. Turn the
   * grammar's structural expectation into domain suggestions. */
  complete?: Record<string, (ctx: CompletionContext) => CompletionItem[]>
}

/** Grammar the service drives: an interpreter combinator or a compiled entry fn. */
type Grammar = Combinator<unknown> | ((input: string, pos: number, ctx: ParseContext) => ParseResult<unknown>)

/**
 * What you hand `languageService`:
 * - a single entry (combinator or `compile()`d fn) — stateless methods only, or
 * - `{ rules, root }` (a `rules()` registry + its root rule name) — also unlocks
 *   `openDocument`, the live incremental editor document.
 */
export type GrammarInput = Grammar | { rules: Registry<NodeLike>; root: string }

/**
 * A live incremental document — the fused editor backend. Holds a tolerant
 * `parseDoc` whose tree survives broken input (recovery) and re-parses only the
 * edited span on `edit()`. Diagnostics walk the maintained tree (recovered errors
 * ride inside it as `parseError` nodes), so they stay complete across edits without
 * re-parsing the whole document.
 */
export type LsDocument = {
  /** The current CST with ABSOLUTE spans (recovered errors embedded as parseError nodes). */
  readonly tree: LsNode | null
  /** Apply an editor change (byte offsets in the CURRENT text); returns the next document. */
  edit(from: number, to: number, replacement: string): LsDocument
  /** Structural parse errors (from the tree) + your per-node-type lint rules. */
  diagnostics(): Diagnostic[]
  /** Completions at a cursor offset in the current text. */
  completionsAt(offset: number): CompletionItem[]
}

export type LanguageService = {
  parse(src: string, opts?: { tolerant?: boolean }): ParseResult<unknown> & { errors: ParseError[] }
  diagnostics(src: string): Diagnostic[]
  completionsAt(src: string, offset: number): CompletionItem[]
  /** Open a live incremental document. Requires `languageService({ rules, root }, …)`. */
  openDocument(src: string): LsDocument
}

const errorMessage = (expected: readonly string[]): string =>
  expected.length ? `Unexpected input; expected ${expected.join(' or ')}` : 'Unexpected input'

/** One walk over a CST: recovered `parseError` nodes → error diagnostics, and each
 * node dispatched to its `config.diagnostics[type]` lint handler. Errors live in the
 * tree, so this is the single source for both — no separate flat channel to merge. */
function diagnoseTree(root: LsNode, config: LanguageServiceConfig): Diagnostic[] {
  const out: Diagnostic[] = []
  const rules = config.diagnostics
  walk(root, {
    enter(node) {
      if (node._tag === 'parseError') {
        out.push({ severity: 'error', message: errorMessage((node as { expected?: string[] }).expected ?? []), span: node.span })
        return
      }
      const h = rules && node.type !== undefined ? rules[node.type] : undefined
      if (h) {
        const d = h(node)
        if (d) out.push(...(Array.isArray(d) ? d : [d]))
      }
    },
  })
  return out
}

export function languageService(grammar: GrammarInput, config: LanguageServiceConfig = {}): LanguageService {
  const build = cstBuildHost()
  const asReg = typeof grammar === 'object' && grammar !== null && 'rules' in grammar
  const registry = asReg ? grammar.rules : undefined
  const root = asReg ? grammar.root : undefined
  const entry: Grammar = asReg ? (registry![root!] as Grammar) : grammar

  const parseTolerant = (src: string) => run(entry as never, src, { tolerant: true, build })

  const complete = (input: string, offset: number, treeForCursor: unknown): CompletionItem[] => {
    const expected = coreCompletionsAt(entry as never, input, offset, { tolerant: true })
    const rule = ruleAtCursor(treeForCursor, offset)
    const handler = rule !== null ? config.complete?.[rule] : undefined
    if (handler) return handler({ rule, expected, offset })
    return expected.map(label => ({ label }))
  }

  return {
    parse(src, opts) {
      return run(entry as never, src, { tolerant: opts?.tolerant ?? true, build }) as ParseResult<unknown> & { errors: ParseError[] }
    },

    diagnostics(src) {
      const r = parseTolerant(src)
      return r.value && typeof r.value === 'object' ? diagnoseTree(r.value as LsNode, config)
        : r.errors.map(e => ({ severity: 'error' as const, message: errorMessage(e.expected), span: e.span }))
    },

    completionsAt(src, offset) {
      return complete(src, offset, parseTolerant(src.slice(0, offset)).value)
    },

    openDocument(src) {
      if (!registry || root === undefined) {
        throw new Error('openDocument requires languageService({ rules, root }, config) — a rules() registry, not a single entry')
      }
      const host = cstBuildHost()
      const make = (doc: ReturnType<typeof parseDoc<NodeLike>>): LsDocument => {
        // Absolutize once per document version (memoized in this closure).
        const abs = doc.tree ? (absolutizeCST(doc.tree as never) as unknown as LsNode) : null
        return {
          get tree() { return abs },
          edit: (from, to, replacement) => make(doc.edit(from, to, replacement)),
          diagnostics: () => (abs ? diagnoseTree(abs, config) : []),
          completionsAt: (offset) => complete(doc.input, offset, abs),
        }
      }
      return make(parseDoc<NodeLike>(registry, root, src, { tolerant: true, structuralReuse: true, build: host }))
    },
  }
}

/** Deepest node whose span brackets the cursor — "which rule is the cursor in".
 * The grammar carries no cursor knowledge, so we reconstruct it from the CST. */
function ruleAtCursor(root: unknown, offset: number): string | null {
  if (!root || typeof root !== 'object') return null
  let best: string | null = null
  walk(root as LsNode, {
    enter(node) {
      const s = node.span
      if (s && s.start <= offset && offset <= s.end && node.type !== undefined) best = node.type
    },
  })
  return best
}
