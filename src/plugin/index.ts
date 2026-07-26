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
import * as path from 'node:path'
import { createUnplugin } from 'unplugin'
import { parseSync } from 'oxc-parser'
import { ResolverFactory } from 'oxc-resolver'
import MagicString from 'magic-string'
import { evaluateExpr, evaluateCombinatorArray, evaluateParserFactory, evaluateWordFactory, evaluateWhenFactory, evaluateRefDeclaration, applyDefineStatement, referencesAny, type Scope, type ScopeEntry } from './evaluator.ts'
import { compile, compileRuleMap, compileLinkable, hasExternalRuleRef, runFusedGatingDiagnostic, beginLoweringCapture, endLoweringCapture } from '../compiler/codegen.ts'
import type { HostMode, LinkablePieces } from '../compiler/codegen.ts'
import { emitFusedSource, materializePiece, pickPieces, once } from '../compiler/linker.ts'
import { evalRuleMapIR, serializeRuleMap } from '../compiler/ir-serialize.ts'
import { buildGrammarPlan } from '../compiler/grammar-coverage-ids.ts'
import { PARSEMAN_VERSION } from '../version.ts'
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
  /**
   * Bake automatic list recovery into the macro-compiled output. **Default `false`.**
   * When on, `many`/`oneOrMore`/`sepBy` in every compiled grammar gain a
   * `_ctx._tolerant`-gated recovery branch (dormant on strict parses — a normal
   * parse is unaffected and allocates nothing). The output stays macro-inlinable
   * (sentinels build via `_ctx._rec`, not `_rp`). Turn it on for grammars you drive
   * from an editor/language service so `run(g, src, { tolerant: true })` recovers on
   * the fast compiled path; leave it off for build-only grammars.
   */
  recovery?: boolean
  /** Emit grammar-coverage hooks in macro output. Off by default, so ordinary
   * macro output remains byte-identical. */
  grammarCoverage?: boolean
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

type ResolvedGrammarModule = {
  file: string
  /** A private TypeScript source module, not a published macro artifact. */
  source: boolean
}

const PRIVATE_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

function nearestPackageRoot(file: string): string | null {
  let dir = path.dirname(file)
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, 'package.json')).isFile()) return fs.realpathSync(dir)
    } catch { /* keep walking upward */ }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function isWithinPackageRoot(file: string, root: string): boolean {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * Resolve only a relative/absolute source-private import. Published package
 * imports deliberately remain compiled-artifact-only: source is allowed here
 * solely so `import { syntax } from './recognition.js'` can consume the
 * colocated `recognition.ts` before a bundler has emitted that JS file.
 */
function resolvePrivateSourceModule(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) return null
  const packageRoot = nearestPackageRoot(from)
  if (!packageRoot) return null
  const base = path.resolve(path.dirname(from), specifier)
  const ext = path.extname(base)
  const candidates = [
    base,
    ...(ext ? ['.ts', '.tsx', '.mts', '.cts'].map(next => `${base.slice(0, -ext.length)}${next}`) : []),
    ...(!ext ? ['.ts', '.tsx', '.mts', '.cts'].map(next => `${base}${next}`) : []),
    ...(!ext ? ['index.ts', 'index.tsx', 'index.mts', 'index.cts'].map(next => path.join(base, next)) : []),
  ]
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue
      // Both paths are real, so a symlink cannot smuggle a source dependency out
      // of the importing package after the lexical `../` check passed.
      const real = fs.realpathSync(candidate)
      if (isWithinPackageRoot(real, packageRoot)) return real
    } catch { /* try the next source spelling */ }
  }
  return null
}

function resolveGrammarModule(from: string, specifier: string): ResolvedGrammarModule | null {
  // An explicit source import means source semantics even when a stale/generated
  // sibling JS artifact exists. Ordinary `.js` imports keep compiled precedence.
  if (PRIVATE_SOURCE_EXTENSIONS.has(path.extname(specifier))) {
    const file = resolvePrivateSourceModule(from, specifier)
    return file ? { file, source: true } : null
  }
  try {
    const file = getCompiledResolver().resolveFileSync(from, specifier).path
    if (file) return { file, source: false }
  } catch { /* private source fallback below */ }
  const file = resolvePrivateSourceModule(from, specifier)
  return file ? { file, source: true } : null
}

// Recursive source lowering is a build-time operation. This guard makes an
// import cycle fail closed rather than recursing into a runtime composition.
const _sourceLowering = new Set<string>()
const _sourceLoweringCache = new Map<string, { mtimeMs: number; parsed: ParsedModule | null }>()

function sourceLoweringCacheKey(
  file: string,
  moduleAliases: Set<string>,
  warnUnloweredRegex: boolean,
  recovery: boolean,
): string {
  return `${file}\0${[...moduleAliases].sort().join('\0')}\0${warnUnloweredRegex ? 'warn' : ''}\0${recovery ? 'recovery' : ''}`
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
    const result = transformMacro(code, id, moduleAliases, opts.warnUnloweredRegex === true, opts.recovery === true, opts.grammarCoverage === true)
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
      // Also accepted: `Object.assign(_g, { [Symbol.for('…composedPieces')]: <literal> })`
      // (transitional; the current emitter uses the non-enumerable defineProperty form below).
      if (obj === 'Object' && prop === 'assign' && args && (args[1] as AnyNode | undefined)?.type === 'ObjectExpression') {
        for (const p of ((args[1] as AnyNode).properties as AnyNode[] | undefined) ?? []) {
          if ((p as { computed?: boolean }).computed && isComposedPiecesSymbol(p.key as AnyNode) && p.value) {
            found = { start: (p.value as AnyNode).start, end: (p.value as AnyNode).end }
            return
          }
        }
      }
      // Current form: `Object.defineProperty(_g, sym, { value: …, enumerable: false })`.
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

/** Local-binding → { source, imported } for every `import { … }` in a parsed
 * module body. Used to resolve an ancestor-pieces spread (`...(binding[Symbol…])`)
 * in a compiled grammar back to the module that binding was imported from. */
function extractImportBindings(body: AnyNode[]): Map<string, { source: string; imported: string }> {
  const out = new Map<string, { source: string; imported: string }>()
  for (const stmt of body) {
    if (stmt.type !== 'ImportDeclaration') continue
    const s = stmt as unknown as ImportDeclaration
    for (const spec of s.specifiers) {
      if (spec.type === 'ImportSpecifier') {
        const imported = (spec.imported as { name?: string }).name ?? spec.local.name
        out.set(spec.local.name, { source: s.source.value, imported })
      }
    }
  }
  return out
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

/**
 * Read a source-private grammar as if Vite had already run this macro on it.
 * The result is still only an in-memory artifact for the importing transform:
 * no source module is executed, emitted, or made available at runtime.
 */
function lowerPrivateSourceModule(
  file: string,
  moduleAliases: Set<string>,
  warnUnloweredRegex: boolean,
  recovery: boolean,
): ParsedModule | null {
  if (_sourceLowering.has(file)) return null
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    return null
  }
  const cacheKey = sourceLoweringCacheKey(file, moduleAliases, warnUnloweredRegex, recovery)
  const hit = _sourceLoweringCache.get(cacheKey)
  if (hit && hit.mtimeMs === mtimeMs) return hit.parsed
  _sourceLowering.add(file)
  let parsedModule: ParsedModule | null = null
  try {
    const source = fs.readFileSync(file, 'utf8')
    const transformed = transformMacro(source, file, moduleAliases, warnUnloweredRegex, recovery)
    if (!transformed || transformed.warnings.length > 0) return null
    const parsed = parseSync(file, transformed.code)
    parsedModule = parsed.errors.length === 0
      ? { body: parsed.program.body as unknown[], src: transformed.code }
      : null
    return parsedModule
  } catch {
    return null
  } finally {
    _sourceLoweringCache.set(cacheKey, { mtimeMs, parsed: parsedModule })
    _sourceLowering.delete(file)
  }
}

export function transformMacro(
  code: string,
  id: string,
  moduleAliases = new Set([PARSEMAN_MODULE]),
  warnUnloweredRegex = false,
  recovery = false,
  grammarCoverage = false,
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

  /*
   * Module-level `const <name> = (g) => …` factory declarations, so a `rules()` call
   * can be handed its factory BY NAME instead of inline.
   *
   * This is what makes one grammar source compilable twice:
   *
   *   const factory = (g) => ({ … })
   *   export const grammar    = rules({ trivia: rw }, factory)
   *   export const cstGrammar = rules({ trivia: rw, hostMode: 'cst' }, factory)
   *
   * Without it, `rules({ hostMode: 'cst' }, factory)` reports "factory isn't statically
   * evaluable" and falls back to the interpreter, and the ONE thing compile-time host
   * mode exists to enable — two artifacts from one source — cannot be written down. The
   * only alternative is duplicating the whole factory at both call sites.
   *
   * Deliberately narrow: a top-level `const` function-valued binding, matched by name.
   * Anything else still takes the existing inline path.
   *
   * The narrowness is load-bearing, because this substitutes a stored initializer for a
   * NAME and so has to reproduce the binding semantics the name actually has:
   *
   *  - `const` ONLY. A `let`/`var` factory can be reassigned between the declaration and
   *    the `rules()` call, and substituting the initializer would compile a grammar the
   *    program does not have. `const` makes reassignment a syntax error, so matching only
   *    `const` removes the case rather than trying to detect it.
   *  - DECLARED BEFORE USE. The map is built from the whole module body up front, so
   *    without a position check a `rules(…, factory)` sitting ABOVE `const factory = …`
   *    would resolve here while the real program throws a temporal-dead-zone
   *    ReferenceError. Suppressing an error the source would raise is the same class of
   *    defect as emitting the wrong grammar. `declaredAt` is compared against the call
   *    site below.
   */
  const factoryDecls = new Map<string, { fn: Expression; declaredAt: number }>()
  for (const stmt of body) {
    const decl = stmt.type === 'ExportNamedDeclaration'
      ? (stmt as unknown as { declaration?: unknown }).declaration
      : stmt
    if ((decl as { type?: string } | undefined)?.type !== 'VariableDeclaration') continue
    // `let`/`var` are rebindable; only `const` can be substituted by name safely.
    if ((decl as unknown as { kind?: string }).kind !== 'const') continue
    for (const d of (decl as unknown as VariableDeclaration).declarations) {
      const id = d.id as unknown as { type: string; name?: string }
      const init = d.init as Expression | null | undefined
      if (id.type !== 'Identifier' || !id.name || !init) continue
      if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
        factoryDecls.set(id.name, {
          fn: init,
          declaredAt: (d as unknown as { end: number }).end,
        })
      }
    }
  }

  // --- Pass 2: evaluate declarations in source order ---
  // Scope stores enriched ScopeEntry objects so evaluateParserFactory can
  // replay mfSrcs when outer-scope combinators are referenced inside factories.
  const scope: Scope = new Map<string, ScopeEntry>()
  const replacements: Array<{ start: number; end: number; replacement: string }> = []
  const warnings: string[] = []
  beginLoweringCapture()
  let anyUnresolved = false
  // A declaration whose emitted value still CALLS a macro import, without anything
  // having failed: a shared shape keeps its `rules(…)` source (the interpreter map is
  // the only correct standalone value for a grammar with a hole) while still carrying
  // fully compiled pieces for downstream composition. The import must survive, but
  // this is not an unresolved shape, so it neither warns nor blocks other cleanups.
  let keepMacroImport = false
  let runtimeComposeFallback = false
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
  const evaluateRulesFactory = (
    init: Expression,
    label: string,
  ): { ruleMap: Map<string, Combinator<unknown>>; trivia?: Combinator<unknown>; scanSkip?: Combinator<unknown>[] } | null => {
    const args = (init as unknown as { arguments: unknown[] }).arguments
    // Options-first: rules({ trivia }, factory). Disambiguate by type — an
    // ObjectExpression first arg means options lead; otherwise the factory leads
    // (bare rules(factory), or the tolerated legacy rules(factory, { trivia })).
    const arg0 = args[0] as AnyNode | undefined
    const arg1 = args[1] as AnyNode | undefined
    const optionsFirst = arg0?.type === 'ObjectExpression'
    const factoryArgRaw = (optionsFirst ? arg1 : arg0) as Expression | undefined
    if (!factoryArgRaw) { warn(init.start, `${label}: rules() needs a factory argument`); return null }
    /* A factory named by identifier resolves to its module-level declaration, so two
     * `rules()` call sites can SHARE one factory — see `factoryDecls`. Only when the
     * declaration PRECEDES this call: a later one is a temporal dead zone in the real
     * program, and resolving it here would compile a grammar out of a binding that does
     * not exist yet. Falling through leaves `factoryArgRaw`, which takes the ordinary
     * inline path and reports "isn't statically evaluable" rather than inventing an answer. */
    const namedFactory = factoryArgRaw.type === 'Identifier'
      ? factoryDecls.get((factoryArgRaw as unknown as { name: string }).name)
      : undefined
    const factoryArg = namedFactory !== undefined && namedFactory.declaredAt <= init.start
      ? namedFactory.fn
      : factoryArgRaw

    // Grammar-level options object — evaluate `trivia` / `scanSkip` so the compiled
    // map seeds them as the ambient defaults (build-time mirror of rules() tagging
    // grammarTrivia / grammarScanSkip at runtime).
    const optionsArg = (optionsFirst ? arg0 : arg1) as AnyNode | undefined
    const optionValue = (name: string): Expression | undefined =>
      optionsArg?.type === 'ObjectExpression'
        ? (((optionsArg.properties as AnyNode[] | undefined) ?? []).find(
            p => (p as { key?: { name?: string } }).key?.name === name,
          ) as { value?: Expression } | undefined)?.value
        : undefined

    // Read and VALIDATE hostMode before evaluating the factory, so a mode the macro
    // cannot honour is reported even when the factory also fails to evaluate. Getting
    // this order wrong means the one option whose silent loss is a wrong TREE gets
    // swallowed by an unrelated warning.
    const hostModeValue = optionValue('hostMode')
    const gHostMode = hostModeValue?.type === 'Literal'
      ? (hostModeValue as unknown as { value?: unknown }).value
      : undefined
    if (hostModeValue !== undefined && gHostMode !== 'ast' && gHostMode !== 'cst') {
      warn(init.start, `${label}: rules({ hostMode }) must be the literal 'ast' or 'cst'`)
      return null
    }

    const ruleMap = evaluateParserFactory(factoryArg, scope, code, [])
    if (!ruleMap) { warn(init.start, `${label}: rules(...) factory isn't statically evaluable`); return null }

    const triviaValue = optionValue('trivia')
    const gTrivia = triviaValue ? evaluateExpr(triviaValue, scope, code, []) : undefined
    const scanSkipValue = optionValue('scanSkip')
    const gScanSkip = scanSkipValue
      ? (evaluateCombinatorArray(scanSkipValue, scope, code) ?? undefined)
      : undefined

    // STAMP `_meta.grammarScanSkip` on the evaluated rules, exactly as runtime
    // `rules({ scanSkip })` does. The macro evaluates the FACTORY directly and never
    // calls `rules()`, so without this the stamp is absent and every macro-side
    // `compileLinkable`/`compileRuleMap` has to pass `opts.scanSkip` by hand — which
    // was forgotten twice (the composeLeaf identifier branch, and the exported
    // full-piece fallback), each time silently re-opening the raw-scan footgun
    // downstream. Both compilers already fall back to this `_meta` field, so
    // stamping here makes omission at a call site structurally impossible.
    // Trivia rules are skipped, mirroring the runtime guard in `rules()`.
    if (gScanSkip) {
      for (const rule of ruleMap.values()) {
        if (rule && !rule._meta.isTrivia) {
          ;(rule._meta as { grammarScanSkip?: Combinator<unknown>[] }).grammarScanSkip = gScanSkip
        }
      }
    }

    // STAMP `_meta.grammarHostMode` for exactly the reason the scanSkip stamp above
    // gives: every macro-side lowering path (`compileRuleMap`, `compileLinkable`,
    // `materializePiece`) falls back to this field, so no call site can forget to
    // thread the option — and forgetting THIS one is silent, not slow.
    //
    // This is what makes `rules({ hostMode: 'cst' }, factory)` work under the macro,
    // which is the only way one grammar source can be compiled for both consumers:
    // two `rules()` call sites over one shared factory become two independent
    // top-level artifacts, each tree-shakeable, neither paying the other's cost.
    if (gHostMode === 'cst') {
      for (const rule of ruleMap.values()) {
        if (rule && !rule._meta.isTrivia) {
          ;(rule._meta as { grammarHostMode?: 'ast' | 'cst' }).grammarHostMode = 'cst'
        }
      }
    }

    return { ruleMap, ...(gTrivia ? { trivia: gTrivia } : {}), ...(gScanSkip ? { scanSkip: gScanSkip } : {}) }
  }

  /** null → the factory itself isn't statically evaluable (already warned).
   * `replacement: null` → the map evaluated fine but `compileRuleMap` couldn't
   * inline it; the caller decides whether that is a fallback-to-interpreter
   * warning or the SHARED-SHAPE case (an unresolved external `g.` ref, which is
   * un-inlinable by construction but still linkable — see `hasExternalRef`). */
  const compileRulesFactory = (
    init: Expression,
    label: string,
  ): { replacement: string | null; ruleMap: Map<string, Combinator<unknown>>; hostMode: HostMode; hostBranchElided: boolean; coverageDefinitions?: readonly { id: string; kind: string }[]; trivia?: Combinator<unknown>; scanSkip?: Combinator<unknown>[] } | null => {
    const evaluated = evaluateRulesFactory(init, label)
    if (!evaluated) return null
    const compiled = compileRuleMap([...evaluated.ruleMap], { ...(evaluated.trivia ? { trivia: evaluated.trivia } : {}), ...(evaluated.scanSkip ? { scanSkip: evaluated.scanSkip } : {}), recovery, coverage: grammarCoverage })
    return {
      replacement: compiled?.replacement ?? null,
      ruleMap: evaluated.ruleMap,
      hostMode: compiled?.hostMode ?? 'ast',
      hostBranchElided: compiled?.hostBranchElided ?? false,
      ...(compiled?.coverageDefinitions ? { coverageDefinitions: compiled.coverageDefinitions } : {}),
      ...(evaluated.trivia ? { trivia: evaluated.trivia } : {}),
      ...(evaluated.scanSkip ? { scanSkip: evaluated.scanSkip } : {}),
    }
  }

  const isRulesCall = (init: Expression): boolean =>
    init.type === 'CallExpression' &&
    (init as unknown as { callee: { type: string; name?: string } }).callee.type === 'Identifier' &&
    (init as unknown as { callee: { name?: string } }).callee.name === 'rules'

  const isComposeCall = (init: Expression): boolean =>
    init.type === 'CallExpression' &&
    (init as unknown as { callee: { type: string; name?: string } }).callee.type === 'Identifier' &&
    (init as unknown as { callee: { name?: string } }).callee.name === 'compose'

  const isComposeLeafCall = (init: Expression): boolean =>
    init.type === 'CallExpression'
    && (init as unknown as { callee: { type: string; name?: string } }).callee.type === 'Identifier'
    && (init as unknown as { callee: { name?: string } }).callee.name === 'composeLeaf'

  const isPickCall = (init: Expression): boolean =>
    init.type === 'CallExpression' &&
    (init as unknown as { callee: { type: string; name?: string } }).callee.type === 'Identifier' &&
    (init as unknown as { callee: { name?: string } }).callee.name === 'pick'

  // Local `rules()` grammars, so a same-file `compose([myRules, …])` can recover
  // the pieces to fuse (name → the rule map evaluated at build). A grammar stays a
  // usable parser AND is composable — no opt-in wrapper.
  const localRuleMaps = new Map<string, Map<string, Combinator<unknown>>>()
  // Local plain grammars (`const g = rules({ trivia }, …)`) that declared a
  // grammar-level trivia — read by composingTrivia() so a same-file
  // `compose([…, g])` can adopt g's trivia (composing-wins). A grammar declared
  // WITHOUT trivia is absent here, so composingTrivia keeps scanning earlier items.
  const localGrammarTrivia = new Map<string, Combinator<unknown>>()
  // …and its grammar-level scanSkip, so a same-file `composeLeaf([g, …])` where the
  // final local grammar is an IDENTIFIER bound to `rules({ scanSkip })` still threads
  // that opaque-unit set to the fused local piece (mirrors the inline-rules() case).
  const localGrammarScanSkip = new Map<string, Combinator<unknown>[]>()

  // Stable, reproducible per-artifact namespace: hash of module id + a label
  // (binding name / arg position) — never a counter, so rebuilds are byte-stable
  // and two artifacts never collide when fused.
  const nsFor = (label: string): string =>
    `_${createHash('sha1').update(`${id}#${label}`).digest('hex').slice(0, 8)}_`

  /** Serialize one `LinkablePieces` to an object-literal source string.
   *
   * The carried rule/wrapper/prelude source is machine-consumed only (the linker
   * concatenates it at fuse time — see fusedBody), never human-read, so we strip
   * the pretty-printer's per-line indentation before embedding it. Only LEADING
   * whitespace after a newline is removed: statement-separating newlines stay (ASI
   * intact) and mid-line tokens — including the `/*@FS:…@*​/` first-set placeholders
   * the linker rewrites — are untouched. ~16% off the carried payload, zero runtime
   * cost (this path feeds the macro's carried literal, not runtime fuseRules). */
  const stripIndent = (s: string): string => s.replace(/\n[ \t]+/g, '\n')
  const serializePieces = (p: LinkablePieces): string => {
    const mapLit = (m: Map<string, unknown>, stripVals = false): string =>
      `new Map([${[...m].map(([k, v]) =>
        `[${JSON.stringify(k)}, ${JSON.stringify(stripVals && typeof v === 'string' ? stripIndent(v) : v)}]`,
      ).join(', ')}])`
    // Stamp the ARTIFACT VERSION LOCK (src/version.ts): fusedBody refuses to link a
    // serialized piece whose `v` differs from the linking parseman — the artifact
    // format is version-locked and carries no cross-version back-compat.
    return `{ v: ${JSON.stringify(p.v)}, ns: ${JSON.stringify(p.ns)}, keys: ${JSON.stringify(p.keys)}, `
      + `prelude: ${JSON.stringify(p.prelude.map(stripIndent))}, ruleFns: ${mapLit(p.ruleFns, true)}, `
      + `wrappers: ${mapLit(p.wrappers, true)}, firstSets: ${mapLit(p.firstSets)}, `
      // Carry per-rule NULLABILITY so a downstream fuse of this serialized artifact
      // can terminate an ordered-chain recipe at a non-nullable ref to one of these
      // rules (else the chain over-unions the tail and the arm degrades to
      // always-try). Absent → treated as nullable (safe). Plain JSON booleans.
      + `nullable: ${p.nullable ? mapLit(p.nullable) : 'new Map()'}, `
      // Carry the leading first-set RECIPE so a DOWNSTREAM compose of this
      // serialized artifact keeps monolithic-parity first-char dispatch (else
      // fusedBody falls back to the shallow `any` first-set and the arm degrades
      // to always-try — the regression Greptile flagged). Ordered-chain (`{alts}`)
      // and legacy (`{concrete, refs}`) recipes are both plain JSON.
      + `firstSetRecipes: ${p.firstSetRecipes ? mapLit(p.firstSetRecipes) : 'new Map()'}, deps: ${mapLit(p.deps)}, `
      // Carry the HOST MODE across serialization. `hostModeOfPieces` (linker.ts) reads
      // exactly these two to classify a fused artifact, and both default to the 'ast'
      // side when absent — so omitting them made a serialized CST piece round-trip as
      // `{ mode: 'ast', elided: false }` and `assertHostModeCompatible` pass VACUOUSLY
      // on the composed result. That is the same hole this change closes for the
      // in-memory fuse, surviving on the macro's carried path.
      //
      // Written UNCONDITIONALLY, including `'ast'`. Elsewhere `'ast'` is "never stamped"
      // and absence means the default, but a serialized piece is exactly where that
      // conflation caused the bug: absent-because-ast and absent-because-dropped are
      // indistinguishable to the reader. A serialized piece therefore always states its
      // mode, so a future missing field is a MISSING FIELD rather than a silent 'ast'.
      + `hostMode: ${JSON.stringify(p.hostMode ?? 'ast')}, `
      + `hostBranchElided: ${p.hostBranchElided === true}, `
      + `needsEmptyTl: ${p.needsEmptyTl}, needsHostReads: ${p.needsHostReads}, hasDirectBuilders: ${p.hasDirectBuilders === true}, isRecognitionOnly: ${p.isRecognitionOnly === true}, mfFns: [], buildFns: [] }`
  }
  /** Serialize a pieces LIST — one entry for a `rules()` grammar, the flattened
   * list for a `compose()` result. */
  // A carried list entry is either a grammar's own pieces (serialized in full) or
  // an IMPORT MARKER standing in for an imported ancestor grammar's pieces. The
  // marker keeps a descendant from re-serializing everything it imported (Less
  // re-shipping CSS, SCSS re-shipping css+less, …): at read time the marker is
  // resolved back to the ancestor's compiled file transitively. Build-time only —
  // importedPieces resolves it via the module resolver; runtime never reads it.
  // An imported ancestor is referenced by SPREADING its live carried pieces off the
  // imported binding — `...(cssGrammar[Symbol.for('parseman.composedPieces')] ?? [])`.
  // At runtime the ES import is a live value, so this self-resolves (transitively:
  // the ancestor's own value already spread ITS ancestors). At macro-compile time
  // the plugin resolves the spread statically by following the import. Either way
  // the ancestor isn't re-serialized. `local` is the binding name as it appears in
  // THIS module's source (the bundler renames import + references together).
  type ImportSpread = { __spreadLocal: string }
  type IRItem = { ns: string; ir: string }
  type CarriedItem = LinkablePieces | ImportSpread | IRItem
  const isSpread = (it: CarriedItem): it is ImportSpread => '__spreadLocal' in it
  const isIR = (it: CarriedItem): it is IRItem => 'ir' in it && !('ruleFns' in it)
  // A carried entry is: an import SPREAD (live ref to an ancestor's pieces), an IR
  // PIECE (this grammar's own rules as a compact combinator expression, re-lowered
  // at fuse), or full LinkablePieces (fallback when a map can't be serialized).
  const serializeItem = (it: CarriedItem): string =>
    isSpread(it)
      ? `...(${it.__spreadLocal}[Symbol.for('parseman.composedPieces')] ?? [])`
      : isIR(it)
        ? `{ ns: ${JSON.stringify(it.ns)}, ir: ${JSON.stringify(it.ir)} }`
        : serializePieces(it)
  const serializeList = (list: CarriedItem[]): string => `[${list.map(serializeItem).join(', ')}]`

  /**
   * Attach a compiled grammar's linkable pieces onto the value, under
   * `Symbol.for('parseman.composedPieces')` — the same symbol `compose()` reads at
   * runtime. This is why `import { cssGrammar }` is all a downstream package needs:
   * the pieces travel WITH the grammar (no detached, tree-shakeable `__pieces`
   * export). `Object.defineProperty` returns the grammar, so it stays one
   * expression that can't be shaken off the exported const without dropping the
   * grammar; `importedPieces()` reads it back out. The descriptor mirrors the
   * runtime attach (`linker.ts`) — `enumerable: false` so the (large) carried IR
   * isn't dragged along by `Object.assign(target, grammar)` or `{ ...grammar }`.
   */
  const withCarriedPieces = (grammarExpr: string, list: CarriedItem[]): string =>
    `/* @__PURE__ */ Object.defineProperty(${grammarExpr}, Symbol.for('parseman.composedPieces'), { value: ${serializeList(list)}, enumerable: false })`
  const withLeafMarker = (grammarExpr: string): string =>
    `/* @__PURE__ */ Object.defineProperty(${grammarExpr}, Symbol.for('parseman.leafComposed'), { value: true, enumerable: false })`
  /**
   * Stamp a macro-emitted `rules()` map with the host mode it was lowered for, and with
   * whether any direct builder's positioned-CST branch was dropped.
   *
   * `compose()` output gets this from inside `fusedBody`, but a plain `rules()` grammar
   * is emitted by `compileRuleMap` and had NO stamp at all — which is not cosmetic. The
   * drivers read exactly these two symbols to refuse an artifact/host mismatch, so an
   * unstamped map reads as `{ mode: 'ast', elided: false }` and every check passes
   * vacuously. That is how a direct builder in a CST grammar reached a positioned-CST
   * host with nothing raised and the node dropped from the tree.
   *
   * Stamped on the rule FUNCTIONS as well as the map, because `run(map.Rule, …)` is
   * handed the rule and never sees the map. Mirrors `fusedBody`.
   */
  const withHostMode = (grammarExpr: string, mode: HostMode, elided: boolean): string =>
    `/* @__PURE__ */ (m => { for (const k of Object.keys(m)) { `
      + `Object.defineProperty(m[k], Symbol.for('parseman.fusedHostMode'), { value: ${JSON.stringify(mode)}, enumerable: false }); `
      + `Object.defineProperty(m[k], Symbol.for('parseman.fusedHostElided'), { value: ${JSON.stringify(elided)}, enumerable: false }) } `
      + `Object.defineProperty(m, Symbol.for('parseman.fusedHostMode'), { value: ${JSON.stringify(mode)}, enumerable: false }); `
      + `Object.defineProperty(m, Symbol.for('parseman.fusedHostElided'), { value: ${JSON.stringify(elided)}, enumerable: false }); `
      + `return m })(${grammarExpr})`
  /** Coverage-only macro output carries the exact IDs emitted in its generated
   * hooks. The metadata is non-enumerable so grammar maps keep their ordinary
   * public shape, and it is absent entirely from production builds. */
  const withCoverageDefinitions = (grammarExpr: string, definitions: readonly { id: string; kind: string }[]): string =>
    !grammarCoverage ? grammarExpr
      : `/* @__PURE__ */ Object.defineProperty(${grammarExpr}, Symbol.for('parseman.grammarCoverageDefinitions'), { value: Object.freeze(${JSON.stringify(definitions)}.map(Object.freeze)), enumerable: false })`
  const emittedCoverageDefinitions = (source: string): Array<{ id: string; kind: 'rule' | 'choice-arm' | 'dispatch-arm' | 'label' }> => {
    const ids = new Set<string>()
    for (const match of source.matchAll(/id:\s*"([^"]+)"/g)) ids.add(match[1]!)
    return [...ids].sort().map(id => ({
      id,
      kind: id.startsWith('rule:') ? 'rule' : id.startsWith('label:') ? 'label' : id.startsWith('dispatch:') ? 'dispatch-arm' : 'choice-arm',
    }))
  }
  // Same-file `const X = compose([...])` → its carried (re-lowerable) list, so a
  // later same-file compose can chain it AND re-lower it under that compose's own
  // composing trivia (composing-wins holds at every level).
  const localComposedCarried = new Map<string, CarriedItem[]>()
  // …and each local composed grammar's OWN composing trivia, so `pick(g, …)` bakes
  // that trivia (pick freezes its grammar's trivia, like the runtime).
  const localComposedTrivia = new Map<string, Combinator<unknown>>()

  // Cache of RE-LOWERABLE pieces lists read from imported COMPILED grammars'
  // carried pieces (IR pieces + spreads left un-materialized, so the composing
  // grammar's trivia can be applied when they are finally lowered).
  type RawItem = Parameters<typeof materializePiece>[0]  // LinkablePieces | IRPiece
  const importedPiecesCache = new Map<string, RawItem[] | null>()

  /**
   * Read an imported grammar's pieces LIST straight off its COMPILED value —
   * the `Symbol.for('parseman.composedPieces')` literal the macro embeds inside
   * the exported const's initializer (see `withCarriedPieces`). No `__pieces`
   * export, no TS source, no recompile. `import { <name> }` carries everything.
   * null if the grammar wasn't macro-compiled (or isn't source-free composable).
   */
  // Resolve the FULLY-EXPANDED pieces list from a compiled grammar's carried
  // literal. The literal may SPREAD imported ancestors' pieces —
  // `...(binding[Symbol.for('parseman.composedPieces')] ?? [])` — which the runtime
  // resolves off the live import. Here (build time, no live module) we resolve each
  // spread by following that module's own import of `binding` to its compiled file
  // and recursing, then eval the literal with the resolved ancestors stubbed in so
  // the spreads splice their pieces. `seen` guards against an import cycle.
  const resolveModulePieces = (module: ResolvedGrammarModule, exportName: string, seen: Set<string>): RawItem[] | null => {
    const { file } = module
    const mod = module.source
      ? lowerPrivateSourceModule(file, moduleAliases, warnUnloweredRegex, recovery)
      : parseModuleCached(file)
    if (!mod) return null
    const localFor = exportLocalName(mod.body as AnyNode[], exportName)
    const initNode = localFor ? topLevelInit(mod.body as AnyNode[], localFor) : null
    const literalRange = initNode ? findCarriedPiecesLiteral(initNode) : null
    if (!literalRange) return null
    const literal = mod.src.slice(literalRange.start, literalRange.end)

    const imports = extractImportBindings(mod.body as AnyNode[])
    const stubNames: string[] = []
    const stubVals: unknown[] = []
    const spreadRe = /\.\.\.\s*\(?\s*([A-Za-z_$][\w$]*)\s*\[\s*Symbol\s*\.\s*for\s*\(\s*['"]parseman\.composedPieces['"]/g
    const done = new Set<string>()
    for (let m: RegExpExecArray | null; (m = spreadRe.exec(literal)); ) {
      const local = m[1]!
      if (done.has(local)) continue
      done.add(local)
      const b = imports.get(local)
      let subPieces: RawItem[] = []
      if (b) {
        const subModule = resolveGrammarModule(file, b.source)
        if (subModule && !seen.has(subModule.file)) {
          subPieces = resolveModulePieces(subModule, b.imported, new Set(seen).add(subModule.file)) ?? []
        }
      }
      stubNames.push(local)
      stubVals.push({ [Symbol.for('parseman.composedPieces')]: subPieces })
    }
    try {
      // Build-time eval of the carried literal with ancestor spreads stubbed — NOT
      // runtime. `Symbol.for`/`Map` are globals; `stubNames` provide the imports.
      // The result stays RE-LOWERABLE: IR pieces ({ns, ir}) are NOT materialized here,
      // so the composing grammar's trivia can be seeded when they are finally lowered
      // (materializeCarried). Ancestor spreads were already resolved (also un-lowered).
      // eslint-disable-next-line no-new-func
      const list = new Function(...stubNames, `return (${literal})`)(...stubVals) as RawItem[]
      return list
    } catch { return null }
  }

  const importedPieces = (localName: string): RawItem[] | null => {
    if (importedPiecesCache.has(localName)) return importedPiecesCache.get(localName)!
    let result: RawItem[] | null = null
    const binding = importBindings.get(localName)
    if (binding) {
      const module = resolveGrammarModule(id, binding.source)
      result = module ? resolveModulePieces(module, binding.imported, new Set([module.file])) : null
    }
    importedPiecesCache.set(localName, result)
    return result
  }

  /** Lower a compose() carried list to fused `LinkablePieces`, seeding the composing
   * grammar's `trivia` into EVERY re-lowerable item (composing-wins B): an IR piece
   * is re-lowered with that trivia; an import spread's re-lowerable items are re-lowered
   * with it too; a full baked piece (the un-serializable fallback) passes through. */
  const materializeCarried = (
    items: CarriedItem[],
    composing?: Combinator<unknown>,
    captureTerminals = false,
    hostMode?: HostMode,
  ): LinkablePieces[] => {
    const out: LinkablePieces[] = []
    for (const it of items) {
      if (isSpread(it)) {
        for (const p of importedPieces(it.__spreadLocal) ?? []) out.push(materializePiece(p, composing, captureTerminals, hostMode))
      } else if (isIR(it)) {
        out.push(materializePiece(it as RawItem, composing, captureTerminals, hostMode))
      } else {
        out.push(it)
      }
    }
    return out
  }

  /** The carried list's re-lowerable rule maps, in compose order — the input to the
   * fuse-time gating diagnostic. Opaque baked pieces have no combinator graph and are
   * skipped: a hole one of them would bind stays unresolved, so its choice stays
   * DEFERRED (silent) instead of being warned about on a guess. */
  /** The carried list's re-lowerable rule maps PLUS the opaque pieces skipped along the
   * way. The macro engine keeps its
   * own carried-item representation, so it needs its own detailed variant — but it
   * must report the SAME opaque findings the runtime linker does, or the two engines
   * disagree about how much of a fuse was actually analysed. `parity` test:
   * test/unit/gating-composed-grammar.test.ts. */
  const carriedRuleMapsDetailed = (
    items: CarriedItem[],
  ): { maps: Array<Array<[string, Combinator<unknown>]>>; opaque: Array<{ ns: string; ruleNames: string[] }> } => {
    const maps: Array<Array<[string, Combinator<unknown>]>> = []
    const opaque: Array<{ ns: string; ruleNames: string[] }> = []
    const add = (it: CarriedItem): void => {
      if (isIR(it)) { maps.push(evalRuleMapIR(it.ir)); return }
      // `ruleFns` is a Map — see the note on the runtime linker's twin. `Object.keys`
      // on it silently yields [], anonymising every opaque piece.
      const o = it as { ns?: string; ruleFns?: Map<string, string> }
      opaque.push({
        ns: o.ns ?? '<unknown>',
        ruleNames: o.ruleFns instanceof Map ? [...o.ruleFns.keys()] : [],
      })
    }
    for (const it of items) {
      if (isSpread(it)) for (const p of importedPieces(it.__spreadLocal) ?? []) add(p as CarriedItem)
      else add(it)
    }
    return { maps, opaque }
  }

  /** Materialize the exact combinator identities that will be lowered for a
   * coverage-enabled terminal composition.  Coverage IDs are WeakMap keyed, so
   * planning from a second IR hydration would silently leave the emitted pieces
   * uninstrumented.  Opaque baked pieces deliberately fail closed: they cannot
   * prove the post-compose winner graph. */
  const materializeLeafCoverage = (
    items: CarriedItem[],
    localRules: Iterable<readonly [string, unknown]>,
    localNs: string,
    composing?: Combinator<unknown>,
    captureTerminals = false,
  ): LinkablePieces[] | null => {
    type CoverageSource = { ns: string; rules: Array<[string, Combinator<unknown>]> }
    const sources: CoverageSource[] = []
    const add = (item: RawItem): boolean => {
      if (!isIR(item)) return false
      sources.push({ ns: item.ns, rules: evalRuleMapIR(item.ir) })
      return true
    }
    for (const item of items) {
      if (isSpread(item)) {
        const imported = importedPieces(item.__spreadLocal)
        if (!imported || !imported.every(add)) return null
      } else if (!add(item as RawItem)) return null
    }
    sources.push({ ns: localNs, rules: [...localRules] as Array<[string, Combinator<unknown>]> })
    const winners: Record<string, Combinator<unknown>> = {}
    for (const source of sources) for (const [name, rule] of source.rules) winners[name] = rule
    const plan = buildGrammarPlan(Object.values(winners), winners)
    const pieces: LinkablePieces[] = []
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!
      const piece = compileLinkable(source.rules, source.ns, {
        ...(composing ? { trivia: composing } : {}),
        recovery,
        ...(index < sources.length - 1 && captureTerminals ? { captureTerminals: true } : {}),
        coverage: plan,
      })
      if (!piece) return null
      pieces.push(piece)
    }
    return pieces
  }

  /** Resolve one `compose([...])` argument to its RE-LOWERABLE carried items (IR
   * pieces / import spreads / baked-pieces fallback). The composing grammar's trivia
   * is applied later, uniformly, in materializeCarried — never per-piece here. */
  // A local rule map → its compact IR ({ns, ir}) for carrying; the trivia is NOT baked
  // into the IR (it is seeded at re-lower time). When the map can't be faithfully
  // serialized, fall back to full lowered pieces WITH the composing trivia baked in.
  const localCarried = (rm: Iterable<readonly [string, unknown]>, label: string, composing?: Combinator<unknown>, scanSkip?: Combinator<unknown>[]): { carried: CarriedItem[] } | null => {
    const entries = [...rm]
    const ns = nsFor(label)
    // scanSkip is PER-PIECE (opaque units are dialect-specific — NOT composing-wins
    // like trivia), so it rides WITH this element's IR: it is emitted into the carried
    // `rules({ scanSkip }, …)` options, which stamps `_meta.grammarScanSkip` when the IR
    // is re-lowered (materializePiece → compileLinkable picks it up), and survives to a
    // downstream re-compose. The full-pieces fallback bakes it via the compile option.
    const ir = serializeRuleMap(entries as never, scanSkip)
    if (ir) return { carried: [{ ns, ir }] }
    // FULL-PIECES FALLBACK — never taken silently.
    //
    // This branch has no test fixture, and not for want of trying: every callback-source
    // trigger in `serializeRuleMap` is pre-empted by the macro's own stricter guard (a
    // direct builder must be "macro-static and self-contained", which throws first), and
    // every "unsupported tag" trigger is a ChoiceStrategy tag (`types.ts:405-408`), not a
    // ParserDef tag, so it never reaches that switch. It also fired ZERO times across
    // jess's whole five-package compose chain, measured.
    //
    // It is kept rather than deleted because `serializeRuleMap` is a general utility whose
    // trigger set is NOT owned by this call site: if its guards and the macro's guards
    // ever drift apart, this is the path that catches it. What is not acceptable is
    // reaching it without knowing. A silent fallback costs the compact IR (so a downstream
    // re-compose cannot re-lower) and produces a larger artifact — a real degradation that
    // previously looked like normal operation.
    warn(0, `${label}: rule map could not be serialized to IR; carrying FULL pieces instead. `
      + 'The artifact is correct but larger, and a downstream compose cannot re-lower it. '
      + 'Re-run with PARSEMAN_IR_DEBUG=1 to print the exact combinator that blocked serialization.')
    const p = compileLinkable(entries as never, ns, { ...(composing ? { trivia: composing } : {}), ...(scanSkip ? { scanSkip } : {}), recovery })
    return p ? { carried: [p] } : null
  }

  const argPieces = (arg: Expression, label: string, composing?: Combinator<unknown>): { carried: CarriedItem[] } | null => {
    // `pick(grammar, ['A', 'B'])` — à-la-carte selection. Resolve the inner grammar's
    // carried items, materialize them under the INNER grammar's OWN trivia (pick freezes
    // its grammar's trivia — it runs standalone, BEFORE any compose, so the outer
    // composing trivia does NOT reach it; mirrors the runtime pick), then filter to the
    // picked names + their transitive dep closure (same pickPieces() the runtime uses).
    if (isPickCall(arg)) {
      const pargs = (arg as unknown as { arguments: Expression[] }).arguments
      const inner = pargs[0]
      const namesArg = pargs[1] as AnyNode | undefined
      if (!inner || namesArg?.type !== 'ArrayExpression') return null
      const names: string[] = []
      for (const el of (namesArg.elements as AnyNode[] | undefined) ?? []) {
        // oxc emits array string elements as `Literal` (object keys as `StringLiteral`).
        const v = (el as { type?: string; value?: unknown } | undefined)?.value
        if ((el?.type === 'Literal' || el?.type === 'StringLiteral') && typeof v === 'string') names.push(v)
        else return null
      }
      // NOTE: `pick()` is withdrawn from the public API and kept internal/experimental
      // (see src/index.ts + docs/guide/extending.md). Its build-time lowering has known
      // edges — an IMPORTED grammar's ambient trivia can't be carried across the module
      // boundary here, and a picked composed grammar's trivia is frozen against a later
      // outer compose — which is why it's held back. These are not exercised by any
      // public grammar; they'll be resolved if/when pick is re-exposed.
      const innerArg = argPieces(inner, `${label}_pick`)
      if (!innerArg) return null
      try {
        return { carried: pickPieces(materializeCarried(innerArg.carried, ownTrivia(inner)), names) }
      } catch (e) { warn(arg.start, `pick(): ${(e as Error).message}`); return null }
    }
    // Inline `rules(g => …)` or `rules({ trivia }, g => …)` (options-first). The
    // element's OWN trivia option is ignored for lowering — composing-wins means the
    // composing grammar's trivia (computed once, in compileComposeCall) governs every
    // fused rule, this element's included. It only matters as a CANDIDATE for the
    // composing trivia itself, which composingTrivia() reads directly off the AST.
    if (isRulesCall(arg)) {
      // This element's OWN scanSkip DOES thread (per-piece, unlike composing-wins
      // trivia): evaluateRulesFactory returns both the rule map and the grammar-level
      // scanSkip option, which localCarried carries with this piece's IR.
      const evaluated = evaluateRulesFactory(arg, label)
      return evaluated ? localCarried(evaluated.ruleMap, label, composing, evaluated.scanSkip) : null
    }
    if (arg.type === 'Identifier') {
      const name = (arg as unknown as { name: string }).name
      // Local grammar var (`const myRules = rules(...)`).
      const rm = localRuleMaps.get(name)
      if (rm) return localCarried(rm, label, composing, localGrammarScanSkip.get(name))
      // Local composed var (`const g = compose([...])`) → its own carried list, which
      // materializeCarried re-lowers under THIS compose's composing trivia.
      const composed = localComposedCarried.get(name)
      if (composed) return { carried: composed }
      // Imported grammar — carry a live spread of the imported binding (so we don't
      // re-serialize an ancestor); resolved + re-lowered in materializeCarried.
      const pieces = importedPieces(name)
      if (!pieces) return null
      return { carried: importBindings.has(name) ? [{ __spreadLocal: name }] : [...pieces] }
    }
    return null
  }

  /** The composing (outermost) grammar's trivia: the LAST array element that is a
   * plain grammar declaring `trivia` — an inline `rules({ trivia }, …)` (options-first
   * OR legacy trailing-options) or a local `const g = rules({ trivia }, …)`. Composed
   * sub-results and imported compiled grammars do NOT contribute (they carry no
   * re-surfaced trivia identity) — mirrors runtime composingTriviaOf skipping
   * COMPOSED_PIECES / already-compiled artifacts. */
  const rulesCallTrivia = (el: Expression): Combinator<unknown> | undefined => {
    const rulesArgs = (el as unknown as { arguments: unknown[] }).arguments
    const a0 = rulesArgs[0] as AnyNode | undefined
    const a1 = rulesArgs[1] as AnyNode | undefined
    const optExpr = (a0?.type === 'ObjectExpression' ? a0 : a1?.type === 'ObjectExpression' ? a1 : undefined) as AnyNode | undefined
    const triviaProp = ((optExpr?.properties as AnyNode[] | undefined) ?? []).find(
      p => (p as { key?: { name?: string } }).key?.name === 'trivia',
    ) as { value?: Expression } | undefined
    if (!triviaProp?.value) return undefined
    return (evaluateExpr(triviaProp.value, scope, code, []) as Combinator<unknown> | null) ?? undefined
  }
  const composingTrivia = (elements: ReadonlyArray<Expression | null>): Combinator<unknown> | undefined => {
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i]
      if (!el) continue
      if (isRulesCall(el)) {
        const t = rulesCallTrivia(el)
        if (t) return t
        continue
      }
      if (el.type === 'Identifier') {
        const t = localGrammarTrivia.get((el as unknown as { name: string }).name)
        if (t) return t
        // local composed / imported compiled grammar → contributes rules, not trivia.
      }
      // a pick(...) element carries a frozen artifact → contributes rules, not trivia.
    }
    return undefined
  }

  /** A single grammar element's OWN declared trivia (used by pick, which freezes it):
   * an inline `rules({ trivia }, …)`, a local `rules({ trivia }, …)`, a local composed
   * grammar's composing trivia, or (recursively) the grammar inside a nested pick. */
  const ownTrivia = (arg: Expression): Combinator<unknown> | undefined => {
    if (isRulesCall(arg)) return rulesCallTrivia(arg)
    if (isPickCall(arg)) {
      const inner = (arg as unknown as { arguments: Expression[] }).arguments[0]
      return inner ? ownTrivia(inner) : undefined
    }
    if (arg.type === 'Identifier') {
      const name = (arg as unknown as { name: string }).name
      return localGrammarTrivia.get(name) ?? localComposedTrivia.get(name)
    }
    return undefined
  }

  /** Compile `compose([...])` to STATIC fused source (eval-free) + its carried
   * (re-lowerable) list (for a sidecar / same-file chaining). null → leave the
   * runtime `compose()` in place (correct, just not build-fused). */
  const compileComposeCall = (init: Expression): { replacement: string; carried: CarriedItem[]; trivia?: Combinator<unknown> } | null => {
    const args = (init as unknown as { arguments: Expression[] }).arguments
    const arr = args[0]
    if (!arr || arr.type !== 'ArrayExpression') {
      warn(init.start, 'compose(): expected a static array of grammars/artifacts')
      return null
    }
    const elements = (arr as unknown as { elements: Expression[] }).elements
    // `compose(items, { hostMode })` — read and VALIDATE it, mirroring `rules()`. This
    // argument used to be ignored entirely: `args[1]` was never read, so a macro build of
    // `compose(items, { hostMode: 'cst' })` silently produced an 'ast' artifact while the
    // runtime path honoured the option. Silently is the operative word — the caller asked
    // for a CST artifact, got an eval-AST one, and the compatibility assertion then passed
    // because the artifact genuinely WAS 'ast'. Same vacuous-classification shape this
    // change exists to remove, one call site over.
    const cOptions = (init as unknown as { arguments: Expression[] }).arguments[1] as AnyNode | undefined
    const cHostModeValue = cOptions?.type === 'ObjectExpression'
      ? (((cOptions.properties as AnyNode[] | undefined) ?? []).find(
          p => (p as { key?: { name?: string } }).key?.name === 'hostMode',
        ) as { value?: Expression } | undefined)?.value
      : undefined
    const cHostMode = cHostModeValue?.type === 'Literal'
      ? (cHostModeValue as unknown as { value?: unknown }).value
      : undefined
    if (cHostModeValue !== undefined && cHostMode !== 'ast' && cHostMode !== 'cst') {
      warn(init.start, "compose({ hostMode }) must be the literal 'ast' or 'cst'")
      return null
    }
    // Composing-wins (B): ONE composing trivia, from the last plain grammar in the
    // list that declares one, governs EVERY fused rule — including inherited ones.
    const composing = composingTrivia(elements)
    const carried: CarriedItem[] = []       // re-lowerable; also SERIALIZED onto the value
    for (let i = 0; i < elements.length; i++) {
      const r = argPieces(elements[i]!, `compose${init.start}_${i}`, composing)
      if (!r) { warn(init.start, `compose(): argument ${i} isn't a build-resolvable grammar; falling back to runtime`); return null }
      carried.push(...r.carried)
    }
    // Fuse time is where a shared shape's `g.Foo` hole is finally bound, so it is the
    // only site that can answer whether the choices it leads actually gate.
    // ONE hydration shared by both thunks — see `once` in the linker.
    const detailed = once(() => carriedRuleMapsDetailed(carried))
    runFusedGatingDiagnostic(
      () => detailed().maps,
      undefined,
      () => detailed().opaque,
    )
    // Lower the whole list ONCE, seeding the composing trivia into every re-lowerable
    // piece (composing-wins), then fuse.
    const pieces = materializeCarried(carried, composing, false, cHostMode as HostMode | undefined)
    try {
      return { replacement: emitFusedSource(pieces), carried, ...(composing ? { trivia: composing } : {}) }
    } catch (e) {
      warn(init.start, `compose(): ${(e as Error).message}; falling back to runtime`)
      return null
    }
  }

  /**
   * Compile a terminal composition. Imported/base pieces still travel as normal
   * re-lowerable IR, but the final local rules map is compiled directly in this
   * module. Its direct builders may therefore refer to lexical AST constructors;
   * they are inlined into the fused output and are never serialized or carried.
   */
  const compileComposeLeafCall = (init: Expression): { replacement: string } | null => {
    const args = (init as unknown as { arguments: Expression[] }).arguments
    const arr = args[0]
    if (!arr || arr.type !== 'ArrayExpression') {
      warn(init.start, 'composeLeaf(): expected a static array of grammars')
      return null
    }
    const elements = (arr as unknown as { elements: Expression[] }).elements
    if (elements.length < 2) {
      warn(init.start, 'composeLeaf(): needs imported recognition grammar(s) and one local rules() map')
      return null
    }
    const localArg = elements[elements.length - 1]!
    let localRules: Iterable<readonly [string, unknown]> | null = null
    // The LOCAL leaf grammar's own ambient scanSkip (from its `rules({ scanSkip })`)
    // governs the scanTo/balanced sites IT defines — unlike trivia (composing-wins),
    // opaque units are dialect-specific, so the local declaration is threaded to the
    // local piece's compile.
    let localScanSkip: Combinator<unknown>[] | undefined
    if (isRulesCall(localArg)) {
      const evaluated = evaluateRulesFactory(localArg, `composeLeaf${init.start}`)
      localRules = evaluated?.ruleMap ?? null
      localScanSkip = evaluated?.scanSkip
    } else if (localArg.type === 'Identifier') {
      const name = (localArg as unknown as { name: string }).name
      localRules = localRuleMaps.get(name) ?? null
      localScanSkip = localGrammarScanSkip.get(name)
    }
    if (!localRules) {
      warn(init.start, 'composeLeaf(): final argument must be a local rules() map')
      return null
    }
    const composing = composingTrivia(elements)
    const carried: CarriedItem[] = []
    for (let i = 0; i < elements.length - 1; i++) {
      const r = argPieces(elements[i]!, `composeLeaf${init.start}_${i}`, composing)
      if (!r) {
        warn(init.start, `composeLeaf(): argument ${i} isn't a build-resolvable recognition grammar`)
        return null
      }
      carried.push(...r.carried)
    }
    try {
      // The imported pieces are recognition-only, but the local leaf grammar
      // may place one beneath a direct node(). Re-lower their terminals with
      // capture enabled so that node receives the imported token values in its
      // normal child collector; the pieces still contain no semantic callback.
      const localNs = nsFor(`composeLeaf${init.start}`)
      // The local leaf map is the LAST (winning) contributor, and is usually the one
      // that binds the imported shapes' holes — so it must be part of the fused view.
      const detailedLeaf = once(() => carriedRuleMapsDetailed(carried))
      runFusedGatingDiagnostic(
        () => [...detailedLeaf().maps, [...localRules] as Array<[string, Combinator<unknown>]>],
        undefined,
        () => detailedLeaf().opaque,
      )
      const plainLocalPiece = compileLinkable([...localRules] as never, localNs, { ...(composing ? { trivia: composing } : {}), ...(localScanSkip ? { scanSkip: localScanSkip } : {}), recovery })
      if (!plainLocalPiece) {
        warn(init.start, 'composeLeaf(): local rules could not be statically compiled')
        return null
      }
      const recognitionPieces = grammarCoverage
        ? materializeLeafCoverage(carried, localRules, localNs, composing, plainLocalPiece.hasDirectBuilders === true)
        : materializeCarried(carried, composing, plainLocalPiece.hasDirectBuilders === true)
      if (!recognitionPieces) {
        warn(init.start, 'composeLeaf(): coverage needs re-lowerable recognition IR')
        return null
      }
      const importedRecognitionPieces = grammarCoverage ? recognitionPieces.slice(0, -1) : recognitionPieces
      if (importedRecognitionPieces.some(piece => piece.hasDirectBuilders !== false || piece.isRecognitionOnly !== true)) {
        warn(init.start, 'composeLeaf(): every pre-final grammar must explicitly prove recognition-only')
        return null
      }
      const replacement = withLeafMarker(emitFusedSource(grammarCoverage ? recognitionPieces : [...recognitionPieces, plainLocalPiece]))
      return { replacement: withCoverageDefinitions(replacement, emittedCoverageDefinitions(replacement)) }
    } catch (e) {
      warn(init.start, `composeLeaf(): ${(e as Error).message}`)
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
            const compiled = compile(refCombi, undefined, { recovery, coverage: grammarCoverage, gating: { entryName: varName } })
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
          // Remember the rule map so a same-file `compose([varName, …])` can fuse it,
          // and its grammar-level trivia so that compose can adopt it (composing-wins).
          localRuleMaps.set(varName, compiledRules.ruleMap)
          if (compiledRules.trivia) localGrammarTrivia.set(varName, compiledRules.trivia)
          if (compiledRules.scanSkip) localGrammarScanSkip.set(varName, compiledRules.scanSkip)
          // Carry the grammar's linkable pieces ON the value so a downstream package
          // composes it via `import { <name> }` alone. Needed when EXPORTED — and
          // computed unconditionally for a SHARED SHAPE, because the pieces are the
          // proof that the shape really did compile (see below).
          //
          // Thread `scanSkip` explicitly: this is the FULL-PIECE fallback taken when
          // the IR isn't serializable, and it is what a downstream package composes.
          // (The `_meta` stamp in evaluateRulesFactory also covers it; passing it
          // here keeps the intent local and independent of that.) `trivia` is NOT
          // threaded — it is composing-wins, so the downstream compose supplies it;
          // `scanSkip` is per-piece (opaque units are dialect-specific) and must
          // travel WITH the grammar or the downstream loses ambient skipping.
          const ns = nsFor(varName)
          const pieces = exportPrefix || compiledRules.replacement === null
            ? compileLinkable([...compiledRules.ruleMap], ns, {
                ...(compiledRules.scanSkip ? { scanSkip: compiledRules.scanSkip } : {}),
                recovery,
              })
            : null
          // A SHARED SHAPE — a map with an unresolved external `g.` ref, e.g.
          // `Ratio: sequence(g.Value, literal('/'), g.Value)` where the consuming
          // dialect defines `Value`. It can't be inlined as a standalone parser (the
          // hole has no body here), so its runtime value stays the `rules(…)` call —
          // the interpreter map, which is the only correct standalone value for a
          // grammar with a hole. `compileLinkable` DOES compile it (it emits a by-name
          // `_r_<Name>` call for each hole, bound at fuse time), so a downstream
          // `compose()` / `composeLeaf()` still fully macro-fuses it. Nothing failed,
          // so this doesn't warn — it only pins the macro import, since the emitted
          // source still calls `rules`. Requiring `pieces` here is what keeps this
          // from swallowing a map that failed to inline for some OTHER reason and
          // merely happens to also reference an external rule.
          if (compiledRules.replacement === null) {
            if (!pieces || !hasExternalRuleRef([...compiledRules.ruleMap])) {
              warn(init.start, `${varName}: rule map couldn't be inlined`)
              continue
            }
            keepMacroImport = true
          }
          const source = compiledRules.replacement ?? code.slice(init.start, init.end)
          // Carry only when the pieces are fully static (no runtime-only callbacks) —
          // otherwise the grammar isn't source-free composable and we ship it as a
          // plain map.
          let replacement = withCoverageDefinitions(
            source,
            compiledRules.coverageDefinitions?.length ? compiledRules.coverageDefinitions : emittedCoverageDefinitions(source),
          )
          // Only a genuinely lowered map is stamped. The SHARED-SHAPE fallback above keeps
          // its `rules(…)` source, and that value is built by the interpreter at runtime —
          // which stamps itself, and which never elides a branch.
          if (compiledRules.replacement !== null) {
            replacement = withHostMode(replacement, compiledRules.hostMode, compiledRules.hostBranchElided)
          }
          if (exportPrefix && pieces && !pieces.mfFns.length && !pieces.buildFns.length) {
            // Carry the compact IR when serializable; else the full lowered pieces.
            // Thread the grammar's scanSkip into the IR so a downstream compose of
            // this imported grammar re-lowers its scanTo/balanced sites ambiently.
            const ir = serializeRuleMap([...compiledRules.ruleMap] as never, compiledRules.scanSkip)
            replacement = withCarriedPieces(replacement, [ir ? { ns, ir } : pieces])
          }
          replacements.push({ start: init.start, end: init.end, replacement })
          continue
        }

        // const name = compose([...]) → STATIC fused source (eval-free); the macro
        // fuses at build, never emitting `new Function`.
        if (isComposeCall(init)) {
          const fused = compileComposeCall(init)
          if (!fused) {
            runtimeComposeFallback = true
            continue // leave the runtime compose() call in place
          }
          // Remember for a same-file downstream compose, and (if exported) carry the
          // re-lowerable list on the value so another package can compose this composed
          // grammar via `import { <name> }` (re-composition, no source) and re-lower it
          // under ITS composing trivia.
          localComposedCarried.set(varName, fused.carried)
          if (fused.trivia) localComposedTrivia.set(varName, fused.trivia)
          const replacement = exportPrefix
            ? withCarriedPieces(fused.replacement, fused.carried)
            : fused.replacement
          replacements.push({ start: init.start, end: init.end, replacement: withCoverageDefinitions(replacement, emittedCoverageDefinitions(replacement)) })
          continue
        }

        // `composeLeaf([...recognition, localRules])` is static and terminal:
        // local direct builders stay lexical and are not carried/recomposable.
        if (isComposeLeafCall(init)) {
          const fused = compileComposeLeafCall(init)
          if (!fused) {
            throw new Error(`${id}:${lineOf(init.start)} — composeLeaf() must macro-fuse; runtime composition is forbidden`)
          }
          replacements.push({ start: init.start, end: init.end, replacement: fused.replacement })
          continue
        }

        const mapFnSources: string[] = []
        const parser = evaluateExpr(init, scope, code, mapFnSources)
        if (parser === null) {
          const wordFactory = evaluateWordFactory(init, scope, code)
          if (wordFactory) {
            ;(scope as Map<string, unknown>).set(varName, wordFactory)
            replacements.push({ start: init.start, end: init.end, replacement: 'undefined' })
            continue
          }
          const whenFactory = evaluateWhenFactory(init, scope, code)
          if (whenFactory) {
            ;(scope as Map<string, unknown>).set(varName, whenFactory)
            replacements.push({ start: init.start, end: init.end, replacement: 'undefined' })
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
          // A `rules()` FACTORY is not a combinator and never was one — it is a function
          // that returns the rule map. It only reaches this branch now that a factory can
          // be shared by name (see `factoryDecls`), and warning here would tell the author
          // to "simplify" the one declaration the two-artifact pattern requires.
          if (factoryDecls.has(varName)) continue
          warn(init.start, `"${varName}" references a parseman macro import but isn't a statically-evaluable combinator`)
          continue
        }

        // Sources are carried on each transform's def (set by the evaluator), so
        // codegen derives them in traversal order — no positional array needed.
        // `entryName`: attribute the gating diagnostic to the BINDING's own name.
        // Without it every top-level combinator const warns as `choice @ <entry>`,
        // which names nothing and gives the `accept` allowlist no discriminating key.
        const compiled = compile(parser, undefined, { recovery, coverage: grammarCoverage, gating: { entryName: varName } })
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
        // A destructured binding names INDIVIDUAL rules, so it has to inline —
        // there is no shared-shape path here (a hole has no standalone value).
        if (compiledRules.replacement === null) { warn(init.start, `{ … }: rule map couldn't be inlined`); continue }

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
  // the macro attribute so the import stays valid for the interpreter). A shared
  // shape also keeps the import — its emitted value still calls `rules(…)` — but
  // without the "fell back to the interpreter" warning, because nothing failed.
  for (const imp of macroImports) {
    imp.fullyResolved = !anyUnresolved && !keepMacroImport
  }

  const ms = new MagicString(code)

  // Strip `x.define(...)` statements — only when every ref() cluster was inlined.
  // If anything fell back to the interpreter the import stays, and those
  // statements are still needed to wire the ref at runtime. (A shared shape holds
  // no ref() cluster of its own, so it doesn't gate this.)
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

  // Runtime compose consumes combinator objects. A partially lowered module mixes
  // compiled parser functions with those objects (for example `trivia(ws)` after
  // `ws` was lowered), so an unresolved compose makes the whole module runtime.
  const applied = runtimeComposeFallback ? [] : replacements
  for (const { start, end, replacement } of applied.slice().sort((a, b) => b.start - a.start)) {
    ms.overwrite(start, end, replacement)
  }

  // Stamp the generated artifact with a version-lock banner. This is the exact spot a
  // stale artifact is inspected, and the version here IS the stamp fusedBody's
  // version-lock assertion compares (see src/version.ts).
  if (applied.length > 0) {
    ms.prepend(
      `// Generated by parseman v${PARSEMAN_VERSION} — DO NOT EDIT.\n` +
      `// Version-locked: compile AND fuse/link this artifact with parseman v${PARSEMAN_VERSION} ONLY.\n` +
      `// Parseman does not read artifacts across versions; recompile if the version differs.\n`,
    )
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
