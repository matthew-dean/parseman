import type { Combinator, ParseContext, ParseResult, ParserMeta, Span } from '../types.ts'
import { ref } from '../combinators/ref.ts'
import type { CSTNode, CSTLeaf, CSTError, CSTTrivia, CSTRawChild, NodeLike } from './types.ts'
import { makeParseDoc } from './incremental.ts'
import type { ParseDoc } from './incremental.ts'

// ---------------------------------------------------------------------------
// TypeScript helpers
// ---------------------------------------------------------------------------

type Capital = 'A'|'B'|'C'|'D'|'E'|'F'|'G'|'H'|'I'|'J'|'K'|'L'|'M'|'N'
             | 'O'|'P'|'Q'|'R'|'S'|'T'|'U'|'V'|'W'|'X'|'Y'|'Z'

/** Keys of T whose names start with a capital letter (CST parser). */
export type RuleKeys<T> = {
  [K in keyof T & string]: K extends `${Capital}${string}` ? K : never
}[keyof T & string]

/**
 * Maps each grammar property to its resolved Combinator type.
 *
 * Use as the parameter type in rule thunks — gives `g.*` the correct
 * Combinator type instead of the raw function type:
 *
 *   Expr = (g: Refs<this>) => choice(g.Atom, sequence(g.Expr, literal('+'), g.Atom))
 */
export type Refs<T> = {
  [K in keyof T as K extends `_${string}` ? never
    : T[K] extends Combinator<any> ? K
    : T[K] extends (g: any) => Combinator<any> ? K
    : never
  ]: T[K] extends Combinator<infer V> ? Combinator<V>
   : T[K] extends (g: any) => Combinator<infer V> ? Combinator<V>
   : never
}

// ---------------------------------------------------------------------------
// Parser base class
// ---------------------------------------------------------------------------

/**
 * Base class for grammars that automatically produce a CST (or a custom AST
 * if you override `buildNode`).
 *
 * Rules are declared as class properties:
 *   - Plain Combinator  (no cross-references needed):
 *       digits = regex(/[0-9]+/)
 *   - Thunk  (references other parser via `g`):
 *       Expr = (g: Refs<this>) => choice(g.Atom, sequence(g.Expr, literal('+')))
 *
 * Convention:
 *   Capital letter → CSTNode-producing rule (span + state + children)
 *   lowercase      → transparent helper (terminals bubble up as CSTLeaf in the
 *                    nearest enclosing capital rule)
 *
 * Mutual recursion works because thunks are collected first, ref() placeholders
 * installed for each one, then all thunks are called with `g` (a map of refs).
 * Initialization is lazy — triggered on the first call to rule().
 *
 * Grammar inheritance: subclass property initializers naturally override parent
 * ones (they run last in construction order), so extending a grammar means only
 * re-declaring the parser you want to change.
 *
 *   class JSONCParser extends JSONParser {
 *     ws = jsoncWs  // override just this one rule
 *   }
 */
export class Parser<N extends NodeLike = CSTNode> {
  private _built = false

  /** Set in a subclass to enable automatic trivia skipping between sequence terms. */
  protected _trivia?: Combinator<unknown>

  /**
   * Set in a subclass to make the rule name optional in `parse()`.
   * When defined, `parse(input)` is equivalent to `parse(defaultRule, input)`.
   */
  protected _defaultRule?: RuleKeys<this>

  /**
   * Set `true` in a subclass to record trivia (whitespace/comments) consumed
   * between terms into each node's rawChildren as separate CSTTrivia tokens.
   * Requires `_trivia` to be set. Default: trivia is skipped without recording.
   */
  protected _captureTrivia?: boolean

  /**
   * When set, makeParseDoc injects this array as ctx._triviaLog so each
   * scanTrivia.commit() pushes [runStart, runEnd] pairs into it.
   * Reset to [] before each parse() call in any subclass that uses it.
   */
  protected _triviaLog?: number[]

  /**
   * Optional map of public entry-point aliases → actual rule names. Lets callers
   * `parse('value', src)` when the grammar's rule is `ValueList`, removing
   * per-adapter name-translation tables.
   */
  protected _aliases?: Record<string, string>

  /** Resolve an alias to its target rule name (identity if not aliased). */
  protected _resolveRule(name: string): string {
    return this._aliases?.[name] ?? name
  }

  private _build() {
    if (this._built) return
    this._built = true

    // All own enumerable properties are set by the time this runs (called from
    // rule() after construction completes, so subclass initializers have fired).
    const keys = Object.keys(this).filter(k => !k.startsWith('_'))

    type Slot = ReturnType<typeof ref<unknown>>
    const slots = new Map<string, Slot>()
    const g: Record<string, unknown> = {}

    // Phase 1: separate plain Combinators from thunks.
    // Plain Combinators go directly into g (capital ones wrapped first).
    // Thunks get a ref() slot in g so mutual references resolve lazily.
    for (const key of keys) {
      const val = (this as unknown as Record<string, unknown>)[key]
      if (isCombinator(val)) {
        const isRule = /^[A-Z]/.test(key)
        const final = isRule ? this._makeNodeParser(key, val as Combinator<unknown>) : val as Combinator<unknown>
        g[key] = final
        Object.defineProperty(this, key, { value: final, writable: false, configurable: false })
      } else if (typeof val === 'function') {
        const slot = ref<unknown>()
        slots.set(key, slot)
        g[key] = slot
      }
    }

    // Phase 2: call thunks with g, wrap capitals, define their slots.
    for (const [key, slot] of slots) {
      const thunk = (this as unknown as Record<string, unknown>)[key] as (g: unknown) => Combinator<unknown>
      const inner = thunk(g)
      const isRule = /^[A-Z]/.test(key)
      const final = isRule ? this._makeNodeParser(key, inner) : inner
      slot.define(final)
      // Propagate first-set so choices wrapping this ref dispatch correctly.
      slot._meta.firstSet        = final._meta.firstSet
      slot._meta.canMatchNewline = final._meta.canMatchNewline
      Object.defineProperty(this, key, { value: final, writable: false, configurable: false })
    }
  }

  /**
   * Override to produce a custom AST node instead of a plain CSTNode.
   * The returned object must satisfy NodeLike for IncrementalParser to work.
   *
   * `rawChildren` is `children` plus any trivia tokens (whitespace/comments)
   * consumed between terms, in parse order. Use it to inspect trivia when the
   * grammar is whitespace-sensitive (e.g. CSS descendant vs adjacent combinators).
   * The default implementation ignores `rawChildren`.
   */
  protected buildNode(
    type: string,
    span: Span,
    children: ReadonlyArray<N | CSTLeaf | CSTError>,
    state: unknown,
    _rawChildren: ReadonlyArray<CSTRawChild>,
  ): N {
    return { _tag: 'node', type, span, children: children as CSTNode['children'], state } as unknown as N
  }

  /** Wrap an inner combinator so it produces a CSTNode on each match. */
  private _makeNodeParser(type: string, inner: Combinator<unknown>): Combinator<N> {
    const self = this
    const meta: ParserMeta = {
      firstSet:        inner._meta.firstSet,
      canMatchNewline: inner._meta.canMatchNewline,
      isTrivia:        false,
    }
    return {
      _tag: 'cstNode',
      _meta: meta,
      _def:  { tag: 'unknown' },
      parse(input: string, pos: number, ctx: ParseContext): ParseResult<N> {
        const state = ctx.state !== undefined
          ? Object.assign({}, ctx.state as Record<string, unknown>)
          : undefined

        const children: (N | CSTLeaf | CSTError)[] = []
        const rawChildren: CSTRawChild[] = []
        const innerCtx: ParseContext = {
          ...ctx,
          _cstChildren:    children as unknown[],
          _cstLeaves:      children as unknown[],
          _cstRawChildren: rawChildren as unknown[],
        }

        const r = inner.parse(input, pos, innerCtx)
        if (!r.ok) return r

        const node = self.buildNode(type, r.span, children, state, rawChildren)
        // A custom buildNode may collapse a rule to a non-node value (e.g. a
        // bare string). Keep the raw value in `children` (the AST view) but
        // record it in `rawChildren` as a spanned leaf so the parent can still
        // recover this child's source span (for fieldSpans/valueSpans).
        const isNodeLike = typeof node === 'object' && node !== null && (node as { _tag?: string })._tag === 'node'
        if (ctx._cstChildren)    (ctx._cstChildren as unknown[]).push(node)
        if (ctx._cstRawChildren) (ctx._cstRawChildren as unknown[]).push(
          isNodeLike ? node : { _tag: 'leaf', value: typeof node === 'string' ? node : '', span: r.span }
        )
        return { ok: true, value: node, span: r.span }
      },
    }
  }

  /** Reconstruct a node with a new children array (used by IncrementalParser). */
  rebuild(node: N, newChildren: ReadonlyArray<N | CSTLeaf | CSTError>): N {
    return this.buildNode(node.type, node.span, newChildren, node.state, [])
  }

  /**
   * Parse input starting from a named rule, returning a ParseDoc.
   * The doc carries the tree, any parse errors, and an edit() method
   * for incremental re-parsing on subsequent changes.
   *
   *   const doc = css.parse('Stylesheet', src)
   *   doc.tree    // the CST root, or null on failure
   *   doc.errors  // ParseFail[], empty on success
   *
   *   // In an editor — just keep calling edit():
   *   const doc2 = doc.edit(newSrc, changeStart, changeEnd)
   *
   * If the grammar defines `_defaultRule`, the rule name may be omitted:
   *   const doc = css.parse(src)  // uses _defaultRule
   */
  parse(ruleName: RuleKeys<this>, input: string): ParseDoc<N>
  parse(input: string): ParseDoc<N>
  parse(ruleNameOrInput: RuleKeys<this> | string, input?: string): ParseDoc<N> {
    let ruleName: string
    let src: string
    if (input === undefined) {
      if (this._defaultRule === undefined) {
        throw new Error('parse(input) requires a _defaultRule to be set on the grammar')
      }
      ruleName = this._defaultRule as string
      src = ruleNameOrInput as string
    } else {
      ruleName = ruleNameOrInput as string
      src = input
    }
    return makeParseDoc(this, this._resolveRule(ruleName), src, this._trivia, this._captureTrivia, this._triviaLog)
  }

  /**
   * Get the compiled Combinator for a named rule.
   * Triggers lazy initialization on first call.
   */
  rule(name: RuleKeys<this>): Combinator<N> {
    this._build()
    const resolved = this._resolveRule(name as string)
    const p = (this as unknown as Record<string, unknown>)[resolved]
    if (!p) throw new Error(`No rule '${String(name)}' on this parser`)
    return p as Combinator<N>
  }
}

function isCombinator(val: unknown): boolean {
  return val !== null && typeof val === 'object' && '_tag' in (val as object)
}
