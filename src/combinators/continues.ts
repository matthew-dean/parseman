import type { Combinator } from '../types.ts'
import { node, type BuildNode, type NodeCombinator, type NodeOptions } from './node.ts'
import { sequence } from './sequence.ts'

/**
 * A construct that is its first item unless more follows: `Sum = Product (op Product)*`.
 *
 * Parse `corner`, then look at the next token. If `tail` cannot start there, or takes
 * nothing, the corner IS the result: the wrapper never existed, and neither does its
 * frame, its children array or its builder call. If `tail` takes something, the node
 * opens with the corner as its first child and its start as its start, and `build`
 * runs as a `node(type, sequence(corner, tail), build)` reducer would.
 *
 * So a one-child node that MEANS something is not this form: a single-item list that
 * is a real list, or a `{…}` group, keeps `node()`.
 *
 * `corner` must publish exactly one child and carry no field of its own; `tail` must
 * be able to match empty. Both are checked when the table is built.
 */
export function continues<N, const Type extends string = string, const Tags extends readonly string[] = readonly never[]>(
  type: Type,
  corner: Combinator<unknown>,
  tail: Combinator<unknown>,
  build?: BuildNode<N>,
  opts?: Omit<NodeOptions<Tags>, 'collapse' | 'unwrap' | 'project' | 'trailingTrivia' | 'continues'>,
): NodeCombinator<N, Type, Tags[number]> {
  return node<N, Type, Tags>(type, sequence(corner, tail), build, { ...opts, collapse: true, continues: true } as NodeOptions<Tags>)
}
