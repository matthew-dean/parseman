---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: Parséman
  text: 100% Pure Parsing
  tagline: Parser combinators in TypeScript — fast enough to run as-is, blazing fast once the bundler macro turns them into inline code. Same grammar either way. No grammar files, no generated output to check in.
  image:
    src: https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/parseman.png
    alt: Parséman
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Why three modes?
      link: /guide/modes
    - theme: alt
      text: View on GitHub
      link: https://github.com/matthew-dean/parseman

features:
  - icon: ⚡
    title: Compiles to flat JavaScript
    details: Add the bundler plugin and your combinator trees are evaluated at build time and replaced with inline functions. The parseman import disappears from the bundle entirely.
    link: /guide/macro-mode
    linkText: Macro mode
  - icon: 🧩
    title: Just functions, all the way down
    details: literal, choice, sequence, many, node… compose plain functions. No DSL, no code-generation step to run, no generated files to commit.
    link: /guide/combinators
    linkText: Combinators
  - icon: 🌳
    title: CST / AST with trivia capture
    details: node() rules capture terminals and whitespace/comment offsets for you — no wrapping terminals to recover spans. Purpose-built for editors, formatters, and incremental re-parsing.
    link: /guide/ast
    linkText: Building trees
  - icon: 🛟
    title: Fault-tolerant by design
    details: "recover(), expect(), and a { recover: true } channel keep parsing broken input and report every error — not just the first. The foundation for language servers and linters."
    link: /guide/error-recovery
    linkText: Error recovery
  - icon: 🏎️
    title: Aged for speed
    details: On JSON, CSV, and GraphQL the macro build beats Peggy at every fixture size; compiled CST beats Lezer on tree-building too.
    link: /guide/benchmarks
    linkText: Benchmarks
  - icon: 🐛
    title: Debuggable output
    details: Interpreter mode runs your combinator source directly. Macro build compiles it away but keeps breakpoints working via source maps — you step through choice(...), not charCode dispatch.
    link: /guide/modes#debugging-compiled-grammars
    linkText: Debugging by mode
---
