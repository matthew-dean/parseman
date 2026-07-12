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
annotation), emits a `ParseError` over the skipped span, and keeps parsing. It also
records the completions probe. Strict parses (the default) are byte-identical to a
grammar with no recovery.

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

## 3. Wire it into a language server

```ts
connection.onCompletion(({ textDocument, position }) => {
  const doc = documents.get(textDocument.uri)!
  const offset = doc.offsetAt(position)
  return css.completionsAt(doc.getText(), offset).map(c => ({ label: c.label, detail: c.detail }))
})

connection.onDidChangeContent(({ document }) => {
  const diags = css.diagnostics(document.getText()).map(d => ({
    severity: d.severity === 'error' ? 1 : 2,
    range: { start: document.positionAt(d.span.start), end: document.positionAt(d.span.end) },
    message: d.message,
  }))
  connection.sendDiagnostics({ uri: document.uri, diagnostics: diags })
})
```

## Notes & limits

- **`parseman/language-service` is a tree-shakeable subpath.** A build-only consumer
  that never imports it pays nothing for the editor code.
- **Completions on incomplete input** map to a semantic handler only when a node
  actually completes around the cursor (rule-at-cursor is reconstructed by
  span-containment over the partial CST). Otherwise the grammar's raw expected-token
  labels are returned — always useful, just not domain-mapped.
- **Recovery quality** is good, not provably optimal: the sync point is inferred from
  grammar structure (a `sepBy`'s separator, an enclosing delimiter) via standard
  follow-set panic-mode. There are no per-rule recovery knobs — recovery is a property
  of the grammar's shape, kept out of both the grammar source and the service config.
