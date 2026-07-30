import type { ParserDef } from '../types.ts'
import { recordDegradation } from './degradation.ts'

/**
 * Per-node children/fields/raw/trivia/state capture is dead work when the build
 * never declares the corresponding formal param. This module derives a build's
 * *confirmed* formal-parameter arity so the compiler and macro can elide their
 * direct-AST-only CST collectors without changing structural/CST output.
 *
 * Conservative by construction: any source we can't confidently parse — rest params,
 * destructuring, `arguments`, an unrecognized shape — yields `null` (arity unknown),
 * and callers KEEP full capture. We only ever return a number when the parameter list
 * is a plain comma-separated list of simple identifiers.
 */

type NodeDef = Extract<ParserDef, { tag: 'node' }>

/**
 * Is a positioned-CST host installed for this parse?
 *
 * `cstBuildHost` (and the language-service hosts) mark themselves with
 * `_parsemanCstOutput`. That flag is what re-routes a node with its OWN direct builder
 * through the host — and therefore what makes the direct builder's formal arity the
 * WRONG basis for eliding capture, since the consumer is no longer that builder.
 *
 * The COMPILED engine answers this at compile time (`hostMode`, 0.37.0). The interpreter
 * has no compile step, so it asks per parse.
 */
export function cstOutputHost(build: unknown): boolean {
  return (build as { _parsemanCstOutput?: true } | undefined)?._parsemanCstOutput === true
}

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

/**
 * The source a def's arity/shape analysis must read.
 *
 * `buildSrc` is the source text of the EXPRESSION written at the `node(...)` call
 * site. When the reducer is passed as a bare identifier — `node('Foo', p, { build:
 * foldOperation })` — that text is just `"foldOperation"`, which matches no parameter
 * list and used to fail open into all five capture tiers, silently. The macro plugin
 * already holds the whole module's AST, so it resolves such an identifier to its
 * module-scope declaration and parks that declaration's source here. `buildSigSrc` is
 * ANALYSIS-ONLY: it is never emitted, so the generated builder reference is unchanged.
 */
export function buildAnalysisSrc(def: NodeDef): string {
  return def.buildSigSrc ?? def.buildSrc ?? def.build!.toString()
}

/**
 * Why a parameter list could not be read — the actionable half of the diagnostic.
 *
 * Only genuinely undecidable shapes reach here. The resolver (`plugin/reducer-resolver.
 * ts`) handles named reducers, cross-module imports, namespace members, aliases,
 * non-reassigned `let`/`var`, defaults and destructuring; a decline from it carries a
 * machine-readable reason, which is what the author needs in order to fix or declare it.
 */
const RESOLVER_REASONS: Record<string, string> = {
  'rest-parameter': 'its parameter list uses a rest parameter, so the declared arity is unbounded',
  'arguments': 'its body references `arguments`',
  'reassigned': 'the binding it names is reassigned, so the function read here is not decidable',
  'not-a-function': 'the binding it names is not a function declaration',
  'unresolved-import': 'its module could not be resolved or parsed',
  'not-found': 'the name did not resolve to any binding',
  'computed': 'it is a computed expression',
}

function unconfirmableReason(def: NodeDef, src: string): string {
  const declared = def.buildArityUnresolved
  if (declared !== undefined && RESOLVER_REASONS[declared]) return RESOLVER_REASONS[declared]!
  const s = src.trim()
  const params = s.slice(0, s.indexOf(')') + 1)
  if (params.includes('...')) return RESOLVER_REASONS['rest-parameter']!
  if (/\barguments\b/.test(s)) return RESOLVER_REASONS['arguments']!
  if (/^[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)?$/.test(s)) {
    return 'it names a binding this build could not resolve to a function declaration'
  }
  return 'its parameter list could not be parsed'
}

/**
 * Confirmed formal arity for a node def, reporting once when it cannot be confirmed.
 *
 * Order of authority:
 *   1. `node(..., { buildArity })` — the author DECLARED it. Nothing overrides that.
 *   2. `def.buildArity` as resolved by the macro's reducer resolver (real scope analysis
 *      and cross-module import following).
 *   3. Reading the parameter list out of whatever source we have.
 *
 * Fail-open is the correct BEHAVIOR — capturing too much is safe, capturing too little
 * is a correctness bug. Fail-open with no diagnostic was the defect. But a diagnostic is
 * the right answer only for the genuinely undecidable; for everything a static analysis
 * can decide, the right answer is to decide it, which is why (2) exists and why (1) gives
 * the author a way out of (3) entirely.
 */
export function confirmedArityForDef(def: NodeDef): number | null {
  if (def.buildArity !== undefined) return def.buildArity
  const src = buildAnalysisSrc(def)
  const arity = confirmedBuildArity(src)
  if (arity !== null) return arity
  const subject = `build reducer \`${(def.buildSrc ?? '<runtime fn>').trim().split('\n')[0]!.slice(0, 60)}\``
  recordDegradation({
    code: 'build-arity-unconfirmed',
    severity: 'warn',
    where: `node("${def.type ?? '<inferred>'}")`,
    subject,
    fellBackTo: `could not confirm its declared arity — ${unconfirmableReason(def, src)} — `
      + 'so this node captures children, fields and raw children, logs trivia, and clones `_ctx.state` on every match',
    otherwise: 'only the tiers the reducer actually declares would be captured '
      + '(arity >= 1 children, >= 2 fields, >= 4 raw, >= 5 trivia, >= 6 state). '
      + 'Declare it with `node(..., { buildArity: n })` if it cannot be derived',
  })
  return null
}

/** Build reads its 1st (`children`) arg? Unknown/unparseable → true (keep capture). */
export function buildReadsChildren(def: NodeDef): boolean {
  if (!def.build) return true // structural node: CST output always owns children
  const arity = confirmedArityForDef(def)
  if (arity === null) return true
  return arity >= 1
}

/** Build reads its 4th (`rawChildren`) arg? Unknown/unparseable → true (keep capture). */
export function buildReadsRaw(def: NodeDef): boolean {
  if (!def.build) return true // structural node: host/default CST may read raw children
  const arity = confirmedArityForDef(def)
  if (arity === null) return true
  return arity >= 4
}

/** Build reads the 5th (triviaLog) arg? Unknown/unparseable → true (keep capture). */
export function buildReadsTrivia(def: NodeDef): boolean {
  if (!def.build) return true // structural node: host may read trivia — keep capture
  const arity = confirmedArityForDef(def)
  if (arity === null) return true
  return arity >= 5
}

/** Build reads the 6th (state) arg? Unknown/unparseable → true (keep state clone). */
export function buildReadsState(def: NodeDef): boolean {
  if (!def.build) return true // structural node: host may read state — keep clone
  const arity = confirmedArityForDef(def)
  if (arity === null) return true
  return arity >= 6
}
