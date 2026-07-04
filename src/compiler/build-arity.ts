import type { ParserDef } from '../types.ts'

/**
 * Per-node CST-trivia (4th build arg) and state-clone (5th build arg) capture is
 * dead work when the build never declares those formal params. This module derives
 * a build's *confirmed* formal-parameter arity so all three eval paths (interpreter,
 * compiler, macro) can elide that capture identically.
 *
 * Conservative by construction: any source we can't confidently parse — rest params,
 * destructuring, `arguments`, an unrecognized shape — yields `null` (arity unknown),
 * and callers KEEP full capture. We only ever return a number when the parameter list
 * is a plain comma-separated list of simple identifiers.
 */

type NodeDef = Extract<ParserDef, { tag: 'node' }>

/** Matches the formal-parameter list of an arrow or function build, capturing its inner text. */
const PARAM_LIST_RE =
  // (params) => ...   |   function name?(params) ...   |   single-ident arrow `x => ...`
  /^(?:function\b[^(]*\(([^)]*)\)|\(([^)]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>)/

/**
 * A confirmable formal param: a plain identifier, optionally `?`-optional and
 * optionally carrying a TypeScript type annotation (`c`, `c?`, `c: any`,
 * `c?: Foo`). The build source is sliced verbatim from the (possibly TS) grammar
 * source, so typed params must be recognized or every typed grammar keeps full
 * capture. Type annotations containing a comma (generics/tuples/object types) are
 * split apart by the caller's `,`-split into non-matching fragments → `null`
 * (conservative). No `=` (default) is accepted — defaults stay unconfirmed.
 */
const CONFIRMABLE_PARAM_RE = /^[A-Za-z_$][\w$]*\s*\??\s*(?::[^,=]+)?$/

/**
 * Confirmed count of simple formal parameters the build declares, or `null` when the
 * source can't be parsed into a plain identifier list (→ caller keeps full capture).
 */
export function confirmedBuildArity(src: string): number | null {
  const s = src.trim()
  const m = PARAM_LIST_RE.exec(s)
  if (!m) return null

  // Single-ident arrow: `x => ...` → exactly one param.
  if (m[3] !== undefined) return 1

  const inner = (m[1] ?? m[2] ?? '').trim()
  if (inner === '') return 0

  // Reject anything that isn't a flat list of simple identifiers. A rest param
  // (`...args`), destructuring (`{a}`, `[a]`), or default (`a = 1`) all appear here.
  const parts = inner.split(',')
  for (const part of parts) {
    if (!CONFIRMABLE_PARAM_RE.test(part.trim())) return null
  }

  // A stray `arguments` reference defeats formal-arity reasoning entirely; only a
  // full-source scan can rule it out. Cheap guard against the obvious cases.
  if (/\barguments\b/.test(s)) return null

  return parts.length
}

/** Build reads the 4th (triviaLog) arg? Unknown/unparseable → true (keep capture). */
export function buildReadsTrivia(def: NodeDef): boolean {
  if (!def.build) return true // structural node: host may read trivia — keep capture
  const src = def.buildSrc ?? def.build.toString()
  const arity = confirmedBuildArity(src)
  if (arity === null) return true
  return arity >= 4
}

/** Build reads the 5th (state) arg? Unknown/unparseable → true (keep state clone). */
export function buildReadsState(def: NodeDef): boolean {
  if (!def.build) return true // structural node: host may read state — keep clone
  const src = def.buildSrc ?? def.build.toString()
  const arity = confirmedBuildArity(src)
  if (arity === null) return true
  return arity >= 5
}
