/**
 * Every runtime path a shipped program can take, run once each. Imported by
 * `test/unit/csp-runtime-paths.test.ts` in-process (with `Function`/`eval` spied)
 * and run as a child process under `--disallow-code-generation-from-strings` (the
 * Content-Security-Policy without `'unsafe-eval'`, as Node spells it).
 *
 * Each path returns what it parsed, so the two runs can be compared and a path
 * that silently parsed nothing cannot pass.
 */
import {
  choice, compile, compose, composeLeaf, literal, many, node, regex, rules, run, sequence, trivia,
} from '../../src/index.ts'
import { linkable } from '../../src/compiler/linker.ts'
import { toEBNF, toRailroadSvg } from '../../src/spec/index.ts'

const ws = trivia(regex(/[ \t\n]*/))
const INPUT = 'a = b c'

const base = () => rules({ trivia: ws }, (g: any) => ({
  Doc: node('Doc', many(g.Item), c => ({ type: 'Doc', items: c.map(x => (x as { value?: unknown }).value ?? x) })),
  Item: choice(g.Pair, g.Word),
  Pair: sequence(g.Word, literal('='), g.Word),
  Word: regex(/[a-z]+/),
}))
// The delta widens a leaf the base's own rules reach (open recursion).
const delta = () => rules((_g: any) => ({ Word: regex(/[a-z0-9]+/) }))

const parsed = (entry: unknown, input = INPUT): string => {
  const r = run(entry as never, input)
  return JSON.stringify({ ok: r.ok, end: r.ok ? r.span.end : null, value: r.ok ? r.value : null })
}

/** Paths that must NEVER construct code. */
export const noCodegenPaths: Record<string, () => string> = {
  'interpreter rules()': () => parsed(base().Doc),
  'runtime compose()': () => parsed(compose([base(), delta()]).Doc, 'a = b9 c'),
  'runtime compose() of a composition': () => parsed(compose([compose([base()]), delta()]).Doc, 'a = b9 c'),
  'runtime composeLeaf()': () => parsed(composeLeaf([base(), delta()]).Doc, 'a = b9 c'),
  'runtime linkable()': () => parsed((linkable(base()).rules as Record<string, unknown>).Doc),
  'spec: EBNF and railroad SVG': () => {
    const svg = toRailroadSvg(base())
    return JSON.stringify({ ebnf: toEBNF(base()).length > 0, svg: JSON.stringify(svg).includes('<svg') })
  },
}

/** `compile()` — the one path that may specialise, and must fall back under CSP. */
export const compilePaths: Record<string, () => string> = {
  'compile(combinator)': () => {
    const r = compile(sequence(literal('a'), literal('b'))).parse('ab')
    return JSON.stringify({ ok: r.ok, end: r.ok ? r.span.end : null })
  },
  'compile(compose())': () => parsed(compile(compose([base(), delta()]) as Record<string, unknown>).Doc, 'a = b9 c'),
}

if (process.argv[2] === '--child') {
  const out: Record<string, string> = {}
  for (const [name, path] of Object.entries({ ...noCodegenPaths, ...compilePaths })) {
    try { out[name] = path() } catch (e) { out[name] = `THREW ${(e as Error).name}: ${(e as Error).message}` }
  }
  process.stdout.write(JSON.stringify(out))
}
