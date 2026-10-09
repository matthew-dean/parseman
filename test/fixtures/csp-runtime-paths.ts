/**
 * Every runtime path a shipped program can take, run once each. Imported by
 * `test/unit/csp-runtime-paths.test.ts` in-process (with `Function`/`eval` spied)
 * and run as a child process under `--disallow-code-generation-from-strings` (the
 * Content-Security-Policy without `'unsafe-eval'`, as Node spells it).
 *
 * Each path returns what it parsed, so the two runs can be compared and a path
 * that silently parsed nothing cannot pass.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
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

/** What a parse produced. `full` is read WITH `ok`: a failed parse reports no end. */
const parsed = (entry: unknown, input = INPUT): string => {
  const r = run(entry as never, input)
  const end = r.ok ? r.span.end : null
  return JSON.stringify({ ok: r.ok, full: end === input.length, end, value: r.ok ? r.value : null })
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
    return JSON.stringify({ ok: true, full: true, ebnf: toEBNF(base()).length > 0, svg: JSON.stringify(svg).includes('<svg') })
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

/*
 * ── COMPILED GRAMMARS, SHIPPED AS PACKAGES ──────────────────────────────────
 *
 * The shape a dialect package ships: a base grammar package (css) built by the
 * macro, and a downstream package (less) whose own module composes the IMPORTED
 * base and is macro-built too. Loading either module and parsing with it is the
 * whole runtime of a compiled grammar, so it must construct no code. The base
 * carries a direct `node()` builder and grammar trivia; the downstream overrides a
 * rule the base's own rules reach, adds one, and declares its own trivia.
 */
const COMPILED_BASE = `import { rules, regex, literal, node, many, choice, sequence, trivia } from 'parseman' with { type: 'macro' }
const ws = trivia(regex(/[ \\t\\n]*/))
export const css = rules({ trivia: ws }, g => ({
  Doc: node('Doc', many(g.Item), (children, _fields, span) => ({ type: 'Doc', n: children.length, span })),
  Item: choice(g.Pair, g.Word),
  Pair: sequence(g.Word, literal('='), g.Value),
  Value: g.Word,
  Word: regex(/[a-z]+/),
}))`

const COMPILED_DOWNSTREAM = `import { compose, rules, regex, literal, sequence, choice, trivia } from 'parseman' with { type: 'macro' }
import { css } from './css.js'
const ws = trivia(regex(/[ \\t\\n]*/))
export const less = compose([css, rules({ trivia: ws }, g => ({
  Word: regex(/[a-z0-9]+/),
  Value: choice(sequence(literal('@'), g.Word), g.Word),
}))])`

/*
 * The same downstream shape over a BUNDLED upstream: `less-bundle` composes css and is
 * then bundled by esbuild, which inlines css as a top-level `var`, renames the clashing
 * `tableRules` import and reprints the carried-pieces key as
 * `[/* @__PURE__ *\/ Symbol.for("parseman.composedPieces")]`. A dialect composing that
 * bundle must still lower at build time: a runtime compose() cannot link it.
 */
const MID = `import { compose, rules, regex, trivia } from 'parseman' with { type: 'macro' }
import { css } from './css.js'
const ws = trivia(regex(/[ \\t\\n]*/))
export const lessBundle = compose([css, rules({ trivia: ws }, g => ({ Word: regex(/[a-z0-9]+/) }))])`

const OVER_BUNDLE = `import { compose, rules, literal, sequence, choice, trivia, regex } from 'parseman' with { type: 'macro' }
import { lessBundle } from './less-bundle.js'
const ws = trivia(regex(/[ \\t\\n]*/))
export const dialect = compose([lessBundle, rules({ trivia: ws }, g => ({
  Value: choice(sequence(literal('$'), g.Word), g.Word),
}))])`

/** The specifier of the parseman module a `parseman` / `parseman/<sub>` import names,
 * as SOURCE — what the published `dist/<sub>/index.js` is built from. */
function parsemanSource(spec: string): string {
  const sub = spec === 'parseman' ? 'index.ts' : `${spec.slice('parseman/'.length)}/index.ts`
  return pathToFileURL(path.resolve(import.meta.dirname, '../../src', sub)).href
}

/**
 * BUILD TIME: macro-compile both packages into `dir`, as a bundler would emit them.
 * Runs the macro plugin, which may evaluate grammar source (it is exempt: it runs in
 * the bundler), so it is never called under the CSP flag.
 */
export async function buildCompiledPackages(dir: string): Promise<void> {
  const { transformMacro } = await import('../../src/plugin/index.ts')
  const { build } = await import('esbuild')
  const emit = (source: string, name: string): void => {
    const out = transformMacro(source, path.join(dir, `${name}.ts`), new Set(['parseman']))
    if (!out) throw new Error(`the macro did not transform ${name}`)
    if (out.warnings.length > 0) throw new Error(`${name}: ${out.warnings.join('; ')}`)
    if (/\bcompose\s*\(\s*\[/.test(out.code)) throw new Error(`${name}: compose() was left to run at runtime`)
    fs.writeFileSync(path.join(dir, `${name}.js`), out.code)
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  emit(COMPILED_BASE, 'css')
  emit(COMPILED_DOWNSTREAM, 'less')
  emit(MID, 'less-bundle-src')
  await build({
    entryPoints: [path.join(dir, 'less-bundle-src.js')], outfile: path.join(dir, 'less-bundle.js'),
    bundle: true, format: 'esm', external: ['parseman', 'parseman/*'], logLevel: 'silent',
  })
  emit(OVER_BUNDLE, 'dialect')
  // Every module reaches parseman as SOURCE, so the run measures this checkout.
  for (const name of ['css', 'less', 'less-bundle', 'dialect']) {
    const file = path.join(dir, `${name}.js`)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
      .replace(/(["'])(parseman(?:\/[\w-]+)?)\1/g, (_m, q: string, spec: string) => `${q}${parsemanSource(spec)}${q}`))
  }
}

/**
 * RUNTIME: import the built packages (module evaluation is part of loading) and
 * return their parse paths.
 */
export async function loadCompiledPaths(dir: string): Promise<Record<string, () => string>> {
  const { css } = await import(pathToFileURL(path.join(dir, 'css.js')).href) as { css: Record<string, unknown> }
  const { less } = await import(pathToFileURL(path.join(dir, 'less.js')).href) as { less: Record<string, unknown> }
  const { dialect } = await import(pathToFileURL(path.join(dir, 'dialect.js')).href) as { dialect: Record<string, unknown> }
  return {
    'compiled base package': () => parsed(css.Doc, 'a = b c'),
    'compiled downstream package composing the base': () => parsed(less.Doc, 'a = @b9 c1'),
    'compiled package composing an esbuild-bundled compiled package': () => parsed(dialect.Doc, 'a = $b9 c1'),
    // Runtime compose() links live interpreter grammars only. A compiled grammar
    // carries IR source, never live rules, so it is REFUSED rather than evaluated.
    'runtime compose() over a compiled base': () => {
      try {
        compose([css, delta()])
        return 'linked'
      } catch (e) {
        return `refused: ${(e as Error).message.slice(0, 60)}`
      }
    },
  }
}

if (process.argv[2] === '--child') {
  const out: Record<string, string> = {}
  const record = (name: string, path: () => string): void => {
    try { out[name] = path() } catch (e) { out[name] = `THREW ${(e as Error).name}: ${(e as Error).message}` }
  }
  for (const [name, path] of Object.entries({ ...noCodegenPaths, ...compilePaths })) record(name, path)
  try {
    for (const [name, path] of Object.entries(await loadCompiledPaths(process.argv[3]!))) record(name, path)
  } catch (e) {
    out['loading the compiled packages'] = `THREW ${(e as Error).name}: ${(e as Error).message}`
  }
  process.stdout.write(JSON.stringify(out))
}
