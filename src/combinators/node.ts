import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { beginCstNodeCapture, endCstNodeCapture, pushCstChild } from '../cst/capture-buffer.ts'

/**
 * A CST/AST node rule. Runs `parser` while collecting its terminals into
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
) => N

export function node<N>(type: string, parser: Combinator<unknown>, build: BuildNode<N>): Combinator<N> {
  const meta: ParserMeta = {
    firstSet: parser._meta.firstSet,
    canMatchNewline: parser._meta.canMatchNewline,
    isTrivia: false,
  }
  return {
    _tag: 'node',
    _meta: meta,
    _def: { tag: 'node', type, parser, build },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<N> {
      const saved = beginCstNodeCapture(ctx)
      const r = parser.parse(input, pos, ctx)
      const { children, rawChildren, triviaLog } = endCstNodeCapture(ctx, saved)

      if (!r.ok) return r

      const built = build(children, rawChildren, r.span, triviaLog)
      const isNodeLike = typeof built === 'object' && built !== null && (built as { _tag?: string })._tag === 'node'
      const rawEntry = isNodeLike
        ? built
        : { _tag: 'leaf', value: typeof built === 'string' ? built : '', span: r.span }
      if (saved.buf !== undefined || saved.ch !== undefined) {
        pushCstChild(ctx, built, rawEntry)
      }
      return { ok: true, value: built, span: r.span }
    },
  }
}
