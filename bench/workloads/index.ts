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
import { Stylesheet as LessStylesheet } from './less.ts'
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

export type Workload = {
  id: string
  /** Bytes of input, reported so a reader can see the sample behind every number. */
  bytes: number
  /** Built fresh per side: compiling is part of neither side's measurement. */
  make: () => { parse: () => unknown }
  input: string
}

const withCapture = (c: Combinator<unknown>, input: string): (() => { parse: () => unknown }) => () => {
  const compiled = compile(c)
  return { parse: () => compiled.parseWithContext(input, { trackLines: false, _triviaLog: [] }, 0) }
}

const withoutCapture = (c: Combinator<unknown>, input: string): (() => { parse: () => unknown }) => () => {
  const compiled = compile(c)
  return { parse: () => compiled.parseWithContext(input, { trackLines: false }, 0) }
}

export function buildWorkloads(): Workload[] {
  const lessCorpus = readFixture('app.less')
  const cssCorpus = readFixture('site.css')

  const lessInput = scaleStyles(lessCorpus, 48)
  const mixinInput = scaleStyles(mixinWeighted(lessCorpus), 48)
  const cssInput = scaleStyles(cssCorpus, 48)
  const gqlInput = graphqlInput(48)
  const jsonInput = jsonPayload(48)

  return [
    { id: 'less/stylesheet', bytes: lessInput.length, make: withCapture(LessStylesheet, lessInput), input: lessInput },
    { id: 'less/mixins', bytes: mixinInput.length, make: withCapture(LessStylesheet, mixinInput), input: mixinInput },
    { id: 'css/stylesheet', bytes: cssInput.length, make: withCapture(CssStylesheet, cssInput), input: cssInput },
    { id: 'graphql/document', bytes: gqlInput.length, make: withoutCapture(graphqlDoc, gqlInput), input: gqlInput },
    { id: 'json/document', bytes: jsonInput.length, make: withoutCapture(jsonDoc, jsonInput), input: jsonInput },
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
