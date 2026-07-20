# Grammar observability

Parséman has two opt-in grammar-observability modes. They share stable grammar
IDs from the selected start-rule closure, including the final winner after
composition.

- Coverage answers “which rules, choice arms, and labels succeeded?”
- Trace answers “what did this parse try, select, fail, and backtrack through?”

Neither mode changes ordinary interpreter parsing or ordinary macro output.

## Coverage

Use coverage when a test should prove that a grammar exercised a particular
semantic branch. A run returns the normal `RunResult` plus an immutable coverage
snapshot.

```ts
import { choice, literal, runWithGrammarCoverage } from 'parseman'

const parser = choice(literal('yes'), literal('no'))
const { result, coverage } = runWithGrammarCoverage(parser, 'no')

console.log(result.ok)       // true
console.log(coverage.hits)   // ['choice:entry/arm:1']
console.log(coverage.unhit)  // ['choice:entry/arm:0']
```

Pass one collector explicitly to merge several inputs. CI thresholds should use
the boolean hit set and an explicit required-ID list.

## Trace

Trace is intentionally more verbose. It records lifecycle events with the same
IDs: rule entry/success/failure, choice-arm attempt/failure/backtrack/selection,
and successful labels.

```ts
import { createGrammarTraceSink, runWithGrammarCoverage } from 'parseman'

const trace = createGrammarTraceSink({ capacity: 200 })
runWithGrammarCoverage(parser, 'no', { trace })

console.log(trace.snapshot().events)
```

The sink retains the first `capacity` events. It detaches when full, when a
stream callback returns `false`, or when that callback throws. Its snapshot
reports `truncated` and `dropped`; detachment never changes parse results.

## Macro mode

Static combinators, `ref()` entries, and `rules(...)` maps can also emit
instrumentation. This includes a terminal `composeLeaf(...)`, which uses its
post-compose winner plan rather than imported-piece identities.
Enable it only in a test/debug build:

```ts
import parseman from 'parseman/plugin'

export default {
  plugins: [parseman({ grammarCoverage: true })],
}
```

With this option off, the macro emits its normal parser source: no collector,
trace sink, helper, or observability identifier is present. With it on, the
generated parser reads the dedicated coverage/trace context supplied by its test
harness. Use the typed helper rather than constructing internal context fields:

```ts
import {
  createGrammarCoverageCollector,
  createGrammarInstrumentationContext,
  createGrammarTraceSink,
  grammarCoverageDefinitions,
} from 'parseman'

const collector = createGrammarCoverageCollector(grammarCoverageDefinitions(parser))
const trace = createGrammarTraceSink({ capacity: 200 })
const context = createGrammarInstrumentationContext({ collector, trace })

compiledParser('yes', 0, context)
```

## CI artifacts

The canonical result is the in-memory snapshot. A CI job may serialize that
snapshot as stable JSON after its tests finish, sorted by grammar ID, and compare
required IDs plus a per-grammar minimum ratio. Keep this separate from line
coverage: grammar coverage changes when branch topology changes, while V8 line
coverage answers a different question.

For composed grammars always select an explicit start rule. IDs come from the
final composed winner graph; an overridden rule does not retain a second ID.
