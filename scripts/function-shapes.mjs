/**
 * FUNCTION SHAPES — one normaliser for "is this function a copy of that one".
 *
 * Used by the duplicate-function gate (`bench/dup-function-guard.ts`, over emitted and
 * printed artifacts), by INV-13 in `scripts/check-invariants.mjs` (over engine
 * source), and by the call-count instrumentation (`bench/engine-guards/instrument.ts`)
 * for its AST walk. A `.mjs` because the invariant gate runs under bare `node`.
 *
 * A function's SHAPE is its AST with comments, whitespace and positions dropped, and
 * every name the function binds itself (parameters, declarations, catch parameters)
 * renamed in order of first appearance. Free names — the constants and helpers it
 * closes over — are kept, as are property names. Two functions with one shape are one
 * function written twice, whatever their locals are called.
 */
import { createHash } from 'node:crypto'
import { parseSync } from 'oxc-parser'

/** @typedef {{ type: string, start: number, end: number, [k: string]: unknown }} AstNode */
/** @typedef {{ hash: string, chars: number, name: string, line: number }} FunctionShape */

/** @param {unknown} v @returns {v is AstNode} */
export const isNode = (v) => typeof v === 'object' && v !== null && typeof /** @type {{ type?: unknown }} */ (v).type === 'string'

const SKIP = new Set(['start', 'end', 'range', 'loc', 'raw'])

/** @param {AstNode} n @returns {AstNode[]} */
export function children(n) {
  /** @type {AstNode[]} */
  const out = []
  for (const k in n) {
    if (SKIP.has(k)) continue
    const v = n[k]
    if (Array.isArray(v)) { for (const x of v) if (isNode(x)) out.push(x) } else if (isNode(v)) out.push(v)
  }
  return out
}

export const FUNCTION = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/** Parse a module; `.ts` files as TypeScript. Throws on the first syntax error. @param {string} code @param {string} filename @returns {AstNode} */
export function parseModule(code, filename) {
  const r = parseSync(filename, code, { lang: filename.endsWith('.ts') ? 'ts' : 'js', sourceType: 'module' })
  if (r.errors.length > 0) throw new Error(`${filename}: ${r.errors[0].message}`)
  return /** @type {AstNode} */ (/** @type {unknown} */ (r.program))
}

/** Names a function binds anywhere inside itself. @param {AstNode} fn */
function boundNames(fn) {
  /** @type {Set<string>} */
  const out = new Set()
  /** @param {unknown} p */
  const pattern = (p) => {
    if (!isNode(p)) return
    if (p.type === 'Identifier') out.add(/** @type {string} */ (p.name))
    else if (p.type === 'ObjectPattern') for (const q of /** @type {AstNode[]} */ (p.properties)) pattern(q.type === 'RestElement' ? q : q.value)
    else if (p.type === 'ArrayPattern') for (const q of /** @type {unknown[]} */ (p.elements)) pattern(q)
    else if (p.type === 'RestElement') pattern(p.argument)
    else if (p.type === 'AssignmentPattern') pattern(p.left)
    else if (p.type === 'TSParameterProperty') pattern(p.parameter)
  }
  /** @param {AstNode} n */
  const walk = (n) => {
    if (FUNCTION.has(n.type)) {
      for (const p of /** @type {AstNode[]} */ (n.params)) pattern(p)
      if (n !== fn) pattern(n.id)
    }
    if (n.type === 'VariableDeclarator') pattern(n.id)
    if (n.type === 'CatchClause') pattern(n.param)
    if (n.type === 'ClassDeclaration') pattern(n.id)
    for (const c of children(n)) walk(c)
  }
  walk(fn)
  return out
}

/** One function printed with its own bindings renamed. @param {AstNode} fn @returns {string} */
function canonical(fn) {
  const bound = boundNames(fn)
  /** @type {Map<string, string>} */
  const renamed = new Map()
  /** @type {string[]} */
  const parts = []
  /** @param {AstNode} n @param {boolean} nameKept */
  const emit = (n, nameKept) => {
    if (n.type === 'Identifier' || n.type === 'PrivateIdentifier') {
      const name = /** @type {string} */ (n.name)
      if (!nameKept && bound.has(name)) {
        if (!renamed.has(name)) renamed.set(name, `$${renamed.size}`)
        parts.push(/** @type {string} */ (renamed.get(name)))
      } else parts.push(name)
      return
    }
    parts.push(n.type, '(')
    for (const k in n) {
      if (SKIP.has(k) || k === 'type' || (n === fn && k === 'id')) continue
      const v = n[k]
      // A property NAME is not a binding, even when it is spelled like one.
      const keepName = (k === 'property' || k === 'key') && n.computed === false
      if (Array.isArray(v)) {
        parts.push('[')
        for (const x of v) {
          if (isNode(x)) emit(x, false)
          else parts.push(JSON.stringify(x) ?? 'null')
          parts.push(',')
        }
        parts.push(']')
      } else if (isNode(v)) emit(v, keepName)
      else if (v !== null && typeof v === 'object') parts.push(JSON.stringify(v))
      else parts.push(String(v))
      parts.push(';')
    }
    parts.push(')')
  }
  emit(fn, false)
  return parts.join('')
}

/**
 * Every function in `code` whose body is at least `minChars` characters once
 * whitespace and comments are gone, with the hash of its shape. The floor keeps
 * one-line idioms (`() => FAIL`) from counting as copies.
 *
 * @param {string} code @param {string} filename @param {number} [minChars]
 * @returns {FunctionShape[]}
 */
export function functionShapes(code, filename, minChars = 60) {
  const program = parseModule(code, filename)
  /** @type {number[]} */
  const breaks = []
  for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) breaks.push(i)
  /** @param {number} pos */
  const lineAt = (pos) => {
    let lo = 0
    let hi = breaks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (breaks[mid] < pos) lo = mid + 1
      else hi = mid
    }
    return lo + 1
  }
  /** @type {FunctionShape[]} */
  const out = []
  /** @param {AstNode} n @param {string} name */
  const walk = (n, name) => {
    if (FUNCTION.has(n.type)) {
      const body = /** @type {AstNode} */ (n.body)
      const chars = code.slice(body.start, body.end).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|\s+/g, '').length
      if (chars >= minChars) {
        const id = n.id
        out.push({
          hash: createHash('sha256').update(canonical(n)).digest('hex').slice(0, 16),
          chars,
          name: isNode(id) ? /** @type {string} */ (id.name) : name,
          line: lineAt(n.start),
        })
      }
    }
    const named = n.type === 'VariableDeclarator' ? n.id : n.type === 'Property' || n.type === 'MethodDefinition' ? n.key : null
    const nextName = isNode(named) && named.type === 'Identifier' ? /** @type {string} */ (named.name) : '<anon>'
    for (const c of children(n)) walk(c, nextName)
  }
  walk(program, '<anon>')
  return out
}

/** Copies beyond the first, summed over every shape that occurs more than once. @param {readonly FunctionShape[]} shapes */
export function duplicateCount(shapes) {
  /** @type {Map<string, number>} */
  const seen = new Map()
  for (const f of shapes) seen.set(f.hash, (seen.get(f.hash) ?? 0) + 1)
  let dup = 0
  for (const n of seen.values()) if (n > 1) dup += n - 1
  return dup
}
