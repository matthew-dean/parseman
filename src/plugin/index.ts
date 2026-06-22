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
import { createUnplugin } from 'unplugin'
import { parseSync } from 'oxc-parser'
import MagicString from 'magic-string'
import { evaluateExpr, referencesAny, type Scope } from './evaluator.ts'
import { compile } from '../compiler/codegen.ts'
import type { Combinator } from '../types.ts'
import type {
  ImportDeclaration,
  VariableDeclarator,
  Expression,
  Statement,
} from '@oxc-project/types'

export type ParsecraftPluginOptions = {
  /** Extra module specifiers to treat as parseman re-exports */
  moduleAliases?: string[]
}

const PARSEMAN_MODULE = 'parseman'

export default createUnplugin((opts: ParsecraftPluginOptions = {}) => ({
  name: 'parseman',

  transformInclude(id: string) {
    return /\.[jt]sx?$/.test(id) && !id.includes('node_modules')
  },

  transform(code: string, id: string) {
    if (!code.includes('parseman')) return null
    if (!code.includes('macro')) return null
    const moduleAliases = new Set([PARSEMAN_MODULE, ...(opts.moduleAliases ?? [])])
    return transformMacro(code, id, moduleAliases)
  },
}))

// ---------------------------------------------------------------------------
// Core transform (exported for testing)
// ---------------------------------------------------------------------------

type ImportInfo = {
  start: number
  end: number
  names: Set<string>
  fullyResolved: boolean   // mutated after evaluation
}

export function transformMacro(
  code: string,
  id: string,
  moduleAliases = new Set([PARSEMAN_MODULE]),
): { code: string; map: ReturnType<MagicString['generateMap']> } | null {
  let result: ReturnType<typeof parseSync>
  try {
    result = parseSync(id, code)
  } catch {
    return null
  }
  if (result.errors.length > 0) return null

  const body = result.program.body

  // --- Pass 1: collect macro imports ---
  const macroImports: ImportInfo[] = []
  const allNames = new Set<string>()

  for (const stmt of body) {
    if (stmt.type !== 'ImportDeclaration') continue
    const s = stmt as ImportDeclaration
    if (!moduleAliases.has(s.source.value)) continue

    // Check `with { type: 'macro' }` — oxc exposes this as ImportDeclaration.attributes
    const isMacro = s.attributes.some(a => {
      const key = a.key.type === 'Identifier' ? a.key.name : String(a.key.value)
      return key === 'type' && a.value.value === 'macro'
    })
    if (!isMacro) continue

    const names = new Set<string>()
    for (const spec of s.specifiers) {
      if (spec.type === 'ImportSpecifier') names.add(spec.local.name)
    }
    macroImports.push({ start: s.start, end: s.end, names, fullyResolved: false })
    for (const n of names) allNames.add(n)
  }

  if (macroImports.length === 0) return null

  // --- Pass 2: evaluate declarations in source order ---
  const scope: Scope = new Map<string, Combinator<unknown>>()
  const replacements: Array<{ start: number; end: number; replacement: string }> = []
  let anyUnresolved = false

  for (const stmt of body as Statement[]) {
    if (stmt.type !== 'VariableDeclaration') continue

    for (const decl of stmt.declarations) {
      const d = decl as VariableDeclarator
      if (!d.init) continue
      if (d.id.type !== 'Identifier') continue

      const varName = d.id.name
      const init = d.init as Expression

      if (!referencesAny(init, allNames, scope)) continue

      const parser = evaluateExpr(init, scope)
      if (parser === null) { anyUnresolved = true; continue }

      const compiled = compile(parser)
      if (compiled.inlineExpression === null) { anyUnresolved = true; continue }

      replacements.push({
        start: init.start,
        end: init.end,
        replacement: compiled.inlineExpression,
      })

      scope.set(varName, parser)
    }
  }

  if (replacements.length === 0) return null

  // If every declaration referencing an imported name was successfully inlined,
  // the import is no longer needed. Otherwise downgrade to runtime.
  for (const imp of macroImports) {
    imp.fullyResolved = !anyUnresolved
  }

  const ms = new MagicString(code)

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

  return {
    code: ms.toString(),
    map: ms.generateMap({ hires: true }),
  }
}
