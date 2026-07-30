/**
 * The AST-identity oracle: an accept/reject gate for grammar refactors.
 *
 * ## What it is for
 *
 * "Collapse these two near-duplicate rules" is a judgement call until something
 * can answer "did the tree move?" mechanically. This answers it: run a corpus
 * through your parse entry points before and after the change, digest the
 * results, compare. Identical digests mean the refactor is output-neutral and can
 * land on its own merits. Different digests mean it is not a refactor — it is a
 * semantics change, and needs the decision that goes with one.
 *
 * It is a differential, not a correctness check. It says the output did not move;
 * it says nothing about whether the output was right to begin with.
 *
 * ## Failures are part of the contract
 *
 * A parse that throws, and a parse that returns a failure result, are both
 * hashed. Error behaviour IS behaviour: a change that turns a hard rejection into
 * a silent accept has moved the grammar's contract as surely as one that renames
 * a node. A corpus with a healthy number of rejections in it is a FEATURE — feed
 * it your invalid inputs on purpose. What matters is that the throw counts and
 * the digests do not move.
 *
 * ## Measure what SHIPS
 *
 * Digest the artifact your consumers get. For a macro-compiled grammar that means
 * the BUILT output, rebuilt between edits — a macro-fallback build runs the
 * interpreter, and the interpreter and the compiled artifact are not guaranteed
 * to agree on every tree. A digest taken on a fallback build certifies something
 * nobody runs. This module cannot check that for you; your build can, and should.
 *
 * ## The harness cannot drift silently
 *
 * A digest that moves because the HARNESS changed, rather than the grammar, is
 * worse than no oracle: it either invents a regression or, far worse, hides one.
 * Three things prevent it:
 *
 *  1. Every report carries {@link HARNESS_DIGEST} — a behavioural fingerprint of
 *     this harness, produced by running it over a frozen canary corpus that
 *     exercises every payload-shaping decision it makes.
 *  2. {@link compareReports} REFUSES to compare two reports whose harness
 *     digests differ. It returns `incomparable`, never `identical` and never
 *     `moved`. A drifted harness produces an error, not a verdict.
 *  3. Parseman's own suite pins `HARNESS_DIGEST` to a literal constant, so
 *     changing the projection requires editing that constant in a reviewed diff.
 *     There is no edit to this file that changes a digest and stays quiet.
 *
 * ## Nondeterminism is caught, not hashed
 *
 * A grammar whose output depends on `Map` iteration over object identity, a
 * timestamp, or a counter produces a digest that moves every run — which reads
 * exactly like a regression. {@link digestCorpus} re-parses a sample of the
 * corpus and fails loudly if any entry does not reproduce. An oracle that cannot
 * be trusted should say so rather than emit a number.
 */
import { digestValue, hash, DIGEST_FORMAT, FINGERPRINT_HEX } from './digest.ts'

/**
 * One parse entry point under test.
 *
 * Declare EVERY shipped surface, not just the one you are editing. A refactor
 * that touches one grammar should move neither, and the untouched surface is a
 * free control: if it moves too, the harness or the corpus moved, not the rule
 * you edited.
 */
export type Surface = {
  /** Stable identifier. Renaming a surface changes its aggregate, deliberately. */
  name: string
  /** Called once per corpus entry. May return anything, and may throw. */
  parse: (source: string, id: string) => unknown
}

export type CorpusEntry = {
  /**
   * Stable, RELATIVE identifier — a path relative to a base, not an absolute
   * one. An absolute path makes the digest depend on the checkout directory,
   * which means two machines can never agree.
   */
  id: string
  source: string
}

export type SurfaceReport = {
  name: string
  /** sha256 over every entry's fingerprint, in id order. The gate. */
  aggregate: string
  /** How many entries threw. Expected to be non-zero; expected not to MOVE. */
  threw: number
}

export type IdentityReport = {
  format: number
  /** Behavioural fingerprint of the harness that produced this report. */
  harness: string
  entries: number
  surfaces: SurfaceReport[]
  /** entry id → surface name → 16-hex fingerprint. Diff this to localise a move. */
  perEntry: Record<string, Record<string, string>>
}

export type DigestOptions = {
  /**
   * Project a thrown value into something hashable. The default keeps an Error's
   * `name` and `message`.
   *
   * Override when your messages embed anything machine-specific — an absolute
   * path, a wall-clock time, a memory address. Those make a digest that cannot
   * be compared across machines, and the symptom is a gate that fails for
   * everyone except its author.
   */
  projectError?: (thrown: unknown, id: string, surface: string) => unknown
  /**
   * How many entries to re-parse to prove the grammar is deterministic. Sampled
   * evenly across the corpus, not from the front. `0` disables the check; do that
   * only if you have another reason to trust it.
   */
  determinismSample?: number
  /**
   * Visit budget per digested value — see {@link DEFAULT_MAX_VISITS}. Exceeding
   * it raises {@link CanonicalBudgetError}, which is NOT caught and NOT counted
   * in `threw`: the tool giving up is not a fact about the grammar.
   */
  maxVisits?: number
}

const defaultProjectError = (thrown: unknown): unknown =>
  thrown instanceof Error ? { name: thrown.name, message: thrown.message } : { thrown }

/**
 * The `OK:` / `ERR:` discriminator.
 *
 * Not decoration, and not droppable: it keeps a successful parse and a thrown
 * error in disjoint hash spaces. Without it a surface that returns exactly the
 * projected error shape hashes identically to one that threw it, and the single
 * most important thing this oracle detects — an error becoming an accept — is
 * the thing it stops detecting.
 */
function payload(surface: Surface, entry: CorpusEntry, options: DigestOptions): { digest: string; threw: boolean } {
  let value: unknown
  let threw = false
  try {
    value = surface.parse(entry.source, entry.id)
  } catch (thrown) {
    threw = true
    value = (options.projectError ?? defaultProjectError)(thrown, entry.id, surface.name)
  }

  /*
   * Digesting happens OUTSIDE the try, and that placement is the whole point.
   *
   * When it was inside, a failure of the PROJECTION — a `RangeError` from
   * joining a canonical string past V8's maximum length, an OOM-adjacent throw,
   * a budget refusal — was caught here and recorded as `ERR:` with `threw++`.
   * The tool failing to answer became indistinguishable from the grammar
   * rejecting the input, which is the one distinction this oracle exists to
   * make. A gate that reports its own breakage as a grammar change does not
   * degrade, it LIES; so a digest failure now propagates and takes the run down
   * with a named error.
   */
  return { digest: digestValue(value, threw ? 'ERR:' : 'OK:', { maxVisits: options.maxVisits }), threw }
}

const fingerprint = (digest: string): string => digest.slice(0, FINGERPRINT_HEX)

/**
 * Run every surface over every entry and produce the report.
 *
 * The corpus is sorted by id, so the aggregate does not depend on the order the
 * caller happened to list files in. The aggregate covers the ids as well as the
 * fingerprints, so a corpus that quietly SHRANK — a root that stopped resolving,
 * a glob that stopped matching — moves the aggregate instead of producing a
 * smaller, greener gate. {@link compareReports} then tells you it was the corpus.
 */
export function digestCorpus(
  surfaces: readonly Surface[],
  corpus: readonly CorpusEntry[],
  options: DigestOptions = {},
): IdentityReport {
  if (surfaces.length === 0) throw new Error('digestCorpus: no surfaces — there is nothing to compare.')
  const names = new Set<string>()
  for (const s of surfaces) {
    if (names.has(s.name)) throw new Error(`digestCorpus: duplicate surface name ${JSON.stringify(s.name)}.`)
    names.add(s.name)
  }

  const entries = [...corpus].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (let n = 1; n < entries.length; n++) {
    if (entries[n]!.id === entries[n - 1]!.id) {
      throw new Error(`digestCorpus: duplicate corpus id ${JSON.stringify(entries[n]!.id)}.`)
    }
  }

  const perEntry: Record<string, Record<string, string>> = {}
  const threw: Record<string, number> = {}
  /*
   * Full digests, not the canonical TEXTS this used to keep. The determinism
   * re-check only needs to know whether a second parse produces the same bytes,
   * and comparing two sha256 digests answers that exactly as well as comparing
   * two strings — while holding 64 hex chars per entry instead of the entire
   * projection of every tree in the corpus. On a corpus with any DAG-shaped
   * sharing in it those projections run to hundreds of megabytes EACH, and
   * retaining all of them is what turned a slow digest into an OOM.
   */
  const digests: Map<string, string>[] = []
  for (const s of surfaces) threw[s.name] = 0

  for (const entry of entries) {
    const row: Record<string, string> = {}
    const rowDigests = new Map<string, string>()
    for (const s of surfaces) {
      const result = payload(s, entry, options)
      if (result.threw) threw[s.name]!++
      row[s.name] = fingerprint(result.digest)
      rowDigests.set(s.name, result.digest)
    }
    perEntry[entry.id] = row
    digests.push(rowDigests)
  }

  verifyDeterminism(surfaces, entries, digests, options)

  return {
    format: DIGEST_FORMAT,
    harness: HARNESS_DIGEST,
    entries: entries.length,
    surfaces: surfaces.map(s => ({
      name: s.name,
      // The surface NAME is inside its own aggregate: two surfaces that happen
      // to agree on every entry must still have distinct aggregates, or a
      // report that swapped them would compare equal.
      aggregate: hash(
        [`surface:${s.name}`, ...entries.map(e => `${e.id}:${perEntry[e.id]![s.name]}`)].join('\n'),
      ),
      threw: threw[s.name]!,
    })),
    perEntry,
  }
}

function verifyDeterminism(
  surfaces: readonly Surface[],
  entries: readonly CorpusEntry[],
  digests: ReadonlyArray<Map<string, string>>,
  options: DigestOptions,
): void {
  const want = options.determinismSample ?? 32
  if (want <= 0 || entries.length === 0) return
  const stride = Math.max(1, Math.floor(entries.length / Math.min(want, entries.length)))
  for (let n = 0; n < entries.length; n += stride) {
    const entry = entries[n]!
    for (const s of surfaces) {
      if (payload(s, entry, options).digest === digests[n]!.get(s.name)) continue
      throw new Error(
        `digestCorpus: surface ${JSON.stringify(s.name)} is NOT DETERMINISTIC on ${JSON.stringify(entry.id)} — `
        + 'two parses of the same source produced different output. Every digest from this grammar would move on '
        + 'its own, so a comparison against it cannot mean anything. Usual causes: a timestamp or counter in the '
        + 'output, iteration over a keyed-by-object Map, or a node carrying a reference to mutable shared state.',
      )
    }
  }
}

export type SurfaceComparison = {
  name: string
  before: string | null
  after: string | null
  equal: boolean
  /** Entry ids whose fingerprint moved on this surface. Empty when equal. */
  moved: string[]
  beforeThrew: number | null
  afterThrew: number | null
}

export type IdentityComparison = {
  /**
   * `identical` — output-neutral, the refactor is accepted.
   * `moved` — the output changed; this is not a refactor.
   * `incomparable` — the two reports cannot be compared at all. Never a pass.
   */
  verdict: 'identical' | 'moved' | 'incomparable'
  reason: string | null
  addedEntries: string[]
  removedEntries: string[]
  surfaces: SurfaceComparison[]
}

/**
 * Compare two reports.
 *
 * Refuses — `incomparable`, with a reason — when the two were not produced by the
 * same harness over comparable inputs. That is the whole point: the failure mode
 * this guards against is a harness change that quietly re-baselines every recorded
 * digest, and the only defence is that mismatched provenance can never come out
 * as a verdict about the grammar.
 *
 * A corpus that gained or lost entries is reported but is NOT by itself
 * incomparable — the surviving entries still carry a real signal, and telling you
 * "1 entry disappeared, the other 4,300 are unchanged" is more useful than
 * refusing. The verdict still reflects the difference.
 */
export function compareReports(before: IdentityReport, after: IdentityReport): IdentityComparison {
  if (before.harness !== after.harness) {
    return incomparable(
      `harness drift: reports were produced by DIFFERENT versions of the identity harness `
      + `(${before.harness.slice(0, 12)}… vs ${after.harness.slice(0, 12)}…). Their digests are not comparable, `
      + `and treating them as such would either invent a regression or hide one. Re-run BOTH sides on one harness.`,
    )
  }
  if (before.format !== after.format) {
    return incomparable(`digest format ${before.format} vs ${after.format} — re-run both sides on one version.`)
  }

  const beforeIds = new Set(Object.keys(before.perEntry))
  const afterIds = new Set(Object.keys(after.perEntry))
  const addedEntries = [...afterIds].filter(id => !beforeIds.has(id)).sort()
  const removedEntries = [...beforeIds].filter(id => !afterIds.has(id)).sort()
  const shared = [...beforeIds].filter(id => afterIds.has(id)).sort()

  const byName = new Map<string, { before?: SurfaceReport; after?: SurfaceReport }>()
  for (const s of before.surfaces) byName.set(s.name, { ...byName.get(s.name), before: s })
  for (const s of after.surfaces) byName.set(s.name, { ...byName.get(s.name), after: s })

  const surfaces: SurfaceComparison[] = [...byName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, pair]) => {
      const moved = pair.before && pair.after
        ? shared.filter(id => before.perEntry[id]![name] !== after.perEntry[id]![name])
        : []
      return {
        name,
        before: pair.before?.aggregate ?? null,
        after: pair.after?.aggregate ?? null,
        equal: pair.before !== undefined && pair.after !== undefined && pair.before.aggregate === pair.after.aggregate,
        moved,
        beforeThrew: pair.before?.threw ?? null,
        afterThrew: pair.after?.threw ?? null,
      }
    })

  const identical =
    addedEntries.length === 0 && removedEntries.length === 0 && surfaces.every(s => s.equal)
  return { verdict: identical ? 'identical' : 'moved', reason: null, addedEntries, removedEntries, surfaces }
}

function incomparable(reason: string): IdentityComparison {
  return { verdict: 'incomparable', reason, addedEntries: [], removedEntries: [], surfaces: [] }
}

/** Human-readable rendering of a comparison, for a CLI or a CI log. */
export function formatComparison(c: IdentityComparison, options: { maxMoved?: number } = {}): string {
  if (c.verdict === 'incomparable') return `INCOMPARABLE — ${c.reason ?? 'unknown reason'}`
  const max = options.maxMoved ?? 10
  const lines: string[] = []
  for (const s of c.surfaces) {
    if (s.before === null) lines.push(`  + surface ${s.name} (added)`)
    else if (s.after === null) lines.push(`  - surface ${s.name} (removed)`)
    else if (s.equal) lines.push(`  = ${s.name}  ${s.before.slice(0, 16)}…  threw=${s.afterThrew}`)
    else {
      lines.push(
        `  ! ${s.name}  ${s.before.slice(0, 16)}… -> ${s.after.slice(0, 16)}…  `
        + `threw ${s.beforeThrew} -> ${s.afterThrew}  (${s.moved.length} entries moved)`,
      )
      for (const id of s.moved.slice(0, max)) lines.push(`      ${id}`)
      if (s.moved.length > max) lines.push(`      … and ${s.moved.length - max} more`)
    }
  }
  if (c.addedEntries.length > 0) lines.push(`  corpus GAINED ${c.addedEntries.length} entries`)
  if (c.removedEntries.length > 0) {
    lines.push(
      `  corpus LOST ${c.removedEntries.length} entries — a differential over a SMALLER corpus is a weaker gate, `
      + `not a passing one`,
    )
  }
  return [c.verdict === 'identical' ? 'IDENTICAL — output-neutral' : 'MOVED — this is not a refactor', ...lines]
    .join('\n')
}

/**
 * The frozen canary.
 *
 * One entry per decision the projection and {@link payload} make — INCLUDING
 * {@link CANARY_PROJECTION_FAILURE_ID}, whose value parses and then refuses to
 * project, which is what puts the digest's try-scope inside the fingerprint. Any
 * edit that changes what this harness produces for ANY input changes what it
 * produces for one of these, and therefore changes {@link HARNESS_DIGEST}.
 *
 * Exported for parseman's own suite, which asserts the projection-failing entry
 * is still here. It is not part of the published oracle surface.
 *
 * It deliberately builds its values by hand rather than by parsing anything: the
 * harness fingerprint must move when the HARNESS moves and at no other time. If
 * it ran a real grammar, every combinator change in this repo would re-baseline
 * it, and a fingerprint that moves for unrelated reasons is one people learn to
 * update without reading.
 */
/**
 * The canary entry whose value the PROJECTION cannot digest — the one that makes
 * {@link payload}'s try-scope observable.
 *
 * Exported for parseman's own suite, which asserts this entry still fails to
 * project. Without that assertion the coverage gap below can silently reopen.
 */
export const CANARY_PROJECTION_FAILURE_ID = 'j/projection-failure'

/**
 * A value that PARSES fine and then cannot be projected: an enumerable own key
 * whose getter throws while the walk is reading it.
 *
 * This exists because the canary corpus otherwise contained nothing that fails
 * projection, and a canary that never exercises a decision cannot fingerprint
 * it. Moving the digest out of {@link payload}'s `try` changed the fingerprint
 * and the `threw` count of every corpus entry with a masked projection failure
 * in it — but left {@link HARNESS_DIGEST} exactly where it was, because no canary
 * entry had one. {@link compareReports} would then have compared an old report
 * against a new one and returned `moved`: a HARNESS change, announced in the
 * vocabulary reserved for a GRAMMAR change, which is precisely the lie that
 * guarantee (1) at the top of this file says is impossible.
 *
 * With this entry in the corpus the guarantee holds: the try-scope decision is
 * inside the fingerprint, so changing it moves {@link HARNESS_DIGEST}, and an old
 * report is refused as `incomparable` rather than mis-read as a regression.
 *
 * A throwing getter rather than an over-long string or an exhausted budget: it
 * fails on the first key it is asked for, costs nothing, and its message is fixed
 * rather than dependent on an engine limit.
 */
export function canaryProjectionFailure(): unknown {
  return {
    ok: 1,
    get boom(): never {
      throw new Error('canary: this value cannot be projected')
    },
  }
}

/**
 * Digest one canary entry, distinguishing a PROJECTION failure from a PARSE
 * failure — the distinction {@link payload}'s try-scope exists to draw.
 *
 * A projection failure gets its own digest space (`PROJ:`, disjoint from both
 * `OK:` and `ERR:`) and is deliberately NOT counted in `threw`, because the tool
 * giving up is not a fact about the grammar. Were the digest ever to move back
 * inside the parse `try`, `payload` would return normally instead of throwing,
 * the entry would land in `ERR:` and would bump `threw` — two changes to the
 * aggregate, and {@link HARNESS_DIGEST} moves. That is this entry's whole job.
 */
function canaryPayload(surface: Surface, entry: CorpusEntry): { digest: string; threw: boolean } {
  try {
    return payload(surface, entry, {})
  } catch (thrown) {
    return { digest: digestValue(defaultProjectError(thrown), 'PROJ:'), threw: false }
  }
}

export function canaryReport(): IdentityReport {
  class Tagged {
    x: number
    constructor(x: number) {
      this.x = x
    }
  }
  const shared = { shared: true }
  const cyclic: Record<string, unknown> = { name: 'root' }
  cyclic.self = cyclic
  cyclic.child = { up: cyclic }

  const values: Record<string, unknown> = {
    [CANARY_PROJECTION_FAILURE_ID]: canaryProjectionFailure(),
    'a/scalars': [0, -0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 10n, true, false, null],
    'b/absent': [{ a: undefined }, {}, { a: null }, [undefined], []],
    'c/key-order': [{ a: 1, b: 2 }, { b: 2, a: 1 }],
    'd/collections': [new Map([['k', 1], ['j', 2]]), new Set([1, 2]), new Date(0), /ab+c/giu],
    'e/tagged': [new Tagged(1), { x: 1 }],
    'f/sharing': { left: shared, right: shared },
    'g/cycle': cyclic,
    'h/text': ['', 'a\u0000b', 'a b', '"quoted"', '\\'],
    'i/callable': [function named() {}, Symbol('sym')],
  }

  const surfaces: Surface[] = [
    { name: 'value', parse: (_source, id) => values[id] },
    {
      name: 'thrower',
      parse: (_source, id) => {
        if (id === 'a/scalars') throw new TypeError('canary')
        if (id === 'b/absent') throw 'a bare string' // eslint-disable-line no-throw-literal
        return { id }
      },
    },
  ]

  const corpus: CorpusEntry[] = Object.keys(values).map(id => ({ id, source: id }))
  // Built inline rather than through digestCorpus() so the harness digest does
  // not have to exist before it is computed.
  const perEntry: Record<string, Record<string, string>> = {}
  const threw: Record<string, number> = { value: 0, thrower: 0 }
  for (const entry of [...corpus].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const row: Record<string, string> = {}
    for (const s of surfaces) {
      const result = canaryPayload(s, entry)
      if (result.threw) threw[s.name]!++
      row[s.name] = fingerprint(result.digest)
    }
    perEntry[entry.id] = row
  }
  const ids = Object.keys(perEntry).sort()
  return {
    format: DIGEST_FORMAT,
    harness: '',
    entries: ids.length,
    surfaces: surfaces.map(s => ({
      name: s.name,
      aggregate: hash([`surface:${s.name}`, ...ids.map(id => `${id}:${perEntry[id]![s.name]}`)].join('\n')),
      threw: threw[s.name]!,
    })),
    perEntry,
  }
}

/**
 * Behavioural fingerprint of this harness, embedded in every report it produces.
 *
 * Parseman's suite pins this to a literal. If you change the projection, that
 * test fails and the constant has to be updated in the same diff — which is the
 * point. There is no quiet edit here.
 */
export const HARNESS_DIGEST: string = (() => {
  const canary = canaryReport()
  return hash(
    [`format:${DIGEST_FORMAT}`, ...canary.surfaces.map(s => `${s.name}:${s.aggregate}:${s.threw}`)].join('\n'),
  )
})()
