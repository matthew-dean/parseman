/**
 * Statically evaluates parseman combinator call expressions from an oxc AST
 * into actual Combinator<unknown> objects by calling the real library functions.
 *
 * Returns null for anything unresolvable (user closures, external variables,
 * template literals, computed keys, etc.) — callers leave those as-is.
 */
import type { Expression, Node } from '@oxc-project/types'
import type { Combinator } from '../types.ts'
import * as parseman from '../index.ts'

export type Scope = Map<string, Combinator<unknown>>

const SUPPORTED: Record<string, (...args: unknown[]) => Combinator<unknown>> = {
  literal:   (...a) => parseman.literal(a[0] as string, a[1] as parseman.LiteralOptions | undefined),
  regex:     (...a) => parseman.regex(a[0] as RegExp, a[1] as string | undefined),
  sequence:  (...a) => (parseman.sequence as (...p: Combinator<unknown>[]) => Combinator<unknown[]>)(...(a as Combinator<unknown>[])),
  choice:    (...a) => (parseman.choice as (...p: Combinator<unknown>[]) => Combinator<unknown>)(...(a as Combinator<unknown>[])),
  many:      (...a) => parseman.many(a[0] as Combinator<unknown>),
  oneOrMore: (...a) => parseman.oneOrMore(a[0] as Combinator<unknown>),
  optional:  (...a) => parseman.optional(a[0] as Combinator<unknown>),
  sepBy:     (...a) => parseman.sepBy(a[0] as Combinator<unknown>, a[1] as Combinator<unknown>),
}

/** Try to evaluate an oxc AST Expression as a parseman Combinator. Returns null if impossible.
 *
 * When `code` and `mapFnSources` are provided, `transform()` calls are also evaluated:
 * the callback source text is pushed to `mapFnSources` in emit order so the plugin can
 * inject them directly into the compiled inline expression.
 */
export function evaluateExpr(
  node: Expression,
  scope: Scope,
  code?: string,
  mapFnSources?: string[],
): Combinator<unknown> | null {
  if (node.type === 'Identifier') return scope.get(node.name) ?? null

  if (node.type !== 'CallExpression') return null

  const callee = node.callee
  if (callee.type !== 'Identifier') return null

  // transform(inner, fn) — evaluate inner recursively (which may push nested map fn sources),
  // then capture fn's source text. Order matches codegen's depth-first emit traversal.
  if (callee.name === 'transform' && code !== undefined && mapFnSources !== undefined) {
    const [parserArg, fnArg] = node.arguments
    if (!parserArg || !fnArg || parserArg.type === 'SpreadElement' || fnArg.type === 'SpreadElement') return null
    const inner = evaluateArg(parserArg as Expression, scope, code, mapFnSources)
    if (inner === null) return null
    mapFnSources.push(code.slice((fnArg as Expression).start, (fnArg as Expression).end))
    try {
      // Dummy fn — only the source text matters for the macro; the inline expression
      // will reference the real fn from the user's module scope.
      return parseman.transform(inner as Combinator<unknown>, (v: unknown) => v)
    } catch {
      return null
    }
  }

  const factory = SUPPORTED[callee.name]
  if (!factory) return null

  const args = node.arguments.map(arg => {
    if (arg.type === 'SpreadElement') return null
    return evaluateArg(arg as Expression, scope, code, mapFnSources)
  })
  if (args.some(a => a === null)) return null

  try {
    return factory(...(args as unknown[]))
  } catch {
    return null
  }
}

/** Evaluate any expression to its JS value (string, number, boolean, RegExp, object, or Combinator). */
function evaluateArg(
  node: Expression,
  scope: Scope,
  code?: string,
  mapFnSources?: string[],
): unknown {
  // oxc unifies all literal types under type: "Literal", discriminated by value/regex shape
  if (node.type === 'Literal') {
    if ('regex' in node && node.regex !== null && node.regex !== undefined) {
      return new RegExp(node.regex.pattern, node.regex.flags)
    }
    return node.value  // string | number | boolean | null
  }

  if (node.type === 'ObjectExpression') {
    const obj: Record<string, unknown> = {}
    for (const prop of node.properties) {
      if (prop.type !== 'Property') return null
      if (prop.computed) return null
      const key = prop.key.type === 'Identifier' ? prop.key.name
        : prop.key.type === 'Literal' ? String(prop.key.value)
        : null
      if (key === null) return null
      obj[key] = evaluateArg(prop.value as Expression, scope, code, mapFnSources)
    }
    return obj
  }

  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return undefined
    return scope.get(node.name) ?? null
  }

  if (node.type === 'CallExpression') return evaluateExpr(node, scope, code, mapFnSources)

  return null
}

/** Check if an AST node references any name from the given set (used to detect parseman usage). */
export function referencesAny(node: Node, names: Set<string>, scope: Scope): boolean {
  if (node.type === 'Identifier') {
    return names.has(node.name) || scope.has(node.name)
  }
  for (const key of Object.keys(node) as (keyof typeof node)[]) {
    const child = node[key]
    if (!child || typeof child !== 'object') continue
    if (Array.isArray(child)) {
      if (child.some(c => c && typeof c === 'object' && 'type' in c && referencesAny(c as Node, names, scope))) return true
    } else if ('type' in child) {
      if (referencesAny(child as Node, names, scope)) return true
    }
  }
  return false
}
