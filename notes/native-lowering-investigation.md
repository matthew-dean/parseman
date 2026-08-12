# Native Lowering Investigation

This is a parked investigation, not a roadmap commitment.

## Prompt

Parseman already macro-compiles grammars into static JavaScript recognizers. The
open question is whether that macro output, or a narrower intermediate form
behind it, could become a partially native/static compilation target.

The motivating reference is `scriptc` (`https://scriptc.dev/`), which presents
TypeScript-to-native compilation as explicit tiers:

- static native compilation by default for supported TypeScript;
- an opt-in dynamic tier for unsupported JavaScript;
- compile-time rejection with diagnostics for the rest.

That tier model is more interesting than "run Parseman through a native
compiler" as a blanket goal. Parseman already has a strong correctness boundary:
interpreter fallback is not just slower, it can emit a different tree. Any
native-lowering experiment must preserve that same explicitness.

## Investigation Questions

1. What is the smallest Parseman artifact that could be a native/static target?
   Candidates:
   - macro-generated JavaScript;
   - serialized grammar IR;
   - a lower-level scanner/choice/dispatch instruction stream.
2. Can native lowering preserve Parseman's host-mode contracts?
   - AST mode;
   - CST mode;
   - `routed()` ownership;
   - fields, trivia, recovery, and spans.
3. Can the compiler report coverage by grammar site, not just by TypeScript
   statement?
4. Is there a useful partial tier?
   - Static-native recognition for terminals, sequences, `choice`, `dispatch`,
     and repeats;
   - JavaScript fallback only for reducer callbacks or unsupported hosts;
   - hard failure when fallback would change AST/CST semantics.
5. What benchmark would justify touching this?
   - generated parser startup time;
   - cold parse of large grammars;
   - hot parse of Less/CSS corpora;
   - binary size and deployment ergonomics.

## Constraints

- No silent fallback. A dynamic tier must be explicit and visible in diagnostics.
- No AST/CST semantic drift. Native/static and JavaScript paths must be checked
  by an identity oracle.
- No reducer-host abstraction creep. This must not become a new Jess AST host.
- Do not prioritize this ahead of the grammar fold, dispatch adoption, or
  declarative node projection / `drop`-style boilerplate reducers. Prefer
  extending Parseman's existing functional combinator shape unless a new helper
  proves leaner against real grammars.

## Suggested First Agent Task

Produce a read-only design memo that compares three possible compilation
targets: macro-generated JavaScript, Parseman serialized IR, and a new
recognizer bytecode/instruction stream. For each target, explain what would
compile statically, what would remain dynamic, and what oracle would prove
equivalence.
