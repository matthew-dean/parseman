import type { ParserDef } from '../types.ts'

/** `(c, r, s, tl) => mk('Type', c, r, s, tl)` — CSS perf regression builder shape. */
const MK_BUILD_RE =
  /^\(\s*(?:\w+\s*,\s*){3}\w+\s*\)\s*=>\s*mk\s*\(\s*(['"])([^'"]+)\1\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)\s*$/

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Any callee — covers `mk`, `import_x.mk`, `__vite_ssr_import_0__.mk`, etc. */
function looseMkBuildRe(type: string): RegExp {
  return new RegExp(
    String.raw`^\(\s*(?:\w+\s*,\s*){3}\w+\s*\)\s*=>\s*.+\(\s*(['"])${escapeRegExp(type)}\1\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)\s*$`,
  )
}

/**
 * When a node() build is a thin `mk(type, …)` wrapper, emit the object literal
 * at the call site instead of `_build[n](…)`.
 */
export function analyzeMkInlineBuild(def: Extract<ParserDef, { tag: 'node' }>): string | null {
  if (!def.build) return null // structural node — no own build to inline
  if (def.type === undefined) return null
  const src = (def.buildSrc ?? def.build.toString()).trim()
  const strict = src.match(MK_BUILD_RE)
  if (strict) {
    const mkType = strict[2]!
    return mkType === def.type ? def.type : null
  }
  if (looseMkBuildRe(def.type).test(src)) return def.type
  return null
}

/** Object literal matching `stub-build.ts` `mk()` without the function call. */
export function emitInlineMkNodeExpr(
  type: string,
  chV: string,
  rawV: string,
  pos: string,
  endVar: string,
  tlV: string,
): string {
  return `{ _tag: 'node', type: ${JSON.stringify(type)}, span: { start: ${pos}, end: ${endVar} }, children: ${chV}, rawCount: ${rawV}.length, localTriviaLen: ${tlV}.length }`
}
