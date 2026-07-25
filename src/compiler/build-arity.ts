import type { ParserDef } from '../types.ts'

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
 * Does the injected `ctx.build` host read its (n+1)th positional arg?
 *
 * The interpreter twin of the compiled prelude's `_hostReads` (codegen's
 * `HOST_READS_DECL`). Both engines MUST answer identically — see
 * `test/unit/host-capture-parity.test.ts`, which evaluates the emitted source and
 * compares it against this function over a shared table. A host is data supplied at
 * parse time, so its arity can only be inferred at runtime; `.length` alone
 * under-counts (it stops at the first default/rest param) and cannot see through a
 * bound function, so anything we cannot read confidently forces FULL capture.
 *
 * Conservative by construction: an unreadable source, an `arguments` reference, or a
 * rest/default param all return `true`. A host never silently loses what it reads.
 */
export function hostReads(build: unknown, n: number): boolean {
  if (build === undefined) return false
  let s: string
  try {
    s = Function.prototype.toString.call(build)
  } catch {
    return true
  }
  if (/\barguments\b/.test(s)) return true
  const m = /^[^(]*\(([\s\S]*?)\)/.exec(s)
  if (m !== null && m[1] !== undefined && /\.\.\.|=/.test(m[1])) return true
  return (build as { length: number }).length > n
}

/** Positional index of each host-supplied arg, for `hostReads` / `_hostReads`. */
export const HOST_ARG = { fields: 2, rawChildren: 4, triviaLog: 5, state: 6 } as const

/**
 * Is a positioned-CST host installed for this parse?
 *
 * `cstBuildHost` (and any language-service host that opts in) marks itself with
 * `_parsemanCstOutput`. That flag is what re-routes a node with its OWN direct
 * builder through the host (`node.ts`), and it is therefore also what makes the
 * direct builder's formal arity the WRONG basis for eliding capture: the consumer
 * is no longer that builder, it is the host.
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
 * Does the host want this node type's trivia log? An explicit per-type preference
 * (`_parsemanCaptureTrivia`) wins; otherwise fall back to arity inference. Mirrors
 * codegen's `hostTriviaGate` so both engines decide identically.
 */
export function hostCapturesTrivia(build: unknown, type: string): boolean {
  if (build === undefined) return false
  const pref = (build as { _parsemanCaptureTrivia?: (t: string) => boolean })._parsemanCaptureTrivia
  return pref !== undefined ? pref(type) : hostReads(build, HOST_ARG.triviaLog)
}

/**
 * Fail loudly when a positioned-CST host is about to be handed a collector that was
 * never populated.
 *
 * The regression this exists to make unreachable: capture is elided from the DIRECT
 * builder's formal arity, but under a CST host the direct builder is bypassed and the
 * host receives the collectors instead — so an arity-1 `children => …` builder used to
 * hand the host an empty triviaLog, absent fields and absent state, and the host had no
 * way to tell that apart from a genuinely trivia-free node. A thin tree that reports
 * clean is worse than a crash; this turns that silence into an error.
 *
 * Runs ONLY on the CST-host path (`_parsemanCstOutput`), so the eval-AST hot path
 * never reaches it. Each argument is the CAPTURE GATE decision, not the value — an
 * empty trivia log and an elided one are indistinguishable by value, which is exactly
 * how the defect stayed invisible.
 */
export function assertHostCaptureSatisfied(
  type: string,
  build: unknown,
  gates: { trivia: boolean; fields: boolean; state: boolean; hasFields: boolean },
): void {
  const missing: string[] = []
  // `hostCapturesTrivia`, not raw arity: a host that explicitly opts OUT per type via
  // `_parsemanCaptureTrivia` has asked for the thin log, so that is not a loss.
  if (!gates.trivia && hostCapturesTrivia(build, type)) missing.push('triviaLog')
  if (gates.hasFields && !gates.fields && hostReads(build, HOST_ARG.fields)) missing.push('fields')
  if (!gates.state && hostReads(build, HOST_ARG.state)) missing.push('state')
  if (missing.length === 0) return
  throw new Error(
    `parseman: node "${type}" was built through a positioned-CST host that reads `
      + `${missing.join(', ')}, but capture for ${missing.length > 1 ? 'those args was' : 'that arg was'} `
      + `elided. The host would have received a silently thin node. This is a parseman bug — `
      + `capture elision must be gated on what the HOST reads, not on the direct builder's arity.`,
  )
}

/** Build reads its 1st (`children`) arg? Unknown/unparseable → true (keep capture). */
export function buildReadsChildren(def: NodeDef): boolean {
  if (!def.build) return true // structural node: CST output always owns children
  const src = def.buildSrc ?? def.build.toString()
  const arity = confirmedBuildArity(src)
  if (arity === null) return true
  return arity >= 1
}

/** Build reads its 4th (`rawChildren`) arg? Unknown/unparseable → true (keep capture). */
export function buildReadsRaw(def: NodeDef): boolean {
  if (!def.build) return true // structural node: host/default CST may read raw children
  const src = def.buildSrc ?? def.build.toString()
  const arity = confirmedBuildArity(src)
  if (arity === null) return true
  return arity >= 4
}

/** Build reads the 5th (triviaLog) arg? Unknown/unparseable → true (keep capture). */
export function buildReadsTrivia(def: NodeDef): boolean {
  if (!def.build) return true // structural node: host may read trivia — keep capture
  const src = def.buildSrc ?? def.build.toString()
  const arity = confirmedBuildArity(src)
  if (arity === null) return true
  return arity >= 5
}

/** Build reads the 6th (state) arg? Unknown/unparseable → true (keep state clone). */
export function buildReadsState(def: NodeDef): boolean {
  if (!def.build) return true // structural node: host may read state — keep clone
  const src = def.buildSrc ?? def.build.toString()
  const arity = confirmedBuildArity(src)
  if (arity === null) return true
  return arity >= 6
}
