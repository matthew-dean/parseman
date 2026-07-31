import type { ParserDef } from '../types.ts'
import { buildAnalysisSrc } from './build-arity.ts'
import { recordDegradation } from './degradation.ts'

/**
 * A formal param, optionally carrying a TypeScript annotation.
 *
 * The macro path TS-strips `buildSrc` before it reaches here, so a bare `\w+` was
 * *usually* enough — but "usually" is exactly the failure class this module is being
 * audited for: a `mk` reducer spelled with a type annotation that survives (a runtime
 * `compile()` over untranspiled source, a hand-written IR string) silently loses the
 * inline-`mk` fast path and pays a `_build[n](...)` call on every match, with nothing
 * said. Admitting the annotation removes the class rather than relying on an upstream
 * pass to have removed it. No `=` (default) — a default is not a plain positional param.
 */
/** Optional `?` and/or `: T` suffix on a formal param. */
const ANN = String.raw`\s*\??\s*(?::[^,)=]+)?`
/** A whole ignorable param (the `fields` slot, whose name the shape never re-reads). */
const ANY_P = String.raw`\w+${ANN}`

/** `(c, f, s, r, tl) => mk('Type', c, r, s, tl)` — CSS perf regression builder shape. */
const MK_BUILD_RE = new RegExp(
  String.raw`^\(\s*(\w+)${ANN}\s*,\s*${ANY_P}\s*,\s*(\w+)${ANN}\s*,\s*(\w+)${ANN}\s*,\s*(\w+)${ANN}\s*\)\s*=>\s*mk\s*\(\s*(['"])([^'"]+)\5\s*,\s*\1\s*,\s*\3\s*,\s*\2\s*,\s*\4\s*\)\s*$`,
)

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Same shape, but the type is named by an IDENTIFIER in BOTH positions rather than by a
 * string literal.
 *
 * `node(type, body, (c, f, s, r, tl) => mk(type, c, r, s, tl))` inside a factory is the
 * ordinary way to write a family of nodes — jess's `less` grammar does it at 31 sites —
 * and it missed the inline path purely because the matcher demanded a quoted literal.
 * Requiring the SAME identifier in both positions is what makes this sound rather than a
 * loosening: the arrow's own parameters are `(c, f, s, r, tl)`, so nothing between the
 * two occurrences can rebind the name, and the evaluator has already resolved that
 * binding to `def.type`. Two spellings of one value, not two values.
 */
function identMkBuildRe(typeIdent: string): RegExp {
  return new RegExp(
    String.raw`^\(\s*(\w+)${ANN}\s*,\s*${ANY_P}\s*,\s*(\w+)${ANN}\s*,\s*(\w+)${ANN}\s*,\s*(\w+)${ANN}\s*\)\s*=>\s*(?:[\w$.]*\.)?mk\s*\(\s*${escapeRegExp(typeIdent)}\s*,\s*\1\s*,\s*\3\s*,\s*\2\s*,\s*\4\s*\)\s*$`,
  )
}

/** Any callee — covers `mk`, `import_x.mk`, `__vite_ssr_import_0__.mk`, etc. */
function looseMkBuildRe(type: string): RegExp {
  return new RegExp(
    String.raw`^\(\s*(\w+)${ANN}\s*,\s*${ANY_P}\s*,\s*(\w+)${ANN}\s*,\s*(\w+)${ANN}\s*,\s*(\w+)${ANN}\s*\)\s*=>\s*.+\(\s*(['"])${escapeRegExp(type)}\5\s*,\s*\1\s*,\s*\3\s*,\s*\2\s*,\s*\4\s*\)\s*$`,
  )
}

/**
 * Does this source LOOK like it wants the inline-`mk` path? Used only to decide whether
 * a miss is worth reporting: a reducer that never mentions `mk(` was never a candidate,
 * and warning about it would be per-rule noise on every grammar that does not use the
 * pattern at all — the flood that turns a diagnostic back into silence.
 */
const LOOKS_LIKE_MK_RE = /=>\s*(?:[\w$.]*\.)?mk\s*\(/


/**
 * When a node() build is a thin `mk(type, …)` wrapper, emit the object literal
 * at the call site instead of `_build[n](…)`.
 */
export function analyzeMkInlineBuild(def: Extract<ParserDef, { tag: 'node' }>): string | null {
  if (!def.build) return null // structural node — no own build to inline
  if (def.type === undefined) return null
  const src = buildAnalysisSrc(def).trim()
  const strict = src.match(MK_BUILD_RE)
  if (strict) {
    const mkType = strict[6]!
    if (mkType === def.type) return def.type
    reportMkMiss(def.type, src, `it builds a "${mkType}" node, not "${def.type}"`)
    return null
  }
  if (looseMkBuildRe(def.type).test(src)) return def.type
  // Factory-authored: `node(t, …, (…) => mk(t, …))`. See `identMkBuildRe`.
  if (def.typeSrc !== undefined && identMkBuildRe(def.typeSrc).test(src)) return def.type
  if (LOOKS_LIKE_MK_RE.test(src)) {
    reportMkMiss(def.type, src, 'its parameter list or argument order does not match '
      + '`(children, fields, span, rawChildren, triviaLog) => mk(type, children, rawChildren, span, triviaLog)`')
  }
  return null
}

/** A near-miss on the inline-`mk` shape costs a real call per match — say so. */
function reportMkMiss(type: string, src: string, why: string): void {
  recordDegradation({
    code: 'mk-inline-missed',
    severity: 'warn',
    where: `node("${type}")`,
    subject: `build reducer \`${src.split('\n')[0]!.slice(0, 80)}\``,
    fellBackTo: `looks like an inline-\`mk\` builder but ${why}, so every match pays a `
      + '`_build[n](...)` call instead of an inlined object literal',
    otherwise: 'the node object would be constructed at the call site with no call frame',
  })
}

/** Object literal matching `stub-build.ts` `mk()` without the function call. */
export function emitInlineMkNodeExpr(
  type: string,
  chV: string,
  rawV: string,
  spanExpr: string,
  tlV: string,
): string {
  return `{ _tag: 'node', type: ${JSON.stringify(type)}, span: ${spanExpr}, children: ${chV}, rawCount: ${rawV}.length, localTriviaLen: ${tlV}.length }`
}
