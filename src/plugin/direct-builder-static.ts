/**
 * Build-time validation for a direct node builder that may cross a compiled
 * artifact boundary. This module deliberately belongs to the macro plugin: the
 * public parser/compiler runtime must not import Oxc or its platform bindings.
 */
import { parseSync } from 'oxc-parser'

const STATIC_BUILDER_GLOBALS = new Set([
  'Array', 'Boolean', 'Date', 'JSON', 'Math', 'NaN', 'Number', 'Object', 'String',
  'Infinity', 'parseFloat', 'parseInt', 'undefined',
  // Frozen intrinsic error constructors. Reducers pervasively `throw new TypeError(…)`;
  // once the statement walker walks a `throw` argument these surface as free names, and
  // refusing them would re-refuse the very productions the block-body lift clears. They
  // carry no closure state, so admitting them cannot make an unanalyzable builder
  // analyzable by accident. A MODULE-SCOPE custom error stays a free name (rescued by
  // provenance or refused) — unchanged.
  'Error', 'TypeError', 'RangeError', 'SyntaxError',
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
 *
 * Kept as the combined `structural ++ free` list so every existing caller and the
 * standalone unit gate see one flat array. `directBuilderBindings` exposes the
 * split the provenance path needs.
 */
export function directBuilderUnsupportedBindings(src: string): string[] {
  const r = directBuilderBindings(src)
  return [...r.structural, ...r.free]
}

/**
 * The analysis, SPLIT into two kinds of unsupported binding:
 *
 * - `structural` — a refusal no provenance can rescue: an un-analyzable node
 *   kind, a non-Identifier parameter, `this` / `arguments`, an async or generator
 *   reducer. These fail closed and fall back to the interpreter.
 * - `free` — a plain lexical read of a name declared OUTSIDE the builder. Such a
 *   name is a refusal on its own, but it CAN be re-bound in a downstream module if
 *   that module re-emits the import it came from. The evaluator resolves each free
 *   name against the authoring module's imports: one that resolves is carried as
 *   import provenance; one that does not stays a refusal.
 */
export function directBuilderBindings(src: string): { structural: string[]; free: string[] } {
  let init: Ast | undefined
  try {
    const parsed = parseSync('parseman-direct-builder.ts', `const _direct = (${src})`)
    if (parsed.errors.length > 0) return { structural: ['invalid callback source'], free: [] }
    const program = parsed.program as unknown as Ast
    const statementNode = (program.body as Ast[] | undefined)?.[0]
    const declaration = (statementNode?.declarations as Ast[] | undefined)?.[0]
    init = unwrapCallbackExpression(declaration?.init as Ast | undefined)
  } catch {
    return { structural: ['invalid callback source'], free: [] }
  }
  // A direct builder is an arrow OR a resolved `function` reducer (a bare reference
  // to a top-level `function foldOperation(…) {…}` resolves to a FunctionExpression
  // here). Both inline verbatim into the fused table. An async or generator reducer
  // is NOT a pure synchronous builder and stays refused.
  if (init === undefined) return { structural: ['unsupported callback shape'], free: [] }
  const isCallable = init.type === 'ArrowFunctionExpression'
    || init.type === 'FunctionExpression'
    || init.type === 'FunctionDeclaration'
  if (!isCallable || !Array.isArray(init.params)) return { structural: ['unsupported callback shape'], free: [] }
  if (init.async === true || init.generator === true) return { structural: ['unsupported callback shape'], free: [] }
  const allowed = new Set(STATIC_BUILDER_GLOBALS)
  for (const param of init.params as Ast[]) {
    if (param.type !== 'Identifier' || typeof param.name !== 'string') return { structural: ['unsupported parameter pattern'], free: [] }
    allowed.add(param.name)
  }
  // A named function expression binds its own name inside its body (recursion), so
  // an inlined `function foldOperation(…) { … foldOperation(…) … }` is self-contained.
  const selfName = astChild(init.id)
  if (selfName?.type === 'Identifier' && typeof selfName.name === 'string') allowed.add(selfName.name)

  const structural = new Set<string>()
  const free = new Set<string>()
  const reportUnsupportedNode = (ast: Ast): void => { structural.add(`unsupported ${ast.type}`) }
  const read = (ast: Ast, allowedNames: ReadonlySet<string>): void => {
    if (typeof ast.name === 'string' && allowedNames.has(ast.name)) return
    // `arguments` is a function-only binding that no import can supply; refuse it
    // structurally rather than letting it masquerade as a rescuable free name.
    if (ast.name === 'arguments') { structural.add('unsupported arguments'); return }
    if (typeof ast.name === 'string') free.add(ast.name)
    else structural.add('unsupported identifier')
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
        // A nested arrow with a block body is carried as source and inlined verbatim,
        // exactly like the top-level builder — walk it, do not refuse it.
        const nestedBody = astChild(ast.body)
        if (nestedBody?.type === 'BlockStatement') { statement(nestedBody, nested); return }
        expression(ast.body, nested)
        return
      }
      default: reportUnsupportedNode(ast); return
    }
  }
  // A block body is not a SERIALIZATION limit — `buildSrc` is carried as text and
  // inlined verbatim downstream, so a statement inlines exactly as an expression
  // does. The refusal was an ANALYZER gap: the walker only knew expressions. Walk
  // statements too and the refusal disappears for the shapes grammar reducers use.
  const statement = (node: unknown, names: Set<string>): void => {
    const ast = astChild(node)
    if (!ast) return
    switch (ast.type) {
      case 'VariableDeclaration':
        for (const d of astArray(ast.declarations)) {
          expression(d.init, names)
          const idAst = astChild(d.id)
          if (idAst?.type === 'Identifier' && typeof idAst.name === 'string') names.add(idAst.name)
          else reportUnsupportedNode(idAst ?? ast)
        }
        return
      case 'ReturnStatement': expression(ast.argument, names); return
      case 'ExpressionStatement': expression(ast.expression, names); return
      case 'ThrowStatement': expression(ast.argument, names); return
      case 'IfStatement':
        expression(ast.test, names)
        statement(ast.consequent, new Set(names))
        if (ast.alternate) statement(ast.alternate, new Set(names))
        return
      case 'ForStatement': {
        // The init's bindings (`index`) are visible to test / update / body but must
        // not leak to the enclosing scope — hence the child set.
        const inner = new Set(names)
        if (ast.init) {
          const initAst = astChild(ast.init)
          if (initAst?.type === 'VariableDeclaration') statement(initAst, inner)
          else expression(initAst, inner)
        }
        if (ast.test) expression(ast.test, inner)
        if (ast.update) expression(ast.update, inner)
        statement(ast.body, inner)
        return
      }
      case 'ForOfStatement': case 'ForInStatement': {
        // The iterable (`ast.right`) is read in the OUTER scope; the loop variable is
        // in scope only for the body. A non-declaration target (`for (x of …)`, a
        // destructuring or member target) is refused by the statement walker.
        const inner = new Set(names)
        statement(ast.left, inner)
        expression(ast.right, names)
        statement(ast.body, inner)
        return
      }
      case 'BlockStatement': { const inner = new Set(names); for (const s of astArray(ast.body)) statement(s, inner); return }
      case 'BreakStatement': case 'ContinueStatement': case 'EmptyStatement': return
      default: reportUnsupportedNode(ast); return
    }
  }
  const bodyAst = astChild(init.body)
  if (bodyAst?.type === 'BlockStatement') statement(bodyAst, allowed)
  else expression(init.body, allowed)
  return { structural: [...structural], free: [...free] }
}
