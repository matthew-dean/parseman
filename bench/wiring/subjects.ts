/**
 * The sweep's subjects — the SAME combinators and the SAME corpora the broad
 * perf gate uses (`bench/workloads/index.ts`), re-exposed with the parse
 * CONTEXT under the caller's control.
 *
 * `Workload.make` hard-codes `{ trackLines: false }`, and the overgeneration leg
 * has to build the OTHER option variant of the same grammar to have anything to
 * overgenerate. This file exists for that and for nothing else: the combinators
 * and the input strings are imported from the gate's own module, never rebuilt.
 */
import { compile, type Combinator } from '../../src/index.ts'
import { Stylesheet as LessStylesheet } from '../workloads/less.ts'
import { Stylesheet as CssStylesheet } from '../../examples/css/parser.ts'
import { graphqlDoc } from '../../examples/graphql/parser.ts'
import { jsonDoc } from '../../examples/json/parser.ts'
import { buildWorkloads } from '../workloads/index.ts'

export type ParseCfg = { trackLines: boolean; capture: boolean }

export type Subject = {
  id: string
  bytes: number
  input: string
  /** Fresh compile + a parse closure under an explicit option set. */
  make: (cfg: ParseCfg) => { parse: () => unknown }
}

const COMBINATOR: Record<string, Combinator<unknown>> = {
  'less/stylesheet': LessStylesheet as Combinator<unknown>,
  'less/mixins': LessStylesheet as Combinator<unknown>,
  'css/stylesheet': CssStylesheet as Combinator<unknown>,
  'graphql/document': graphqlDoc as Combinator<unknown>,
  'json/document': jsonDoc as Combinator<unknown>,
}

/** The gate's own default per workload — capture on for the CST dialects. */
const CAPTURES = new Set(['less/stylesheet', 'less/mixins', 'css/stylesheet'])

export function subjects(): Subject[] {
  return buildWorkloads().map(w => ({
    id: w.id,
    bytes: w.bytes,
    input: w.input,
    make: (cfg: ParseCfg) => {
      const compiled = compile(COMBINATOR[w.id]!)
      const ctx = cfg.capture
        ? { trackLines: cfg.trackLines, _triviaLog: [] }
        : { trackLines: cfg.trackLines }
      return { parse: () => compiled.parseWithContext(w.input, ctx, 0) }
    },
  }))
}

export const defaultCfg = (id: string): ParseCfg => ({ trackLines: false, capture: CAPTURES.has(id) })
