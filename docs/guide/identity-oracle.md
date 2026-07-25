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

## The loop

```ts
import { compile, parse } from 'parseman'
import { loadCorpus, digestCorpus, compareReports, formatComparison } from 'parseman/oracle'
import { grammar } from './src/grammar.ts'

const { entries } = loadCorpus({
  base: process.cwd(),
  roots: ['test/fixtures', 'corpus'],
  extensions: ['.less', '.css'],
})

const compiled = compile(grammar.stylesheet)
const report = digestCorpus(
  [
    { name: 'interpreted', parse: source => parse(grammar.stylesheet, source) },
    { name: 'compiled', parse: source => compiled.parse(source) },
  ],
  entries,
)
```

1. Run it, save the report as `before.json`.
2. Edit the grammar. **Rebuild.**
3. Run it again, save as `after.json`.
4. `console.log(formatComparison(compareReports(before, after)))`.

`IDENTICAL` accepts the change. `MOVED` names the surface and lists the entries
whose fingerprints changed, so you can go and look at one.

## Four things that make it worth trusting

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

### Digest what ships

If your grammar is macro-compiled, digest the **built** artifact and rebuild
between edits. A macro-*fallback* build runs the interpreter, and the interpreter
and the compiled artifact are not guaranteed to agree on every tree, so a digest
taken on a fallback build certifies something nobody runs. Keep your
macro-buildability check green; a red one invalidates any digest taken on that
build. The oracle cannot check this for you. Your build can.

### A corpus cannot quietly shrink

An entry id is *relative to an explicit base*, never absolute, so two machines can
agree. `loadCorpus` throws on a root that does not resolve rather than returning a
smaller corpus, and the aggregate covers the entry ids as well as their
fingerprints — so a corpus that lost files moves the aggregate instead of producing
a smaller, greener gate. `compareReports` then tells you it was the corpus.

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

## The harness cannot drift silently

A digest that moves because the **harness** changed rather than the grammar is
worse than no oracle: it either invents a regression or, far worse, hides one. This
is not a hypothetical failure — it is why this module exists in parseman rather
than being re-derived in each consumer. Three things prevent it:

- Every report carries `HARNESS_DIGEST`, a behavioural fingerprint of the
  projection, computed over a frozen canary that exercises every payload-shaping
  decision it makes.
- `compareReports` **refuses** to compare two reports whose harness digests differ.
  It returns `incomparable` — never `identical`, never `moved`. A drifted harness
  produces an error, not a verdict about your grammar.
- Parseman's own suite pins `HARNESS_DIGEST` to a literal constant, so changing the
  projection requires editing that constant in a reviewed diff.

## Nondeterminism is caught, not hashed

A grammar whose output depends on a timestamp, a counter, or iteration over a
Map keyed by object identity produces a digest that moves every run — which reads
exactly like a regression. `digestCorpus` re-parses a sample of the corpus and
fails loudly if any entry does not reproduce. Tune or disable it with
`determinismSample`.

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
need them covered, strip or normalise them in the surface you hand to `digestCorpus`.
