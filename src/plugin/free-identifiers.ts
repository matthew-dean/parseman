/**
 * Emit-time scope check: does the module parseman is about to hand back name
 * anything that nothing binds?
 *
 * Lowering DELETES code — the `rules(...)` call sites, the `x.define(...)`
 * statements, and finally the macro import itself. Every one of those deletions
 * is only safe because the text that referenced the deleted binding was deleted
 * too. When a shape slips through where it wasn't, the artifact still builds,
 * still imports, and throws `ReferenceError` the first time a consumer touches
 * the binding — in the consumer's process, long after publish.
 *
 * The specific shapes are refused where they are recognised (an exported
 * `rules()` factory is thrown on in index.ts before we ever get here). This is
 * the net beneath them: it does not know or care HOW a name escaped, only that
 * the emitted module reads it and nothing in the module binds it.
 *
 * Two deliberate design points:
 *
 * 1. SCOPE ANALYSIS, NOT GREP. A text scan for the macro names reports `node`,
 *    `rule`, `not` and `field` in hand-written host modules — they are ordinary
 *    parameter and property names — and a check that cries wolf is a check
 *    people learn to pass with a comment. Only an identifier in a READ position
 *    with no binding counts.
 *
 * 2. FLAT BINDINGS, NOT A SCOPE TREE. A name is considered bound if ANYTHING in
 *    the module binds it, in any scope. That is deliberately weaker than real
 *    scope resolution: it cannot see a name that is bound in a sibling scope and
 *    free in this one. It is also structurally incapable of the false positive
 *    that would make this check worthless, and the failure it exists to catch —
 *    a name whose ONLY binding was the deleted import — is caught exactly.
 *
 * Build-time only. Nothing here runs in, or is emitted into, the artifact.
 */
import { parseSync } from 'oxc-parser'

export type FreeIdentifier = {
  /** The identifier that is read but bound by nothing. */
  name: string
  /** 1-based line in the EMITTED module. */
  line: number
  /** 1-based column in the emitted module. */
  column: number
  /**
   * The top-level declaration the read sits inside — `export const cssFactory`,
   * `function build`, … — or null if it is at statement level. This is what turns
   * "free identifier `sequence`" into a place to go and look.
   */
  enclosing: string | null
}

/** Per-top-level-statement facts, for the reachability filter. */
type TopLevel = {
  /** Names this statement binds at module level. */
  declared: Set<string>
  /** `export`ed, so the module system can reach it however unreferenced it looks. */
  exported: boolean
  /** A binding whose value is only produced by CALLING it — a function/arrow initializer. */
  declaresOnlyFunctions: boolean
  label: string | null
}

type AnyNode = { type: string } & Record<string, unknown>

const isNode = (v: unknown): v is AnyNode =>
  typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string'

/**
 * Type-land keys. The emitted module is TypeScript, and a type annotation names
 * types — `Combinator`, `Record`, `HostMode` — which are not value bindings and
 * must never be read as references.
 */
const TYPE_KEYS = new Set([
  'typeAnnotation', 'returnType', 'typeParameters', 'typeArguments',
  'superTypeArguments', 'typeName', 'implements', 'extends', 'accessibility',
])

/**
 * TS wrapper nodes that DO contain a real value expression. Everything else whose
 * type starts with `TS` is pure type-land and is skipped whole.
 */
const TS_VALUE_WRAPPERS = new Set([
  'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression',
  'TSInstantiationExpression', 'TSTypeAssertion',
])

/**
 * Names that are legitimately free in a module: the host environment provides
 * them. Taken from the live `globalThis` rather than a hand-kept list — the check
 * runs in the build's own Node process, so this is the set that actually exists —
 * plus the implicit bindings and the browser/CJS names a Node build host lacks but
 * a published artifact may legitimately expect.
 */
const HOST_GLOBALS = new Set<string>([
  ...Object.getOwnPropertyNames(globalThis),
  'undefined', 'NaN', 'Infinity', 'globalThis', 'arguments',
  'window', 'document', 'self', 'navigator', 'location', 'top', 'parent',
  'require', 'module', 'exports', '__dirname', '__filename',
])

/** Collect every name the pattern BINDS. Default values inside it are references, not bindings. */
function bindPattern(pattern: unknown, out: Set<string>): void {
  if (!isNode(pattern)) return
  switch (pattern.type) {
    case 'Identifier':
    case 'BindingIdentifier':
      out.add(String(pattern.name))
      return
    case 'ObjectPattern':
      for (const prop of (pattern.properties as unknown[]) ?? []) {
        if (!isNode(prop)) continue
        if (prop.type === 'RestElement' || prop.type === 'BindingRestElement') bindPattern(prop.argument, out)
        else bindPattern(prop.value, out)
      }
      return
    case 'ArrayPattern':
      for (const el of (pattern.elements as unknown[]) ?? []) bindPattern(el, out)
      return
    case 'AssignmentPattern':
      bindPattern(pattern.left, out)
      return
    case 'RestElement':
    case 'BindingRestElement':
      bindPattern(pattern.argument, out)
      return
    case 'TSParameterProperty':
      bindPattern(pattern.parameter, out)
      return
    default:
      return
  }
}

/** Every name bound ANYWHERE in the module, in any scope. See the header for why flat. */
function collectBindings(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectBindings(child, out)
    return
  }
  if (!isNode(node)) return

  switch (node.type) {
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      if (isNode(node.local)) out.add(String(node.local.name))
      break
    case 'VariableDeclarator':
      bindPattern(node.id, out)
      break
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'TSDeclareFunction':
    case 'ArrowFunctionExpression':
      if (isNode(node.id)) out.add(String(node.id.name))
      for (const p of ((node.params as AnyNode | undefined)?.items as unknown[] | undefined)
        ?? (node.params as unknown[] | undefined) ?? []) bindPattern(p, out)
      if (isNode(node.params) && node.params.rest) bindPattern(node.params.rest, out)
      break
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (isNode(node.id)) out.add(String(node.id.name))
      break
    case 'CatchClause':
      if (node.param) {
        // oxc wraps it: CatchParameter { pattern }. ESTree puts the pattern directly.
        bindPattern(isNode(node.param) && node.param.pattern ? node.param.pattern : node.param, out)
      }
      break
    default:
      break
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    collectBindings(node[key], out)
  }
}

const FUNCTION_TYPES = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'])

/** What a top-level statement declares, exports, and is called, for the diagnostic and the filter. */
function describeTopLevel(stmt: AnyNode): TopLevel {
  const declared = new Set<string>()
  let target: AnyNode = stmt
  let prefix = ''
  let exported = false
  if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
    exported = true
    prefix = 'export '
    if (!isNode(stmt.declaration)) return { declared, exported, declaresOnlyFunctions: false, label: `${prefix}{ … }` }
    target = stmt.declaration
  }

  if (target.type === 'VariableDeclaration') {
    const decls = ((target.declarations as unknown[]) ?? []).filter(isNode)
    for (const d of decls) bindPattern(d.id, declared)
    const declaresOnlyFunctions = decls.length > 0
      && decls.every(d => isNode(d.init) && FUNCTION_TYPES.has(d.init.type))
    const name = [...declared][0]
    return {
      declared, exported, declaresOnlyFunctions,
      label: name ? `${prefix}${String(target.kind)} ${name}` : null,
    }
  }
  if (target.type === 'FunctionDeclaration' && isNode(target.id)) {
    declared.add(String(target.id.name))
    return { declared, exported, declaresOnlyFunctions: true, label: `${prefix}function ${String(target.id.name)}` }
  }
  if (target.type === 'ClassDeclaration' && isNode(target.id)) {
    declared.add(String(target.id.name))
    return { declared, exported, declaresOnlyFunctions: false, label: `${prefix}class ${String(target.id.name)}` }
  }
  return { declared, exported, declaresOnlyFunctions: false, label: null }
}

/**
 * Every identifier the emitted module READS but nothing binds.
 *
 * Returns an empty array when the module can't be parsed: a check that can't see
 * the code has nothing to say about it, and refusing to emit on a parse failure
 * would turn this into a second, worse syntax error.
 */
export function findFreeIdentifiers(code: string, filename: string): FreeIdentifier[] {
  let parsed: ReturnType<typeof parseSync>
  try {
    parsed = parseSync(filename, code)
  } catch {
    return []
  }
  if (parsed.errors.length > 0) return []

  const bound = new Set<string>()
  collectBindings(parsed.program.body, bound)

  // Line starts, so a byte offset becomes line:column without rescanning the file.
  const lineStarts = [0]
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1)
  const positionOf = (offset: number): { line: number; column: number } => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: offset - lineStarts[lo]! + 1 }
  }

  const statements = (parsed.program.body as unknown[]).filter(isNode)
  const tops = statements.map(describeTopLevel)

  type Candidate = FreeIdentifier & { stmt: number; insideFunction: boolean }
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  /** name -> indices of the top-level statements that READ it. Drives the reachability filter. */
  const readIn = new Map<string, Set<number>>()

  const visit = (node: unknown, stmt: number, insideFunction: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, stmt, insideFunction)
      return
    }
    if (!isNode(node)) return

    const type = node.type

    // Import declarations bind; nothing in them reads.
    if (type === 'ImportDeclaration' || type === 'ExportAllDeclaration') return
    // `import.meta` / `new.target` — neither half is an identifier reference.
    if (type === 'MetaProperty' || type === 'PrivateIdentifier') return
    // `export { x } from './m'` re-exports; `x` is the OTHER module's name, not a local read.
    if (type === 'ExportNamedDeclaration' && node.source) return
    // Type-land. The wrappers carry a real expression; everything else is types only.
    if (type.startsWith('TS')) {
      if (TS_VALUE_WRAPPERS.has(type)) visit(node.expression, stmt, insideFunction)
      return
    }

    if (type === 'Identifier' || type === 'IdentifierReference') {
      const name = String(node.name)
      let readers = readIn.get(name)
      if (!readers) readIn.set(name, readers = new Set())
      readers.add(stmt)
      if (bound.has(name) || HOST_GLOBALS.has(name)) return
      const offset = typeof node.start === 'number' ? node.start : 0
      const { line, column } = positionOf(offset)
      const key = `${name}@${line}:${column}`
      if (seen.has(key)) return
      seen.add(key)
      candidates.push({ name, line, column, enclosing: tops[stmt]!.label, stmt, insideFunction })
      return
    }

    const nowInsideFunction = insideFunction || FUNCTION_TYPES.has(type)

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      if (TYPE_KEYS.has(key)) continue

      // A non-computed key is a NAME, not a read: `{ node: 1 }`, `x.field`, `class { rule() {} }`.
      if (key === 'key' && node.computed !== true) continue
      if (key === 'property' && node.computed !== true) continue
      // Labels: `outer: for (…) { break outer }` — neither position is a value.
      if (key === 'label') continue
      // `export { local as exported }` — `exported` is a name in the export list.
      if (key === 'exported') continue
      // `import { imported as local }` is already returned above; belt and braces.
      if (key === 'imported') continue

      visit(node[key], stmt, nowInsideFunction)
    }
  }

  for (let i = 0; i < statements.length; i++) visit(statements[i], i, false)

  /*
   * REACHABILITY. A `const factory = (g) => ({ node(…) })` that lowering left as text is
   * not a runtime failure and must not be reported: it is not exported, nothing else in
   * the module names it, and its free names sit inside a function body that is therefore
   * never entered — dead code a bundler drops and an unbundled module simply never
   * evaluates. That is the documented two-artifact pattern (a LOCAL factory const), and
   * it is exactly the contrast that makes the exported case fatal.
   *
   * All three conditions are load-bearing. Drop `insideFunction` and `const x = node(…)`
   * at statement level stops being caught, though it throws the moment the module is
   * imported. Drop the unreferenced test and a factory something still calls is missed.
   * Drop `exported` and the shape 8995b1c refuses walks straight through.
   */
  return candidates.filter(c => {
    const top = tops[c.stmt]!
    if (!c.insideFunction || top.exported || !top.declaresOnlyFunctions || top.declared.size === 0) return true
    for (const name of top.declared) {
      const readers = readIn.get(name)
      if (readers && [...readers].some(i => i !== c.stmt)) return true
    }
    return false
  }).map(({ name, line, column, enclosing }) => ({ name, line, column, enclosing }))
}
