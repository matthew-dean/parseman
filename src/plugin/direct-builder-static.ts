/**
 * Build-time validation for a direct node builder that may cross a compiled
 * artifact boundary. This module deliberately belongs to the macro plugin: the
 * public parser/compiler runtime must not import Oxc or its platform bindings.
 */
import { parseSync } from 'oxc-parser'

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
 * Return lexical reads that cannot cross an artifact boundary. This is an Oxc
 * AST binding check, never a source-text heuristic: property names and plain
 * object keys are not lexical reads. The result becomes inert metadata on the
 * macro-produced node and is enforced later by the runtime IR re-lowerer.
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
  const reportUnsupportedNode = (ast: Ast): void => { unsupported.add(`unsupported ${ast.type}`) }
  const read = (ast: Ast, allowedNames: ReadonlySet<string>): void => {
    if (typeof ast.name === 'string' && allowedNames.has(ast.name)) return
    unsupported.add(typeof ast.name === 'string' ? ast.name : 'identifier')
  }
  const expression = (node: unknown, allowedNames: ReadonlySet<string>): void => {
    const ast = astChild(node)
    if (!ast) return
    switch (ast.type) {
      case 'Literal': return
      case 'Identifier': read(ast, allowedNames); return
      case 'ParenthesizedExpression': case 'ChainExpression': case 'TSAsExpression':
      case 'TSTypeAssertion': case 'TSNonNullExpression': expression(ast.expression, allowedNames); return
      case 'ArrayExpression': for (const element of astArray(ast.elements)) expression(element, allowedNames); return
      case 'ObjectExpression':
        for (const property of astArray(ast.properties)) {
          if (property.type === 'SpreadElement') { expression(property.argument, allowedNames); continue }
          if (property.type !== 'Property' || property.method === true || property.kind !== 'init') { reportUnsupportedNode(property); continue }
          if (property.computed === true) expression(property.key, allowedNames)
          expression(property.value, allowedNames)
        }
        return
      case 'MemberExpression': expression(ast.object, allowedNames); if (ast.computed === true) expression(ast.property, allowedNames); return
      case 'CallExpression': case 'NewExpression': expression(ast.callee, allowedNames); for (const argument of astArray(ast.arguments)) expression(argument, allowedNames); return
      case 'UnaryExpression': case 'UpdateExpression': expression(ast.argument, allowedNames); return
      case 'BinaryExpression': case 'LogicalExpression': case 'AssignmentExpression': expression(ast.left, allowedNames); expression(ast.right, allowedNames); return
      case 'ConditionalExpression': expression(ast.test, allowedNames); expression(ast.consequent, allowedNames); expression(ast.alternate, allowedNames); return
      case 'SequenceExpression': for (const value of astArray(ast.expressions)) expression(value, allowedNames); return
      case 'TemplateLiteral': for (const value of astArray(ast.expressions)) expression(value, allowedNames); return
      case 'SpreadElement': expression(ast.argument, allowedNames); return
      case 'ArrowFunctionExpression': {
        const nested = new Set(allowedNames)
        for (const param of astArray(ast.params)) {
          if (param.type !== 'Identifier' || typeof param.name !== 'string') { reportUnsupportedNode(param); continue }
          nested.add(param.name)
        }
        if (astChild(ast.body)?.type === 'BlockStatement') { reportUnsupportedNode(astChild(ast.body)!); return }
        expression(ast.body, nested)
        return
      }
      default: reportUnsupportedNode(ast); return
    }
  }
  if (astChild(init.body)?.type === 'BlockStatement') unsupported.add('unsupported BlockStatement')
  else expression(init.body, allowed)
  return [...unsupported]
}
