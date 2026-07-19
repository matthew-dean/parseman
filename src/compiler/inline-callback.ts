/** Builtins allowed in inlined transform bodies (not treated as free closure refs). */
import { parseSync } from 'oxc-parser'

const INLINE_BUILTINS = new Set([
  'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Object', 'Array', 'Math', 'JSON',
  'undefined', 'null', 'true', 'false', 'NaN', 'Infinity',
])

const STATIC_BUILDER_GLOBALS = new Set([
  'Array', 'Boolean', 'Date', 'JSON', 'Math', 'NaN', 'Number', 'Object', 'String',
  'Infinity', 'parseFloat', 'parseInt', 'undefined',
])

type Ast = { type: string; [key: string]: unknown }

function astArray(value: unknown): Ast[] {
  return Array.isArray(value) ? value as Ast[] : []
}

function astChild(value: unknown): Ast | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Ast
    : null
}

function unwrapCallbackExpression(node: Ast | undefined): Ast | undefined {
  let current = node
  while (current?.type === 'ParenthesizedExpression') current = astChild(current.expression) ?? undefined
  return current
}

/**
 * Validate callback source with Oxc before it crosses the IR boundary. We accept
 * the deliberately small portable subset: an expression arrow with identifier
 * parameters and an expression body that reads only those parameters or standard
 * globals. This is deliberately an AST binding check rather than a source-text
 * heuristic: identifier property names and object keys are not lexical reads.
 * No closure transport or runtime factory is involved.
 */
export function directBuilderUnsupportedBindings(src: string): string[] {
  let init: Ast | undefined
  try {
    const parsed = parseSync('parseman-direct-builder.ts', `const _direct = (${src})`)
    if (parsed.errors.length > 0) return ['invalid callback source']
    const program = parsed.program as unknown as Ast
    const statement = (program.body as Ast[] | undefined)?.[0]
    const declaration = (statement?.declarations as Ast[] | undefined)?.[0]
    init = unwrapCallbackExpression(declaration?.init as Ast | undefined)
  } catch {
    return ['invalid callback source']
  }
  if (init?.type !== 'ArrowFunctionExpression' || !Array.isArray(init.params)) return ['unsupported callback shape']
  const allowed = new Set(STATIC_BUILDER_GLOBALS)
  for (const param of init.params as Ast[]) {
    if (param.type !== 'Identifier' || typeof param.name !== 'string') return ['unsupported parameter pattern']
    allowed.add(param.name)
  }
  const unsupported = new Set<string>()
  const reportUnsupportedNode = (ast: Ast): void => {
    unsupported.add(`unsupported ${ast.type}`)
  }
  const read = (ast: Ast, allowedNames: ReadonlySet<string>): void => {
    if (typeof ast.name === 'string' && allowedNames.has(ast.name)) return
    unsupported.add(typeof ast.name === 'string' ? ast.name : 'identifier')
  }
  const expression = (node: unknown, allowedNames: ReadonlySet<string>): void => {
    const ast = astChild(node)
    if (!ast) return
    switch (ast.type) {
      case 'Literal': return
      case 'Identifier':
        read(ast, allowedNames)
        return
      case 'ParenthesizedExpression': case 'ChainExpression': case 'TSAsExpression':
      case 'TSTypeAssertion': case 'TSNonNullExpression':
        expression(ast.expression, allowedNames)
        return
      case 'ArrayExpression':
        for (const element of astArray(ast.elements)) expression(element, allowedNames)
        return
      case 'ObjectExpression':
        for (const property of astArray(ast.properties)) {
          if (property.type === 'SpreadElement') {
            expression(property.argument, allowedNames)
            continue
          }
          // Non-computed object keys name a property; only computed keys read.
          if (property.type !== 'Property' || property.method === true || property.kind !== 'init') {
            reportUnsupportedNode(property)
            continue
          }
          if (property.computed === true) expression(property.key, allowedNames)
          expression(property.value, allowedNames)
        }
        return
      case 'MemberExpression':
        expression(ast.object, allowedNames)
        // `value.length` reads `value`, not a lexical `length` binding.
        if (ast.computed === true) expression(ast.property, allowedNames)
        return
      case 'CallExpression': case 'NewExpression':
        expression(ast.callee, allowedNames)
        for (const argument of astArray(ast.arguments)) expression(argument, allowedNames)
        return
      case 'UnaryExpression': case 'UpdateExpression':
        expression(ast.argument, allowedNames)
        return
      case 'BinaryExpression': case 'LogicalExpression': case 'AssignmentExpression':
        expression(ast.left, allowedNames)
        expression(ast.right, allowedNames)
        return
      case 'ConditionalExpression':
        expression(ast.test, allowedNames)
        expression(ast.consequent, allowedNames)
        expression(ast.alternate, allowedNames)
        return
      case 'TemplateLiteral':
        for (const value of astArray(ast.expressions)) expression(value, allowedNames)
        return
      case 'SpreadElement':
        expression(ast.argument, allowedNames)
        return
      case 'ArrowFunctionExpression': {
        // A nested expression-arrow is self-contained when its own parameters
        // plus the enclosing legal bindings cover all of its lexical reads.
        const nested = new Set(allowedNames)
        for (const param of astArray(ast.params)) {
          if (param.type !== 'Identifier' || typeof param.name !== 'string') {
            reportUnsupportedNode(param)
            continue
          }
          nested.add(param.name)
        }
        if (astChild(ast.body)?.type === 'BlockStatement') {
          reportUnsupportedNode(astChild(ast.body)!)
          return
        }
        expression(ast.body, nested)
        return
      }
      default:
        reportUnsupportedNode(ast)
        return
    }
  }
  // A block body is valid JavaScript, but allowing local declarations requires a
  // complete statement-scope model. Rejecting it is intentional: direct builders
  // cross an artifact boundary and must remain a small, portable expression.
  if (astChild(init.body)?.type === 'BlockStatement') {
    unsupported.add('unsupported BlockStatement')
  } else {
    expression(init.body, allowed)
  }
  return [...unsupported]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Source text for a transform callback — macro `fnSrc` or arrow `toString()`. */
export function transformFnSource(fn: Function, fnSrc?: string | null): string | null {
  if (fnSrc) return fnSrc.trim()
  const s = fn.toString().trim()
  if (s.includes('[native code]')) return null
  return s
}

function replaceParam(body: string, param: string, valueVar: string): string {
  return body.replace(new RegExp(`\\b${escapeRegExp(param)}\\b`, 'g'), valueVar)
}

function stripForIdCheck(body: string): string {
  return body
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
    .replace(/\bas\s+const\b/g, '')
    .replace(/\b[A-Za-z_$][\w$]*\s*:/g, ':')
}

function hasFreeIdentifiers(body: string, allowed: ReadonlySet<string>): boolean {
  const stripped = stripForIdCheck(body)
  const ids = stripped.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []
  for (const id of ids) {
    if (INLINE_BUILTINS.has(id)) continue
    if (allowed.has(id)) continue
    return true
  }
  return false
}

/** `s => expr` / `() => expr` when expr only uses the param (+ builtins). */
export function tryInlineUnaryTransform(src: string, valueVar: string): string | null {
  const allowed = new Set([valueVar])
  const nullary = src.match(/^\(\s*\)\s*=>\s*(.+)$/)
  if (nullary) {
    const body = nullary[1]!.trim()
    return hasFreeIdentifiers(body, allowed) ? null : body
  }
  const m = src.match(/^(\w+)\s*=>\s*(.+)$/)
  if (!m) return null
  const body = replaceParam(m[2]!.trim(), m[1]!, valueVar)
  return hasFreeIdentifiers(body, allowed) ? null : body
}

/** Parse `[a, , c]` destructuring slots (null = ignore). */
export function parseArrayDestructure(pattern: string, arity: number): (string | null)[] {
  const slots: (string | null)[] = []
  for (const part of pattern.split(',')) {
    const name = part.trim()
    slots.push(name === '' || name === '_' ? null : name)
  }
  while (slots.length < arity) slots.push(null)
  return slots.slice(0, arity)
}

/**
 * `([x, y]) => body` — substitute destructure names with sequence value vars.
 * Caller must ensure body only references slotted params (+ builtins).
 */
export function tryInlineDestructureTransform(
  src: string,
  valueVars: string[],
): string | null {
  const m = src.match(/^\(\s*\[([^\]]*)\]\s*\)\s*=>\s*(.+)$/s)
  if (!m) return null
  const slots = parseArrayDestructure(m[1]!, valueVars.length)
  let body = m[2]!.trim()
  const allowed = new Set(valueVars)
  for (let i = 0; i < slots.length; i++) {
    const name = slots[i]
    if (name) body = replaceParam(body, name, valueVars[i]!)
  }
  return hasFreeIdentifiers(body, allowed) ? null : body
}
