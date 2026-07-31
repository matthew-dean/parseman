/**
 * The workload set the broad gate measures.
 *
 * ## The rule this file exists to enforce
 *
 * ONE ENTRY PER WORKLOAD, NEVER AGGREGATED. Replaying 0.34.0, the css workload
 * moves −1.6% and the less workload moves +25.5% in the same run. A mean of
 * those two is +12% at best and a shrug at worst, and the release that shipped
 * the regression is exactly the release that read "mild" in aggregate. The gate
 * reports and thresholds each row on its own.
 *
 * ## Why these workloads
 *
 * They are chosen to SPAN, not to sample:
 *
 * - `less/stylesheet` — high speculative rollback, wide derived expected sets,
 *   full CST with trivia capture. The dialect that caught all three regressions.
 * - `less/mixins` — the same grammar over input weighted towards the constructs
 *   that backtrack hardest (mixin calls, guards, arithmetic). Same grammar,
 *   different input: separates "the grammar got slower" from "this shape of
 *   source got slower".
 * - `css/stylesheet` — the same problem domain at LOW rollback density. It is
 *   here to be the control. When less/* moves and css/* does not, the cost is
 *   per-speculation; when both move, it is not.
 * - `graphql/document`, `json/document` — non-CSS, and non-CST: they build plain
 *   values through `transform` rather than `node`, so they exercise codegen paths
 *   with capture switched off entirely. A regression that only shows up when
 *   capture is live should NOT move these, and that difference is information.
 *
 * ## Sizes
 *
 * Each corpus is repeated with a per-copy identifier prefix until it passes its
 * target size. Repetition supplies bytes; the corpus supplies the construct mix,
 * and the mix is what the measurement depends on. The prefix keeps the text from
 * being byte-identical copy to copy, so a parser cannot benefit from something a
 * real file would not give it — but it is repetition, and that is a documented
 * limitation, not a hidden one: see `docs/design/perf-gates.md`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile, type Combinator } from '../../src/index.ts'
import { Stylesheet as LessStylesheet, makeLessRules, type NodeFactory } from './less.ts'
import { astNodeFactory } from './ast.ts'
import { Stylesheet as CssStylesheet } from '../../examples/css/parser.ts'
import { graphqlDoc } from '../../examples/graphql/parser.ts'
import { jsonDoc } from '../../examples/json/parser.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

const readFixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')

/**
 * Repeat `corpus` until the result passes `targetKB`, renaming every
 * class / id / variable / mixin name per copy.
 *
 * The rename only touches names introduced by a `.`, `#` or `@` sigil, so it
 * cannot rewrite a property name, a keyword or a unit into something the grammar
 * would reject — and the gate asserts every workload parses to EOF, so a rename
 * that broke the input would fail loudly rather than quietly measure an error
 * path.
 */
function scaleStyles(corpus: string, targetKB: number): string {
  const target = targetKB * 1024
  const parts: string[] = []
  let size = 0
  for (let n = 0; size < target; n++) {
    const copy = n === 0
      ? corpus
      : corpus.replace(/([.#@])([a-zA-Z][-a-zA-Z0-9]*)/g, (_m, lead: string, name: string) => `${lead}s${n}x${name}`)
    parts.push(copy)
    size += copy.length + 1
  }
  return parts.join('\n')
}

/**
 * The mixin-weighted variant: the same corpus with its declaration runs thinned
 * and its mixin calls, guards and arithmetic kept. Derived rather than authored
 * separately so the two less/* rows cannot drift apart in construct vocabulary —
 * only in proportion, which is the variable under test.
 */
function mixinWeighted(corpus: string): string {
  const lines = corpus.split('\n')
  const kept: string[] = []
  let plain = 0
  for (const line of lines) {
    const isPlainDecl = /^\s{2,}[-a-zA-Z]+\s*:\s*[^@(]*;\s*$/.test(line)
    if (isPlainDecl) {
      plain++
      if (plain % 3 !== 0) continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * WHICH CONSUMER a row measures. Never optional and never inferred: a speed number
 * from this file that does not say `ast` or `cst` is a bug in the harness, because
 * the two paths do measurably different amounts of work on identical input and a
 * lane has already been misled by exactly that ambiguity.
 *
 * - `ast` — what a COMPILER takes. Arity-1 reducers, no trivia log, structural
 *   delimiters discarded. parseman's canonical measure.
 * - `cst` — what an EDITOR takes. Arity-5 reducers, `_triviaLog` live, every leaf
 *   retained. A nice-to-have where latency hides behind a human.
 * - `value` — neither: `transform`-built plain values with no node machinery at
 *   all. json/graphql are here, and they are the control that says whether a
 *   change touches capture or the runtime underneath it.
 */
export type WorkloadPath = 'ast' | 'cst' | 'value'

export type Workload = {
  id: string
  /** Which consumer's path this row measures. Printed with every number. */
  path: WorkloadPath
  /** Bytes of input, reported so a reader can see the sample behind every number. */
  bytes: number
  /** Built fresh per side: compiling is part of neither side's measurement. */
  make: () => { parse: () => unknown }
  input: string
}

/**
 * The CST consumer: trivia log installed, five-argument reducers upstream.
 * Unchanged from what this file has always measured.
 */
const withCapture = (c: Combinator<unknown>, input: string): (() => { parse: () => unknown }) => () => {
  const compiled = compile(c)
  return { parse: () => compiled.parseWithContext(input, { trackLines: false, _triviaLog: [] }, 0) }
}

/**
 * The AST consumer: no trivia log. Paired with an arity-1 reducer upstream, this
 * is what makes codegen elide the rawChildren/trivia/state tiers.
 */
const withoutCapture = (c: Combinator<unknown>, input: string): (() => { parse: () => unknown }) => () => {
  const compiled = compile(c)
  return { parse: () => compiled.parseWithContext(input, { trackLines: false }, 0) }
}

/**
 * The Less grammar instantiated on a given node factory.
 *
 * ONE grammar, two reducers — see the note on `NodeFactory` in `less.ts`. A second
 * copy of the grammar would drift, and then the AST-vs-CST comparison would
 * silently become a grammar-vs-grammar comparison.
 */
export const lessEntry = (factory: NodeFactory): Combinator<unknown> => {
  const { Stylesheet } = makeLessRules(factory)
  return Stylesheet
}

export function buildWorkloads(): Workload[] {
  const lessCorpus = readFixture('app.less')
  const cssCorpus = readFixture('site.css')

  const lessInput = scaleStyles(lessCorpus, 48)
  const mixinInput = scaleStyles(mixinWeighted(lessCorpus), 48)
  const cssInput = scaleStyles(cssCorpus, 48)
  const gqlInput = graphqlInput(48)
  const jsonInput = jsonPayload(48)

  // Built once per call so the AST and CST rows for a workload are the SAME
  // grammar text on the SAME input, differing only in the reducer.
  const lessAst = lessEntry(astNodeFactory)

  // The path is part of the ID, not a column a formatter may drop. Every
  // consumer of this list — the broad gate, the AST gate, any future one — keys
  // and prints by id, so making the id carry the path is the only way to
  // GUARANTEE a number can never be quoted without saying which consumer it
  // describes. `--only=ast` and `--only=cst` become path filters for free.
  const row = (
    name: string, path: WorkloadPath, input: string, make: () => { parse: () => unknown },
  ): Workload => ({ id: `${name} [${path}]`, path, bytes: input.length, make, input })

  return [
    // The AST path FIRST, because it is the canonical one and a reader stops at
    // the top of a table.
    row('less/stylesheet', 'ast', lessInput, withoutCapture(lessAst, lessInput)),
    row('less/mixins', 'ast', mixinInput, withoutCapture(lessAst, mixinInput)),

    row('less/stylesheet', 'cst', lessInput, withCapture(LessStylesheet, lessInput)),
    row('less/mixins', 'cst', mixinInput, withCapture(LessStylesheet, mixinInput)),
    row('css/stylesheet', 'cst', cssInput, withCapture(CssStylesheet, cssInput)),

    row('graphql/document', 'value', gqlInput, withoutCapture(graphqlDoc, gqlInput)),
    row('json/document', 'value', jsonInput, withoutCapture(jsonDoc, jsonInput)),
  ]
}

function graphqlInput(targetKB: number): string {
  const parts: string[] = []
  let size = 0
  for (let n = 0; size < targetKB * 1024; n++) {
    const q = `
query Dashboard${n}($id: ID!, $first: Int = 20, $withDetail: Boolean!) {
  viewer {
    id
    displayName
    avatar(size: ${32 + (n % 4) * 16}) { url width height }
  }
  organisation(id: $id) {
    name
    slug
    members(first: $first, after: "cursor-${n}") {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges {
        cursor
        node {
          id
          email
          role
          profile @include(if: $withDetail) {
            ...ProfileFields
            timezone
            locale
          }
        }
      }
    }
    repositories(orderBy: { field: PUSHED_AT, direction: DESC }) {
      nodes {
        name
        isPrivate
        primaryLanguage { name color }
        ... on Repository {
          diskUsage
          collaborators { totalCount }
        }
      }
    }
  }
}

fragment ProfileFields on Profile {
  bio
  company
  websiteUrl
  pronouns
}
`.trim()
    parts.push(q)
    size += q.length + 2
  }
  return parts.join('\n\n')
}

function jsonPayload(targetKB: number): string {
  const records: unknown[] = []
  let n = 0
  let text = ''
  while (text.length < targetKB * 1024) {
    for (let k = 0; k < 50; k++, n++) {
      records.push({
        id: n,
        sku: `SKU-${String(n).padStart(8, '0')}`,
        title: `Product number ${n} with a reasonably long descriptive title`,
        price: Number(((n % 997) * 1.37).toFixed(2)),
        inStock: n % 3 !== 0,
        tags: ['alpha', 'beta', `tag-${n % 23}`],
        dimensions: { w: n % 40, h: (n % 17) + 1, d: 2.5 },
        supplier: { id: n % 97, name: `Supplier ${n % 97}`, rating: (n % 50) / 10, verified: n % 5 === 0 },
        history: [
          { at: `2024-0${(n % 9) + 1}-15T10:30:00Z`, event: 'created', by: null },
          { at: `2024-0${(n % 9) + 1}-16T11:45:12Z`, event: 'priced', by: `user-${n % 31}` },
        ],
      })
    }
    text = JSON.stringify({ page: 1, total: records.length, records })
  }
  return text
}
