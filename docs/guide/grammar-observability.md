# Grammar observability

Parséman has two opt-in modes for watching a grammar work: coverage and trace.

- **Coverage** answers "which rules, choice arms, dispatch arms, and labels actually fired?"
- **Trace** answers "what did this parse try, pick, fail at, and back out of?"

Both are off by default, and turning them on never changes what a parse
returns — you just get more information alongside the normal result.

## Coverage

Use coverage when a test needs to prove a grammar actually exercised some
branch, not just that it returned the right answer. A run returns the normal
`RunResult` plus an immutable coverage snapshot.

```ts
import { choice, literal, runWithGrammarCoverage } from 'parseman'

const parser = choice(literal('yes'), literal('no'))
const { result, coverage } = runWithGrammarCoverage(parser, 'no')

console.log(result.ok)       // true
console.log(coverage.hits)   // ['choice:entry/arm:1']
console.log(coverage.unhit)  // ['choice:entry/arm:0']
```

Reuse the same collector across several inputs to merge their coverage
together. For a CI threshold, check the boolean hit set against an explicit
list of required IDs.

### Vitest with a macro grammar

Turn on instrumentation only in your test build, then pass `run()` the
collector and, if you want one, a trace sink. A coverage-enabled macro grammar
carries its own list of everything it could hit — every rule, arm, and label.
That list is what keeps the percentage honest: it's measured against
everything the grammar can do, not against whatever a test happened to
touch.

```ts
// vitest.config.ts
import parseman from 'parseman/plugin'

export default {
  plugins: [parseman.vite({ grammarCoverage: true })],
}
```

```ts
import {
  compiledGrammarCoverageDefinitions,
  createGrammarCoverageCollector,
  createGrammarInstrumentationContext,
  run,
} from 'parseman'
import { grammar } from '../src/grammar.js'

const collector = createGrammarCoverageCollector(
  compiledGrammarCoverageDefinitions(grammar),
)

for (const source of fixtures) {
  const result = run(grammar.Stylesheet, source, {
    trivia: grammar.whitespace,
    instrumentation: createGrammarInstrumentationContext({ collector }),
  })
  expect(result.ok && result.unconsumedFrom === null).toBe(true)
}

const coverage = collector.snapshot()
expect(coverage.ratio).toBe(1) // 100% of structural definitions in this corpus
```

`ratio` is `hits.length / definitions.length` — the share of named rules,
choice arms, dispatch arms, and labels that actually succeeded. It isn't V8
line coverage or statement coverage, and hitting 100% doesn't mean you've
tested every invalid input — only every structural branch. Build without
`grammarCoverage: true` and none of this exists: no definition metadata, no
hooks, and production parsing untouched.

## Trace

Trace is the more verbose sibling. It logs every lifecycle event using the
same IDs coverage uses: a rule entering, succeeding, or failing; a choice arm
being attempted, failing, backtracking, or winning; a dispatch arm attempted,
chosen, succeeding, or failing; and each successful label.

```ts
import { createGrammarTraceSink, runWithGrammarCoverage } from 'parseman'

const trace = createGrammarTraceSink({ capacity: 200 })
runWithGrammarCoverage(parser, 'no', { trace })

console.log(trace.snapshot().events)
```

The sink keeps the first `capacity` events, then detaches — also if a stream
callback returns `false` or throws. Its snapshot reports how much got
`truncated` and `dropped`. Either way, detaching a trace never changes the
parse result; it only stops watching.

`dispatch` only traces the route it actually took. An arm the returned string
ruled out never shows an attempt or a backtrack, because it was never parsed.
If the chosen tail then fails, the dispatch arm reports `failure` and that's
final. Branches using `routed()` still report the dispatch's start offset, so
the trace reads as the grammar's path through the input, not as one branch's
internal bookkeeping.

## Macro mode

Static combinators, `ref()` entries, and `rules(...)` maps can emit
instrumentation too, including a terminal `composeLeaf(...)` — which reports
the plan it settled on after composing, not the identities of the pieces that
went into it. Turn this on only in a test or debug build:

```ts
import parseman from 'parseman/plugin'

export default {
  plugins: [parseman.vite({ grammarCoverage: true })],
}
```

With the option off, the macro emits its normal parser source — no collector,
trace sink, or observability code anywhere in it. With it on, the generated
parser reads a coverage/trace context that your test harness supplies. Build
that context with the typed helper below rather than constructing the
internal fields yourself:

```ts
import {
  createGrammarCoverageCollector,
  createGrammarInstrumentationContext,
  createGrammarTraceSink,
  compiledGrammarCoverageDefinitions,
  run,
} from 'parseman'

const collector = createGrammarCoverageCollector(compiledGrammarCoverageDefinitions(grammar))
const trace = createGrammarTraceSink({ capacity: 200 })
const context = createGrammarInstrumentationContext({ collector, trace })

run(grammar.Entry, 'yes', { instrumentation: context })
```

## CI artifacts

The in-memory snapshot is the source of truth. A CI job can serialize it to
stable JSON once tests finish — sorted by grammar ID — and check it against a
list of required IDs plus a minimum ratio per grammar. Keep this separate
from line coverage: grammar coverage tracks branch topology, and V8 line
coverage answers a different question entirely.

For a composed grammar, always pick an explicit start rule. IDs are assigned
from the final composed graph, so a rule you've overridden doesn't keep a
second ID from before the override.
