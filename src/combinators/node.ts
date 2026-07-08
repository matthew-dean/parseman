import type { Combinator, ParseContext, ParseResult, ParserMeta, ParserDef } from '../types.ts'
import { beginCstNodeCapture, endCstNodeCapture, pushCstChild } from '../cst/capture-buffer.ts'
import { buildReadsTrivia, buildReadsState } from '../compiler/build-arity.ts'

/**
 * A CST/AST node rule. Runs `combinator` while collecting its terminals into
 * `children` / `rawChildren` arrays and trivia spans into `triviaLog`, then
 * calls `build(children, rawChildren, span, triviaLog)` to produce the node.
 *
 *   - `children`    — structural items in source order: spanned CSTLeaf terminals
 *                     and sub-nodes (whatever `build` returned for inner nodes).
 *   - `rawChildren` — structural children only (same items as `children`).
 *   - `triviaLog`   — flat log of trivia entries: each entry is `[start, end, insertIdx]`
 *                     consumed between terms. `insertIdx` is the rawChildren index
 *                     before which the trivia was consumed. Use `buildTriviaIndex`
 *                     to turn this into a before/after lookup table.
 *
 * If `build` returns a non-node value (e.g. a bare string for an unwrapped rule),
 * the parent records it as a spanned leaf so its source span is still recoverable.
 */
export type BuildNode<N> = (
  children: ReadonlyArray<unknown>,
  rawChildren: ReadonlyArray<unknown>,
  span: { start: number; end: number },
  triviaLog: readonly number[],
  state: unknown,
) => N

/**
 * Options for `node()`.
 * - `unwrap` — an AST/value wrapper rule that IS its single child when it
 *   captured exactly one. A leaf unwraps to its string value; a sub-node is
 *   returned as-is.
 * - `collapse` — a structural wrapper rule that returns its single child exactly
 *   as captured. A leaf stays a CSTLeaf; a node stays a node.
 * Both skip `build` only for a one-child match; zero or two-plus children go
 * through `build` normally.
 */
export type NodeOptions = { unwrap?: boolean; collapse?: boolean }

/** A captured child's value form: a leaf unwraps to its string value, else as-is. */
function unwrapChild(child: unknown): unknown {
  return child !== null && typeof child === 'object' && (child as { _tag?: string })._tag === 'leaf'
    ? (child as { value: unknown }).value
    : child
}

function isCstChild(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && ((value as { _tag?: string })._tag === 'node'
      || (value as { _tag?: string })._tag === 'leaf'
      || (value as { _tag?: string })._tag === 'error')
}

function missingInferredType(): never {
  throw new Error('node(): inferred node type requires a rules() key; pass node("Type", parser) outside rules()')
}

export function node<N>(combinator: Combinator<unknown>, build?: BuildNode<N>, opts?: NodeOptions): Combinator<N>
export function node<N>(type: string, combinator: Combinator<unknown>, build?: BuildNode<N>, opts?: NodeOptions): Combinator<N>
export function node<N>(
  typeOrCombinator: string | Combinator<unknown>,
  combinatorOrBuild?: Combinator<unknown> | BuildNode<N>,
  buildOrOpts?: BuildNode<N> | NodeOptions,
  maybeOpts?: NodeOptions,
): Combinator<N> {
  const hasExplicitType = typeof typeOrCombinator === 'string'
  const type = hasExplicitType ? typeOrCombinator : undefined
  const combinator = (hasExplicitType ? combinatorOrBuild : typeOrCombinator) as Combinator<unknown>
  const build = (hasExplicitType ? buildOrOpts : combinatorOrBuild) as BuildNode<N> | undefined
  const opts = (hasExplicitType ? maybeOpts : buildOrOpts) as NodeOptions | undefined
  const baseDef = { tag: 'node' as const, parser: combinator, ...(type === undefined ? {} : { type }), ...(build === undefined ? {} : { build }) }
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  const unwrap = opts?.unwrap === true
  const collapse = opts?.collapse === true
  if (unwrap && collapse) {
    throw new Error('node() options cannot set both unwrap and collapse')
  }
  const def: Extract<ParserDef, { tag: 'node' }> = unwrap || collapse
    ? { ...baseDef, ...(unwrap ? { unwrap: true } : {}), ...(collapse ? { collapse: true } : {}) }
    : baseDef
  // Arity-gated elision — decided once, identically to the compiler (build-arity.ts).
  // When the build never reads the trivia (4th) arg, disable per-node CST-trivia
  // capture for the inner scope; when it never reads state (5th), skip the state clone.
  // A STRUCTURAL node (no own build) defers to `ctx.build` / a default CST, which
  // may read either, so capture both.
  const capturesTrivia = build ? buildReadsTrivia(def) : true
  const clonesState = build ? buildReadsState(def) : true
  return {
    _tag: 'node',
    _meta: meta,
    _def: def,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<N> {
      const saved = beginCstNodeCapture(ctx)
      // Short-circuit the per-node trivia push (scanTrivia gates on captureTrivia)
      // without touching the global _triviaLog, which is committed independently.
      if (!capturesTrivia) ctx.captureTrivia = false
      const r = combinator.parse(input, pos, ctx)
      const { children, rawChildren, triviaLog } = endCstNodeCapture(ctx, saved)

      if (!r.ok) return r

      // unwrap/collapse: a single captured child IS the value — skip build.
      const st = clonesState && ctx.state !== undefined ? Object.assign({}, ctx.state as Record<string, unknown>) : undefined
      const nodeType = def.type ?? missingInferredType()
      const built: unknown = unwrap && children.length === 1
        ? unwrapChild(children[0])
        : collapse && children.length === 1
          ? children[0]
        : !build
          && ctx.build?._parsemanCstCollapse
          && children.length === 1
          && rawChildren.length === 1
          && ctx.build._parsemanCstCollapse(nodeType, children[0], children, rawChildren)
          ? children[0]
        : build
          ? build(children, rawChildren, r.span, triviaLog, st)
          // Structural node: a `ctx.build` host if present, else a default CST.
          : ctx.build
              ? ctx.build(nodeType, children, rawChildren, r.span, triviaLog, st)
              : { _tag: 'node', type: nodeType, span: { start: r.span.start, end: r.span.end }, state: st ?? null, children }
      const rawEntry = isCstChild(built)
        ? built
        : { _tag: 'leaf', value: typeof built === 'string' ? built : '', span: r.span }
      if (saved.buf !== undefined || saved.ch !== undefined) {
        pushCstChild(ctx, built, rawEntry)
      }
      return { ok: true, value: built as N, span: r.span }
    },
  }
}
