/**
 * Grammar-aware CST traversal. `createVisitor(grammar, handlers)` consumes the
 * reflection stamped on interpreted `rules()` maps and macro/compiled grammar
 * maps, precomputes tag dispatch once, and returns a reusable `visit(root)` fn.
 */
import type { CSTChild, CSTNode } from './types.ts'
import type { Combinator } from '../types.ts'
import {
  collectGrammarReflection,
  grammarReflectionOf,
  type GrammarWithReflection,
} from './reflection.ts'

export type Walkable = {
  readonly _tag: string
  readonly type?: string
  readonly children?: ReadonlyArray<Walkable>
}

type GrammarNodeType<G> =
  G extends GrammarWithReflection<infer NodeType, string>
    ? NodeType
    : G extends Record<string, unknown>
      ? Extract<keyof G, string>
      : string

type GrammarNodeTag<G> =
  G extends GrammarWithReflection<string, infer NodeTag> ? NodeTag : never

type NodeForType<N extends Walkable, Type extends string> =
  Extract<N, { readonly _tag: 'node' }> extends never
    ? CSTNode & { readonly type: Type }
    : Extract<N, { readonly _tag: 'node' }> & { readonly type: Type }

export type VisitorHandler<N extends Walkable, Root extends Walkable = CSTChild, C = undefined> =
  (node: N, parent: Root | null, ctx: C) => void

export type VisitorSpec<G, N extends Walkable = CSTChild, C = undefined> = {
  enter?(node: N, parent: N | null, ctx: C): boolean | void
  leave?(node: N, parent: N | null, ctx: C): void
  type?: {
    [K in GrammarNodeType<G>]?: VisitorHandler<NodeForType<N, K>, N, C>
  }
  tag?: {
    [K in GrammarNodeTag<G>]?: VisitorHandler<NodeForType<N, GrammarNodeType<G>>, N, C>
  }
}

function isCombinator(value: unknown): value is Combinator<unknown> {
  return !!value && typeof value === 'object'
    && '_def' in value
    && '_meta' in value
    && typeof (value as { parse?: unknown }).parse === 'function'
}

function reflectionFor(grammar: object) {
  const stamped = grammarReflectionOf(grammar)
  if (stamped) return stamped
  const entries = Object.entries(grammar).filter((entry): entry is [string, Combinator<unknown>] => isCombinator(entry[1]))
  return collectGrammarReflection(entries)
}

export function createVisitor<G extends object, N extends Walkable = CSTChild, C = undefined>(
  grammar: G,
  spec: VisitorSpec<G, N, C>,
): (root: N, ctx?: C) => void {
  const reflection = reflectionFor(grammar)
  const typeHandlers = spec.type as Record<string, VisitorHandler<N, N, C> | undefined> | undefined
  const tagSpec = spec.tag as Record<string, VisitorHandler<N, N, C> | undefined> | undefined
  const tagHandlersByType = new Map<string, Array<VisitorHandler<N, N, C>>>()

  if (tagSpec !== undefined) {
    for (const node of reflection.nodes) {
      const handlers: Array<VisitorHandler<N, N, C>> = []
      for (const tag of node.tags) {
        const handler = tagSpec[tag]
        if (handler) handlers.push(handler)
      }
      if (handlers.length > 0) tagHandlersByType.set(node.type, handlers)
    }
  }

  return (root: N, ctx: C = undefined as C): void => {
    const go = (node: N, parent: N | null): void => {
      const descend = spec.enter ? spec.enter(node, parent, ctx) : undefined
      if (node._tag === 'node' && node.type !== undefined) {
        typeHandlers?.[node.type]?.(node, parent, ctx)
        const tagHandlers = tagHandlersByType.get(node.type)
        if (tagHandlers !== undefined) {
          for (const handler of tagHandlers) handler(node, parent, ctx)
        }
      }
      const children = node.children as ReadonlyArray<N> | undefined
      if (descend !== false && Array.isArray(children)) {
        for (const child of children) go(child, node)
      }
      spec.leave?.(node, parent, ctx)
    }
    go(root, null)
  }
}
