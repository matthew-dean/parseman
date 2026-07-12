# Editor / language-server integration

Parseman's editor support follows one principle: **the grammar is pure structure;
editor behaviour hooks onto it from the outside.** A grammar describes what a valid
document *is* — it carries no recovery policy, no completion lists, no lint rules.
Those are consumer concerns (they differ per editor, per project), so they live in a
separate layer keyed by rule/node name, and the grammar is never modified to support
them.

There are three layers:

1. **The grammar** — combinators (`rules`, `sequence`, `many`, `sepBy`, `node`, …).
   Authored once, compiled for speed. No IDE surface.
2. **Recovery + completions in the compiled parser** — automatic, opt-in at compile
   time, so the *published compiled artifact* an editor loads can recover past broken
   input and answer completions on the fast path.
3. **`parseman/language-service`** — the external, grammar-agnostic layer that turns
   the parser's raw signals into editor features (diagnostics, semantic completions),
   configured by the consumer.

## 1. Compile the grammar with recovery

Recovery is dormant unless you opt in. A normal (strict) parse of an
opted-in grammar is unaffected (~1% overhead, dormant branches); the output stays
macro-inlinable.

**Build-time (macro):**

```ts
// vite/rollup/esbuild config
parseman({ recovery: true })
```

**Or at runtime:**

```ts
import { compile } from 'parseman'
const parser = compile(grammar, undefined, { recovery: true })
```

A recovery-compiled grammar, run tolerantly, skips a malformed list element to an
*inferred* sync point (the enclosing delimiter / a `sepBy`'s separator — no grammar
annotation), embeds a `parseError` node **in the CST** over the skipped span, and keeps
parsing. It also records the completions probe. Strict parses (the default) are
byte-identical to a grammar with no recovery.

Because the error is a node in the tree (not a side channel), a walk finds every
diagnostic, and — crucially for the incremental document below — the error rides inside
the subtree it belongs to, so it survives edit-time reuse.

## 2. Wrap it in a language service

```ts
import { languageService } from 'parseman/language-service'

const css = languageService(grammar, {
  // lint rules keyed by node type — run over the parsed CST
  diagnostics: {
    Color: (node) =>
      isLegacyHex(node) ? [{ severity: 'warning', message: 'prefer #rrggbb', span: node.span }] : [],
  },
  // semantic completions keyed by the rule the cursor is in
  complete: {
    Declaration: (cx) => valuesFor(cx /* … */).map(label => ({ label })),
  },
})

css.parse(src, { tolerant: true }) // → CST + ParseError[]
css.diagnostics(src)               // → structural errors + your lint rules
css.completionsAt(src, offset)     // → completion items
```

The grammar passed in is **untouched** — the same combinator parses identically with
or without the service wrapping it.

The two above (`css.parse` / `css.diagnostics` / `css.completionsAt`) are one-shot: each
re-parses the whole text. For an editor re-parsing on every keystroke, open an
**incremental document** instead.

## 3. Open an incremental document

Pass the grammar as `{ rules, root }` (a `rules()` registry plus its entry rule) to
unlock `openDocument`. The document holds a tolerant, incremental parse: `edit()`
re-parses only the changed span and reuses untouched subtrees, and the tree stays alive
through a broken keystroke.

```ts
const css = languageService({ rules: grammar, root: 'StyleSheet' }, config)

let doc = css.openDocument(source)
doc.tree            // CST with absolute spans; recovered errors embedded as parseError nodes
doc.diagnostics()   // walks the maintained tree — errors + lint, complete, no full reparse
doc.completionsAt(offset)

// on each editor change:
doc = doc.edit(from, to, replacement)   // incremental; tree survives even mid-typo
```

Because recovered errors live in the tree, an `edit()` that reuses an untouched region
keeps that region's diagnostics without re-deriving them — the fused incremental
re-parse and recovery are one pipeline, not two.

## 4. Wire it into a language server

```ts
const css = languageService({ rules: grammar, root: 'StyleSheet' }, config)
const docs = new Map<string, ReturnType<typeof css.openDocument>>()

connection.onDidOpenTextDocument(({ textDocument: t }) => {
  docs.set(t.uri, css.openDocument(t.text))
  publish(t.uri)
})

connection.onDidChangeTextDocument(({ textDocument, contentChanges }) => {
  let doc = docs.get(textDocument.uri)!
  for (const c of contentChanges) {
    const from = doc /* map c.range → offsets */ , to = from // (via your line index)
    doc = doc.edit(from, to, c.text)
  }
  docs.set(textDocument.uri, doc)
  publish(textDocument.uri)
})

connection.onCompletion(({ textDocument, position }) => {
  const doc = docs.get(textDocument.uri)!
  return doc.completionsAt(offsetOf(position)).map(c => ({ label: c.label, detail: c.detail }))
})

function publish(uri: string) {
  const diags = docs.get(uri)!.diagnostics().map(d => ({
    severity: d.severity === 'error' ? 1 : 2,
    range: rangeOf(d.span),
    message: d.message,
  }))
  connection.sendDiagnostics({ uri, diagnostics: diags })
}
```

## Notes & limits

- **`parseman/language-service` is a tree-shakeable subpath.** A build-only consumer
  that never imports it pays nothing for the editor code.
- **`openDocument` needs `{ rules, root }`** — the incremental engine addresses rules
  individually, so a bare single-combinator service has only the one-shot methods (it
  throws a clear error on `openDocument`).
- **Completions still probe.** `completionsAt` runs a truncated parse for the
  expected-set (inherent — it's a "what could go here" query), but uses the maintained
  tree to find the rule at the cursor cheaply. Completions are on-demand, not per
  keystroke, so this isn't on the hot path.
- **Completions on incomplete input** map to a semantic handler only when a node
  actually completes around the cursor (rule-at-cursor is reconstructed by
  span-containment over the partial CST). Otherwise the grammar's raw expected-token
  labels are returned — always useful, just not domain-mapped.
- **Recovery quality** is good, not provably optimal: the sync point is inferred from
  grammar structure (a `sepBy`'s separator, an enclosing delimiter) via standard
  follow-set panic-mode. There are no per-rule recovery knobs — recovery is a property
  of the grammar's shape, kept out of both the grammar source and the service config.
