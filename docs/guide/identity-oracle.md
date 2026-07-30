# The identity oracle

`parseman/oracle` answers one question mechanically: **did this grammar change move
the output?**

Grammar cleanup is normally a judgement call. You can see that two `choice` arms
are near-duplicates, and you can see that collapsing them *ought* to be neutral,
but the only way to be sure is to read every path through them — and the reason
they are duplicated is usually that someone already tried that and gave up. The
oracle replaces the reading with a comparison: digest a corpus through your parse
entry points before the change and after it. Identical digests mean the refactor
is output-neutral and lands on its own merits. Different digests mean it is not a
refactor — it is a semantics change, and needs the decision that goes with one.

It is a **differential, not a correctness check**. It tells you the output did not
move. It has no opinion about whether the output was right to begin with.

## What parseman gives you

One primitive: `digestInto(target, value, prefix?, options?)`, the deterministic
serialization of **one** parse result. It streams a canonical token projection at
a hash you supply, so you own the algorithm and keep the number.

```ts
import { createHash } from 'node:crypto'
import { compile, parse } from 'parseman'
import { digestInto } from 'parseman/oracle'
import { grammar } from './src/grammar.ts'

const compiled = compile(grammar.stylesheet)

function digest(source) {
  const sha = createHash('sha256')
  let value
  let threw = false
  try {
    value = compiled.parse(source)
  } catch (error) {
    threw = true
    value = { name: error.name, message: error.message }
  }
  // The prefix keeps a successful parse and a rejection in disjoint hash spaces.
  digestInto(sha, value, threw ? 'ERR:' : 'OK:')
  return { digest: sha.digest('hex'), threw }
}
```

That is the part only parseman can write: it is parseman's node shapes that
decide which distinctions are semantically meaningful.

## The loop, and the harness you write around it

1. Digest every file in your corpus. Keep a short fingerprint per file and fold
   them, in **id order**, into one aggregate per parse surface.
2. Save it. Edit the grammar. **Rebuild.**
3. Digest again and compare: equal aggregates accept the change; a different one
   names the surface, and the per-file fingerprints say which file to go look at.

Corpus walking, the aggregate, the verdict and the report formatting are yours,
not parseman's — they only mean anything with your corpus roots and your
committed baseline in hand. jess's is
`packages/syntax/less/less-parser/test/identity-oracle/` and is a reasonable
model to copy. The rest of this page is the discipline that makes such a harness
worth trusting; every item is something that has gone wrong for real.

## Six things that make it worth trusting

### Declare every surface, not just the one you are editing

A refactor touching one grammar should move neither surface. The untouched one is
a free **control**: if it moved too, something other than the rule you edited moved
— the harness, the corpus, or the build. Declaring the interpreter and the compiled
artifact side by side, as above, is the cheapest version of this and catches a
refactor that is neutral for one and not the other.

### Failures are part of the contract

A parse that throws and a parse that returns a failure are both hashed. Error
behaviour *is* behaviour: a change that turns a hard rejection into a silent accept
has moved the grammar's contract as surely as one that renames a node. So a corpus
full of invalid inputs is a **feature** — feed it your rejection fixtures on
purpose. Expect the throw count to be non-zero. Require that it does not move.

Hash the rejections under a **different prefix** than the successes, as above.
Without it, a surface that returns exactly the shape you project an error into
digests identically to one that threw it — and the single most important thing
this kind of gate detects, an error becoming an accept, is the thing it stops
detecting.

### "It rejected the input" and "I could not digest it" are different facts

The first is a fact about the **grammar** and belongs in the hash. The second —
`CanonicalBudgetError`, an out-of-memory, a bug in your own projection — is a fact
about the **tool**, and it is the exact opposite. Keep them on separate channels,
and make sure the second cannot produce a verdict at all: a run that could not
digest something has not compared anything, and should say so rather than report
a number.

The way this goes wrong is banal. Digest inside the same `try` that guards the
parse and every projection failure silently becomes a rejection: the count moves,
the fingerprint moves, and the gate reports its own breakage in the vocabulary of
a grammar regression. Take the digest **outside** that `try` — and any transform
you apply to the tree before digesting with it.

### Digest what ships

If your grammar is macro-compiled, digest the **built** artifact and rebuild
between edits. A macro-*fallback* build runs the interpreter, and the interpreter
and the compiled artifact are not guaranteed to agree on every tree, so a digest
taken on a fallback build certifies something nobody runs. Keep your
macro-buildability check green; a red one invalidates any digest taken on that
build. The oracle cannot check this for you. Your build can.

### A corpus cannot quietly shrink

Derive an entry id *relative to an explicit base*, never from an absolute path, or
two machines can never agree and the first cross-machine comparison reads as a
total regression. Fail on a corpus root that does not resolve rather than quietly
walking a smaller tree. And fold the entry **ids** into the aggregate alongside
their fingerprints, so a corpus that lost files moves the aggregate instead of
producing a smaller, greener gate.

## What the projection sees

`JSON.stringify` silently collapses several distinctions a grammar refactor can
actually move. The oracle's projection does not:

```ts
// [verify]
import { canonicalize } from 'parseman/oracle'

// A key that became an explicit `undefined` is a tree move; JSON hides it.
canonicalize({ a: undefined }) === canonicalize({})
// → false

// So is swapping one node class for another with the same fields.
class Decl { constructor(name) { this.name = name } }
class Rule { constructor(name) { this.name = name } }
canonicalize(new Decl('x')) === canonicalize(new Rule('x'))
// → false

// Property insertion order, which a refactor churns constantly and no consumer
// observes, is NOT a move.
canonicalize({ a: 1, b: 2 }) === canonicalize({ b: 2, a: 1 })
// → true

// Array order is.
canonicalize([1, 2]) === canonicalize([2, 1])
// → false
```

`NaN`, `±Infinity`, `-0`, `Map`, `Set`, `Date` and `RegExp` are likewise each
distinct rather than collapsed to `null` or `{}`. Own **enumerable** keys are
hashed, deliberately: the question is whether the *output* moved, and
non-enumerable properties are engine bookkeeping a consumer never sees. Hashing
them would make your grammar's digest move when parseman's internals change, which
is the wrong sensitivity for a grammar gate.

A node reachable by two paths is written out in full both times; only a genuine
back-edge into the current path is abbreviated, and it records the distance to the
ancestor it points at. Marking every repeat as a cycle — the easy version — makes
the digest depend on traversal order for any DAG, which parse trees with shared
subtrees routinely are.

### The harness must not be able to drift silently

A digest that moves because the **harness** changed rather than the grammar is
worse than no oracle: it either invents a regression or, far worse, hides one. Give
your harness a behavioural fingerprint of its own — run it over a small frozen
canary of hand-built values that exercises every shaping decision it makes, hash
that, and stamp it into every report. Then **refuse** to compare two reports whose
fingerprints differ: return `incomparable`, never `identical` and never `moved`. A
drifted harness has to produce an error, not a verdict about your grammar.

Pin the fingerprint to a literal in your own suite, so changing the projection
requires editing that constant in a reviewed diff. `DIGEST_FORMAT` is exported for
the same purpose from parseman's side: fold it in and a projection format bump
moves your fingerprint too.

One decision a frozen canary *cannot* cover is whether a projection failure lands
on the tool's channel or the grammar's — an entry that exercises it produces no
fingerprint, by definition. Assert that one directly instead.

### Nondeterminism is caught, not hashed

A grammar whose output depends on a timestamp, a counter, or iteration over a
Map keyed by object identity produces a digest that moves every run — which reads
exactly like a regression. Re-parse an evenly spaced sample of the corpus and fail
loudly, naming the surface and the entry, if any of them does not reproduce. Hold
the source you already read rather than re-reading the file, or an edit landing
mid-run reports as grammar nondeterminism.

## What it is not

It is not a performance gate. A cleanup that is output-neutral can still be slower,
and proving it is not is a separate job — see
[Performance](/guide/performance) and `docs/design/perf-gates.md`.

It is also not a substitute for `analyzeGating()`. Gating tells you what your
grammar's dispatch *shape* is, statically, and will tell you when a collapse cost
you first-char dispatch. The oracle tells you whether the collapse changed the
output. A cleanup wants both answers.

And it does not distinguish two **callables** that share a name, or two symbols that
share a description. A function is projected as `f"<name>"`, so if your AST parks a
callback on a node and a refactor swaps it for a different function of the same name,
the digest does not move. Anonymous functions all project as `f""`.

This is a known hole rather than an oversight. Closing it means hashing the function's
source text, which would flip the digest on a comment edit inside a builder, or
refusing to digest any value that carries a callable, which rejects ASTs that
legitimately hold one. Neither default is right for every caller, so the projection
states what it sees and leaves the choice open. If your trees carry callables and you
need them covered, strip or normalise them before you digest.
