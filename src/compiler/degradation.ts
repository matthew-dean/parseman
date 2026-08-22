/**
 * Degradation diagnostics — "parseman could not do the fast/complete thing here".
 *
 * A fallback that is CORRECT but slower (or less complete) and announces nothing is
 * indistinguishable from working properly. Every such path in the compiler and the
 * analysis APIs reports through this one channel so a consumer's build gate can
 * assert ZERO degradations, exactly the way jess's `check:macro` already asserts zero
 * `"falling back to runtime"` lines.
 *
 * Machine-greppable contract (stable across minor versions):
 *
 *   [parseman] degraded [<code>] <where>: <subject> — <fell back to>; otherwise <what>
 *
 * Grep token is the literal `[parseman] degraded`. The `<code>` is a stable kebab-case
 * identifier; new codes may be added, existing ones are not renamed without a note in
 * CHANGELOG.md.
 *
 * NOT for: user errors (those throw), un-taken optimizations that cost nothing, or
 * anything a grammar author cannot act on. A diagnostic that fires on every rule gets
 * filtered out and becomes the same silence we are trying to end — so a code that is
 * common and unavoidable AGGREGATES (see `DETAIL_CAP`) into one summary line with a
 * count instead of one line per rule.
 */

/** Off / print / throw. */
export type DegradationLevel = 'off' | 'warn' | 'error'

/** Stable, greppable code per degradation class. */
export type DegradationCode =
  /** A node build's formal parameter list could not be read → all capture tiers kept. */
  | 'build-arity-unconfirmed'
  /** A composed/carried piece is an opaque artifact → its rules were not analysed. */
  | 'opaque-artifact'
  /** A coverage-definition request could not read the grammar → empty is NOT a zero. */
  | 'coverage-definitions-unavailable'

/**
 * Severity. `warn` = a real, measurable cost the author can remove. `info` = the author
 * has nothing to act on (e.g. an imported reducer in someone else's package), but the
 * fact still has to be visible and countable.
 */
export type DegradationSeverity = 'warn' | 'info'

export type Degradation = {
  code: DegradationCode
  severity: DegradationSeverity
  /** Rule / node type / artifact the cost lands on. Never a bare "<unknown>" if avoidable. */
  where: string
  /** The reducer, identifier, or input that could not be analysed. */
  subject: string
  /** What parseman did instead. */
  fellBackTo: string
  /** What it would have done had the input been analysable. */
  otherwise: string
}

/** One line per finding, in the documented greppable shape. */
export function formatDegradation(d: Degradation): string {
  return `[parseman] degraded [${d.code}] ${d.where}: ${d.subject} — ${d.fellBackTo}; otherwise ${d.otherwise}`
}

/**
 * Per-code detail cap. Above it the remaining sites collapse to one counted summary
 * line. Chosen small on purpose: the point of a detail line is to give an author a
 * concrete place to start, and eight starting points is already more than anyone acts
 * on in one pass. The COUNT is what makes the rest visible.
 */
const DETAIL_CAP = 8

/** Group by code, cap the detail lines, and append a counted summary for the rest. */
export function formatDegradations(list: readonly Degradation[]): string[] {
  const byCode = new Map<DegradationCode, Degradation[]>()
  for (const d of list) {
    const bucket = byCode.get(d.code)
    if (bucket) bucket.push(d)
    else byCode.set(d.code, [d])
  }
  const out: string[] = []
  for (const [code, items] of byCode) {
    for (const d of items.slice(0, DETAIL_CAP)) out.push(formatDegradation(d))
    if (items.length > DETAIL_CAP) {
      out.push(
        `[parseman] degraded [${code}] +${items.length - DETAIL_CAP} more site(s) not listed `
        + `(${items.length} total). Set PARSEMAN_DEGRADATION=error to fail the build on these.`,
      )
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Capture sink
//
// Compilation is single-module and synchronous, so a module-level sink (opened per
// transform, drained after) records findings without threading a field through every
// Ctx and every compile*() return — the same shape as the regex-lowering sink in
// codegen.ts, for the same reason.
// ---------------------------------------------------------------------------
//
// A STACK, not a single slot. `transformMacro` re-enters itself when it lowers a private
// source module, so a single slot let the inner call's `endDegradationCapture()` close
// the OUTER module's sink — every later finding in the outer pass then bypassed capture
// and printed instead. A stack scopes each frame to its own module.
// ---------------------------------------------------------------------------
const _sinks: Array<Map<string, Degradation>> = []

/** Begin collecting degradations instead of printing them. */
export function beginDegradationCapture(): void {
  _sinks.push(new Map())
}

/** Stop collecting and return the findings (deduped, insertion-ordered). */
export function endDegradationCapture(): Degradation[] {
  const sink = _sinks.pop()
  return sink ? [...sink.values()] : []
}

/** Open-sink depth, for a caller that must unwind exactly its own frames. */
export function degradationCaptureDepth(): number {
  return _sinks.length
}

/**
 * Close every sink opened above `depth` and return their findings, outermost first.
 *
 * The safety net for an ABORTED capture. `beginDegradationCapture()` and its matching
 * `end` used to sit on the straight-line path of a function that throws between them, so
 * one failed macro transform left the sink open for the REST OF THE PROCESS: every later
 * `recordDegradation` — including from an unrelated runtime `compile()` — went into a
 * dead Map and printed nothing. Calling this from a `finally` bounds the damage to the
 * frame that failed, and returns what it had collected so it can still be reported
 * rather than silently dropped.
 */
export function unwindDegradationCapture(depth: number): Degradation[] {
  const found: Degradation[] = []
  while (_sinks.length > depth) {
    const sink = _sinks.pop()!
    found.unshift(...sink.values())
  }
  return found
}

/**
 * Resolve the level: explicit argument wins, else `PARSEMAN_DEGRADATION`, else
 * default-on `'warn'`. Default-on is the whole point — this exists because the
 * default was silence.
 */
export function resolveDegradationLevel(explicit?: DegradationLevel): DegradationLevel {
  if (explicit !== undefined) return explicit
  const env = typeof process !== 'undefined' ? (process.env?.PARSEMAN_DEGRADATION as DegradationLevel | undefined) : undefined
  if (env === 'off' || env === 'warn' || env === 'error') return env
  return 'warn'
}

/**
 * The dedup key for one finding.
 *
 * `JSON.stringify` of the tuple, NOT a delimiter-joined string. Two of the three
 * components are unbounded author text — `where` embeds a node type and `subject` is a
 * verbatim slice of reducer SOURCE — so no single delimiter character can be shown absent
 * from them, and picking a rarer one is the same bug one notch weaker. A JSON array is
 * injective by construction and needs no such argument.
 *
 * It is also PRINTABLE, which is the property this file lost twice. The key was built
 * with RAW 0x00 bytes in a template literal, which makes the whole source file BINARY:
 * `git diff --numstat` reported `- -` for it, GitHub refused to render it, and `grep -rn`
 * skipped it SILENTLY — no "binary file matches", no output, exit 0. The largest new file
 * in the release was invisible to ordinary review. Commit `ed81612` had already removed
 * exactly this pattern from `gating.ts` and `duplication.ts`; it came straight back here.
 * `scripts/check-control-bytes.mjs` now fails CI on it, because a fix without a gate got
 * us a second occurrence and would get us a third.
 *
 * This runs only when a degradation is actually recorded — never per match — so the
 * encoding cost is irrelevant.
 */
function degradationKey(d: Degradation): string {
  return JSON.stringify([d.code, d.where, d.subject])
}

/**
 * Record one degradation. Deduped on `code + where + subject`, so the four capture-tier
 * probes that all consult the same unreadable parameter list produce ONE finding, not
 * four.
 *
 * With a sink open (a macro transform) the finding is collected and the drain site
 * decides what to do with it. With NO sink open — a runtime `compile()` — this is the
 * only place that ever sees the finding, so it is also the only place that can honour
 * `'error'`. It therefore throws here. `docs/guide/degradation-diagnostics.md` documents
 * `PARSEMAN_DEGRADATION=error` as "fail the build" without qualification, and until this
 * throw existed that was false in library mode: `error` silently behaved as `warn`,
 * because `endDegradationCapture()` had exactly one call site, in the macro plugin.
 */
export function recordDegradation(d: Degradation): void {
  const level = resolveDegradationLevel()
  if (level === 'off') return
  const key = degradationKey(d)
  const sink = _sinks[_sinks.length - 1]
  if (sink) {
    if (!sink.has(key)) sink.set(key, d)
    return
  }
  if (_immediate.has(key)) return
  _immediate.add(key)
  if (level === 'error') throw new Error(`parseman: degraded compilation path\n${formatDegradation(d)}`)
  console.warn(formatDegradation(d))
}

/** Dedup memo for the sink-less (runtime `compile()`) path. */
const _immediate = new Set<string>()

/**
 * Open a per-`compile()` drain and return the function that closes it.
 *
 * This channel stays LOUD. `compile()` no longer prints gating advice — that is a
 * deliberate diagnostic now (`diagnoseGrammar`) — but a degradation is not advice: it
 * is parseman reporting that it could not do the thing the caller asked for, and this
 * release exists to stop that happening silently. What changes here is only the SHAPE.
 *
 * Before, the sink-less path printed one ~500-character line per site as it went, with
 * no aggregation — 31 of them for a single code in one `pnpm perf:workloads` run, each
 * repeating the same advice. The macro drain has always aggregated (`formatDegradations`,
 * `DETAIL_CAP`); the runtime path simply had no drain to aggregate at. It has one now,
 * so both paths report the same way and a real count survives instead of a wall.
 *
 * Nested inside a macro transform this is a NO-OP: that transform's sink owns the whole
 * module's findings and returns them on the bundler's warning channel. A per-compile
 * drain underneath it would steal them and print them instead.
 *
 * @returns `drain(report)` — always unwinds the sink (so a `compile()` that throws
 *   cannot leave it open for the rest of the process), and reports only when
 *   `report` is true, so a failed compile does not mask its own error with a second one.
 */
export function beginCompileDegradationDrain(): (report: boolean) => void {
  if (resolveDegradationLevel() === 'off' || _sinks.length > 0) return () => {}
  const depth = degradationCaptureDepth()
  beginDegradationCapture()
  return (report: boolean) => {
    const found = unwindDegradationCapture(depth)
    if (!report || found.length === 0) return
    // Process-level dedup, preserved from the immediate path: compiling the same grammar
    // twice must not re-print what the author has already been told once.
    const fresh = found.filter(d => {
      const k = degradationKey(d)
      if (_immediate.has(k)) return false
      _immediate.add(k)
      return true
    })
    if (fresh.length === 0) return
    const lines = formatDegradations(fresh)
    if (resolveDegradationLevel() === 'error') {
      throw new Error(`parseman: ${fresh.length} degraded compilation path(s)\n${lines.join('\n')}`)
    }
    for (const l of lines) console.warn(l)
  }
}

/** Test-only: forget the sink-less dedup memo. */
export function resetDegradationMemo(): void {
  _immediate.clear()
}
