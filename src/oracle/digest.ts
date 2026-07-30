/**
 * The canonical projection and the hashing the identity oracle is built on.
 *
 * Everything here exists to make ONE claim trustworthy: "this grammar change did
 * not move the tree." That claim is only worth as much as the projection behind
 * it, so the rules below are stated rather than left to `JSON.stringify`, which
 * silently collapses several distinctions a grammar refactor can actually move:
 *
 * | value                  | `JSON.stringify` | here            |
 * |------------------------|------------------|-----------------|
 * | `{ a: undefined }`     | `{}`             | distinct from `{}` |
 * | `NaN` / `±Infinity`    | `null`           | each distinct   |
 * | `-0`                   | `0`              | distinct from `0` |
 * | `new Map([[1, 2]])`    | `{}`             | entries, in order |
 * | `new Set([1])`         | `{}`             | members, in order |
 * | `new Foo({ x: 1 })`    | `{"x":1}`        | tagged `Foo`    |
 *
 * A refactor that starts emitting `undefined` where it used to omit a key, or
 * that swaps one node class for another with the same fields, is a tree move.
 * An oracle that cannot see it is worse than no oracle, because it certifies.
 *
 * ## Key order does not matter; array and Map/Set order does
 *
 * Object keys are sorted, so property INSERTION order — which a refactor churns
 * constantly and which no consumer observes — never moves a digest. Array
 * elements and Map/Set entries keep their order, because those orders are the
 * output.
 *
 * ## Sharing is not a cycle
 *
 * A node reachable by two paths is written out twice, in full. Only a genuine
 * back-edge into the CURRENT path is abbreviated, and it records the DISTANCE to
 * the ancestor it points at, so a self-reference and a reference to the root are
 * different digests. (Marking every repeat as a cycle — the easy version — makes
 * the digest depend on traversal order for any DAG, which parse trees with
 * interned or shared subtrees routinely are.)
 *
 * The cost of that choice is stated plainly, because it has now bitten a
 * consumer: writing a shared subtree once per PATH is EXPONENTIAL in sharing
 * depth. A node referenced from two places at each of `d` levels is written
 * `2^d` times. See {@link DEFAULT_MAX_VISITS} for the backstop and for why the
 * obvious fix is a format change rather than a patch.
 *
 * ## Own ENUMERABLE keys only
 *
 * `Object.keys`, deliberately, not `getOwnPropertyNames`. The oracle answers "did
 * the OUTPUT move" and non-enumerable properties are engine bookkeeping a
 * consumer never sees — parseman's own carried CST pieces among them. Hashing
 * them would make a consumer's grammar digest move when parseman's internals
 * change, which is precisely the wrong sensitivity for a grammar-refactor gate.
 *
 * ## Tokens, not concatenation
 *
 * Every value writes one or more self-contained tokens joined by NUL. Writing
 * `#1` then `#2` into a single buffer would be indistinguishable from `#12`; a
 * projection with an ambiguity in it is a projection that can be made to lie.
 * Strings are JSON-escaped, so no token can contain a raw NUL.
 *
 * ## The projection is streamed, never materialised
 *
 * {@link digestInto} walks a value and pushes the token stream at a caller-owned
 * hash. Nothing accumulates, so there is no maximum-string-length ceiling and no
 * corpus size at which the digest stops being takeable. {@link canonicalize}
 * still builds the string, because reading it is its entire purpose — but it is
 * a debugging aid, not the path a gate runs on.
 */
import { createHash } from 'node:crypto'

/**
 * Bump when the token grammar below changes in a way that alters output for any
 * input. It is a coarse, human-readable companion to the behavioural harness
 * digest — the harness digest is what actually enforces this, but a reader
 * comparing two reports should not have to diff hex to see that the format moved.
 */
export const DIGEST_FORMAT = 1

/**
 * The token separator, in one place.
 *
 * {@link canonicalize} joins with it and {@link StreamSink} interleaves it, and
 * they MUST agree — the equality of those two byte streams is what lets a
 * streamed digest reproduce one taken from the string form. Sharing the constant
 * is how that stops being a thing anyone has to remember.
 */
const SEPARATOR = String.fromCharCode(0)

const str = (s: string): string => JSON.stringify(s)

const tagOf = (v: object): string => {
  const ctor = (v as { constructor?: unknown }).constructor
  return typeof ctor === 'function' && typeof ctor.name === 'string' ? ctor.name : ''
}

/**
 * Where canonical tokens go.
 *
 * Two implementations describing the SAME byte stream: {@link ArraySink}
 * materialises it, {@link StreamSink} pushes it at a hash and forgets it.
 */
type CanonicalSink = {
  push(token: string): void
}

/** Collects tokens so {@link canonicalize} can join them. */
class ArraySink implements CanonicalSink {
  readonly tokens: string[] = []

  push(token: string): void {
    this.tokens.push(token)
  }
}

/**
 * Anything that absorbs a stream of text. Node's `crypto.Hash` satisfies it, and
 * so does a three-line test double.
 *
 * The CALLER supplies this, and therefore owns the algorithm and the result.
 * Deciding what the canonical byte stream IS depends on parseman's node shapes
 * and on nothing else; deciding that you wanted sha256-hex does not.
 */
export type DigestTarget = {
  update(chunk: string): void
}

/**
 * Pushes the canonical token stream at a {@link DigestTarget} without ever
 * materialising it.
 *
 * The bytes written are exactly what {@link canonicalize} would have returned —
 * the separator goes BETWEEN tokens, never after — so hashing either gives the
 * same digest. That equality is not an implementation detail, it is the entire
 * safety argument for streaming: every digest ever recorded stays reproducible.
 * `test/unit/oracle-digest.test.ts` asserts it directly over the canary shapes.
 *
 * Tokens are buffered and flushed in blocks rather than written one at a time:
 * one `update()` per token is a call into native code per AST node. Flushing
 * only ever happens at a token boundary and tokens are whole JS strings, so a
 * surrogate pair can never be split across two `update()` calls — which would
 * encode to different UTF-8 bytes than the joined string does.
 */
class StreamSink implements CanonicalSink {
  private readonly target: DigestTarget
  private buffer: string[] = []
  private buffered = 0
  private started = false

  constructor(target: DigestTarget) {
    this.target = target
  }

  /**
   * Write text that is NOT a canonical token and takes no separator — the
   * `OK:` / `ERR:` discriminator, which the string form concatenates onto the
   * front rather than joining.
   */
  prefix(text: string): void {
    if (text === '') return
    this.buffer.push(text)
    this.buffered += text.length
  }

  push(token: string): void {
    if (this.started) {
      this.buffer.push(SEPARATOR)
      this.buffered += 1
    } else {
      this.started = true
    }
    this.buffer.push(token)
    this.buffered += token.length
    if (this.buffered >= FLUSH_CHARS) this.flush()
  }

  flush(): void {
    if (this.buffer.length === 0) return
    this.target.update(this.buffer.join(''))
    this.buffer = []
    this.buffered = 0
  }
}

/**
 * How much token text to accumulate before handing a block to the target. Large
 * enough that per-call overhead disappears, small enough that the extra live
 * memory is a rounding error next to the tree being walked.
 */
const FLUSH_CHARS = 1 << 16

/**
 * Raised when a walk exceeds its visit budget.
 *
 * A distinct class, and deliberately NOT an ordinary `Error` a caller might
 * lump in with a parse failure: this says the TOOL gave up, which is the
 * opposite of a fact about the grammar.
 */
export class CanonicalBudgetError extends Error {
  override readonly name = 'CanonicalBudgetError'

  constructor(budget: number) {
    super(
      `canonicalize: exceeded ${budget} visits. The value is not merely large — it is almost certainly a DAG being `
      + 'unrolled. This projection writes a shared subtree once per PATH that reaches it (see "Sharing is not a '
      + 'cycle"), so a node referenced from two places at each of d levels costs 2^d. Deduplicate the shared '
      + 'structure, or raise `maxVisits` if the value really is that big.',
    )
  }
}

/**
 * Default visit budget.
 *
 * A backstop against unbounded work, not a correctness feature. Any walk that
 * finishes under budget writes exactly the bytes it always did, so this cannot
 * move a recorded digest — which is the only reason it can be added to a shipped
 * format at all.
 *
 * It is NOT a fix for the underlying asymmetry. The fix is to dedupe by node
 * IDENTITY instead of by ancestor path, and that rewrites the byte stream for
 * every value with any sharing in it: `{ left: shared, right: shared }` stops
 * being two full writes and becomes a back-reference. That invalidates every
 * digest, every committed baseline, and {@link DIGEST_FORMAT} itself. It is a
 * format decision for the owner, not something to slip in behind a bug fix.
 */
export const DEFAULT_MAX_VISITS = 100_000_000

type WriteState = {
  readonly path: Map<object, number>
  readonly sink: CanonicalSink
  readonly budget: number
  visits: number
}

function writeScalar(v: unknown, out: CanonicalSink): void {
  switch (typeof v) {
    case 'undefined':
      out.push('u')
      return
    case 'boolean':
      out.push(v ? 'T' : 'F')
      return
    case 'bigint':
      out.push(`n${v}`)
      return
    case 'string':
      out.push(`s${str(v)}`)
      return
    // TODO(oracle-callable-identity): a callable is projected by NAME and a symbol by
    // DESCRIPTION, so two distinct same-named functions — or two same-description
    // symbols — digest identically, and a change between them reads as "identical".
    // This is a real hole in a tool whose whole claim is paranoia, and it is left open
    // deliberately: closing it means either hashing `Function.prototype.toString()`,
    // which flips the digest on a comment edit inside a builder, or REFUSING to digest
    // any value carrying a callable, which rejects legitimate ASTs that park a callback
    // on a node. Both are worse than the hole for some caller, and picking between them
    // is a product decision, not a bug fix. Documented under "What it is not" in
    // `docs/guide/identity-oracle.md` so no reader infers a guarantee that is not here.
    case 'symbol':
      out.push(`y${str(v.description ?? '')}`)
      return
    case 'function':
      out.push(`f${str(v.name)}`)
      return
    case 'number':
      if (Number.isNaN(v)) out.push('#nan')
      else if (v === Number.POSITIVE_INFINITY) out.push('#inf')
      else if (v === Number.NEGATIVE_INFINITY) out.push('#-inf')
      else if (Object.is(v, -0)) out.push('#-0')
      // Number→string is exact and round-trips in JS, so this loses nothing.
      else out.push(`#${v}`)
      return
    default:
      // `typeof null`. Distinct from `undefined`, which is `'u'`.
      out.push('z')
  }
}

function write(v: unknown, state: WriteState, depth: number): void {
  const out = state.sink
  // Everything that is not a live object reference is written here, so the rest
  // of the function has `v: object` and needs no assertion to index or key on it.
  if (typeof v !== 'object' || v === null) {
    writeScalar(v, out)
    return
  }

  // Counted per OBJECT visit, not per token: the runaway this guards against is
  // re-walking structure, and scalars cannot re-walk anything.
  if (--state.visits < 0) throw new CanonicalBudgetError(state.budget)

  const path = state.path
  const seenAt = path.get(v)
  if (seenAt !== undefined) {
    // Distance to the ancestor, not its identity: a self-reference and a
    // reference to the root must not hash the same.
    out.push(`^${depth - seenAt}`)
    return
  }
  path.set(v, depth)

  if (Array.isArray(v)) {
    out.push('[')
    // `for..of` rather than indexing so a sparse hole reads as the `undefined`
    // it is, consistently with a present `undefined` — the distinction between
    // a hole and an explicit undefined is not observable output.
    for (const item of v) write(item, state, depth + 1)
    out.push(']')
  } else if (v instanceof Map) {
    out.push('M')
    for (const [k, val] of v) {
      write(k, state, depth + 1)
      write(val, state, depth + 1)
    }
    out.push('}')
  } else if (v instanceof Set) {
    out.push('S')
    for (const item of v) write(item, state, depth + 1)
    out.push('}')
  } else if (v instanceof Date) {
    out.push(`D${v.getTime()}`)
  } else if (v instanceof RegExp) {
    out.push(`R${str(v.source)}${str(v.flags)}`)
  } else {
    const tag = tagOf(v)
    out.push(`{${str(tag === 'Object' ? '' : tag)}`)
    for (const k of Object.keys(v).sort()) {
      out.push(`k${str(k)}`)
      write((v as Record<string, unknown>)[k], state, depth + 1)
    }
    out.push('}')
  }

  path.delete(v)
}

/** Options shared by every entry point that walks a value. */
export type CanonicalOptions = {
  /**
   * Maximum object visits before {@link CanonicalBudgetError}. Defaults to
   * {@link DEFAULT_MAX_VISITS}. A walk that finishes under budget is byte-for-byte
   * unaffected, so this can never change a digest.
   *
   * MUST be a non-negative safe integer. `NaN`, `Infinity`, a negative and a
   * fractional value are all REJECTED rather than clamped — see
   * {@link newState} for why a bad budget is a thrown error and not a shrug.
   */
  maxVisits?: number | undefined
}

/**
 * Build the walk state, validating the budget before anything is written.
 *
 * The budget is spent with `--visits < 0`, and that comparison is silently
 * FALSE for `NaN` — so `maxVisits: NaN` did not raise the ceiling, it removed
 * it, and the walk it was supposed to bound ran to the OOM the budget exists to
 * prevent. `Infinity` is the same wish spelled honestly and gets the same
 * refusal, because an unbounded walk is not an option this offers. A fraction
 * never reaches `-1` cleanly either.
 *
 * So the budget is checked once, here, where the option is read: a bad number is
 * a caller mistake and says so, rather than turning into a hang under load.
 */
function newState(sink: CanonicalSink, options: CanonicalOptions | undefined): WriteState {
  const budget = options?.maxVisits ?? DEFAULT_MAX_VISITS
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new RangeError(
      `canonicalize: maxVisits must be a non-negative safe integer, received ${String(budget)}. `
      + 'A non-finite or fractional budget does not raise the ceiling, it REMOVES it — the budget is spent with '
      + '`--visits < 0`, which is false forever for NaN and never reached for Infinity — so the walk this bounds '
      + 'would run unbounded into the OOM the budget exists to prevent.',
    )
  }
  return { path: new Map(), sink, budget, visits: budget }
}

/**
 * The canonical token string for a value. Exported because a moved digest is
 * only actionable if you can see WHAT moved: diff two canonical strings and the
 * answer is a line, not a hex mismatch.
 *
 * This MATERIALISES the projection, so it is bounded by the maximum JS string
 * length and by available memory. Use it to explain a move you already know
 * about; take the digest itself with {@link digestInto}, which is bounded by
 * neither.
 */
export function canonicalize(value: unknown, options?: CanonicalOptions): string {
  const out = new ArraySink()
  write(value, newState(out, options), 0)
  return out.tokens.join(SEPARATOR)
}

/**
 * Stream a value's canonical projection into a caller-owned hash.
 *
 * This is the primitive: deterministic serialization of ONE parse result, which
 * is the part only parseman can do — it is parseman's node shapes that decide
 * which distinctions are semantically meaningful. The caller brings the hash and
 * keeps the result, so the algorithm, the encoding and the digest width are all
 * theirs.
 *
 * ```ts
 * const sha = createHash('sha256')
 * digestInto(sha, tree)
 * const digest = sha.digest('hex')
 * ```
 *
 * `prefix` is written ahead of the first token with NO separator, for callers
 * that discriminate one digest space from another (parseman's own oracle writes
 * `OK:` or `ERR:`). Pass `''` when there is nothing to discriminate.
 *
 * Equivalent to `hash(prefix + canonicalize(value))`, and preferable in every
 * case where you do not need to READ the projection.
 *
 * ## Two sharp edges, stated because the target is YOURS
 *
 * **A throw leaves the target written-to.** The token stream is pushed at
 * `target` as the walk proceeds, so a {@link CanonicalBudgetError}, a throwing
 * getter, or any other failure mid-walk leaves an ARBITRARY PREFIX of the
 * projection already absorbed. The hash object is then polluted: its digest is
 * neither the value's nor anything else's, and it is not recoverable — a
 * `crypto.Hash` cannot be rewound. On any throw, DISCARD the target and start a
 * fresh one. {@link digestValue} does exactly that by owning its hash for a
 * single call.
 *
 * **Two calls against one target concatenate with NO delimiter.** There is no
 * record separator between calls: `digestInto(t, a); digestInto(t, b)` writes
 * exactly `canonicalize(a) + canonicalize(b)`, with nothing in between. That is
 * ambiguous across the call boundary — the byte stream does not record where one
 * value ended, so a differently-split sequence can produce the identical stream
 * and therefore the identical digest. Concretely, `digestInto(t, 1);
 * digestInto(t, 2)` and the single call `digestInto(t, 2, '#1')` both write
 * `#1#2`. (Within ONE call the projection is unambiguous — every token is
 * self-contained and NUL-joined; it is only the seam between calls that is not.)
 *
 * This is DOCUMENTED rather than fixed. Any delimiter at the seam — written
 * before, after, or between — changes the bytes some existing caller already
 * hashes, and moving a recorded digest is a {@link DIGEST_FORMAT} decision for
 * the owner, not a patch. Callers hashing a SEQUENCE should digest a wrapper
 * value (`digestInto(t, [a, b])`), or write their own unambiguous separator
 * between calls, or use one target per value.
 */
export function digestInto(
  target: DigestTarget,
  value: unknown,
  prefix = '',
  options?: CanonicalOptions,
): void {
  const sink = new StreamSink(target)
  sink.prefix(prefix)
  write(value, newState(sink, options), 0)
  sink.flush()
}

/**
 * Full 64-hex sha256 of a value's canonical projection, streamed.
 *
 * The convenience wrapper over {@link digestInto} for the common case.
 * Identical to `sha256(prefix + canonicalize(value))` for every value the
 * latter can survive, and unbounded where it is not.
 */
export function digestValue(value: unknown, prefix = '', options?: CanonicalOptions): string {
  const sha = createHash('sha256')
  digestInto(sha, value, prefix, options)
  return sha.digest('hex')
}
