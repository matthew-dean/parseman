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

export type LanguageService = {
  parse(src: string, opts?: { tolerant?: boolean }): ParseResult<unknown> & { errors: ParseError[] }
  diagnostics(src: string): Diagnostic[]
  completionsAt(src: string, offset: number): CompletionItem[]
}

export function languageService(grammar: Grammar, config: LanguageServiceConfig = {}): LanguageService {
  const build = cstBuildHost()

  const parseTolerant = (src: string) => run(grammar as never, src, { tolerant: true, build })

  return {
    parse(src, opts) {
      return run(grammar as never, src, { tolerant: opts?.tolerant ?? true, build }) as ParseResult<unknown> & { errors: ParseError[] }
    },

    diagnostics(src) {
      const r = parseTolerant(src)
      const out: Diagnostic[] = r.errors.map(e => ({
        severity: 'error' as const,
        message: e.expected.length ? `Unexpected input; expected ${e.expected.join(' or ')}` : 'Unexpected input',
        span: e.span,
      }))
      const rules = config.diagnostics
      if (rules && r.value && typeof r.value === 'object') {
        walk(r.value as LsNode, {
          enter(node) {
            const h = node.type !== undefined ? rules[node.type] : undefined
            if (h) {
              const d = h(node)
              if (d) out.push(...(Array.isArray(d) ? d : [d]))
            }
          },
        })
      }
      return out
    },

    completionsAt(src, offset) {
      const expected = coreCompletionsAt(grammar as never, src, offset, { tolerant: true })
      const rule = ruleAtCursor(parseTolerant(src.slice(0, offset)).value, offset)
      const handler = rule !== null ? config.complete?.[rule] : undefined
      if (handler) return handler({ rule, expected, offset })
      // No semantic handler → surface the grammar's raw expected labels.
      return expected.map(label => ({ label }))
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
