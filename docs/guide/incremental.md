# Incremental re-parsing

Editors re-parse on every keystroke. Re-parsing the whole document each time is wasteful
when a single character changed. `parseDoc` wraps a parse in a document that
re-parses **incrementally** on edits, sharing untouched nodes by reference.

::: warning Experimental
`parseDoc` / `edit()` is **experimental** and its API may still change. It's correct today —
every `edit()` returns a tree structurally identical to a full re-parse, and reuse falls
back to a full re-parse whenever it can't be proven safe — but the surface isn't frozen yet.
Pin your version and expect occasional rough edges.
:::

## `parseDoc`

```ts
import { parseDoc } from 'parseman'

const registry = { Expr, Num }              // straight from rules()
let doc = parseDoc(registry, 'Expr', src)

doc.tree    // your Node root, or null on failure
doc.errors  // ParseFail[], empty on success
doc.input   // the source string

// edit(from, to, replacement) — two byte offsets into the OLD text + the
// replacement. "Select from→to, type replacement" — the three things every
// editor knows on each keystroke. Returns a NEW doc; the old one is untouched.
doc = doc.edit(changeStart, changeStart + changeLength, newText)
```

- The **`registry`** is the object `rules()` returns (rule name → parser function). The
  parser functions stay stateless; all incremental state lives in the doc.
- **`rootRule`** names the entry in the registry to parse from.
- Each rule's `type` string must match its registry key — that's how `edit()` knows which
  rule to re-parse.

## How `edit()` works

`edit()` finds the smallest node containing the change, re-parses just that rule from its
start offset using the node's saved `state`, and grafts the result back in when the new
span end lands where the edit's delta predicts. Nodes unaffected by the edit are shared by
reference between the old and new docs — so a keystroke deep in a large file re-parses one
small subtree, not the whole thing.

### Spans are parent-relative

An incremental doc's `tree` stores each node's `span` **relative to its parent's start**
(the root's base is 0). That's what lets a length-changing edit stay cheap: a subtree that
sits *after* the edit slides as a unit with its parent, so its parent-relative offsets are
*unchanged* and the whole subtree is **shared by identity** — no per-node offset rewrite.
An in-place value edit (overtype) and a character insert are both close to free as a result.

You get absolute positions two ways:

```ts
doc.spanAt(path)        // O(depth) cursor — absolute span of the node at a child-index path
absolutizeCST(doc.tree) // O(nodes) — the whole tree with absolute spans, when you need it
```

Prefer `spanAt` for the handful of nodes an editor queries per keystroke; reach for
`absolutizeCST` only when a consumer genuinely needs the entire absolute tree at once.
(A fresh, non-incremental `node().parse()` result is unchanged — its spans are still
absolute.)

### Structural edits: opt-in list reuse

Inserting or deleting a *whole element* in a large collection (the "add a line at the top
of a big array" case) would otherwise re-parse the entire collection. Pass
`{ structuralReuse: true }` and `edit()` instead re-parses only the disturbed span and
reuses the collection's untouched tail elements by identity — turning that edit from
O(list) into O(edit + trailing siblings):

```ts
let doc = parseDoc(registry, 'Stylesheet', src, { structuralReuse: true })
```

This stays **sound automatically** — you don't have to promise anything about your grammar.
`parseDoc` reads the grammar and **only ever splices a rule it can prove is a genuine
repetition** (`many` / `sepBy` / `oneOrMore`). A fixed-arity sequence of same-typed tokens
(e.g. `Triple = Num ',' Num ',' Num`) has CST children that look *exactly* like a 3-element
list, but its grammar is a plain `sequence` with no repetition — so it is never spliced and
falls back to a full, correct reparse. The result of `edit()` is always structurally
identical to a fresh parse, flag or no flag.

For that proof, pass the **`rules()` combinators** as the registry (what the examples above
do) — parseDoc inspects their grammar. If you instead pass bare parse *functions*, there's
no grammar to inspect, so structural reuse simply doesn't engage (still correct, just no
speedup). It's off by default only because it's a newer, opt-in optimization — not because
it's unsafe. On top of the grammar check, every splice is still guarded (exact tiling of the
reparsed span, a lookahead probe, a stateless-tail check). See the
[incremental re-parse benchmark](./benchmarks#incremental-re-parse) for how the three edit
kinds compare to Lezer.

Because docs are immutable, `edit()` returns a new doc and leaves the old one intact —
convenient for undo stacks and time-travel debugging.

## In an editor extension

Keep one registry per language and one doc per open document. Each keystroke gives you the
changed range as byte offsets — pass them straight to `edit()`:

```ts
const docs = new Map<string, ReturnType<typeof parseDoc<Node>>>()

vscode.workspace.onDidOpenTextDocument(d => {
  docs.set(d.uri.toString(), parseDoc(registry, 'Stylesheet', d.getText()))
})

vscode.workspace.onDidChangeTextDocument(event => {
  const uri = event.document.uri.toString()
  let doc = docs.get(uri)!
  for (const change of event.contentChanges) {
    doc = doc.edit(change.rangeOffset, change.rangeOffset + change.rangeLength, change.text)
  }
  docs.set(uri, doc)
  // walk doc.tree for diagnostics, folding ranges, semantic tokens, etc.
})
```

## Class-instance ASTs

The default graft shallow-spreads a parent to replace one child. For ASTs that can't be
shallow-spread — class instances with private fields, say — pass `opts.rebuild(node, children)`
to control how a parent is reconstructed:

```ts
const doc = parseDoc(registry, 'Program', src, {
  rebuild: (node, children) => node.withChildren(children),
})
```

With a custom `rebuild`, a **length-changing** edit falls back to a full reparse — sliding
the span of a class instance can't be done safely by the graft, so correctness wins over the
incremental fast path (and `structuralReuse` is likewise skipped). Same-length edits still
graft incrementally. Plain object trees (the default) get the incremental path for both.

## Build a CST from a composed grammar

If your grammar is [composed](./extending) from `node()` rules that build an evaluator AST,
you usually want a plain **positioned CST** for editor features. Pass a build host with
`opts.build` and it's threaded into every (re)parse — so `.edit()` produces the same CST
your fresh parse does, on the same grammar:

```ts
import { parseDoc, cstBuildHost } from 'parseman'

let doc = parseDoc(registry, 'Stylesheet', src, { build: cstBuildHost })
doc = doc.edit(from, to, text)   // re-parsed subtrees are CST nodes too
```

Leave `build` unset to use the grammar's own builders. (This is the same `ctx.build` host
`compose()` grammars accept — see [`cstBuildHost`](../reference/api#cstbuildhost).)

## Pairs with error recovery

Incremental docs are most useful on *broken* input — the code an editor sees mid-keystroke
is invalid most of the time. Combine this with [error recovery](./error-recovery) so a
syntax error in one region doesn't blow away the tree for the rest of the document.
