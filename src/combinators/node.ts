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
 * If `build` returns a non-node value (e.g. a bare string for a collapsed rule),
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
 * - `collapse` — a structural wrapper rule (a selector list, an
 *   expression-precedence level, …) that IS its single child when it captured
 *   exactly one. With `collapse: true`, a one-child match returns that child
 *   directly (a leaf unwrapped to its string value, a sub-node as-is) and
 *   `build` is NOT called; zero or two-plus children go through `build`
 *   normally. Lets a grammar keep readable layered rules without paying a build
 *   call per collapsing layer — and without hand-writing
 *   `if (children.length === 1) return children[0]` in every wrapper builder.
 */
export type NodeOptions = { collapse?: boolean }

/** A captured child's value form: a leaf unwraps to its string value, else as-is. */
function collapseChild(child: unknown): unknown {
  return child !== null && typeof child === 'object' && (child as { _tag?: string })._tag === 'leaf'
    ? (child as { value: unknown }).value
    : child
}

export function node<N>(type: string, combinator: Combinator<unknown>, build: BuildNode<N>, opts?: NodeOptions): Combinator<N> {
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  const collapse = opts?.collapse === true
  const def: Extract<ParserDef, { tag: 'node' }> = collapse
    ? { tag: 'node', type, parser: combinator, build, collapse: true }
    : { tag: 'node', type, parser: combinator, build }
  // Arity-gated elision — decided once, identically to the compiler (build-arity.ts).
  // When the build never reads the trivia (4th) arg, disable per-node CST-trivia
  // capture for the inner scope; when it never reads state (5th), skip the state clone.
  const capturesTrivia = buildReadsTrivia(def)
  const clonesState = buildReadsState(def)
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

      // collapse: a single captured child IS the value — skip build.
      const built: unknown = collapse && children.length === 1
        ? collapseChild(children[0])
        : build(
          children, rawChildren, r.span, triviaLog,
          clonesState && ctx.state !== undefined ? Object.assign({}, ctx.state as Record<string, unknown>) : undefined,
        )
      const isNodeLike = typeof built === 'object' && built !== null && (built as { _tag?: string })._tag === 'node'
      const rawEntry = isNodeLike
        ? built
        : { _tag: 'leaf', value: typeof built === 'string' ? built : '', span: r.span }
      if (saved.buf !== undefined || saved.ch !== undefined) {
        pushCstChild(ctx, built, rawEntry)
      }
      return { ok: true, value: built as N, span: r.span }
    },
  }
}
