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
 */
import { createHash } from 'node:crypto'

/**
 * Bump when the token grammar below changes in a way that alters output for any
 * input. It is a coarse, human-readable companion to the behavioural harness
 * digest — the harness digest is what actually enforces this, but a reader
 * comparing two reports should not have to diff hex to see that the format moved.
 */
export const DIGEST_FORMAT = 1

const str = (s: string): string => JSON.stringify(s)

const tagOf = (v: object): string => {
  const ctor = (v as { constructor?: unknown }).constructor
  return typeof ctor === 'function' && typeof ctor.name === 'string' ? ctor.name : ''
}

function writeScalar(v: unknown, out: string[]): void {
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

function write(v: unknown, path: Map<object, number>, depth: number, out: string[]): void {
  // Everything that is not a live object reference is written here, so the rest
  // of the function has `v: object` and needs no assertion to index or key on it.
  if (typeof v !== 'object' || v === null) {
    writeScalar(v, out)
    return
  }

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
    for (const item of v) write(item, path, depth + 1, out)
    out.push(']')
  } else if (v instanceof Map) {
    out.push('M')
    for (const [k, val] of v) {
      write(k, path, depth + 1, out)
      write(val, path, depth + 1, out)
    }
    out.push('}')
  } else if (v instanceof Set) {
    out.push('S')
    for (const item of v) write(item, path, depth + 1, out)
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
      write((v as Record<string, unknown>)[k], path, depth + 1, out)
    }
    out.push('}')
  }

  path.delete(v)
}

/**
 * The canonical token string for a value. Exported because a moved digest is
 * only actionable if you can see WHAT moved: diff two canonical strings and the
 * answer is a line, not a hex mismatch.
 */
export function canonicalize(value: unknown): string {
  const out: string[] = []
  write(value, new Map(), 0, out)
  return out.join('\u0000')
}

/** Full 64-hex sha256 of a string. */
export function hash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * Per-entry fingerprint width. 64 bits over any realistic corpus is far below
 * the collision floor, and a report a human has to read stays readable.
 */
export const FINGERPRINT_HEX = 16
