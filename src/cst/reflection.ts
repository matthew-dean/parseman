import type { Combinator, ParserDef } from '../types.ts'

export const GRAMMAR_REFLECTION: unique symbol = Symbol.for('parseman.grammarReflection') as never
export const NODE_TYPE: unique symbol = Symbol.for('parseman.type.nodeType') as never
export const NODE_TAG: unique symbol = Symbol.for('parseman.type.nodeTag') as never

export type GrammarNodeReflection = {
  type: string
  tags: readonly string[]
}

export type GrammarReflection = {
  nodes: readonly GrammarNodeReflection[]
}

export type GrammarWithReflection<
  NodeType extends string = string,
  NodeTag extends string = string,
> = {
  readonly [GRAMMAR_REFLECTION]?: GrammarReflection
  readonly [NODE_TYPE]?: NodeType
  readonly [NODE_TAG]?: NodeTag
}

type NodeDef = Extract<ParserDef, { tag: 'node' }>

function childrenOf(def: ParserDef): readonly Combinator<unknown>[] {
  switch (def.tag) {
    case 'sequence':
    case 'choice':
      return def.parsers
    case 'dispatch':
      return [
        def.selector,
        ...def.cases.map(c => c.parser),
        ...(def.matchers ? def.matchers.map(c => c.parser) : []),
        ...(def.otherwise ? [def.otherwise] : []),
      ]
    case 'many':
    case 'oneOrMore':
    case 'optional':
    case 'attempt':
    case 'transform':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'label':
    case 'field':
    case 'not':
    case 'peek':
    case 'node':
    case 'withCtx':
    case 'expect':
      return [def.parser]
    case 'recover':
      return [def.parser, def.sentinel]
    case 'grammar':
      return def.triviaParser ? [def.parser, def.triviaParser] : [def.parser]
    case 'sepBy':
      return [def.parser, def.separator]
    case 'scanTo':
      return [def.sentinel, ...def.skip]
    case 'routed':
      return def.fallback ? [def.fallback] : []
    case 'literal':
    case 'regex':
    case 'keywords':
    case 'guard':
    case 'adjacency':
    case 'lazy':
    case 'unknown':
      return []
  }
}

function addNode(out: Map<string, string[]>, def: NodeDef): void {
  if (def.type === undefined) return
  const existing = out.get(def.type)
  if (existing === undefined) {
    out.set(def.type, def.tags === undefined ? [] : [...def.tags])
    return
  }
  if (def.tags === undefined) return
  for (const tag of def.tags) {
    if (!existing.includes(tag)) existing.push(tag)
  }
}

function collectFromCombinator(
  parser: Combinator<unknown>,
  out: Map<string, string[]>,
  seen: Set<Combinator<unknown>>,
  followLazy = true,
): void {
  if (seen.has(parser)) return
  seen.add(parser)
  const def = parser._def
  if (def.tag === 'lazy') {
    if (followLazy) {
      try { collectFromCombinator(def.thunk(), out, seen, followLazy) } catch {}
    }
    return
  }
  if (def.tag === 'node') addNode(out, def)
  for (const child of childrenOf(def)) collectFromCombinator(child, out, seen, followLazy)
}

export function collectGrammarReflection(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opts?: { followLazy?: boolean },
): GrammarReflection {
  const byType = new Map<string, string[]>()
  const followLazy = opts?.followLazy !== false
  for (const [, rule] of ruleMap) {
    if (!followLazy && rule._def.tag === 'lazy') {
      try {
        const resolved = rule._def.thunk()
        if (resolved._def.tag !== 'lazy') collectFromCombinator(resolved, byType, new Set(), false)
      } catch {}
      continue
    }
    collectFromCombinator(rule, byType, new Set(), followLazy)
  }
  return { nodes: [...byType].map(([type, tags]) => ({ type, tags })) }
}

export function mergeGrammarReflections(reflections: readonly GrammarReflection[]): GrammarReflection {
  const byType = new Map<string, string[]>()
  for (const reflection of reflections) {
    for (const node of reflection.nodes) {
      const tags = byType.get(node.type)
      if (tags === undefined) {
        byType.set(node.type, [...node.tags])
        continue
      }
      for (const tag of node.tags) {
        if (!tags.includes(tag)) tags.push(tag)
      }
    }
  }
  return { nodes: [...byType].map(([type, tags]) => ({ type, tags })) }
}

export function attachGrammarReflection<T extends object>(grammar: T, reflection: GrammarReflection): T {
  Object.defineProperty(grammar, GRAMMAR_REFLECTION, { value: reflection, enumerable: false, configurable: true })
  return grammar
}

export function grammarReflectionOf(grammar: object): GrammarReflection | undefined {
  return (grammar as GrammarWithReflection)[GRAMMAR_REFLECTION]
}

export function grammarReflectionSource(reflection: GrammarReflection): string {
  return `{ nodes: ${JSON.stringify(reflection.nodes)} }`
}
