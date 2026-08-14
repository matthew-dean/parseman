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
import { evaluateExpr, evaluateCombinatorArray, evaluateParserFactory, evaluateStaticValue, evaluateWordFactory, evaluateWhenFactory, evaluateRefDeclaration, applyDefineStatement, referencesAny, setReducerResolver, propName, type Scope, type ScopeEntry } from './evaluator.ts'
import { classifyRuleMap } from '../analysis/commitment.ts'
import { compile } from '../table/compile.ts'
import { compileRuleMap } from '../table/compile-rule-map.ts'
import { compileLinkableTable } from '../compiler/compile-linkable-table.ts'
import { createReducerResolver } from './reducer-resolver.ts'
import { findFreeIdentifiers } from './free-identifiers.ts'
import {
  beginDegradationCapture, endDegradationCapture, formatDegradation, formatDegradations,
  resolveDegradationLevel, recordDegradation, degradationCaptureDepth, unwindDegradationCapture,
} from '../compiler/degradation.ts'
import type { HostMode } from '../cst/host-mode.ts'
import { COMPOSED_PIECES } from '../compiler/linker.ts'
import { evalRuleMapIR, serializeRuleMap } from '../compiler/ir-serialize.ts'
import { PARSEMAN_VERSION } from '../version.ts'
import { grammarReflectionSource, type GrammarReflection } from '../cst/reflection.ts'
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

/**
 * Where a lowered module imports the shared table driver from.
 *
 * The PUBLIC subpath, not a deep path into `src/`: this string is written into a
 * consumer's build output, so it has to be a specifier their resolver can see.
 * `parseman/table` is declared in package.json `exports` and re-exports
 * `tableRules` as `tableRules` (src/table/index.ts:28).
 */
const TABLE_RUNTIME_SPECIFIER = 'parseman/table'

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

/**
 * The REASON a lowering refused, appended to the warning that reports it.
 *
 * A grammar that fails to lower falls back to the interpreter with the parseman
 * import surviving — it still parses, so no test notices, and the only symptom is
 * ~79 ms against ~14 ms on `benchmark.less`. "Couldn't be inlined" alone does not
 * tell an author which construct to change; the compiler knows, so it says.
 */
function reasonSuffix(runtimeOnly: readonly string[] | undefined): string {
  return runtimeOnly === undefined || runtimeOnly.length === 0
    ? ''
    : ` — ${runtimeOnly.join('; ')}`
}

/** THE reader for a build-time options object — `rules({ … }, f)`, `compose(…, { … })`.
 *
 * Returns the value expression for `name`, or undefined when the object does not set it.
 * Keys are compared through `propName`, the plugin's single property-key reader, so a
 * QUOTED key is the same key and a COMPUTED key is no key at all.
 *
 * This existed three times, inline, each reading only `key.name`. The runtime path reads
 * a real object and cannot tell `{ hostMode: 'cst' }` from `{ 'hostMode': 'cst' }`; the
 * macro could, and dropped the second — shipping an 'ast' artifact for a source that
 * asked for 'cst', with no warning, which `assertHostModeCompatible` then passed because
 * the artifact genuinely WAS 'ast'. Two correct copies would not have been a fix here;
 * there were three copies and all three were wrong the same way. */
function optionProp(optExpr: AnyNode | undefined, name: string): Expression | undefined {
  if (optExpr?.type !== 'ObjectExpression') return undefined
  const found = ((optExpr.properties as AnyNode[] | undefined) ?? [])
    .find(p => propName(p as never) === name)
  return (found as { value?: Expression } | undefined)?.value
}

function unwrapStaticExpression(expr: Expression): Expression {
  let cur = expr as unknown as { type?: string; expression?: Expression }
  while (cur.type === 'TSAsExpression'
    || cur.type === 'TSSatisfiesExpression'
    || cur.type === 'TSNonNullExpression'
    || cur.type === 'TSTypeAssertion'
    || cur.type === 'TSInstantiationExpression'
    || cur.type === 'ParenthesizedExpression') {
    if (!cur.expression) break
    cur = cur.expression as unknown as typeof cur
  }
  return cur as Expression
}

function isStaticNullishExpression(expr: Expression): boolean {
  const unwrapped = unwrapStaticExpression(expr) as Expression & { name?: string; value?: unknown }
  return (unwrapped.type === 'Identifier' && unwrapped.name === 'undefined')
    || (unwrapped.type === 'Literal' && unwrapped.value === null)
}

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
      // Table lowering: `tableRules(program, { [Symbol.for('…composedPieces')]:
      // <literal>, … })`. The metadata object becomes the returned map's
      // prototype, so the symbol remains readable without becoming an own key.
      if ((callee as { type?: string; name?: string } | undefined)?.type === 'Identifier'
        && (callee as { name?: string }).name === 'tableRules'
        && (args?.[1] as AnyNode | undefined)?.type === 'ObjectExpression') {
        for (const p of ((args![1] as AnyNode).properties as AnyNode[] | undefined) ?? []) {
          if ((p as { computed?: boolean }).computed && isComposedPiecesSymbol(p.key as AnyNode) && p.value) {
            found = { start: (p.value as AnyNode).start, end: (p.value as AnyNode).end }
            return
          }
        }
      }
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

/**
 * Transform one module, ALWAYS releasing the process-global capture state.
 *
 * `beginDegradationCapture()`, `beginLoweringCapture()` and `setReducerResolver()` set
 * module-level globals that the body's straight-line path released at the end. The body
 * also THROWS — `composeLeaf() must macro-fuse` at the `compileComposeLeafCall` site is
 * one of several — and every one of those throws jumped over the release.
 *
 * The consequence was process-wide and silent: one failed macro transform left the
 * degradation sink OPEN forever, so every later `recordDegradation` — including from an
 * unrelated runtime `compile()` in the same process — was filed into an orphaned Map that
 * nobody would ever drain, and printed nothing. Measured: 0 `console.warn` calls after an
 * aborted capture, 1 finding stranded in the orphan.
 *
 * So the release lives in a `finally`, and whatever the failed frame had collected is
 * printed rather than dropped — a degradation that was real before the abort is still
 * real after it.
 */
export function transformMacro(
  code: string,
  id: string,
  moduleAliases = new Set([PARSEMAN_MODULE]),
  warnUnloweredRegex = false,
  recovery = false,
  grammarCoverage = false,
): TransformMacroResult | null {
  const depth = degradationCaptureDepth()
  try {
    return transformMacroImpl(code, id, moduleAliases, warnUnloweredRegex, recovery, grammarCoverage)
  } finally {
    setReducerResolver(null)
    // Both are idempotent: on the success path the body already released them and these
    // are no-ops. On an aborted transform they are what stops the leak.
    for (const d of unwindDegradationCapture(depth)) console.warn(formatDegradation(d))
  }
}

function transformMacroImpl(
  code: string,
  id: string,
  moduleAliases: Set<string>,
  warnUnloweredRegex: boolean,
  recovery: boolean,
  grammarCoverage: boolean,
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
  const ordinaryImports: Array<{
    start: number
    end: number
    specifiers: Array<{ type: string; local: string; start: number; end: number }>
  }> = []

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
      const specifiers: Array<{ type: string; local: string; start: number; end: number }> = []
      for (const spec of s.specifiers) {
        if (spec.type === 'ImportSpecifier') {
          const imported = (spec.imported as { name?: string }).name ?? spec.local.name
          importBindings.set(spec.local.name, { source: s.source.value, imported })
          specifiers.push({ type: spec.type, local: spec.local.name, start: spec.start, end: spec.end })
        } else {
          specifiers.push({ type: spec.type, local: spec.local.name, start: spec.start, end: spec.end })
        }
      }
      ordinaryImports.push({ start: s.start, end: s.end, specifiers })
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

  const unwrapVd = (stmt: Statement): VariableDeclaration | null =>
    stmt.type === 'VariableDeclaration'
      ? (stmt as unknown as VariableDeclaration)
      : stmt.type === 'ExportNamedDeclaration'
        && (stmt as unknown as ExportNamedDeclaration).declaration?.type === 'VariableDeclaration'
        ? ((stmt as unknown as ExportNamedDeclaration).declaration as unknown as VariableDeclaration)
        : null

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
  const factoryDecls = new Map<string, { fn: Expression; declaredAt: number; code?: string; scope?: Scope; imported?: boolean }>()
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

  /*
   * Reducer resolution, for `node(..., build)` where `build` is a NAME rather than an
   * inline function.
   *
   * `buildSrc` is the call site's EXPRESSION text, so a named reducer arrives as just the
   * name — no parameter list — and the capture-tier analysis used to fail open and charge
   * the node all five facilities. Sharing reducers across a grammar and importing them
   * from another module is ordinary grammar authoring, so the resolver does the analysis
   * (lexical scope tree, cross-module import following) rather than reporting that it
   * won't. See `reducer-resolver.ts` for what it decides and what genuinely declines.
   *
   * Everything it produces — `_def.buildArity`, `_def.buildSigSrc` — is ANALYSIS-ONLY and
   * never emitted, so the generated builder reference is unchanged either way.
   */
  const reducerResolver = createReducerResolver(id, body as unknown[], code)
  setReducerResolver(reducerResolver, code)

  const topLevelFunction = (moduleBody: AnyNode[], name: string): AnyNode | null => {
    for (const st of moduleBody) {
      const decl = st.type === 'ExportNamedDeclaration'
        ? (st as unknown as { declaration?: AnyNode }).declaration
        : st
      const idn = decl?.type === 'FunctionDeclaration'
        ? (decl as unknown as { id?: { name?: string } }).id
        : undefined
      if (idn?.name === name) return decl ?? null
    }
    return null
  }
  const isParsemanMacroImport = (stmt: AnyNode): boolean => {
    if (stmt.type !== 'ImportDeclaration') return false
    const s = stmt as unknown as ImportDeclaration
    return moduleAliases.has(s.source.value) && s.attributes.some(a => {
      const key = a.key.type === 'Identifier' ? a.key.name : String(a.key.value)
      return key === 'type' && a.value.value === 'macro'
    })
  }
  const sourceScopeUntil = (moduleBody: AnyNode[], source: string, until: number): Scope | null => {
    const out: Scope = new Map()
    for (const stmt of moduleBody as Statement[]) {
      if (stmt.type === 'ImportDeclaration') {
        if (!isParsemanMacroImport(stmt as unknown as AnyNode)) return null
        continue
      }
      if (stmt.type === 'FunctionDeclaration') continue
      if (stmt.type === 'ExportNamedDeclaration' && (stmt as unknown as ExportNamedDeclaration).declaration?.type === 'FunctionDeclaration') continue
      if (stmt.type === 'ExportNamedDeclaration' && !(stmt as unknown as ExportNamedDeclaration).declaration) {
        if ((stmt as unknown as { source?: unknown }).source) return null
        continue
      }
      const vd = unwrapVd(stmt)
      if (!vd || (vd as unknown as { kind?: string }).kind !== 'const') return null
      for (const decl of vd.declarations) {
        const d = decl as VariableDeclarator
        const idn = d.id as unknown as { type?: string; name?: string }
        const init = d.init as Expression | null | undefined
        if ((idn.type !== 'Identifier' && idn.type !== 'BindingIdentifier') || !idn.name || !init) return null
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') continue
        const mapFnSources: string[] = []
        const combi = evaluateExpr(init, out, source, mapFnSources)
        if (combi) {
          if (stmt.start < until) out.set(idn.name, { combi, mfSrcs: mapFnSources })
          continue
        }
        const wordFactory = evaluateWordFactory(init, out, source)
        if (wordFactory) {
          if (stmt.start < until) {
            ;(out as Map<string, unknown>).set(idn.name, wordFactory)
          }
          continue
        }
        const whenFactory = evaluateWhenFactory(init, out, source)
        if (whenFactory) {
          if (stmt.start < until) {
            ;(out as Map<string, unknown>).set(idn.name, whenFactory)
          }
          continue
        }
        const combiArray = evaluateCombinatorArray(init, out, source)
        if (combiArray) {
          if (stmt.start < until) {
            ;(out as Map<string, unknown>).set(idn.name, combiArray)
          }
          continue
        }
        return null
      }
      continue
    }
    return out
  }
  const usedImportedFactories = new Set<string>()
  const markUsedImportedFactories = (names: readonly string[] | undefined): void => {
    for (const name of names ?? []) usedImportedFactories.add(name)
  }
  for (const [localName, binding] of importBindings) {
    const file = resolvePrivateSourceModule(id, binding.source)
    if (!file) continue
    const mod = parseModuleCached(file)
    if (!mod) continue
    const localFor = exportLocalName(mod.body as AnyNode[], binding.imported)
    const init = localFor ? topLevelInit(mod.body as AnyNode[], localFor) ?? topLevelFunction(mod.body as AnyNode[], localFor) : null
    if (!init || (init.type !== 'ArrowFunctionExpression' && init.type !== 'FunctionExpression' && init.type !== 'FunctionDeclaration')) continue
    const factoryScope = sourceScopeUntil(mod.body as AnyNode[], mod.src, init.start)
    if (!factoryScope) continue
    factoryDecls.set(localName, {
      fn: init as unknown as Expression,
      declaredAt: -1,
      code: mod.src,
      scope: factoryScope,
      imported: true,
    })
    // This factory is evaluated with `code: mod.src`, so every `node(…, build)` inside
    // it hands the resolver an offset into THIS file. Tell the resolver the file exists
    // so it answers against that module's own scope tree instead of declining
    // `foreign-source` — a decline is sound but charges the node full capture.
    reducerResolver.register(file)
  }

  // --- Pass 2: evaluate declarations in source order ---
  // Scope stores enriched ScopeEntry objects so evaluateParserFactory can
  // replay mfSrcs when outer-scope combinators are referenced inside factories.
  const scope: Scope = new Map<string, ScopeEntry>()
  const replacements: Array<{ start: number; end: number; replacement: string }> = []
  const warnings: string[] = []
  // Collect degradations instead of printing them, so they arrive on the SAME channel
  // as every other macro warning (the bundler's `this.warn`) with a `file:line` anchor.
  beginDegradationCapture()
  let anyUnresolved = false
  // A declaration whose emitted value still CALLS a macro import, without anything
  // having failed: a shared shape keeps its `rules(…)` source (the interpreter map is
  // the only correct standalone value for a grammar with a hole) while still carrying
  // fully compiled pieces for downstream composition. The import must survive, but
  // this is not an unresolved shape, so it neither warns nor blocks other cleanups.
  let keepMacroImport = false
  /**
   * Set when any emitted replacement is a TABLE, which references the shared
   * driver `tableRules` by name.
   *
   * This is the one CONTRACT DIVERGENCE the table lowering states openly
   * (`table/compile.ts`): a table expression is not self-contained, because the
   * driver being external is exactly why the artifact is 0.56 MB rather than
   * 2.10 MB. Inlining the driver per grammar rebuilds the size this lowering
   * exists to remove. So the plugin owns the import, and the free-identifier net
   * at the end of this transform is what proves it was actually emitted.
   */
  let usedTableRuntime = false
  /** Exported `rules()` factories, whose bodies are left verbatim. See the push site. */
  const exportedFactories: Array<{ name: string; pos: number }> = []
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
  ): { ruleMap: Map<string, Combinator<unknown>>; trivia?: Combinator<unknown>; scanSkip?: Combinator<unknown>[]; trackLines?: boolean; importedFactory?: string } | null => {
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
    const factoryScope = namedFactory?.scope ?? scope
    const factoryCode = namedFactory?.code ?? code
    const importedFactory = namedFactory?.imported === true && factoryArg === namedFactory.fn
      ? (factoryArgRaw as unknown as { name?: string }).name
      : undefined

    // Grammar-level options object — evaluate `trivia` / `scanSkip` so the compiled
    // map seeds them as the ambient defaults (build-time mirror of rules() tagging
    // grammarTrivia / grammarScanSkip at runtime).
    const optionsArg = (optionsFirst ? arg0 : arg1) as AnyNode | undefined
    const optionValue = (name: string): Expression | undefined => optionProp(optionsArg, name)

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
    const trackLinesValue = optionValue('trackLines')
    const gTrackLines = trackLinesValue?.type === 'Literal'
      ? (trackLinesValue as unknown as { value?: unknown }).value
      : undefined
    if (trackLinesValue !== undefined && typeof gTrackLines !== 'boolean') {
      warn(init.start, `${label}: rules({ trackLines }) must be a boolean literal`)
      return null
    }

    // A specific reason when the factory BODY is what failed. The generic message
    // points nowhere near the cause, and the dominant real cause — a forward
    // reference to a const declared lower down — is one the interpreter reports
    // precisely. Two lanes lost a round to the generic text.
    /*
     * THE OPTIONS GO IN, THEY ARE NOT REAPPLIED AFTERWARDS.
     *
     * Three loops used to live below this point, stamping `grammarScanSkip`,
     * `grammarHostMode` and `grammarTrackLines` onto the evaluated rules, each
     * carrying a comment that the macro "evaluates the FACTORY directly and never
     * calls `rules()`". It does now, so the options are threaded as the
     * `RulesOptions` argument and `rules()` applies them — the same code, on the
     * same rules, at the same point, for the runtime and the build.
     *
     * That also fixes the `trackLines` half, which the stamp-only copy got wrong:
     * `rules()` does not merely mark the rules, it WRAPS each non-trivia rule in a
     * `grammarParser({ trackLines: true })` scope (`parser.ts:228-242`). The macro
     * carried the setting to the encoder by a different route instead, so the two
     * routes built structurally different maps for the same source.
     *
     * Evaluated BEFORE the factory because they are now inputs to it.
     */
    const triviaValue = optionValue('trivia')
    const gTrivia = triviaValue ? evaluateExpr(triviaValue, scope, code, []) : undefined
    const scanSkipValue = optionValue('scanSkip')
    const gScanSkip = scanSkipValue
      ? (evaluateCombinatorArray(scanSkipValue, scope, code) ?? undefined)
      : undefined

    const why: { reason?: string } = {}
    const ruleMap = evaluateParserFactory(factoryArg, factoryScope, factoryCode, [], why, {
      ...(gTrivia ? { trivia: gTrivia as Combinator<unknown> } : {}),
      ...(gScanSkip ? { scanSkip: gScanSkip } : {}),
      ...(gHostMode === 'cst' ? { hostMode: 'cst' as const } : {}),
      ...(gTrackLines === true ? { trackLines: true } : {}),
    })
    if (!ruleMap) {
      warn(init.start, why.reason === undefined
        ? `${label}: rules(...) factory isn't statically evaluable`
        : `${label}: rules(...) factory isn't statically evaluable — ${why.reason}`)
      return null
    }

    return {
      ruleMap,
      ...(gTrivia ? { trivia: gTrivia } : {}),
      ...(gScanSkip ? { scanSkip: gScanSkip } : {}),
      ...(gTrackLines === true ? { trackLines: true } : {}),
      ...(importedFactory ? { importedFactory } : {}),
    }
  }

  /** null → the factory itself isn't statically evaluable (already warned).
   * `replacement: null` → the map evaluated fine but `compileRuleMap` couldn't
   * inline it; the caller decides whether that is a fallback-to-interpreter
   * warning or the SHARED-SHAPE case (an unresolved external `g.` ref, which is
   * un-inlinable by construction but still linkable — see `hasExternalRef`). */
  const compileRulesFactory = (
    init: Expression,
    label: string,
  ): { replacement: string | null; replacementWithMetadata?: (metadataSource: string) => string; refusals?: readonly string[]; ruleMap: Map<string, Combinator<unknown>>; hostMode: HostMode; hostBranchElided: boolean; reflection: GrammarReflection; coverageDefinitions?: readonly { id: string; kind: string }[]; trivia?: Combinator<unknown>; scanSkip?: Combinator<unknown>[]; trackLines?: boolean; importedFactory?: string } | null => {
    const evaluated = evaluateRulesFactory(init, label)
    if (!evaluated) return null
    // The reasons, out of the encoder and into the warning. A bare "couldn't be
    // inlined" leaves the author with a ~5x silent perf regression and no lead.
    const refusals: string[] = []
    const compiled = compileRuleMap([...evaluated.ruleMap], { ...(evaluated.trivia ? { trivia: evaluated.trivia } : {}), ...(evaluated.scanSkip ? { scanSkip: evaluated.scanSkip } : {}), ...(evaluated.trackLines ? { trackLines: true } : {}), recovery, coverage: grammarCoverage, refusals })
    // A table replacement names `tableRules`, which nothing in the consumer's
    // module binds. That reference is the whole reason the artifact is small (the
    // driver is SHARED, not inlined per grammar), so the import is owned here.
    if (compiled !== null) usedTableRuntime = true
    return {
      replacement: compiled?.replacement ?? null,
      ...(compiled === null ? {} : { replacementWithMetadata: compiled.replacementWithMetadata }),
      ...(compiled === null ? { refusals } : {}),
      ruleMap: evaluated.ruleMap,
      hostMode: compiled?.hostMode ?? 'ast',
      hostBranchElided: compiled?.hostBranchElided ?? false,
      reflection: compiled?.reflection ?? { nodes: [] },
      ...(compiled?.coverageDefinitions ? { coverageDefinitions: compiled.coverageDefinitions } : {}),
      ...(evaluated.trivia ? { trivia: evaluated.trivia } : {}),
      ...(evaluated.scanSkip ? { scanSkip: evaluated.scanSkip } : {}),
      ...(evaluated.trackLines ? { trackLines: true } : {}),
      ...(evaluated.importedFactory ? { importedFactory: evaluated.importedFactory } : {}),
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
  type IRItem = { ns: string; ir: string; trackLines?: true }
  type CarriedItem = ImportSpread | IRItem
  const isSpread = (it: CarriedItem): it is ImportSpread => '__spreadLocal' in it
  const isIR = (it: CarriedItem): it is IRItem => 'ir' in it
  // A carried entry is: an import SPREAD (live ref to an ancestor's pieces) or an IR
  // PIECE (this grammar's own rules as a compact combinator expression, re-lowered at
  // fuse). There is no third form — a piece that cannot serialize is not carried.
  const serializeItem = (it: CarriedItem): string =>
    isSpread(it)
      ? `...(${it.__spreadLocal}[Symbol.for('parseman.composedPieces')] ?? [])`
      : `{ ns: ${JSON.stringify(it.ns)}, ir: ${JSON.stringify(it.ir)}${it.trackLines ? ', trackLines: true' : ''} }`
  const serializeList = (list: CarriedItem[]): string => `[${list.map(serializeItem).join(', ')}]`

  type StaticTableMetadata = {
    carried?: CarriedItem[]
    reflection?: GrammarReflection
    leaf?: true
  }
  /** Metadata passed into `tableRules` at construction. `stampRuleMap` uses this
   * object as the returned map's prototype, so these ordinary symbol fields are
   * readable but never copied by object spread/Object.assign. Coverage comes
   * directly from the emitted program's `cv` pool and host mode from `h`. */
  const staticTableMetadataSource = (metadata: StaticTableMetadata): string => {
    const fields = [
      ...(metadata.carried === undefined ? [] : [
        `[Symbol.for('parseman.composedPieces')]: ${serializeList(metadata.carried)}`,
      ]),
      ...(metadata.reflection === undefined ? [] : [
        `[Symbol.for('parseman.grammarReflection')]: ${grammarReflectionSource(metadata.reflection)}`,
      ]),
      ...(metadata.leaf === true ? [`[Symbol.for('parseman.leafComposed')]: true`] : []),
    ]
    return `{ ${fields.join(', ')} }`
  }

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
  /** Coverage-only macro output carries the exact IDs emitted in its generated
   * hooks. The metadata is non-enumerable so grammar maps keep their ordinary
   * public shape, and it is absent entirely from production builds. */
  const withCoverageDefinitions = (grammarExpr: string, definitions: readonly { id: string; kind: string }[]): string =>
    !grammarCoverage ? grammarExpr
      : `/* @__PURE__ */ Object.defineProperty(${grammarExpr}, Symbol.for('parseman.grammarCoverageDefinitions'), { value: Object.freeze(${JSON.stringify(definitions)}.map(Object.freeze)), enumerable: false })`
  /**
   * Recover the coverage DENOMINATOR by scraping the IDs out of the generated hooks.
   *
   * This is a fallback: it reads emitted source with a regex, so it silently returns `[]`
   * if the emitted hook shape ever changes or the hooks are absent. An empty denominator
   * is NOT zero coverage — it is NO MEASUREMENT — and it used to travel all the way to a
   * consumer's gate as 100%. `'coverage-definitions-unavailable'` is the declared code for
   * exactly this and had no record site anywhere; this is it.
   */
  const emittedCoverageDefinitions = (source: string, where: string): Array<{ id: string; kind: 'rule' | 'choice-arm' | 'dispatch-arm' | 'label' }> => {
    const ids = new Set<string>()
    for (const match of source.matchAll(/id:\s*"([^"]+)"/g)) ids.add(match[1]!)
    if (grammarCoverage && ids.size === 0) {
      recordDegradation({
        code: 'coverage-definitions-unavailable',
        severity: 'warn',
        where,
        subject: 'generated coverage hooks',
        fellBackTo: 'no coverage definitions could be read out of the generated source, so the '
          + 'grammar carries an EMPTY definition set — which is no measurement, not full coverage',
        otherwise: 'the emitted hook IDs would form the coverage denominator',
      })
    }
    return [...ids].sort().map(id => ({
      id,
      kind: id.startsWith('rule:') ? 'rule' : id.startsWith('label:') ? 'label' : id.startsWith('dispatch:') ? 'dispatch-arm' : 'choice-arm',
    }))
  }
  // Same-file `const X = compose([...])` → its carried (re-lowerable) list, so a
  // later same-file compose can chain it AND re-lower it under that compose's own
  // composing trivia (composing-wins holds at every level).
  const localComposedCarried = new Map<string, CarriedItem[]>()

  // Cache of RE-LOWERABLE pieces lists read from imported COMPILED grammars'
  // carried pieces (IR pieces + spreads left un-materialized, so the composing
  // grammar's trivia can be applied when they are finally lowered).
  type RawItem = IRItem
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
      // The KEY comes from the linker, which owns it. Spelling `Symbol.for('…')`
      // here made the string the contract between a build-time module and a
      // runtime one, with nothing checking: renaming it in `linker.ts` would have
      // left this stub keying on the old name, and a carried-pieces lookup that
      // silently finds nothing produces a grammar that composes to less than it
      // should — no type error, no failing test. (The `Symbol.for('…')` spellings
      // further down are EMITTED SOURCE TEXT, not this module's own key: they are
      // strings by necessity and the runtime resolves them through the registry.)
      stubVals.push({ [COMPOSED_PIECES]: subPieces })
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

  /**
   * MERGE a carried list to ONE rule map — the table lowering's entire composition
   * mechanism, and the reason it needs no linker.
   *
   * Source composition is a TEXTUAL splice: each piece is lowered on its own to
   * namespaced `_r_<Name>` functions, and `fusedBody()` picks a winner per name and
   * substitutes the `@FS:` dispatch placeholders with that winner's first-set
   * condition. A table has no text to splice and no placeholders to resolve, so the
   * merge moves one level UP, onto the combinators: evaluate each piece's IR back to
   * a rule map, let a later piece's name override an earlier one — which is exactly
   * what `compose()` means — and hand the single merged map to
   * `compileRuleMap`, which encodes ONCE.
   *
   * This is what makes table composition the easy kind: no relocation of code
   * offsets, no merging of const / fn / class / expected / dispatch pools between
   * two already-encoded programs. `encodeTableProgram` points `enc.winners` at the
   * merged map (`table/encode.ts:1383`), so a base piece's internal `g.Atom`
   * resolves BY NAME to the override (`:1036`) rather than through a thunk that
   * closes over the base. Open recursion — much of the point of compose — therefore
   * survives the merge, and the result is the table the merged grammar would have
   * produced had it been written as a single `rules()` call.
   *
   * `null` means some piece cannot contribute combinators: a FULL BAKED piece (the
   * un-serializable fallback at `localCarried`) carries lowered SOURCE and nothing
   * else. That shape is codegen-only, so the caller falls back to fused source
   * rather than refusing the grammar.
   */
  type CarriedRuleMap = { ns: string; rules: Array<[string, Combinator<unknown>]> }
  const carriedRuleMaps = (
    items: CarriedItem[],
  ): { pieces: CarriedRuleMap[]; trackLines: boolean } | null => {
    const pieces: CarriedRuleMap[] = []
    let trackLines = false
    const add = (item: RawItem): boolean => {
      if (!isIR(item)) return false
      // `trackLines` rides on the CARRIED ITEM, not inside the IR (`IRPiece.trackLines`
      // is a sibling field of `ir`), so it has to be lifted here. Left behind, the
      // merged encode resolves `trackLines` from `_meta` alone and silently drops line
      // tracking for a grammar that asked for it.
      if (item.trackLines === true) trackLines = true
      pieces.push({ ns: item.ns, rules: evalRuleMapIR(item.ir) })
      return true
    }
    for (const item of items) {
      if (isSpread(item)) {
        const imported = importedPieces(item.__spreadLocal)
        if (!imported || !imported.every(add)) return null
      } else if (!add(item as RawItem)) return null
    }
    return { pieces, trackLines }
  }

  /**
   * Fold ordered rule maps into the composed map: a later piece's name WINS, and
   * `Map` keeps each name at its first-sighting position so the encoded rule order
   * tracks the source lowering's rather than drifting per compose.
   *
   * A REFERENCE IS NOT A DEFINITION. A `rules(g => …)` cache also holds every `g.X`
   * that was merely ACCESSED, so a delta that calls `g.Pair` carries a `Pair` entry
   * that is an unresolved named lazy. Merged in name order that entry lands LAST and
   * shadows the base piece which actually defines `Pair` — the encoder then finds a
   * hole where the winner should be and refuses the whole grammar with "ref() used
   * before .define()". The same filter guards `compileLinkableTable`'s `isLocal`
   * (`compile-linkable-table.ts:96`), `itemCarried` (`linker.ts:696`) and
   * `recoverComposedRules`; this is the fourth site that needs it, for the same
   * reason, and skipping it is why cross-piece composition looked blocked.
   *
   * The reference itself is not lost: it stays inside the delta's own rule bodies and
   * `enc.winners` binds it BY NAME to whichever piece supplies the definition.
   */
  const mergeRuleMaps = (
    maps: ReadonlyArray<ReadonlyArray<readonly [string, Combinator<unknown>]>>,
  ): Array<[string, Combinator<unknown>]> => {
    const winners = new Map<string, Combinator<unknown>>()
    for (const map of maps) {
      for (const [name, rule] of map) {
        if (rule._def.tag === 'lazy') {
          try { rule._def.thunk() } catch { continue }
        }
        winners.set(name, rule)
      }
    }
    return [...winners]
  }

  const mergedCarriedRules = (
    items: CarriedItem[],
  ): { rules: Array<[string, Combinator<unknown>]>; trackLines: boolean } | null => {
    const carriedMaps = carriedRuleMaps(items)
    if (carriedMaps === null) return null
    return { rules: mergeRuleMaps(carriedMaps.pieces.map(p => p.rules)), trackLines: carriedMaps.trackLines }
  }

  /**
   * COMPOSING-WINS, as an OVERRIDE rather than a gap-fill.
   *
   * `compileRuleMap`'s `applyAmbient` only fills a rule that carries no trivia of
   * its own — correct for `composeLeaf`, whose pieces may legitimately disagree, and
   * WRONG for `compose`, where the composing grammar's trivia governs every fused rule
   * INCLUDING the inherited ones. Gap-filling leaves a base rule that declared its own
   * `rules({ trivia }, …)` still skipping the base's trivia after a delta re-declared
   * it, so `compose([css, less])` silently parses the inherited rules under css's
   * whitespace — the multi-level composing-wins contract, inverted.
   *
   * Safe to mutate: every rule here came from `evalRuleMapIR`, which constructs FRESH
   * combinators per piece per compose, so this cannot leak into another compose of the
   * same base grammar.
   */
  const applyComposingTrivia = (
    ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
    composing: Combinator<unknown>,
  ): void => {
    for (const [, rule] of ruleMap) {
      if (rule._meta.isTrivia) continue
      ;(rule._meta as { grammarTrivia?: Combinator<unknown> }).grammarTrivia = composing
    }
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
    const trackLines = entries.some(([, rule]) => (rule as Combinator<unknown> | undefined)?._meta?.grammarTrackLines === true)
    // scanSkip is PER-PIECE (opaque units are dialect-specific — NOT composing-wins
    // like trivia), so it rides WITH this element's IR: it is emitted into the carried
    // `rules({ scanSkip }, …)` options, which stamps `_meta.grammarScanSkip` when the IR
    // is re-lowered (materializePiece → compileLinkable picks it up), and survives to a
    // downstream re-compose. The full-pieces fallback bakes it via the compile option.
    const ir = serializeRuleMap(entries as never, scanSkip)
    if (ir) return { carried: [{ ns, ir, ...(trackLines ? { trackLines: true as const } : {}) }] }
    // NO FULL-PIECES FALLBACK. It used to bake the grammar to lowered source when the IR
    // would not serialize; with one lowering there is nothing to bake to, and IR is not
    // an optimization here but the representation composition is built on.
    //
    // This is not a capability loss. The branch had no test fixture and not for want of
    // trying: every callback-source trigger in `serializeRuleMap` is pre-empted by the
    // macro's own stricter guard (a direct builder must be "macro-static and
    // self-contained", which throws first), and every "unsupported tag" trigger is a
    // ChoiceStrategy tag (`types.ts:405-408`), not a ParserDef tag, so it never reaches
    // that switch. It fired ZERO times across jess's whole five-package compose chain.
    // Refusing here leaves the runtime `compose()` in place, which is correct.
    warn(0, `${label}: rule map could not be serialized to IR, so it cannot be carried for composition. `
      + 'Re-run with PARSEMAN_IR_DEBUG=1 to print the exact combinator that blocked serialization.')
    return null
  }

  const argPieces = (arg: Expression, label: string, composing?: Combinator<unknown>): { carried: CarriedItem[]; importedFactories?: string[] } | null => {
    // Inline `rules(g => …)` or `rules({ trivia }, g => …)` (options-first). The
    // element's OWN trivia option is ignored for lowering — composing-wins means the
    // composing grammar's trivia (computed in compileComposeCall) governs every
    // fused rule, this element's included. It only matters as a CANDIDATE for the
    // composing trivia itself, which composingTrivia() reads directly off the AST.
    if (isRulesCall(arg)) {
      // This element's OWN scanSkip DOES thread (per-piece, unlike composing-wins
      // trivia): evaluateRulesFactory returns both the rule map and the grammar-level
      // scanSkip option, which localCarried carries with this piece's IR.
      const evaluated = evaluateRulesFactory(arg, label)
      const carried = evaluated ? localCarried(evaluated.ruleMap, label, composing, evaluated.scanSkip) : null
      return carried
        ? { ...carried, ...(evaluated?.importedFactory ? { importedFactories: [evaluated.importedFactory] } : {}) }
        : null
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
    const triviaValue = optionProp(optExpr, 'trivia')
    if (!triviaValue) return undefined
    return (evaluateExpr(triviaValue, scope, code, []) as Combinator<unknown> | null) ?? undefined
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
    }
    return undefined
  }

  /** Compile `compose([...])` to STATIC fused source (eval-free) + its carried
   * (re-lowerable) list (for a sidecar / same-file chaining). null → leave the
   * runtime `compose()` in place (correct, just not build-fused). */
  const compileComposeCall = (init: Expression): { replacement: string; exportedReplacement: string; carried: CarriedItem[]; trivia?: Combinator<unknown>; importedFactories?: string[]; coverageDefinitions?: readonly { id: string; kind: string }[] } | null => {
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
    const cHostModeValue = optionProp(cOptions, 'hostMode')
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
    const importedFactories: string[] = []
    for (let i = 0; i < elements.length; i++) {
      const r = argPieces(elements[i]!, `compose${init.start}_${i}`, composing)
      if (!r) { warn(init.start, `compose(): argument ${i} isn't a build-resolvable grammar; falling back to runtime`); return null }
      carried.push(...r.carried)
      importedFactories.push(...(r.importedFactories ?? []))
    }
    // Lower the whole list ONCE, seeding the composing trivia into every re-lowerable
    // piece (composing-wins), then fuse.
    // TABLE FIRST. The merged map IS the composed grammar (see `mergedCarriedRules`),
    // so `compose()` lowers through the SAME `compileRuleMap` a plain `rules()`
    // does — one encode, one `tableRules(…)` expression, no linker. `carried` is
    // unchanged either way: it is the re-lowerable IR list, not a lowering artifact,
    // so a downstream re-compose behaves identically whichever engine emitted here.
    const merged = mergedCarriedRules(carried)
    if (merged !== null) {
      if (composing) applyComposingTrivia(merged.rules, composing)
      const refusals: string[] = []
      const compiled = compileRuleMap(merged.rules, {
        ...(composing ? { trivia: composing } : {}),
        ...(merged.trackLines ? { trackLines: true } : {}),
        ...(cHostMode ? { hostMode: cHostMode as HostMode } : {}),
        recovery,
        coverage: grammarCoverage,
        refusals,
      })
      if (compiled !== null) {
        usedTableRuntime = true
        const reflectionMetadata = staticTableMetadataSource({ reflection: compiled.reflection })
        const exportedMetadata = staticTableMetadataSource({
          carried,
          reflection: compiled.reflection,
        })
        return {
          replacement: compiled.replacementWithMetadata(reflectionMetadata),
          exportedReplacement: compiled.replacementWithMetadata(exportedMetadata),
          carried,
          ...(composing ? { trivia: composing } : {}),
          ...(importedFactories.length ? { importedFactories } : {}),
          // The AUTHORITATIVE denominator, from `buildGrammarPlan` via
          // `compileRuleMapTable`. It was computed here and dropped, leaving the
          // compose() call site with nothing but the regex scrape — see the call site.
          ...(compiled.coverageDefinitions ? { coverageDefinitions: compiled.coverageDefinitions } : {}),
        }
      }
      // There is no second lowering to fall back TO. Leaving the runtime `compose()`
      // call in place is correct (the runtime path fuses the same merged map), just not
      // build-fused — so name the reason rather than reporting a bare refusal.
      warn(init.start, `compose(): could not be lowered to a table; leaving the runtime compose() in place${reasonSuffix(refusals)}`)
      return null
    }
    warn(init.start, 'compose(): a carried piece has no re-lowerable IR; leaving the runtime compose() in place')
    return null
  }

  /**
   * Compile a terminal composition. Imported/base pieces still travel as normal
   * re-lowerable IR, but the final local rules map is compiled directly in this
   * module. Its direct builders may therefore refer to lexical AST constructors;
   * they are inlined into the fused output and are never serialized or carried.
   */
  const compileComposeLeafCall = (init: Expression): { replacement: string; importedFactories?: string[] } | null => {
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
    const importedFactories: string[] = []
    if (isRulesCall(localArg)) {
      const evaluated = evaluateRulesFactory(localArg, `composeLeaf${init.start}`)
      localRules = evaluated?.ruleMap ?? null
      localScanSkip = evaluated?.scanSkip
      if (evaluated?.importedFactory) importedFactories.push(evaluated.importedFactory)
    } else if (localArg.type === 'Identifier') {
      const name = (localArg as unknown as { name: string }).name
      localRules = localRuleMaps.get(name) ?? null
      localScanSkip = localGrammarScanSkip.get(name)
    }
    if (!localRules) {
      // Distinguish "the argument is the wrong SHAPE" from "the argument is the right
      // shape and failed to evaluate". Only the first is a composeLeaf problem. When a
      // `rules()` call is present it has already warned with the specific cause (a
      // forward reference, a non-static callback); repeating a shape complaint here
      // buries it and sends the reader looking at the composeLeaf argument list. That
      // is exactly how this signature got reported twice as a grammar defect.
      const named = localArg.type === 'Identifier' ? (localArg as unknown as { name: string }).name : null
      warn(init.start, isRulesCall(localArg)
        ? 'composeLeaf(): the final rules() map failed to evaluate — see the warning above for the cause'
        : named !== null
          ? `composeLeaf(): final argument \`${named}\` did not resolve to a local rules() map.`
            + ` It must be a \`const ${named} = rules(...)\` in THIS module, declared before this call`
            + ` — an imported or re-exported grammar cannot be the leaf.`
          : 'composeLeaf(): final argument must be a local rules() map')
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
      importedFactories.push(...(r.importedFactories ?? []))
    }
    try {
      // The imported pieces are recognition-only, but the local leaf grammar
      // may place one beneath a direct node(). Re-lower their terminals with
      // capture enabled so that node receives the imported token values in its
      // normal child collector; the pieces still contain no semantic callback.
      const localNs = nsFor(`composeLeaf${init.start}`)
      const localEntries = [...localRules] as Array<[string, Combinator<unknown>]>

      // TABLE FIRST — same merge as `compose()`, with the local leaf map appended LAST
      // so it wins every name and binds the imported shapes' holes (`enc.winners`
      // resolves those by name; see `mergedCarriedRules`).
      //
      // The recognition-only gate is preserved EXACTLY, and is the reason this path
      // needs no `compileLinkable`: `hasDirectBuilders` / `isRecognitionOnly` are
      // predicates over the combinator graph, not products of lowering it, so
      // `classifyRuleMap` answers both from the piece's own rule map. Lowering every
      // piece to read two booleans off `LinkablePieces` was the only thing making this
      // gate look codegen-shaped.
      //
      // Coverage needs no `materializeLeafCoverage` counterpart here. That helper
      // exists because coverage ids are WeakMap-keyed and planning from a second IR
      // hydration would leave the EMITTED pieces uninstrumented; the table plans from
      // the merged map it then encodes, so the planned identities and the encoded
      // identities are the same objects by construction.
      const carriedMaps = carriedRuleMaps(carried)
      if (carriedMaps !== null) {
        const unproven = carriedMaps.pieces.find(p => {
          const c = classifyRuleMap(p.rules)
          return c.hasDirectBuilders || !c.isRecognitionOnly
        })
        if (unproven) {
          warn(init.start, 'composeLeaf(): every pre-final grammar must explicitly prove recognition-only')
          return null
        }
        // The local grammar's OWN ambient scanSkip is stamped onto the LOCAL entries
        // only. Passing it as a merged-map option instead would let `applyAmbient`
        // hand it to every imported rule that happens to carry no stamp of its own —
        // opaque units are dialect-specific, and that is precisely the leak the
        // per-piece threading in the source path exists to avoid.
        if (localScanSkip) {
          for (const [, rule] of localEntries) {
            if (rule._meta.isTrivia) continue
            const meta = rule._meta as { grammarScanSkip?: Combinator<unknown>[] }
            if (meta.grammarScanSkip === undefined) meta.grammarScanSkip = localScanSkip
          }
        }
        const leafMerged = mergeRuleMaps([...carriedMaps.pieces.map(p => p.rules), localEntries])
        // Composing-wins governs the leaf fuse too. The local entries are NOT freshly
        // evaluated (they come from this module's own `rules()` factory), so they are
        // excluded from the override — their declared trivia IS the composing candidate,
        // and rewriting `_meta` on them would mutate the module-level grammar object.
        if (composing) applyComposingTrivia(carriedMaps.pieces.flatMap(p => p.rules), composing)
        const refusals: string[] = []
        const compiled = compileRuleMap(
          leafMerged,
          {
            ...(composing ? { trivia: composing } : {}),
            ...(carriedMaps.trackLines ? { trackLines: true } : {}),
            recovery,
            coverage: grammarCoverage,
            refusals,
          },
        )
        if (compiled !== null) {
          usedTableRuntime = true
          return {
            replacement: compiled.replacementWithMetadata(
              staticTableMetadataSource({ reflection: compiled.reflection, leaf: true }),
              { precompileDefault: true },
            ),
            ...(importedFactories.length ? { importedFactories } : {}),
          }
        }
        warn(init.start, `composeLeaf(): could not be lowered to a table${reasonSuffix(refusals)}`)
        return null
      }
      // `composeLeaf` is TERMINAL and macro-only: there is no runtime composition to
      // fall back to (the caller turns this null into a hard throw), and now no second
      // lowering either. A piece with no re-lowerable IR is the end of the road.
      warn(init.start, 'composeLeaf(): a recognition piece has no re-lowerable IR')
      return null
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
        if (!referencesAny(init, allNames, scope)) {
          const staticValue = evaluateStaticValue(init, scope, code)
          if (staticValue !== null && staticValue !== undefined || isStaticNullishExpression(init)) {
            ;(scope as Map<string, unknown>).set(varName, staticValue)
          }
          continue
        }

        // const name = ref() — resolved by the pre-pass. Compile the (now
        // defined) ref combinator in place; codegen inlines the whole recursive
        // cluster behind a named function. The `.define(...)` statements are
        // removed separately.
        if (refNames.has(varName)) {
          const refEntry = scope.get(varName)
          const refCombi = refEntry?.combi ?? null
          if (refCombi) {
            // `mfSrcs` is the POSITIONAL fallback the evaluator collected while it
            // built this combinator. The encoder's def-carried sources win; this only
            // fills holes. Passing `undefined` here is what made a ref()'s reducers
            // print as `() => {}`.
            const compiled = compile(refCombi, refEntry?.mfSrcs, { recovery, coverage: grammarCoverage })
            if (compiled.inlineExpression === null) {
              warn(init.start, `"${varName}" is a ref() that couldn't be inlined (was .define() called with a static combinator?)`
                + reasonSuffix(compiled.runtimeOnly))
              continue
            }
            usedTableRuntime = true
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
          // Thread `scanSkip` explicitly: it is what a downstream package composes.
          // (The `_meta` stamp in evaluateRulesFactory also covers it; passing it
          // here keeps the intent local and independent of that.) `trivia` is NOT
          // threaded — it is composing-wins, so the downstream compose supplies it;
          // `scanSkip` is per-piece (opaque units are dialect-specific) and must
          // travel WITH the grammar or the downstream loses ambient skipping.
          //
          // `compileLinkableTable` is the piece-artifact producer — the job this call
          // site actually has. It reports `external` as a first-class field, which is
          // what the SHARED-SHAPE check below needs, and it encodes a piece WITH holes
          // to `prog: null` while keeping its IR, so a hole is a described state rather
          // than a refusal.
          const ns = nsFor(varName)
          const pieces = exportPrefix || compiledRules.replacement === null
            ? compileLinkableTable([...compiledRules.ruleMap], ns, {
                ...(compiledRules.scanSkip ? { scanSkip: compiledRules.scanSkip } : {}),
                ...(compiledRules.trackLines ? { trackLines: true } : {}),
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
            if (!pieces || pieces.external.length === 0) {
              warn(init.start, `${varName}: rule map couldn't be inlined` + reasonSuffix(compiledRules.refusals))
              // THE WHOLE MODULE FALLS BACK, for the same reason a runtime `compose()`
              // does. This map keeps its `rules(…)` source and is therefore built by the
              // INTERPRETER, from combinators — but its ambient trivia is an ordinary
              // declaration that this pass may already have lowered to a compiled rule
              // function. Mixing the two hands `rules()` a function where it needs a
              // combinator, and it throws walking it for reflection. Partial lowering is
              // only ever safe when every consumer of a lowered declaration also lowered.
              runtimeComposeFallback = true
              continue
            }
            keepMacroImport = true
          }
          const source = compiledRules.replacement ?? code.slice(init.start, init.end)
          // Carry only when the pieces are fully static (no runtime-only callbacks) —
          // otherwise the grammar isn't source-free composable and we ship it as a
          // plain map.
          let carriedMetadata: CarriedItem[] | undefined
          if (exportPrefix && pieces) {
            // Carry the compact IR. Thread the grammar's scanSkip into it so a
            // downstream compose of this imported grammar re-lowers its
            // scanTo/balanced sites ambiently.
            //
            // IR OR NOTHING. The old alternative was to carry the fully lowered pieces,
            // which a downstream compose could link but never RE-LOWER — so it silently
            // froze that grammar's trivia against any later composing-wins. With one
            // lowering there is no such artifact, and a grammar that cannot serialize
            // simply is not carried: an absent carried list makes the downstream compose
            // say so, where a frozen one did not.
            const ir = serializeRuleMap([...compiledRules.ruleMap] as never, compiledRules.scanSkip)
            if (ir) carriedMetadata = [{ ns, ir, ...(compiledRules.trackLines ? { trackLines: true as const } : {}) }]
            // NOT SILENT. An export with no carried IR cannot be composed downstream at
            // all — the consumer's `compose()` will fall back to runtime and say so, but
            // by then the cause is a module away. The source lowering carried fully
            // lowered pieces here instead; the table has no such form, because merging
            // two ALREADY-ENCODED programs means relocating code offsets and merging
            // every pool, which is the one route `compile-linkable-table.ts` documents
            // as deferred. Naming it at the origin is the least this can do.
            else warn(init.start, `${varName}: exported grammar could not be serialized to IR, so it carries no `
              + 'composable pieces — a downstream compose() of this grammar will fall back to runtime. '
              + 'Re-run with PARSEMAN_IR_DEBUG=1 to print the combinator that blocked serialization.')
          }
          const replacement = compiledRules.replacement !== null
            ? compiledRules.replacementWithMetadata!(staticTableMetadataSource({
                ...(carriedMetadata === undefined ? {} : { carried: carriedMetadata }),
                reflection: compiledRules.reflection,
              }))
            : (() => {
                const covered = withCoverageDefinitions(
                  source,
                  compiledRules.coverageDefinitions?.length
                    ? compiledRules.coverageDefinitions
                    : emittedCoverageDefinitions(source, `${id} rules()`),
                )
                return carriedMetadata === undefined ? covered : withCarriedPieces(covered, carriedMetadata)
              })()
          replacements.push({ start: init.start, end: init.end, replacement })
          if (compiledRules.replacement !== null) {
            markUsedImportedFactories(compiledRules.importedFactory ? [compiledRules.importedFactory] : undefined)
          }
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
          const replacement = exportPrefix ? fused.exportedReplacement : fused.replacement
          // Coverage definitions already ride in the table program's `cv` pool;
          // `tableRules` exposes that same pool through the metadata prototype.
          replacements.push({ start: init.start, end: init.end, replacement })
          markUsedImportedFactories(fused.importedFactories)
          continue
        }

        // `composeLeaf([...recognition, localRules])` is static and terminal:
        // local direct builders stay lexical and are not carried/recomposable.
        if (isComposeLeafCall(init)) {
          const fused = compileComposeLeafCall(init)
          if (!fused) {
            const reasons = warnings.slice(-4)
            throw new Error(
              `${id}:${lineOf(init.start)} — composeLeaf() must macro-fuse; runtime composition is forbidden`
              + (reasons.length ? `\n  causes:\n  - ${reasons.join('\n  - ')}` : ''),
            )
          }
          replacements.push({ start: init.start, end: init.end, replacement: fused.replacement })
          markUsedImportedFactories(fused.importedFactories)
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
          const staticValue = evaluateStaticValue(init, scope, code)
          if (staticValue !== null && staticValue !== undefined || isStaticNullishExpression(init)) {
            ;(scope as Map<string, unknown>).set(varName, staticValue)
            continue
          }
          // A `rules()` FACTORY is not a combinator and never was one — it is a function
          // that returns the rule map. It only reaches this branch now that a factory can
          // be shared by name (see `factoryDecls`), and warning here would tell the author
          // to "simplify" the one declaration the two-artifact pattern requires.
          //
          // Its text is left VERBATIM, which is fine for a local `const` — nothing
          // references it after lowering, so it is dead code the bundler drops. An
          // EXPORTED one cannot be dropped, so the macro-only identifiers in its body
          // (`node`, `sequence`, `literal`, …) survive into the artifact with nothing
          // binding them once the macro import is removed. Record it; whether that is
          // actually fatal depends on whether the import IS removed, which is only
          // decided once every declaration has been seen.
          if (factoryDecls.has(varName)) {
            if (exportPrefix) exportedFactories.push({ name: varName, pos: init.start })
            continue
          }
          warn(init.start, `"${varName}" references a parseman macro import but isn't a statically-evaluable combinator`)
          continue
        }

        // Sources are carried on each transform's def (set by the evaluator) AND
        // collected positionally into `mapFnSources`. Codegen only needed the former;
        // the TABLE ENCODER needs whichever is present, so hand it both — the def
        // sources win and the positional list fills holes. Passing `undefined` here
        // is what made every macro-lowered reducer print as `() => {}`.
        const compiled = compile(parser, mapFnSources, { recovery, coverage: grammarCoverage })
        if (compiled.inlineExpression === null) {
          warn(init.start, `"${varName}" couldn't be inlined (likely closes over a runtime value)`
            + reasonSuffix(compiled.runtimeOnly))
          continue
        }

        usedTableRuntime = true
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
        if (compiledRules.replacement === null) { warn(init.start, `{ … }: rule map couldn't be inlined` + reasonSuffix(compiledRules.refusals)); continue }

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
        markUsedImportedFactories(compiledRules.importedFactory ? [compiledRules.importedFactory] : undefined)
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

  // An exported `rules()` factory whose macro import is about to be removed is an
  // UNRUNNABLE binding: lowering erases the call sites, but an export must still hold a
  // value, so the factory body ships verbatim naming `node`/`sequence`/`literal`/… that
  // nothing imports. It does not fail at build time and it does not fail at import time
  // — it throws `ReferenceError` the first time anything calls it, which in practice is
  // in a consumer's process, long after the artifact was published.
  //
  // There is no correct value to emit instead. Pinning the macro import would make the
  // binding run, but only by dragging the whole parseman runtime into an artifact whose
  // entire point is not to need it — a silent trade the author never asked for. So this
  // refuses to emit the shape at all. The fix is the author's: drop the `export`, since
  // a factory is macro-only by construction and no runtime consumer can use one.
  if (exportedFactories.length > 0 && macroImports.some(imp => imp.fullyResolved)) {
    const which = exportedFactories.map(f => `  - ${id}:${lineOf(f.pos)} — export const ${f.name}`).join('\n')
    throw new Error(
      `${id} — a rules() factory cannot be exported; lowering leaves its body verbatim, so the `
      + `export would ship a binding that throws ReferenceError on first call:\n${which}\n`
      + `  Drop the \`export\`. The factory is macro-only; \`rules(${exportedFactories[0]!.name})\` `
      + `is lowered in place and needs no runtime value.`,
    )
  }

  const ms = new MagicString(code)
  const replacementRanges = runtimeComposeFallback
    ? []
    : replacements.map(({ start, end }) => ({ start, end }))
  const isInsideReplacement = (start: number, end: number): boolean =>
    replacementRanges.some(r => start >= r.start && end <= r.end)
  const importedBindingStillReferenced = (local: string): boolean => {
    const walk = (node: unknown, parent?: AnyNode, parentKey?: string): boolean => {
      if (!node || typeof node !== 'object') return false
      const rec = node as AnyNode
      if (rec.type === 'ImportDeclaration') return false
      if (typeof rec.start === 'number' && typeof rec.end === 'number' && isInsideReplacement(rec.start, rec.end)) return false
      if ((rec.type === 'Identifier' || rec.type === 'BindingIdentifier') && (rec as { name?: string }).name === local) {
        if (
          parentKey === 'key' &&
          (parent?.type === 'ObjectProperty' || parent?.type === 'Property' || parent?.type === 'PropertyDefinition') &&
          (parent as { computed?: boolean }).computed !== true
        ) return false
        if (parentKey === 'property' && parent?.type === 'StaticMemberExpression') return false
        if (parentKey === 'property' && parent?.type === 'MemberExpression' && (parent as { computed?: boolean }).computed !== true) return false
        return true
      }
      for (const key of Object.keys(rec)) {
        if (key === 'type' || key === 'start' || key === 'end') continue
        const value = (rec as Record<string, unknown>)[key]
        if (Array.isArray(value)) {
          if (value.some(child => walk(child, rec, key))) return true
        } else if (walk(value, rec, key)) {
          return true
        }
      }
      return false
    }
    return (body as unknown[]).some(stmt => walk(stmt))
  }

  for (const imp of ordinaryImports) {
    if (
      !runtimeComposeFallback &&
      imp.specifiers.length > 0 &&
      imp.specifiers.every(spec =>
        spec.type === 'ImportSpecifier' &&
        usedImportedFactories.has(spec.local) &&
        !importedBindingStillReferenced(spec.local),
      )
    ) {
      ms.remove(imp.start, imp.end)
    }
  }

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
  // NO MODULE HOIST. It existed to deduplicate declarations across the fused IIFEs the
  // source lowering emitted — `_pfFail` and friends, one copy per variant. A table
  // replacement is a `tableRules(...)` call over a data literal: there are no emitted
  // function declarations to share, so there is nothing to hoist and no marker to
  // resolve.
  for (const { start, end, replacement } of applied.slice().sort((a, b) => b.start - a.start)) {
    ms.overwrite(start, end, replacement)
  }

  // Stamp the generated artifact with a version-lock banner. This is the exact spot a
  // stale artifact is inspected, and the version here IS the stamp fusedBody's
  // version-lock assertion compares (see src/version.ts).
  // THE SHARED DRIVER. A table replacement names `tableRules` and nothing in the
  // consumer's module binds it — the macro import it might have come from is
  // exactly what lowering deletes. Emitted only when a table was actually applied,
  // so a module that lowered nothing (or fell back to runtime compose) does not
  // acquire an import it never uses, and so the artifact of a source-lowered
  // module is unchanged.
  if (usedTableRuntime && applied.length > 0) {
    ms.prepend(`import { tableRules } from ${JSON.stringify(TABLE_RUNTIME_SPECIFIER)}\n`)
  }
  if (applied.length > 0) {
    ms.prepend(
      `// Generated by parseman v${PARSEMAN_VERSION} — DO NOT EDIT.\n` +
      `// Version-locked: compile AND fuse/link this artifact with parseman v${PARSEMAN_VERSION} ONLY.\n` +
      `// Parseman does not read artifacts across versions; recompile if the version differs.\n`,
    )
  }

  /*
   * REFUSE TO EMIT a module that names something nothing binds.
   *
   * Every deletion lowering performs — the `rules(…)` call sites, the `x.define(…)`
   * statements, and last the macro import — is only safe because the text that read
   * the deleted binding went with it. Where a shape slips through where it did not,
   * the artifact builds clean, imports clean, and throws `ReferenceError` the first
   * time a consumer calls the binding: jess shipped exactly that for three days
   * across three grammars, 26 undefined identifiers in the css parser alone, and had
   * to write this check itself downstream. It belongs here.
   *
   * This is the NET, not the diagnostic. Shapes we recognise are refused where they
   * are recognised, with an error that says what to do — an exported `rules()`
   * factory throws above, before this point, so it is never double-reported. What
   * reaches here is a name that escaped by a route nobody enumerated, which is the
   * whole reason for checking the emitted text instead of guessing at shapes.
   *
   * Gated on `applied.length > 0` — the same condition as the version banner. A
   * module that lowered nothing had nothing deleted from it, so it cannot have
   * acquired a free name, and the scan (one extra parse of the emitted module, at
   * macro time) is not worth paying for. Nothing here runs in, or is emitted into,
   * the artifact.
   */
  if (applied.length > 0) {
    /*
     * Only names lowering MADE free. A module that already read something nothing binds
     * — a host that injects the name some other way, an ambient the author knows about
     * — was written that way, and reporting it here would be parseman failing a build
     * over a decision it had no part in. Subtracting the source's own free names is what
     * keeps this a check on parseman's output rather than a lint on the author's input.
     * The source scan runs ONLY when the emitted module already looks wrong, so the
     * clean path costs one parse, not two.
     */
    let sourceFree: Set<string> | null = null
    const freeInSource = (): Set<string> =>
      sourceFree ??= new Set(findFreeIdentifiers(code, id).map(f => f.name))
    const free = findFreeIdentifiers(ms.toString(), id)
      .filter(f => !freeInSource().has(f.name))
    if (free.length > 0) {
      const macroProvided = free.filter(f => allNames.has(f.name))
      const where = (f: (typeof free)[number]): string =>
        `  - ${id}:${f.line}:${f.column} — \`${f.name}\``
        + (f.enclosing ? `, inside \`${f.enclosing}\`` : '')
      const cause = macroProvided.length > 0
        ? `\n  ${macroProvided.length === free.length ? 'All' : `${macroProvided.length}`} of these came from the `
          + `\`with { type: 'macro' }\` import, which was removed because every macro declaration lowered. `
          + `Something still names them verbatim — a declaration parseman left as text rather than compiling. `
          + `Make that declaration macro-buildable, or stop exporting it so lowering can drop it.`
        : ''
      throw new Error(
        `${id} — parseman will not emit this module: ${free.length} identifier(s) are read but bound by `
        + `nothing, so it would throw ReferenceError at runtime (positions are in the EMITTED module):\n`
        + `${free.map(where).join('\n')}${cause}`,
      )
    }
  }

  // NOTE: `warnUnloweredRegex` and the inline-expansion cap were both properties of the
  // SOURCE lowering — "this regex became RegExp.exec instead of a charCodeAt scan", and
  // "this emitted function hit INLINE_MAX_NODES". The table has no emitted function to
  // bound and no per-regex emission choice to report, so both diagnostics are gone
  // rather than reporting a value nothing computes. The option is still accepted so a
  // caller's config does not break; it is now inert.

  setReducerResolver(null)
  // Every place the compiler chose a correct-but-slower path for this module. Reported
  // on the ordinary warning channel and greppable on `[parseman] degraded`, so a
  // consumer's build gate can assert zero of them the way jess's `check:macro` already
  // asserts zero `"falling back to runtime"` lines. `PARSEMAN_DEGRADATION=error` turns
  // the assertion on here instead of in the consumer.
  const degradations = endDegradationCapture()
  if (degradations.length > 0) {
    const lines = formatDegradations(degradations)
    if (resolveDegradationLevel() === 'error') {
      throw new Error(`parseman: ${degradations.length} degraded compilation path(s) in ${id}\n${lines.join('\n')}`)
    }
    for (const l of lines) warnings.push(`${id}: ${l}`)
  }

  return {
    code: ms.toString(),
    map: ms.generateMap({ hires: true }),
    warnings,
  }
}
