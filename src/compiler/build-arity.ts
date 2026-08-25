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

/**
 * ── THE ONE RULE IN THIS FILE ────────────────────────────────────────────────────
 * A WRONG NUMBER IS THE BUG. `null` (unknown) IS ALWAYS ACCEPTABLE.
 *
 * `null` fails open: the caller keeps every capture tier and records a degradation, so
 * the output is correct and the cost is visible. A wrong NUMBER silently drops capture
 * tiers — fields vanish from the AST with no diagnostic, because a confident answer
 * never reaches `recordDegradation`. Every branch below that cannot decide with
 * certainty must therefore return `null`, never a guess.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** `x => ...` — a single unparenthesised identifier parameter. */
const SINGLE_IDENT_ARROW_RE = /^[A-Za-z_$][\w$]*\s*=>/

/** Start of a formal-parameter list: `(`, or `function name?(`. */
const PARAM_LIST_OPEN_RE = /^(?:function\b[^(]*)?\(/

/**
 * A host builtin, a `Function.prototype.bind` result and a `Proxy` all stringify to
 * `function () { [native code] }`. That has an EMPTY parameter list which says nothing
 * whatever about the underlying function's arity — reading it as arity 0 is a confident
 * lie that silently drops every capture tier. None of those are documented reducer
 * shapes and parseman does not owe them support; it owes them an honest `null`.
 */
const NATIVE_CODE_RE = /\{\s*\[native code\]\s*\}/

/** Identifier head of a formal param, with its optional `?`. */
const PARAM_HEAD_RE = /^[A-Za-z_$][\w$]*\s*\??\s*/

/** Same accepted identifier head, captured for parameter-liveness analysis. */
const PARAM_NAME_RE = /^([A-Za-z_$][\w$]*)\s*\??\s*/

/**
 * Confirmed count of simple formal parameters the build declares, or `null` when the
 * source can't be parsed into a plain identifier list (→ caller keeps full capture).
 */
export function confirmedBuildArity(src: string): number | null {
  const s = src.trim()

  // Unreadable source → unknown. Checked FIRST: its parameter list is empty, and the
  // empty-list answer below would otherwise report a confident 0.
  if (NATIVE_CODE_RE.test(s)) return null

  // A stray `arguments` reference defeats formal-arity reasoning entirely; only a
  // full-source scan can rule it out. Cheap guard against the obvious cases.
  //
  // Checked BEFORE the empty-parameter-list answer below. It used to sit after it, which
  // made it unreachable for exactly the shape it matters most for: `function () { return
  // arguments[0] }` has an empty formal list and real arity ≥ 1, and was reported 0.
  if (/\barguments\b/.test(s)) return null

  // Single-ident arrow: `x => ...` → exactly one param.
  if (SINGLE_IDENT_ARROW_RE.test(s)) return 1

  const inner = paramListText(s)
  if (inner === null) return null
  if (inner.trim() === '') return 0

  const parts = splitTopLevel(inner)
  if (parts === null) return null

  // Reject anything that isn't a flat list of simple identifiers. A rest param
  // (`...args`), destructuring (`{a}`, `[a]`), or default (`a = 1`) all appear here.
  for (const part of parts) {
    if (!isConfirmableParam(part.trim())) return null
  }

  return parts.length
}

/**
 * Prove that one simple positional formal is never referenced by a reducer.
 *
 * This deliberately answers a BOOLEAN rather than `boolean | null`: `false` means
 * either "used" OR "not provably unused", and callers keep capture in both cases.
 * The proof accepts only the same plain-parameter shapes as arity analysis and then
 * counts exact identifier tokens across the whole source. The declaration is the one
 * permitted occurrence; any second occurrence — including a comment, string, shadowed
 * binding, or nested closure — conservatively keeps the value.
 *
 * Dynamic name lookup is an unconditional refusal. `eval`, `Function`, `with`, and
 * `arguments` can observe a value without leaving a statically attributable identifier
 * read. False positives merely retain work; a false negative would change a builder's
 * input, so there is no speculative branch here.
 */
export function confirmedBuildParamUnused(src: string, index: number): boolean {
  if (!Number.isInteger(index) || index < 0) return false
  const s = src.trim()
  if (NATIVE_CODE_RE.test(s) || /\b(?:arguments|eval|Function)\b/.test(s) || /\bwith\s*\(/.test(s)) return false

  let names: string[]
  const single = /^([A-Za-z_$][\w$]*)\s*=>/.exec(s)
  if (single) {
    names = [single[1]!]
  } else {
    const inner = paramListText(s)
    if (inner === null || inner.trim() === '') return false
    const parts = splitTopLevel(inner)
    if (parts === null) return false
    names = []
    for (const part of parts) {
      const trimmed = part.trim()
      if (!isConfirmableParam(trimmed)) return false
      const name = PARAM_NAME_RE.exec(trimmed)?.[1]
      if (name === undefined) return false
      names.push(name)
    }
  }

  const name = names[index]
  if (name === undefined) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const uses = s.match(new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`, 'g'))
  return uses?.length === 1
}

/**
 * The text between a build's parameter parentheses, or `null` when it cannot be located
 * with certainty.
 *
 * Found by a BALANCED scan rather than a character class. The previous `[^)]*` stopped at
 * the first `)`, which in ordinary TypeScript is the one inside a function-typed
 * annotation: `(children: (n: N) => N, fields) => …` yielded `children: (n: N` and
 * reported arity 1 instead of 2 — a silent under-capture on precisely the typed shape the
 * docs tell authors to write.
 */
function paramListText(s: string): string | null {
  const open = PARAM_LIST_OPEN_RE.exec(s)
  if (!open) return null
  const start = open[0].length
  const end = matchingParen(s, start)
  if (end === null) return null
  // An arrow's list must be followed by `=>`; a `function`'s is followed by its body.
  // Without this a parenthesised expression could be read as a parameter list.
  if (!s.startsWith('function') && !/^\s*=>/.test(s.slice(end + 1))) return null
  return s.slice(start, end)
}

/** Index of the `)` closing the list opened just before `start`, else `null`. */
function matchingParen(s: string, start: number): number | null {
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const c = s[i]!
    if (c === '"' || c === "'" || c === '`') {
      const close = skipString(s, i)
      if (close === null) return null
      i = close
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') { if (--depth < 0) return null }
    else if (c === ')') { if (depth === 0) return i; depth-- }
  }
  return null
}

/** Index of the closing quote of the literal opened at `open`, else `null`. */
function skipString(s: string, open: number): number | null {
  const quote = s[open]!
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === quote) return i
  }
  return null
}

/**
 * Split a parameter list on TOP-LEVEL commas, or `null` if it cannot be split with
 * certainty.
 *
 * Tracks `()`/`[]`/`{}` AND `<>`, because a comma inside type arguments belongs to the
 * annotation, not the list: a plain `,`-split turned `(a: Map<K, V>, b) => …` into three
 * fragments. `=>` is consumed as a unit so the `>` of an arrow type is not mistaken for
 * the close of a type-argument list.
 */
function splitTopLevel(inner: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let angle = 0
  let last = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (c === '=' && inner[i + 1] === '>') { i++; continue }
    if (c === '"' || c === "'" || c === '`') {
      const close = skipString(inner, i)
      if (close === null) return null
      i = close
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { if (--depth < 0) return null }
    else if (c === '<') angle++
    else if (c === '>') { if (--angle < 0) return null }
    else if (c === ',' && depth === 0 && angle === 0) { parts.push(inner.slice(last, i)); last = i + 1 }
  }
  if (depth !== 0 || angle !== 0) return null
  parts.push(inner.slice(last))
  return parts
}

/**
 * A confirmable formal param: a plain identifier, optionally `?`-optional and optionally
 * carrying a TypeScript type annotation (`c`, `c?`, `c: any`, `c?: Map<K, V>`, `c: (n: N)
 * => N`). The build source is sliced verbatim from the (possibly TS) grammar source, so
 * typed params must be recognized or every typed grammar keeps full capture.
 *
 * A DEFAULT (`a = 1`, `a: number = 1`) stays unconfirmed: the parameter is optional, so
 * the formal count overstates what the reducer is guaranteed to receive.
 */
function isConfirmableParam(part: string): boolean {
  const head = PARAM_HEAD_RE.exec(part)
  if (!head) return false // rest `...a`, destructuring `{a}` / `[a]`
  const rest = part.slice(head[0].length)
  if (rest === '') return true
  if (rest[0] !== ':') return false // `a = 1`, or anything else we cannot read
  return !hasDefaultAssign(rest.slice(1))
}

/** An `=` that is not part of `=>`, `>=`, `<=`, `==` or `!=` — i.e. a default value. */
function hasDefaultAssign(annotation: string): boolean {
  for (let i = 0; i < annotation.length; i++) {
    if (annotation[i] !== '=') continue
    if (annotation[i + 1] === '>' || annotation[i + 1] === '=') { i++; continue }
    const prev = annotation[i - 1]
    if (prev === '<' || prev === '>' || prev === '!' || prev === '=') continue
    return true
  }
  return false
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
  'foreign-source': 'it is named in a module the resolver was never told about, so its '
    + 'offsets index no scope tree the resolver holds',
  'ambiguous-source': 'two distinct registered modules hold byte-identical text, so that '
    + 'text no longer names the module its offsets index',
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
  if (def.buildRawUnused === true) return false
  const arity = confirmedArityForDef(def)
  if (arity === null) return true
  return arity >= 4
}

/** Build reads the 5th (triviaLog) arg? Unknown/unparseable → true (keep capture). */
export function buildReadsTrivia(def: NodeDef): boolean {
  if (!def.build) return true // structural node: host may read trivia — keep capture
  if (def.buildTriviaUnused === true) return false
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
