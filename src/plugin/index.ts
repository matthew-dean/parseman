/**
 * parseman unplugin — macro transform
 *
 * Handles:  import { ... } from 'parseman' with { type: 'macro' }
 *
 * For each such import, walks the file's AST, finds variable declarations
 * whose RHS is a pure parseman combinator call, evaluates them at build time,
 * compiles the result to an optimized inline function, and replaces the
 * declaration — removing the import entirely.
 *
 * Usage:
 *   // vite.config.ts
 *   import parseman from 'parseman/plugin'
 *   export default { plugins: [parseman()] }
 *
 *   // rollup.config.js
 *   import parseman from 'parseman/plugin'
 *   export default { plugins: [parseman.rollup()] }
 */
import * as fs from 'node:fs'
import { createUnplugin } from 'unplugin'
import { parseSync } from 'oxc-parser'
import { ResolverFactory } from 'oxc-resolver'
import MagicString from 'magic-string'
import { evaluateExpr, evaluateCombinatorArray, evaluateParserFactory, evaluateWordFactory, evaluateRefDeclaration, applyDefineStatement, referencesAny, type Scope, type ScopeEntry } from './evaluator.ts'
import { compile, compileRuleMap, compileLinkable, beginLoweringCapture, endLoweringCapture } from '../compiler/codegen.ts'
import type { LinkablePieces } from '../compiler/codegen.ts'
import { emitFusedSource } from '../compiler/linker.ts'
import { createHash } from 'node:crypto'
import type { Combinator } from '../types.ts'
import type {
  ImportDeclaration,
  VariableDeclarator,
  VariableDeclaration,
  Expression,
  Statement,
  ExportNamedDeclaration,
} from '@oxc-project/types'

export type ParsecraftPluginOptions = {
  /** Extra module specifiers to treat as parseman re-exports */
  moduleAliases?: string[]
  /**
   * Warn when a regex terminal can't LOWER to a fast `charCodeAt` scan and falls
   * back to `RegExp.exec`. **Default `false` (opt-in).** `RegExp.exec` is an
   * accepted, JIT-fast compiled path — most un-lowered regexes are perfectly fine
   * and lowering them often shows no real gain — so this is a diagnostic you turn
   * ON when specifically auditing lowering coverage, not a build-time nag.
   */
  warnUnloweredRegex?: boolean
}

const PARSEMAN_MODULE = 'parseman'

// A grammar's carried linkable pieces live ONLY in its COMPILED output (the macro
// embeds them there), never in its `.ts` source. So resolving an imported grammar
// to read its pieces must prefer the built `import`/`require` entry — NOT the
// `source` condition (which would land on un-compiled `.ts` with no pieces).
let _compiledResolver: ResolverFactory | null = null
function getCompiledResolver(): ResolverFactory {
  return _compiledResolver ??= new ResolverFactory({
    extensions: ['.js', '.mjs', '.cjs'],
    conditionNames: ['import', 'require', 'default'],
    mainFields: ['module', 'main'],
  })
}

// Module-level parse cache for imported COMPILED grammar modules (read to recover
// a grammar's carried pieces for compose()), keyed by absolute file path. Shared
// across transformMacro invocations so a grammar imported by many consumer files
// is read + parsed once per build. The mtime guard invalidates a stale entry so a
// watch-mode rebuild picks up a rebuilt module. A null `parsed` (unreadable / parse
// error) is cached too, to avoid retrying a known-bad file for every consumer.
type ParsedModule = { body: unknown[]; src: string }
const _moduleParseCache = new Map<string, { mtimeMs: number; parsed: ParsedModule | null }>()

function parseModuleCached(filePath: string): ParsedModule | null {
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs
  } catch {
    return null  // file vanished — don't cache under a stale key
  }
  const hit = _moduleParseCache.get(filePath)
  if (hit && hit.mtimeMs === mtimeMs) return hit.parsed
  let parsed: ParsedModule | null = null
  try {
    const src = fs.readFileSync(filePath, 'utf8')
    const r = parseSync(filePath, src)
    if (r.errors.length === 0) parsed = { body: r.program.body as unknown[], src }
  } catch { /* leave null */ }
  _moduleParseCache.set(filePath, { mtimeMs, parsed })
  return parsed
}

export default createUnplugin((opts: ParsecraftPluginOptions = {}) => ({
  name: 'parseman',
  // Run BEFORE the bundler's TS/JS transform — otherwise esbuild (Vite) strips
  // the `with { type: 'macro' }` import attribute before we ever see it, and the
  // macro silently never fires.
  enforce: 'pre' as const,

  transformInclude(id: string) {
    return /\.[jt]sx?$/.test(id) && !id.includes('node_modules')
  },

  transform(this: { warn?: (msg: string) => void }, code: string, id: string) {
    if (!code.includes('parseman')) return null
    if (!code.includes('macro')) return null
    const moduleAliases = new Set([PARSEMAN_MODULE, ...(opts.moduleAliases ?? [])])
    const result = transformMacro(code, id, moduleAliases, opts.warnUnloweredRegex === true)
    if (result?.warnings.length) {
      for (const w of result.warnings) {
        if (typeof this?.warn === 'function') this.warn(`[parseman] ${w}`)
        else console.warn(`[parseman] ${w}`)
      }
    }
    if (!result) return null
    return { code: result.code, map: result.map }
  },
}))

// ---------------------------------------------------------------------------
// Reading carried pieces back out of a COMPILED grammar module
// ---------------------------------------------------------------------------
// The macro embeds a grammar's linkable pieces inside its exported const's
// initializer (see `withCarriedPieces`). To compose an imported grammar we parse
// its compiled module, find that const, and pull the pieces literal back out —
// these three pure helpers do exactly that (no runtime, no source recompile).

type AnyNode = { type: string; start: number; end: number } & Record<string, unknown>

/** Map an export NAME → the local binding it refers to. Handles both
 * `export const X = …` (local === exported) and a bundler's rename
 * `const X$1 = …; export { X$1 as X }`. */
function exportLocalName(body: AnyNode[], exported: string): string | null {
  for (const st of body) {
    if (st.type !== 'ExportNamedDeclaration') continue
    const decl = st.declaration as AnyNode | undefined
    if (decl?.type === 'VariableDeclaration') {
      for (const d of (decl.declarations as AnyNode[] | undefined) ?? []) {
        const idn = d.id as { type?: string; name?: string } | undefined
        if (idn?.type === 'Identifier' && idn.name === exported) return exported
      }
    }
    for (const sp of (st.specifiers as AnyNode[] | undefined) ?? []) {
      const exp = (sp.exported as { name?: string } | undefined)?.name
      const loc = (sp.local as { name?: string } | undefined)?.name
      if (exp === exported && loc) return loc
    }
  }
  return null
}

/** Find the top-level `const <name> = <init>` initializer node. */
function topLevelInit(body: AnyNode[], name: string): AnyNode | null {
  for (const st of body) {
    const vd = st.type === 'VariableDeclaration' ? st
      : st.type === 'ExportNamedDeclaration' && (st.declaration as AnyNode | undefined)?.type === 'VariableDeclaration'
        ? (st.declaration as AnyNode) : null
    if (!vd) continue
    for (const d of (vd.declarations as AnyNode[] | undefined) ?? []) {
      const idn = d.id as { type?: string; name?: string } | undefined
      if (idn?.type === 'Identifier' && idn.name === name && d.init) return d.init as AnyNode
    }
  }
  return null
}

/** `Symbol.for('parseman.composedPieces')` ? */
function isComposedPiecesSymbol(n: AnyNode | undefined): boolean {
  if (!n || n.type !== 'CallExpression') return false
  const callee = n.callee as AnyNode | undefined
  const obj = (callee?.object as { name?: string } | undefined)?.name
  const prop = (callee?.property as { name?: string } | undefined)?.name
  const arg0 = (n.arguments as AnyNode[] | undefined)?.[0] as { value?: unknown } | undefined
  return obj === 'Symbol' && prop === 'for' && arg0?.value === 'parseman.composedPieces'
}

/** Walk an initializer subtree for the `Object.defineProperty(_,
 * Symbol.for('parseman.composedPieces'), { value: <LITERAL> })` the macro emits,
 * and return the source range of <LITERAL>. */
function findCarriedPiecesLiteral(root: AnyNode): { start: number; end: number } | null {
  let found: { start: number; end: number } | null = null
  const visit = (n: unknown): void => {
    if (found || !n || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const c of n) visit(c); return }
    const node = n as AnyNode
    if (node.type === 'CallExpression') {
      const callee = node.callee as AnyNode | undefined
      const obj = (callee?.object as { name?: string } | undefined)?.name
      const prop = (callee?.property as { name?: string } | undefined)?.name
      const args = node.arguments as AnyNode[] | undefined
      if (obj === 'Object' && prop === 'defineProperty' && args && isComposedPiecesSymbol(args[1])) {
        const descriptor = args[2] as AnyNode | undefined
        for (const p of (descriptor?.properties as AnyNode[] | undefined) ?? []) {
          const key = p.key as { name?: string; value?: string } | undefined
          if ((key?.name === 'value' || key?.value === 'value') && p.value) {
            found = { start: (p.value as AnyNode).start, end: (p.value as AnyNode).end }
            return
          }
        }
      }
    }
    for (const k in node) {
      if (k === 'type' || k === 'start' || k === 'end') continue
      const v = (node as Record<string, unknown>)[k]
      if (v && typeof v === 'object') visit(v)
    }
  }
  visit(root)
  return found
}

// ---------------------------------------------------------------------------
// Core transform (exported for testing)
// ---------------------------------------------------------------------------

type ImportInfo = {
  start: number
  end: number
  names: Set<string>
  fullyResolved: boolean   // mutated after evaluation
}

export type TransformMacroResult = {
  code: string
  map: ReturnType<MagicString['generateMap']>
  /** Diagnostics for macro-referencing shapes that fell back to the interpreter. */
  warnings: string[]
}

export function transformMacro(
  code: string,
  id: string,
  moduleAliases = new Set([PARSEMAN_MODULE]),
  warnUnloweredRegex = false,
): TransformMacroResult | null {
  let result: ReturnType<typeof parseSync>
  try {
    result = parseSync(id, code)
  } catch {
    return null
  }
  if (result.errors.length > 0) return null

  const body = result.program.body

  // --- Pass 1: collect macro imports + non-macro import bindings ---
  const macroImports: ImportInfo[] = []
  const allNames = new Set<string>()
  // local name -> { source module, imported name }, for every NON-macro named
  // import. Lets a `...frag(g)` spread whose factory is imported (tier 2) be
  // resolved from the exporting module's source at build time.
  const importBindings = new Map<string, { source: string; imported: string }>()

  for (const stmt of body) {
    if (stmt.type !== 'ImportDeclaration') continue
    const s = stmt as ImportDeclaration

    // A macro import is a parseman-alias import carrying `with { type: 'macro' }`
    // (oxc exposes this as ImportDeclaration.attributes).
    const isMacro = moduleAliases.has(s.source.value) && s.attributes.some(a => {
      const key = a.key.type === 'Identifier' ? a.key.name : String(a.key.value)
      return key === 'type' && a.value.value === 'macro'
    })

    if (!isMacro) {
      for (const spec of s.specifiers) {
        if (spec.type === 'ImportSpecifier') {
          const imported = (spec.imported as { name?: string }).name ?? spec.local.name
          importBindings.set(spec.local.name, { source: s.source.value, imported })
        }
      }
      continue
    }

    const names = new Set<string>()
    for (const spec of s.specifiers) {
      if (spec.type === 'ImportSpecifier') names.add(spec.local.name)
    }
    macroImports.push({ start: s.start, end: s.end, names, fullyResolved: false })
    for (const n of names) allNames.add(n)
  }

  if (macroImports.length === 0) return null

  // --- Pass 2: evaluate declarations in source order ---
  // Scope stores enriched ScopeEntry objects so evaluateParserFactory can
  // replay mfSrcs when outer-scope combinators are referenced inside factories.
  const scope: Scope = new Map<string, ScopeEntry>()
  const replacements: Array<{ start: number; end: number; replacement: string }> = []
  const warnings: string[] = []
  beginLoweringCapture()
  let anyUnresolved = false
  // Unique per rules() call site in this file — holds the ONE shared compiled
  // rule-map object; each destructured local name reads its property off it.
  let ruleMapHolderCounter = 0

  // Surface a shape the macro couldn't compile (it silently runs via the
  // interpreter otherwise). Includes a file:line anchor so it's actionable.
  const lineOf = (pos: number): number => {
    let line = 1
    for (let i = 0; i < pos && i < code.length; i++) if (code.charCodeAt(i) === 10) line++
    return line
  }
  const warn = (pos: number, msg: string): void => {
    anyUnresolved = true
    warnings.push(`${id}:${lineOf(pos)} — ${msg} (running via the interpreter; add the plugin or simplify the declaration to compile it)`)
  }

  /**
   * Compile a `rules(factory)` call into ONE shared replacement expression
   * for the whole call — see compileRuleMap() in codegen.ts for why this is
   * one shared codegen pass instead of one `compile()` per entry (a `rules()`
   * factory's entries commonly share large reachable sub-rule graphs; a
   * shared pass compiles each shared sub-rule once instead of once per entry
   * that reaches it).
   */
  const compileRulesFactory = (
    init: Expression,
    label: string,
  ): { replacement: string; ruleMap: Map<string, Combinator<unknown>> } | null => {
    const args = (init as unknown as { arguments: unknown[] }).arguments
    const factoryArg = args[0] as Expression | undefined
    if (!factoryArg) { warn(init.start, `${label}: rules() needs a factory argument`); return null }

    const ruleMap = evaluateParserFactory(factoryArg, scope, code, [])
    if (!ruleMap) { warn(init.start, `${label}: rules(...) factory isn't statically evaluable`); return null }

    const compiled = compileRuleMap([...ruleMap])
    if (!compiled) { warn(init.start, `${label}: rule map couldn't be inlined`); return null }
    return { replacement: compiled.replacement, ruleMap }
  }

  const isRulesCall = (init: Expression): boolean =>
    init.type === 'CallExpression' &&
    (init as unknown as { callee: { type: string; name?: string } }).callee.type === 'Identifier' &&
    (init as unknown as { callee: { name?: string } }).callee.name === 'rules'

  const isComposeCall = (init: Expression): boolean =>
    init.type === 'CallExpression' &&
    (init as unknown as { callee: { type: string; name?: string } }).callee.type === 'Identifier' &&
    (init as unknown as { callee: { name?: string } }).callee.name === 'compose'

  // Local `rules()` grammars, so a same-file `compose([myRules, …])` can recover
  // the pieces to fuse (name → the rule map evaluated at build). A grammar stays a
  // usable parser AND is composable — no opt-in wrapper.
  const localRuleMaps = new Map<string, Map<string, Combinator<unknown>>>()

  // Stable, reproducible per-artifact namespace: hash of module id + a label
  // (binding name / arg position) — never a counter, so rebuilds are byte-stable
  // and two artifacts never collide when fused.
  const nsFor = (label: string): string =>
    `_${createHash('sha1').update(`${id}#${label}`).digest('hex').slice(0, 8)}_`

  /** Serialize one `LinkablePieces` to an object-literal source string. */
  const serializePieces = (p: LinkablePieces): string => {
    const mapLit = (m: Map<string, unknown>): string =>
      `new Map([${[...m].map(([k, v]) => `[${JSON.stringify(k)}, ${JSON.stringify(v)}]`).join(', ')}])`
    return `{ ns: ${JSON.stringify(p.ns)}, keys: ${JSON.stringify(p.keys)}, `
      + `prelude: ${JSON.stringify(p.prelude)}, ruleFns: ${mapLit(p.ruleFns)}, `
      + `wrappers: ${mapLit(p.wrappers)}, firstSets: ${mapLit(p.firstSets)}, deps: ${mapLit(p.deps)}, `
      + `needsEmptyTl: ${p.needsEmptyTl}, needsCollator: ${p.needsCollator}, mfFns: [], buildFns: [] }`
  }
  /** Serialize a pieces LIST — one entry for a `rules()` grammar, the flattened
   * list for a `compose()` result. */
  const serializeList = (list: LinkablePieces[]): string => `[${list.map(serializePieces).join(', ')}]`

  /**
   * Wrap a compiled grammar expression so it CARRIES its own linkable pieces on
   * the value, under `Symbol.for('parseman.composedPieces')` — the same symbol
   * `compose()` reads at runtime. This is why `import { cssGrammar }` is all a
   * downstream package needs: the pieces travel WITH the grammar (no detached,
   * tree-shakeable `__pieces` export). The literal lives inside the exported
   * const's initializer, so it can't be shaken off without dropping the grammar.
   * `importedPieces()` reads it straight back out of the compiled module.
   */
  const withCarriedPieces = (grammarExpr: string, list: LinkablePieces[]): string =>
    `/* @__PURE__ */ (() => { const _g = ${grammarExpr}; `
    + `Object.defineProperty(_g, Symbol.for('parseman.composedPieces'), { value: ${serializeList(list)} }); `
    + `return _g })()`
  // Same-file `const X = compose([...])` → its flattened pieces, so a later
  // same-file compose can chain it.
  const localComposedPieces = new Map<string, LinkablePieces[]>()

  // Cache of pieces LISTS read from imported COMPILED grammars' carried pieces.
  const importedPiecesCache = new Map<string, LinkablePieces[] | null>()

  /**
   * Read an imported grammar's pieces LIST straight off its COMPILED value —
   * the `Symbol.for('parseman.composedPieces')` literal the macro embeds inside
   * the exported const's initializer (see `withCarriedPieces`). No `__pieces`
   * export, no TS source, no recompile. `import { <name> }` carries everything.
   * null if the grammar wasn't macro-compiled (or isn't source-free composable).
   */
  const importedPieces = (localName: string): LinkablePieces[] | null => {
    if (importedPiecesCache.has(localName)) return importedPiecesCache.get(localName)!
    let result: LinkablePieces[] | null = null
    const binding = importBindings.get(localName)
    if (binding) {
      let file: string | null = null
      try { file = getCompiledResolver().resolveFileSync(id, binding.source).path ?? null } catch { /* unresolved */ }
      const mod = file ? parseModuleCached(file) : null
      if (mod) {
        // Map the imported export name → its local binding (handles both
        // `export const X = …` and a bundler's `const X$1 = …; export { X$1 as X }`).
        const localFor = exportLocalName(mod.body as AnyNode[], binding.imported)
        const initNode = localFor ? topLevelInit(mod.body as AnyNode[], localFor) : null
        const literalRange = initNode ? findCarriedPiecesLiteral(initNode) : null
        if (literalRange) {
          const literal = mod.src.slice(literalRange.start, literalRange.end)
          try {
            // Build-time eval of a self-contained data literal (strings/arrays/
            // Map) — NOT runtime; the fused output never carries this.
            // eslint-disable-next-line no-new-func
            result = new Function(`return (${literal})`)() as LinkablePieces[]
          } catch { result = null }
        }
      }
    }
    importedPiecesCache.set(localName, result)
    return result
  }

  /** Resolve one `compose([...])` argument to its pieces LIST (flattened). */
  const argPieces = (arg: Expression, label: string): LinkablePieces[] | null => {
    // Inline `rules(g => …)`.
    if (isRulesCall(arg)) {
      const factory = (arg as unknown as { arguments: unknown[] }).arguments[0] as Expression | undefined
      const rm = factory ? evaluateParserFactory(factory, scope, code, []) : null
      const p = rm ? compileLinkable([...rm], nsFor(label)) : null
      return p ? [p] : null
    }
    if (arg.type === 'Identifier') {
      const name = (arg as unknown as { name: string }).name
      // Local grammar var (`const myRules = rules(...)`).
      const rm = localRuleMaps.get(name)
      if (rm) { const p = compileLinkable([...rm], nsFor(label)); return p ? [p] : null }
      // Local composed var (`const g = compose([...])`) → its flattened pieces.
      const composed = localComposedPieces.get(name)
      if (composed) return composed
      // Imported grammar/composed grammar — its compiled `<name>__pieces` sidecar.
      return importedPieces(name)
    }
    return null
  }

  /** Compile `compose([...])` to STATIC fused source (eval-free) + its flattened
   * pieces (for a sidecar / same-file chaining). null → leave the runtime
   * `compose()` in place (correct, just not build-fused). */
  const compileComposeCall = (init: Expression): { replacement: string; pieces: LinkablePieces[] } | null => {
    const args = (init as unknown as { arguments: Expression[] }).arguments
    const arr = args[0]
    if (!arr || arr.type !== 'ArrayExpression') {
      warn(init.start, 'compose(): expected a static array of grammars/artifacts')
      return null
    }
    const elements = (arr as unknown as { elements: Expression[] }).elements
    const pieces: LinkablePieces[] = []
    for (let i = 0; i < elements.length; i++) {
      const list = argPieces(elements[i]!, `compose${init.start}_${i}`)
      if (!list) { warn(init.start, `compose(): argument ${i} isn't a build-resolvable grammar; falling back to runtime`); return null }
      pieces.push(...list)
    }
    try {
      return { replacement: emitFusedSource(pieces), pieces }
    } catch (e) {
      warn(init.start, `compose(): ${(e as Error).message}; falling back to runtime`)
      return null
    }
  }

  // --- Pre-pass: resolve standalone ref() recursion clusters ---
  // `const x = ref()` … `x.define(expr)` is the interpreter/compile() recursion
  // mechanism. The macro must support it for parity: evaluate every ref slot and
  // apply every `.define(...)` into scope BEFORE the main loop compiles anything,
  // so codegen's emitLazy sees a defined thunk (otherwise it falls back to the
  // interpreter). `.define(...)` statements are stripped from the output since
  // they reference the now-removed import. Only a ref whose define resolves is
  // treated as a macro ref; an unresolved one falls through to the normal warn().
  const unwrapVd = (stmt: Statement): VariableDeclaration | null =>
    stmt.type === 'VariableDeclaration'
      ? (stmt as unknown as VariableDeclaration)
      : stmt.type === 'ExportNamedDeclaration'
        && (stmt as unknown as ExportNamedDeclaration).declaration?.type === 'VariableDeclaration'
        ? ((stmt as unknown as ExportNamedDeclaration).declaration as unknown as VariableDeclaration)
        : null

  // First detect whether any ref() cluster exists; only then do the (more
  // involved) full-scope pre-pass, keeping ordinary macro files on the fast path.
  const refNames = new Set<string>()
  for (const stmt of body as Statement[]) {
    const innerVd = unwrapVd(stmt)
    if (!innerVd) continue
    for (const decl of innerVd.declarations) {
      const d = decl as VariableDeclarator
      if (!d.init || (d.id as unknown as { type: string }).type !== 'Identifier') continue
      const init = d.init as Expression
      if (init.type === 'CallExpression'
        && (init as unknown as { callee: { type: string; name?: string } }).callee.type === 'Identifier'
        && (init as unknown as { callee: { name?: string } }).callee.name === 'ref') {
        refNames.add((d.id as unknown as { name: string }).name)
      }
    }
  }

  // For a ref cluster we must fully populate scope (refs AND the regular consts a
  // `.define(expr)` references) in source order, so each define resolves before
  // the main loop compiles. `.define(...)` statements are stripped from the
  // output since they reference the now-removed import. A ref whose define never
  // resolves falls through to the normal warn() path in the main loop.
  const defineRemovals: Array<{ start: number; end: number }> = []
  if (refNames.size > 0) {
    for (const stmt of body as Statement[]) {
      if (stmt.type === 'ExpressionStatement') {
        const expr = (stmt as unknown as { expression: Expression }).expression
        if (applyDefineStatement(expr, scope, code)) {
          defineRemovals.push({ start: stmt.start, end: stmt.end })
        }
        continue
      }
      const innerVd = unwrapVd(stmt)
      if (!innerVd) continue
      for (const decl of innerVd.declarations) {
        const d = decl as VariableDeclarator
        if (!d.init || (d.id as unknown as { type: string }).type !== 'Identifier') continue
        const name = (d.id as unknown as { name: string }).name
        const init = d.init as Expression
        if (evaluateRefDeclaration(init, name, scope)) continue
        if (scope.has(name)) continue
        if (!referencesAny(init, allNames, scope)) continue
        // Evaluate into scope so a subsequent `.define()` can reference it. The
        // main loop re-evaluates and compiles; refs stay shared, so this is safe.
        const combi = evaluateExpr(init, scope, code, [])
        if (combi) scope.set(name, { combi, mfSrcs: [] })
      }
    }
  }

  for (const stmt of body as Statement[]) {
    // Handle both direct VariableDeclarations and exported ones
    let vd: VariableDeclaration | null = null
    let stmtStart = stmt.start
    let stmtEnd = stmt.end
    let exportPrefix = ''

    if (stmt.type === 'VariableDeclaration') {
      vd = stmt as unknown as VariableDeclaration
    } else if (stmt.type === 'ExportNamedDeclaration') {
      const expStmt = stmt as unknown as ExportNamedDeclaration
      if (expStmt.declaration?.type === 'VariableDeclaration') {
        vd = expStmt.declaration as unknown as VariableDeclaration
        exportPrefix = 'export '
      }
    }

    if (!vd) continue

    for (const decl of vd.declarations) {
      const d = decl as VariableDeclarator
      if (!d.init) continue
      const init = d.init as Expression
      const kind = (vd as unknown as { kind: string }).kind ?? 'const'

      if ((d.id as unknown as { type: string }).type === 'Identifier') {
        // ── Simple binding: const name = <expr> ──────────────────────────
        const varName = (d.id as unknown as { name: string }).name
        if (!referencesAny(init, allNames, scope)) continue

        // const name = ref() — resolved by the pre-pass. Compile the (now
        // defined) ref combinator in place; codegen inlines the whole recursive
        // cluster behind a named function. The `.define(...)` statements are
        // removed separately.
        if (refNames.has(varName)) {
          const refEntry = scope.get(varName)
          const refCombi = refEntry?.combi ?? null
          if (refCombi) {
            const compiled = compile(refCombi)
            if (compiled.inlineExpression === null) {
              warn(init.start, `"${varName}" is a ref() that couldn't be inlined (was .define() called with a static combinator?)`)
              continue
            }
            replacements.push({ start: init.start, end: init.end, replacement: compiled.inlineExpression })
            continue
          }
        }

        // const name = rules(factory) → the ONE shared compiled-rule-map
        // expression, so `name.RuleX(...)` resolves to the compiled function
        // at runtime (the map's own values are already plain functions).
        if (isRulesCall(init)) {
          const compiledRules = compileRulesFactory(init, varName)
          if (!compiledRules) continue
          // Remember the rule map so a same-file `compose([varName, …])` can fuse it.
          localRuleMaps.set(varName, compiledRules.ruleMap)
          // If EXPORTED, carry the grammar's linkable pieces ON the value so a
          // downstream package composes it via `import { <name> }` alone. Only when
          // the pieces are fully static (no runtime-only callbacks) — otherwise the
          // grammar isn't source-free composable and we ship it as a plain map.
          let replacement = compiledRules.replacement
          if (exportPrefix) {
            const pieces = compileLinkable([...compiledRules.ruleMap], nsFor(varName))
            if (pieces && !pieces.mfFns.length && !pieces.buildFns.length) {
              replacement = withCarriedPieces(replacement, [pieces])
            }
          }
          replacements.push({ start: init.start, end: init.end, replacement })
          continue
        }

        // const name = compose([...]) → STATIC fused source (eval-free); the macro
        // fuses at build, never emitting `new Function`.
        if (isComposeCall(init)) {
          const fused = compileComposeCall(init)
          if (!fused) continue // leave the runtime compose() call in place
          // Remember for a same-file downstream compose, and (if exported) carry the
          // FLATTENED pieces on the value so another package can compose this composed
          // grammar via `import { <name> }` (re-composition, no source).
          localComposedPieces.set(varName, fused.pieces)
          const replacement = exportPrefix
            ? withCarriedPieces(fused.replacement, fused.pieces)
            : fused.replacement
          replacements.push({ start: init.start, end: init.end, replacement })
          continue
        }

        const mapFnSources: string[] = []
        const parser = evaluateExpr(init, scope, code, mapFnSources)
        if (parser === null) {
          const wordFactory = evaluateWordFactory(init, scope, code)
          if (wordFactory) {
            ;(scope as Map<string, unknown>).set(varName, wordFactory)
            continue
          }
          // A shared array-of-combinators const (e.g. a reusable `skip` set) — store
          // it in scope so `{ skip: name }` on a later scanTo/balanced resolves the
          // array. Left in the emitted output; it references other emitted consts.
          const combiArray = evaluateCombinatorArray(init, scope, code)
          if (combiArray) {
            ;(scope as Map<string, unknown>).set(varName, combiArray)
            continue
          }
          warn(init.start, `"${varName}" references a parseman macro import but isn't a statically-evaluable combinator`)
          continue
        }

        // Sources are carried on each transform's def (set by the evaluator), so
        // codegen derives them in traversal order — no positional array needed.
        const compiled = compile(parser)
        if (compiled.inlineExpression === null) {
          warn(init.start, `"${varName}" couldn't be inlined (likely closes over a runtime value)`)
          continue
        }

        replacements.push({
          start: init.start,
          end: init.end,
          replacement: compiled.inlineExpression,
        })

        // Store enriched scope entry so factories can replay mfSrcs
        scope.set(varName, { combi: parser, mfSrcs: mapFnSources })

      } else if ((d.id as unknown as { type: string }).type === 'ObjectPattern') {
        // ── Destructured binding: const { a, b } = rules(g => { ... }) ──
        // Only handle rules() factory calls
        if (!referencesAny(init, allNames, scope)) continue
        if (!isRulesCall(init)) {
          warn(init.start, `destructured macro binding must come from rules(...)`)
          continue
        }

        const compiledRules = compileRulesFactory(init, '{ … }')
        if (!compiledRules) continue

        // Walk the ObjectPattern properties, validating each destructured key
        // exists on the compiled rule map — collect bindings before emitting
        // any replacement text (uniform with the previous all-or-nothing
        // per-declaration behavior).
        const pattern = d.id as unknown as { properties: unknown[] }
        const bindings: Array<{ ruleKey: string; localName: string }> = []
        let allOk = true

        for (const prop of pattern.properties) {
          const p = prop as { type: string; key: { type: string; name?: string; value?: unknown }; value: { type: string; name?: string } }
          if (p.type === 'RestElement' || p.type === 'BindingRestElement') {
            warn(init.start, `rest element in a rules() destructure isn't supported`)
            allOk = false; break
          }

          const ruleKey = p.key.type === 'Identifier' ? p.key.name!
            : p.key.type === 'StringLiteral' ? String(p.key.value)
            : null
          const localName = (p.value.type === 'Identifier' || p.value.type === 'BindingIdentifier') ? p.value.name!
            : ruleKey
          if (!ruleKey || !localName) { allOk = false; break }

          if (!compiledRules.ruleMap.has(ruleKey)) {
            warn(init.start, `destructured rule "${ruleKey}" isn't returned by the rules() factory`)
            allOk = false; break
          }

          bindings.push({ ruleKey, localName })
          // Store under the local name so a later macro declaration can reference it.
          const rule = compiledRules.ruleMap.get(ruleKey)
          if (rule) scope.set(localName, { combi: rule, mfSrcs: [] })
        }

        if (!allOk) continue

        // ONE shared holder (not exported — an internal implementation
        // detail) evaluates the compiled rule map exactly once; each
        // destructured local name is just a property read off it, preserving
        // that name's own export-ness from the original declaration.
        const holderVar = `__rules${ruleMapHolderCounter++}`
        const lines = [
          `const ${holderVar} = ${compiledRules.replacement}`,
          ...bindings.map(({ ruleKey, localName }) =>
            `${exportPrefix}${kind} ${localName} = ${holderVar}[${JSON.stringify(ruleKey)}]`),
        ]

        replacements.push({
          start: stmtStart,
          end: stmtEnd,
          replacement: lines.join('\n'),
        })
      }
    }
  }

  // Nothing to rewrite and nothing to report — leave the file untouched.
  if (replacements.length === 0 && warnings.length === 0) return null

  // If every declaration referencing an imported name was successfully inlined,
  // the import is no longer needed. Otherwise downgrade to runtime (strip just
  // the macro attribute so the import stays valid for the interpreter).
  for (const imp of macroImports) {
    imp.fullyResolved = !anyUnresolved
  }

  const ms = new MagicString(code)

  // Strip `x.define(...)` statements — only when the import was fully removed.
  // If anything fell back to the interpreter the import stays, and those
  // statements are still needed to wire the ref at runtime.
  if (!anyUnresolved) {
    for (const { start, end } of defineRemovals) ms.remove(start, end)
  }

  for (const imp of macroImports) {
    if (imp.fullyResolved) {
      ms.remove(imp.start, imp.end)
    } else {
      // Strip only the macro attribute, keep the import
      const original = code.slice(imp.start, imp.end)
      const stripped = original
        .replace(/\s+with\s*\{[^}]*\}/gs, '')
        .replace(/\s+assert\s*\{[^}]*\}/gs, '')
      ms.overwrite(imp.start, imp.end, stripped)
    }
  }

  for (const { start, end, replacement } of [...replacements].sort((a, b) => b.start - a.start)) {
    ms.overwrite(start, end, replacement)
  }

  const unlowered = endLoweringCapture()
  if (warnUnloweredRegex) {
    for (const src of unlowered) {
      warnings.push(`${id}: regex ${src} did not lower to a fast charCodeAt scan (RegExp.exec fallback)`)
    }
  }

  return {
    code: ms.toString(),
    map: ms.generateMap({ hires: true }),
    warnings,
  }
}
