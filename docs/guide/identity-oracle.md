# The identity oracle

`parseman/oracle` answers one question, mechanically: **did my grammar change move the
output?**

Normally that's a judgement call, and a nervous one. You can see two `choice` arms that
are obviously near-duplicates. You can see that collapsing them *ought* to change nothing.
But the only way to be sure is to trace every path through them — and the reason they're
duplicated in the first place is usually that somebody already tried that and lost their
nerve.

The oracle replaces the tracing with a comparison. Run a corpus through your parser,
hash the results, make your change, hash again. Same numbers? The refactor is
output-neutral and can land on its own merits. Different numbers? Then it wasn't a
refactor — it's a semantics change, and it deserves the conversation that goes with one.

It's a **differential, not a correctness check**. It tells you the output didn't move. It
has no opinion about whether the output was any good to begin with.

## What parseman gives you

Exactly one primitive: `digestInto(target, value, prefix?, options?)`, a deterministic
serialization of **one** parse result. It streams a canonical projection into a hash you
supply, so you own the algorithm and you own the number.

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

That's the piece only parseman can write, because it's parseman's node shapes that decide
which differences are meaningful and which are noise.

## The loop

1. Digest every file in your corpus. Keep a short fingerprint per file, and fold them all —
   in **id order** — into one aggregate per parse surface.
2. Save it. Edit the grammar. **Rebuild.**
3. Digest again and compare. Equal aggregates accept the change. A different one names the
   surface, and the per-file fingerprints tell you which file to go stare at.

The corpus walking, the aggregate, the verdict, the report formatting — all yours, not
parseman's. They only mean anything with your corpus roots and your committed baseline in
hand. A folder under `test/identity-oracle/` holding a baseline file and a runner is a
perfectly good shape for it.

The rest of this page is the discipline that makes such a harness worth trusting. Every
item on the list is something that has gone wrong for real.

## Six ways to make it trustworthy

### Declare every surface, not just the one you're editing

A refactor to one grammar should move *neither* surface. The untouched one is a free
**control**: if it moved too, then something other than your edit moved — the harness, the
corpus, or the build. Declaring the interpreter and the compiled artifact side by side is
the cheapest version of this, and it catches a refactor that's neutral for one and not the
other.

### Failures are part of the contract

A parse that throws and a parse that returns a failure both get hashed. Error behaviour
*is* behaviour: turning a hard rejection into a silent accept moves the grammar's contract
just as surely as renaming a node.

So a corpus full of invalid input is a **feature**. Feed it your rejection fixtures on
purpose, expect the throw count to be non-zero, and require that it doesn't budge.

Hash rejections under a **different prefix** than successes, as above. Skip that and a
surface returning exactly the shape you project errors into digests identically to one
that threw — which means the single most valuable thing this gate catches, an error
quietly becoming an accept, is the one thing it stops catching.

### "It rejected the input" and "I couldn't digest it" are different facts

The first is a fact about your **grammar** and belongs in the hash. The second — a
`CanonicalBudgetError`, an out-of-memory, a bug in your own projection — is a fact about
your **tooling**, and it's the exact opposite. Keep them on separate channels, and make
sure the second can't produce a verdict at all. A run that couldn't digest something
hasn't compared anything, and should say so rather than report a number.

The way this goes wrong is completely banal: you digest inside the same `try` that guards
the parse, and now every projection failure silently becomes a rejection. The count moves,
the fingerprint moves, and your gate reports its own breakage in the vocabulary of a
grammar regression. Take the digest **outside** that `try` — and any transform you apply
to the tree before digesting it.

### Digest what actually ships

If your grammar is macro-compiled, digest the **built** artifact, and rebuild between
edits. A macro-*fallback* build runs the interpreter, and the interpreter and the compiled
artifact aren't guaranteed to agree on every tree — so a digest taken on a fallback build
certifies something nobody runs.

Keep your macro-buildability check green; a red one invalidates any digest taken on that
build. The oracle can't check this for you. Your build can.

### A corpus can't be allowed to quietly shrink

Derive each entry's id *relative to an explicit base*, never from an absolute path, or two
machines will never agree and the first cross-machine comparison reads as a total
regression.

Fail loudly on a corpus root that doesn't resolve, rather than cheerfully walking a smaller
tree. And fold the entry **ids** into the aggregate alongside their fingerprints, so a
corpus that lost files moves the aggregate instead of producing a smaller, greener,
completely meaningless gate.

### The harness must not be able to drift in silence

A digest that moved because the *harness* changed, not the grammar, is worse than no
oracle at all: it either invents a regression or — much worse — hides one.

Give the harness a behavioural fingerprint of its own. Run it over a small frozen canary of
hand-built values that exercises every shaping decision it makes, hash that, and stamp it
into every report. Then **refuse** to compare two reports whose fingerprints differ: return
`incomparable`, never `identical` and never `moved`. A drifted harness owes you an error,
not a verdict about your grammar.

Pin that fingerprint to a literal in your own suite, so changing the projection means
editing a constant in a reviewed diff. Parséman exports `DIGEST_FORMAT` for the same
reason — fold it in and a projection-format bump moves your fingerprint too.

One thing a frozen canary *can't* cover: whether a projection failure lands on the tool's
channel or the grammar's. An entry that exercises it produces no fingerprint, by
definition. Assert that one directly instead.

### Nondeterminism gets caught, not hashed

A grammar whose output depends on a timestamp, a counter, or a traversal whose order isn't
stable run to run produces a digest that moves every single run — which reads exactly like
a regression, forever.

Re-parse an evenly spaced sample of the corpus and fail loudly, naming the surface and the
entry, if any of them doesn't reproduce. Hold onto the source you already read rather than
re-reading the file, or an edit landing mid-run gets reported as grammar nondeterminism.

## What the projection notices

`JSON.stringify` quietly collapses several distinctions a grammar refactor can genuinely
move. The oracle's projection doesn't:

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

`NaN`, `±Infinity`, `-0`, `Map`, `Set`, `Date` and `RegExp` all stay distinct too, rather
than collapsing into `null` or `{}`.

Only own **enumerable** keys get hashed, and that's deliberate. The question is whether
your *output* moved, and non-enumerable properties are engine bookkeeping no consumer ever
sees. Hashing them would make your grammar's digest move when parseman's internals change,
which is precisely the wrong sensitivity for a grammar gate.

A node reachable by two different paths is written out in full both times. Only a genuine
back-edge into the current path gets abbreviated, and even then it records the distance to
the ancestor it points at. The easy version — marking every repeat as a cycle — makes the
digest depend on traversal order for any DAG, and parse trees with shared subtrees are
DAGs all the time.

## What it isn't

**It's not a performance gate.** A cleanup can be perfectly output-neutral and still be
slower. Proving it isn't is a separate job — see [Performance](/guide/performance).

**It's not a substitute for `analyzeGating()`.** Gating tells you what your grammar's
dispatch *shape* is, statically, and will tell you when a collapse just cost you first-char
dispatch. The oracle tells you whether the collapse changed the output. A good cleanup
wants both answers.

**It can't tell two functions apart if they share a name.** A function projects as
`f"<name>"`, so if your AST parks a callback on a node and a refactor swaps it for a
different function of the same name, the digest sits there unmoved. Anonymous functions all
project as `f""`.

That last one is a known hole, not an oversight. Closing it means either hashing the
function's source text — which flips your digest on a comment edit inside a builder — or
refusing to digest any value carrying a callable, which rejects ASTs that legitimately hold
one. Neither default is right for everybody, so the projection tells you what it sees and
leaves the choice to you. If your trees carry callables and you need them covered, strip or
normalise them before you digest.
