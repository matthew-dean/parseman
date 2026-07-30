/**
 * Resolve a `node(..., build)` reducer expression to the function it names, so the
 * capture-cost analysis reads a REAL parameter list instead of failing open.
 *
 * `buildSrc` is the source text of the EXPRESSION at the call site. An inline arrow is
 * self-describing, but every other spelling — a bare identifier, a namespaced
 * `helpers.fold`, an import from a shared module — carries no parameter list at all, and
 * the analysis used to give up on all of them and charge the node all five capture tiers.
 *
 * Those spellings are not exotic; sharing reducers across a grammar and importing them
 * from another module is ordinary grammar authoring. So this module does the work rather
 * than reporting that it won't:
 *
 *   - REAL SCOPE ANALYSIS. A lexical scope tree over the module, resolved by the source
 *     OFFSET of the identifier at the call site. Shadowing is decidable, so it is decided:
 *     an inner binding of the same name resolves to the inner binding, and only genuinely
 *     unreadable bindings decline. (The previous rule — "decline any name bound more than
 *     once anywhere in the module" — declined correct code to avoid thinking about this.)
 *   - `let` / `var`, admitted when the binding is never reassigned. Reassignment is
 *     detected, not assumed.
 *   - CROSS-MODULE imports: named, default, namespace-member, aliased, and re-exported.
 *     Modules are resolved and parsed once and cached by path + mtime.
 *   - ALIASES: `const fold = foldOperation` follows to the target.
 *   - AST-based parameter counting, so a DEFAULT (`(c, f = undefined, s, r) =>`, arity 4)
 *     or a destructured parameter is counted positionally instead of defeating a regex.
 *
 * What still declines, because it is genuinely undecidable rather than merely unread:
 * a REST parameter (`...args` — the declared arity is unbounded), a body that references
 * `arguments`, and a reducer that is computed, conditionally assigned, or reassigned. For
 * those the `build-arity-unconfirmed` diagnostic fires, and `node(..., { buildArity: n })`
 * lets the author declare the answer so the fail-open path is a true last resort.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { parseSync } from 'oxc-parser'

type AnyNode = { type: string; start: number; end: number } & Record<string, unknown>

/** Why a reducer could not be reduced to a parameter list. `undefined` = it could. */
export type UnresolvedReason =
  | 'rest-parameter'
  | 'arguments'
  | 'reassigned'
  | 'not-a-function'
  | 'unresolved-import'
  | 'not-found'
  | 'computed'

export type ResolvedReducer = {
  /** Declared positional arity, or `null` when genuinely undecidable. */
  arity: number | null
  /** Source text of the resolved function, for shape analysis (inline-`mk`). */
  src: string | null
  reason?: UnresolvedReason
}

// ---------------------------------------------------------------------------
// Scope tree
// ---------------------------------------------------------------------------

type BindingKind = 'const' | 'let' | 'var' | 'function' | 'class' | 'param' | 'import' | 'catch'

type ImportRef = { specifier: string; imported: string | '*' | 'default' }

type Binding = {
  kind: BindingKind
  /** Initializer / declaration node, when the binding names one directly. */
  init?: AnyNode
  /** Set for an `import` binding. */
  importRef?: ImportRef
  /** Any assignment or update to this name anywhere in its scope subtree. */
  reassigned?: boolean
}

type ScopeNode = {
  start: number
  end: number
  bindings: Map<string, Binding>
  children: ScopeNode[]
  parent: ScopeNode | null
  /** `var` and function declarations hoist to the nearest scope with this set. */
  isFunction: boolean
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const SCOPE_TYPES = new Set([
  ...FUNCTION_TYPES, 'BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'CatchClause', 'ClassDeclaration', 'ClassExpression', 'StaticBlock',
])

function newScope(start: number, end: number, parent: ScopeNode | null, isFunction: boolean): ScopeNode {
  const s: ScopeNode = { start, end, bindings: new Map(), children: [], parent, isFunction }
  parent?.children.push(s)
  return s
}

/** Every identifier a binding pattern introduces. */
function patternNames(pat: unknown, out: string[]): void {
  if (!pat || typeof pat !== 'object') return
  const n = pat as AnyNode
  switch (n.type) {
    case 'Identifier': out.push(n.name as string); return
    case 'AssignmentPattern': return patternNames(n.left, out)
    case 'RestElement': return patternNames(n.argument, out)
    case 'ArrayPattern': for (const el of (n.elements as unknown[]) ?? []) patternNames(el, out); return
    case 'ObjectPattern':
      for (const p of (n.properties as AnyNode[]) ?? []) patternNames(p.type === 'RestElement' ? p.argument : p.value, out)
      return
    // A TS parameter property / assignment target wrapper.
    case 'TSParameterProperty': return patternNames(n.parameter, out)
    default: return
  }
}

function declare(scope: ScopeNode, name: string, b: Binding): void {
  // First declaration wins; a duplicate `var` re-declaration does not change the shape.
  if (!scope.bindings.has(name)) scope.bindings.set(name, b)
}

/** `var` and function declarations hoist to the nearest FUNCTION scope, not the block. */
function functionScope(scope: ScopeNode): ScopeNode {
  let s: ScopeNode = scope
  while (!s.isFunction && s.parent) s = s.parent
  return s
}

function buildScopeTree(body: unknown[], moduleEnd: number): ScopeNode {
  const root = newScope(0, moduleEnd, null, true)

  const declarePattern = (scope: ScopeNode, pat: unknown, kind: BindingKind, init?: AnyNode): void => {
    const names: string[] = []
    patternNames(pat, names)
    const target = kind === 'var' ? functionScope(scope) : scope
    for (const name of names) {
      declare(target, name, init !== undefined && names.length === 1 ? { kind, init } : { kind })
    }
  }

  const walk = (n: unknown, scope: ScopeNode): void => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const item of n) walk(item, scope); return }
    const node = n as AnyNode
    if (typeof node.type !== 'string') return

    // --- declarations, in the CURRENT scope ---
    switch (node.type) {
      case 'VariableDeclaration': {
        const kind = (node.kind as BindingKind) ?? 'var'
        for (const d of (node.declarations as AnyNode[]) ?? []) {
          declarePattern(scope, d.id, kind, (d.init as AnyNode | null) ?? undefined)
        }
        break
      }
      case 'FunctionDeclaration':
        if (node.id) declare(functionScope(scope), (node.id as AnyNode).name as string, { kind: 'function', init: node })
        break
      case 'ClassDeclaration':
        if (node.id) declare(scope, (node.id as AnyNode).name as string, { kind: 'class' })
        break
      case 'ImportDeclaration': {
        const specifier = ((node.source as AnyNode | undefined)?.value as string) ?? ''
        for (const sp of (node.specifiers as AnyNode[]) ?? []) {
          const local = (sp.local as AnyNode | undefined)?.name as string | undefined
          if (!local) continue
          const imported = sp.type === 'ImportDefaultSpecifier'
            ? 'default'
            : sp.type === 'ImportNamespaceSpecifier'
              ? '*'
              : ((sp.imported as AnyNode | undefined)?.name as string) ?? local
          declare(scope, local, { kind: 'import', importRef: { specifier, imported } })
        }
        break
      }
      default: break
    }

    // --- new scopes ---
    if (SCOPE_TYPES.has(node.type)) {
      const isFn = FUNCTION_TYPES.has(node.type)
      const inner = newScope(node.start, node.end, scope, isFn)
      if (isFn) {
        for (const p of (node.params as unknown[]) ?? []) declarePattern(inner, p, 'param')
        // A named function EXPRESSION binds its own name inside its body.
        if (node.type === 'FunctionExpression' && node.id) {
          declare(inner, (node.id as AnyNode).name as string, { kind: 'function', init: node })
        }
      }
      if (node.type === 'CatchClause' && node.param) declarePattern(inner, node.param, 'catch')
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end') continue
        walk(node[key], inner)
      }
      return
    }

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      walk(node[key], scope)
    }
  }

  for (const stmt of body) walk(stmt, root)
  return root
}

/** Innermost scope containing `offset`. */
function scopeAt(root: ScopeNode, offset: number): ScopeNode {
  let cur = root
  for (;;) {
    const next = cur.children.find(c => offset >= c.start && offset <= c.end)
    if (!next) return cur
    cur = next
  }
}

function lookup(scope: ScopeNode, name: string): { binding: Binding; scope: ScopeNode } | null {
  for (let s: ScopeNode | null = scope; s; s = s.parent) {
    const b = s.bindings.get(name)
    if (b) return { binding: b, scope: s }
  }
  return null
}

/**
 * Mark every binding that is assigned or updated after declaration. This is what makes a
 * `let` admissible: "never reassigned" is a decidable property, and declining every
 * `let` because one of them *might* be reassigned is the guesswork this module exists to
 * remove.
 */
function markReassignments(body: unknown[], root: ScopeNode): void {
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const item of n) walk(item); return }
    const node = n as AnyNode
    if (typeof node.type !== 'string') return
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      const target = (node.type === 'UpdateExpression' ? node.argument : node.left) as AnyNode | undefined
      const names: string[] = []
      if (target) patternNames(target, names)
      for (const name of names) {
        const hit = lookup(scopeAt(root, node.start), name)
        if (hit) hit.binding.reassigned = true
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      walk(node[key])
    }
  }
  for (const stmt of body) walk(stmt)
}

// ---------------------------------------------------------------------------
// Parameter list → arity, from the AST
// ---------------------------------------------------------------------------

/**
 * Declared positional arity of a function node, or `null` when undecidable.
 *
 * A DEFAULT does not change positional arity (`(c, f = undefined, s, r)` is 4) and a
 * DESTRUCTURED parameter still occupies one position — both were previously rejected by
 * a regex that only accepted plain identifiers. A REST parameter genuinely is undecidable
 * (the declared arity is unbounded), as is a body that reads `arguments`.
 */
export function functionArity(fn: AnyNode): { arity: number | null; reason?: UnresolvedReason } {
  const params = (fn.params as AnyNode[]) ?? []
  let count = 0
  for (const p of params) {
    if (p.type === 'RestElement') return { arity: null, reason: 'rest-parameter' }
    // A TypeScript `this` parameter is not a positional argument.
    if (p.type === 'Identifier' && p.name === 'this') continue
    count++
  }
  if (fn.type !== 'ArrowFunctionExpression' && referencesArguments(fn.body)) {
    return { arity: null, reason: 'arguments' }
  }
  return { arity: count }
}

/** `arguments` in this function's own body — not a nested non-arrow function's. */
function referencesArguments(n: unknown): boolean {
  if (!n || typeof n !== 'object') return false
  if (Array.isArray(n)) return n.some(referencesArguments)
  const node = n as AnyNode
  if (typeof node.type !== 'string') return false
  if (node.type === 'Identifier' && node.name === 'arguments') return true
  // A nested non-arrow function has its own `arguments`; an arrow inherits ours.
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') return false
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    if (referencesArguments(node[key])) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Module graph
// ---------------------------------------------------------------------------

type AnalysedModule = {
  file: string
  src: string
  body: unknown[]
  scopes: ScopeNode
}

const _moduleCache = new Map<string, { mtimeMs: number; mod: AnalysedModule | null }>()

function analyseModuleFile(file: string): AnalysedModule | null {
  let mtimeMs: number
  try { mtimeMs = fs.statSync(file).mtimeMs } catch { return null }
  const hit = _moduleCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.mod
  let mod: AnalysedModule | null = null
  try {
    const src = fs.readFileSync(file, 'utf8')
    const r = parseSync(file, src)
    if (r.errors.length === 0) {
      const body = r.program.body as unknown[]
      const scopes = buildScopeTree(body, src.length)
      markReassignments(body, scopes)
      mod = { file, src, body, scopes }
    }
  } catch { /* leave null */ }
  _moduleCache.set(file, { mtimeMs, mod })
  return mod
}

const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']

/**
 * Resolve an import specifier to a readable file.
 *
 * Deliberately broader than `resolvePrivateSourceModule` in `index.ts`: that one
 * restricts to the importing package because it LOWERS the target into the output. Here
 * we only READ a parameter list, so a workspace sibling or an installed package is
 * perfectly safe to inspect — and refusing to look is exactly how "imported reducer"
 * became a permanent fail-open.
 */
function resolveImport(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    const base = path.resolve(path.dirname(fromFile), specifier)
    const ext = path.extname(base)
    const stem = ext ? base.slice(0, -ext.length) : base
    const candidates = [
      ...(ext ? [base] : []),
      // `./x.js` in TS source usually means `./x.ts`.
      ...SOURCE_EXTS.map(e => `${stem}${e}`),
      ...SOURCE_EXTS.map(e => path.join(base, `index${e}`)),
    ]
    for (const c of candidates) {
      try { if (fs.statSync(c).isFile()) return fs.realpathSync(c) } catch { /* next */ }
    }
    return null
  }
  // A bare package specifier — a workspace sibling or an installed package. Node's own
  // resolution from the importing file, which is what the built program will use.
  try {
    return fs.realpathSync(createRequire(fromFile).resolve(specifier))
  } catch { return null }
}

/** Does this `export <decl>` actually introduce `name`? */
function declarationBinds(decl: AnyNode, name: string): boolean {
  if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
    return ((decl.id as AnyNode | undefined)?.name as string | undefined) === name
  }
  if (decl.type === 'VariableDeclaration') {
    const names: string[] = []
    for (const d of (decl.declarations as AnyNode[]) ?? []) patternNames(d.id, names)
    return names.includes(name)
  }
  return false
}

/** Find what a module EXPORTS under `name` ('default' for a default export). */
function exportedBinding(
  mod: AnalysedModule,
  name: string,
  seen: Set<string>,
): { mod: AnalysedModule; binding: Binding } | null {
  for (const stmt of mod.body as AnyNode[]) {
    if (stmt.type === 'ExportDefaultDeclaration' && name === 'default') {
      const d = stmt.declaration as AnyNode
      if (FUNCTION_TYPES.has(d.type)) return { mod, binding: { kind: 'const', init: d } }
      if (d.type === 'Identifier') {
        const hit = lookup(mod.scopes, d.name as string)
        return hit ? { mod, binding: hit.binding } : null
      }
      return null
    }
    if (stmt.type === 'ExportNamedDeclaration') {
      const decl = stmt.declaration as AnyNode | undefined
      if (decl && declarationBinds(decl, name)) {
        // `export const f = …` / `export function f() {}` — already in module scope.
        const hit = lookup(mod.scopes, name)
        if (hit && hit.scope === mod.scopes) return { mod, binding: hit.binding }
      }
      for (const sp of (stmt.specifiers as AnyNode[]) ?? []) {
        const exported = ((sp.exported as AnyNode | undefined)?.name as string) ?? ''
        if (exported !== name) continue
        const local = ((sp.local as AnyNode | undefined)?.name as string) ?? exported
        const from = (stmt.source as AnyNode | undefined)?.value as string | undefined
        if (from !== undefined) return followReExport(mod, from, local, seen)
        const hit = lookup(mod.scopes, local)
        return hit ? { mod, binding: hit.binding } : null
      }
    }
    // `export * from './y'` — search the target.
    if (stmt.type === 'ExportAllDeclaration' && !stmt.exported) {
      const from = (stmt.source as AnyNode | undefined)?.value as string | undefined
      if (from === undefined) continue
      const found = followReExport(mod, from, name, seen)
      if (found) return found
    }
  }
  // A plain module-scope declaration that the file exports elsewhere, or a module we
  // parsed from compiled output where the export list is a bundler rename.
  const hit = lookup(mod.scopes, name)
  return hit && hit.scope === mod.scopes ? { mod, binding: hit.binding } : null
}

function followReExport(
  mod: AnalysedModule,
  specifier: string,
  name: string,
  seen: Set<string>,
): { mod: AnalysedModule; binding: Binding } | null {
  const file = resolveImport(mod.file, specifier)
  if (!file || seen.has(`${file}\0${name}`)) return null
  seen.add(`${file}\0${name}`)
  const next = analyseModuleFile(file)
  return next ? exportedBinding(next, name, seen) : null
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

const MAX_HOPS = 12

export type ReducerResolver = {
  /**
   * Resolve the reducer expression at `offset` (its source text is `exprSrc`).
   * Returns `null` when the expression is not a name at all (an inline function —
   * the caller already has its source and needs nothing from us).
   */
  resolve(exprSrc: string, offset: number): ResolvedReducer | null
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/
const MEMBER_RE = /^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)$/

export function createReducerResolver(entryFile: string, body: unknown[], src: string): ReducerResolver {
  const scopes = buildScopeTree(body, src.length)
  markReassignments(body, scopes)
  const entry: AnalysedModule = { file: entryFile, src, body, scopes }

  const fromBinding = (
    mod: AnalysedModule,
    binding: Binding,
    memberName: string | undefined,
    hops: number,
    seen: Set<string>,
  ): ResolvedReducer => {
    if (hops > MAX_HOPS) return { arity: null, src: null, reason: 'not-found' }

    // A reassigned binding may hold a different function by the time it is read.
    if (binding.reassigned) return { arity: null, src: null, reason: 'reassigned' }

    if (binding.kind === 'param' || binding.kind === 'catch' || binding.kind === 'class') {
      return { arity: null, src: null, reason: 'not-a-function' }
    }

    if (binding.kind === 'import' && binding.importRef) {
      const { specifier, imported } = binding.importRef
      // `import * as ns` used without a member names a MODULE, not a function. Decide
      // that before touching the filesystem, so the reason is the real one rather than
      // whatever the resolver happened to say about the path.
      if (imported === '*' && memberName === undefined) return { arity: null, src: null, reason: 'not-a-function' }
      const file = resolveImport(mod.file, specifier)
      if (!file) return { arity: null, src: null, reason: 'unresolved-import' }
      const next = analyseModuleFile(file)
      if (!next) return { arity: null, src: null, reason: 'unresolved-import' }
      // `import * as helpers` + `helpers.fold` — the member names the export.
      const wanted = imported === '*' ? memberName : imported
      if (wanted === undefined) return { arity: null, src: null, reason: 'not-a-function' }
      const found = exportedBinding(next, wanted, seen)
      if (!found) return { arity: null, src: null, reason: 'not-found' }
      return fromBinding(found.mod, found.binding, undefined, hops + 1, seen)
    }

    const init = binding.init
    if (!init) return { arity: null, src: null, reason: 'not-a-function' }

    // `const fold = foldOperation` — follow the alias.
    if (init.type === 'Identifier') {
      const hit = lookup(scopeAt(mod.scopes, init.start), init.name as string)
      if (!hit) return { arity: null, src: null, reason: 'not-found' }
      return fromBinding(mod, hit.binding, undefined, hops + 1, seen)
    }
    // `const fold = helpers.foldOperation`. A COMPUTED access (`table[key]`) names
    // something only the running program knows — that is genuine undecidability, and it
    // reports as such rather than as a missing binding.
    if (init.type === 'ComputedMemberExpression' || (init.computed === true && init.type.endsWith('MemberExpression'))) {
      return { arity: null, src: null, reason: 'computed' }
    }
    if (init.type === 'StaticMemberExpression' || init.type === 'MemberExpression') {
      const obj = init.object as AnyNode | undefined
      const prop = init.property as AnyNode | undefined
      if (obj?.type === 'Identifier' && prop?.type === 'Identifier') {
        const hit = lookup(scopeAt(mod.scopes, init.start), obj.name as string)
        if (!hit) return { arity: null, src: null, reason: 'not-found' }
        return fromBinding(mod, hit.binding, prop.name as string, hops + 1, seen)
      }
      return { arity: null, src: null, reason: 'computed' }
    }

    if (!FUNCTION_TYPES.has(init.type)) return { arity: null, src: null, reason: 'not-a-function' }

    const { arity, reason } = functionArity(init)
    return { arity, src: mod.src.slice(init.start, init.end), ...(reason ? { reason } : {}) }
  }

  return {
    resolve(exprSrc, offset) {
      const text = exprSrc.trim()
      const ident = IDENT_RE.test(text) ? text : null
      const member = ident ? null : MEMBER_RE.exec(text)
      if (!ident && !member) return null // an inline function, or something computed

      const name = ident ?? member![1]!
      const memberName = ident ? undefined : member![2]!
      const hit = lookup(scopeAt(scopes, offset), name)
      if (!hit) return { arity: null, src: null, reason: 'not-found' }
      return fromBinding(entry, hit.binding, memberName, 0, new Set())
    },
  }
}
