/**
 * Under a rollup-family bundler, a composable grammar's carried IR is build-only
 * data: it is written beside the chunk as `<chunk>.parseman.json`, and the runtime
 * artifact carries none of it.
 *
 * Nothing at runtime reads carried IR (docs/design/runtime-and-size-contract.md, rules
 * 1 and 2). Inline, it was about a quarter of every composed grammar's artifact, and
 * its `...upstream[Symbol.for('parseman.composedPieces')]` spreads kept every ancestor
 * grammar's module in the import graph of a parse, even in a variant whose own grammar
 * the bundler had shaken out.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rolldown } from 'rolldown'
import parseman, { artifactDigest, transformMacro } from '../../src/plugin/index.ts'
import { run } from '../../src/index.ts'

const UPSTREAM = `import { rules, regex, literal, sequence, choice, many, trivia } from 'parseman' with { type: 'macro' }
const ws = trivia(regex(/[ \\t\\n]*/))
export const base = rules({ trivia: ws }, g => ({
  Doc: many(g.Item),
  Item: choice(g.Pair, g.Word),
  Pair: sequence(g.Word, literal('='), g.Word),
  Word: regex(/[a-z]+/),
}))
`

// Two compositions in one module, as a grammar package declares its variants; each
// entry re-exports one of them.
const DOWNSTREAM = `import { compose, rules, regex, trivia } from 'parseman' with { type: 'macro' }
import { base } from 'up'
const ws = trivia(regex(/[ \\t\\n]*/))
export const digits = compose([base, rules({ trivia: ws }, g => ({ Word: regex(/[a-z0-9]+/) }))])
export const upper = compose([base, rules({ trivia: ws }, g => ({ Word: regex(/[A-Za-z]+/) }))])
`

const OVER = `import { compose, rules, literal, sequence, choice, trivia, regex } from 'parseman' with { type: 'macro' }
import { digits } from 'down'
const ws = trivia(regex(/[ \\t\\n]*/))
export const dialect = compose([digits, rules({ trivia: ws }, g => ({
  Word: choice(sequence(literal('$'), regex(/[a-z0-9]+/)), regex(/[a-z0-9]+/)),
}))])
`

let dir = ''

/** A package in `dir/pkgs`, linked from `dir/node_modules` (the macro skips a module
 * whose path is inside `node_modules`), with its `lib` built by rolldown. */
async function buildPackage(name: string, sources: Record<string, string>, entries: string[]): Promise<void> {
  const root = path.join(dir, 'pkgs', name)
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  fs.symlinkSync(root, path.join(dir, 'node_modules', name), 'dir')
  const exports = Object.fromEntries(entries.map(e => [e === 'index' ? '.' : `./${e}`, `./lib/${e}.js`]))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, type: 'module', exports }))
  for (const [file, text] of Object.entries(sources)) fs.writeFileSync(path.join(root, 'src', file), text)
  // One build per entry, so each artifact holds its own variant and nothing else.
  for (const e of entries) {
    const bundle = await rolldown({
      input: { [e]: path.join(root, 'src', `${e}.ts`) },
      plugins: [parseman.rolldown({})],
      external: id => !id.startsWith('.') && !path.isAbsolute(id),
      logLevel: 'silent',
    })
    await bundle.write({ dir: path.join(root, 'lib'), format: 'esm' })
    await bundle.close()
  }
}

const lib = (pkg: string, file: string): string => path.join(dir, 'pkgs', pkg, 'lib', file)
const read = (pkg: string, file: string): string => fs.readFileSync(lib(pkg, file), 'utf8')

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-sidecar-')))
  await buildPackage('up', { 'grammar.ts': UPSTREAM, 'index.ts': "export { base } from './grammar.ts'\n" }, ['index'])
  await buildPackage('down', {
    'grammar.ts': DOWNSTREAM,
    'index.ts': "export { digits } from './grammar.ts'\n",
    'upper.ts': "export { upper } from './grammar.ts'\n",
  }, ['index', 'upper'])
  await buildPackage('over', { 'index.ts': OVER }, ['index'])
  // An entry that renames the grammar it re-exports, directly and through an
  // imported binding.
  await buildPackage('renamed', {
    'grammar.ts': UPSTREAM,
    'index.ts': "export { base as grammar } from './grammar.ts'\n",
    'via.ts': "import { base as local } from './grammar.ts'\nexport { local as viaImport }\n",
  }, ['index', 'via'])
})
afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

describe('carried pieces under rolldown', () => {
  it('leave the runtime artifact: no IR, no carried-pieces key, no import kept alive for them', () => {
    for (const [pkg, file] of [['up', 'index.js'], ['down', 'index.js'], ['down', 'upper.js'], ['over', 'index.js']] as const) {
      const code = read(pkg, file)
      expect(code, `${pkg}/${file}`).toMatch(/tableRules\(/)
      expect(code, `${pkg}/${file}`).not.toContain('parseman.composedPieces')
      expect(code, `${pkg}/${file}`).not.toMatch(/\bir:/)
    }
    // The upstream grammar was read only to resolve the spread; with no spread, the
    // composed artifact no longer imports it.
    expect(read('down', 'index.js')).not.toMatch(/from\s*["']up["']/)
    expect(read('over', 'index.js')).not.toMatch(/from\s*["']down["']/)
  })

  it('are written beside each chunk, an ancestor in a package as a reference to it', () => {
    const up = JSON.parse(read('up', 'index.js.parseman.json'))
    expect(Object.keys(up.exports)).toEqual(['base'])
    expect(up.exports.base).toHaveLength(1)
    expect(typeof up.exports.base[0].ir).toBe('string')

    const down = JSON.parse(read('down', 'index.js.parseman.json'))
    expect(Object.keys(down.exports)).toEqual(['digits'])
    expect(down.exports.digits[0]).toEqual({ from: 'up', name: 'base' })
    expect(typeof down.exports.digits[1].ir).toBe('string')
    // Each chunk carries only what it exports.
    expect(Object.keys(JSON.parse(read('down', 'upper.js.parseman.json')).exports)).toEqual(['upper'])
  })

  it('are written under the name an entry re-exports a grammar as', () => {
    expect(Object.keys(JSON.parse(read('renamed', 'index.js.parseman.json')).exports)).toEqual(['grammar'])
    expect(Object.keys(JSON.parse(read('renamed', 'via.js.parseman.json')).exports)).toEqual(['viaImport'])
    const downstream = `import { compose, rules, regex, trivia } from 'parseman' with { type: 'macro' }
import { grammar } from 'renamed'
const ws = trivia(regex(/[ \\t\\n]*/))
export const more = compose([grammar, rules({ trivia: ws }, g => ({ Word: regex(/[a-z0-9]+/) }))])
`
    const out = transformMacro(downstream, path.join(dir, 'pkgs', 'over', 'src', 'renamed.ts'), new Set(['parseman']))
    expect(out?.code).toMatch(/tableRules\(/)
  })

  it('are read back from the sidecar by a downstream build, across two package boundaries', async () => {
    // `over` composed `digits`, which composed `up`'s `base`: its build resolved the
    // reference in down's sidecar from down's own location. Run it.
    const file = lib('over', 'index.js')
    const src = path.resolve(import.meta.dirname, '../../src')
    fs.writeFileSync(file, read('over', 'index.js').replace(/(["'])parseman\/table\1/g, `"${pathToFileURL(path.join(src, 'table/index.ts')).href}"`))
    const { dialect } = await import(pathToFileURL(file).href) as { dialect: Record<string, unknown> }
    const r = run(dialect.Doc as never, 'a = $b9 c1')
    expect(r.ok && r.span.end).toBe('a = $b9 c1'.length)
  })

  it('stay inline for a transform with no build-only sink', () => {
    const out = transformMacro(UPSTREAM, path.join(dir, 'inline.ts'), new Set(['parseman']))!
    expect(out.code).toContain('parseman.composedPieces')
  })

  it('treat a sidecar without an exports object as absent, and report the missing pieces', () => {
    const file = lib('up', 'index.js.parseman.json')
    const kept = fs.readFileSync(file, 'utf8')
    try {
      fs.writeFileSync(file, JSON.stringify({ parseman: 'x' }))
      expect(() => transformMacro(DOWNSTREAM, path.join(dir, 'pkgs', 'down', 'src', 'shape.ts'), new Set(['parseman'])))
        .toThrow(/is a compiled grammar with no carried pieces/)
    } finally {
      fs.writeFileSync(file, kept)
    }
  })

  it('fail the downstream build, naming the file, when an artifact has neither form', () => {
    fs.rmSync(lib('up', 'index.js.parseman.json'))
    expect(() => transformMacro(DOWNSTREAM, path.join(dir, 'pkgs', 'down', 'src', 'again.ts'), new Set(['parseman'])))
      .toThrow(/is a compiled grammar with no carried pieces — no inline literal, and no entry in index\.js\.parseman\.json/)
  })
})

/** One rolldown build of several entries of `root/src`, as a package with subpath
 * entries builds them; `plugin` is reused across builds as a watcher keeps it. */
async function buildEntries(
  root: string, entries: Record<string, string>, out: string, plugin = parseman.rolldown({}),
  opts: { external?: (id: string) => boolean; sourcemap?: boolean } = {},
): Promise<void> {
  const bundle = await rolldown({
    input: Object.fromEntries(Object.entries(entries).map(([e, file]) => [e, path.join(root, 'src', file)])),
    plugins: [plugin],
    external: opts.external ?? (id => !id.startsWith('.') && !path.isAbsolute(id)),
    logLevel: 'silent',
  })
  await bundle.write({ dir: path.join(root, out), format: 'esm', ...(opts.sourcemap === true ? { sourcemap: true } : {}) })
  await bundle.close()
}

function sources(name: string, files: Record<string, string>): string {
  const root = path.join(dir, 'pkgs', name)
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'src', file), text)
  return root
}

// The same grammar shape over digits, already compiled with its pieces inline: a
// dependency vendored as built JavaScript, which the macro never lowers again.
const vendored = (): string => transformMacro(UPSTREAM.replace('/[a-z]+/', '/[0-9]+/'), path.join(dir, 'vendor-src.ts'), new Set(['parseman']))!.code
const exportsOf = (root: string, file: string): Record<string, unknown[]> | null => {
  const at = path.join(root, file + '.parseman.json')
  return fs.existsSync(at) ? (JSON.parse(fs.readFileSync(at, 'utf8')) as { exports: Record<string, unknown[]> }).exports : null
}

describe('carried pieces of a multi-entry build', () => {
  it('are not borrowed from another module that records the same name', async () => {
    // `a` re-exports the vendored `base`, which recorded nothing; `b` declares its
    // own `base`. `a`'s artifact keeps its inline pieces and must get no sidecar:
    // b's pieces would make a downstream compose of `a` parse letters.
    const root = sources('mixed', {
      'vendor.js': vendored(),
      'a.ts': "export { base } from './vendor.js'\n",
      'b.ts': UPSTREAM,
    })
    await buildEntries(root, { a: 'a.ts', b: 'b.ts' }, 'lib')
    expect(exportsOf(root, 'lib/a.js')).toBeNull()
    expect(Object.keys(exportsOf(root, 'lib/b.js') ?? {})).toEqual(['base'])
  })

  it('are followed through export * to a shared chunk', async () => {
    // Two modules export a grammar named `base`. `css` and `index` re-export the
    // first with `export *`, so it lands in a chunk both facades import from; the
    // second is re-exported the same way by `less`. Each facade's sidecar must
    // carry its own module's pieces.
    const root = sources('star', {
      'css.ts': UPSTREAM,
      'less.ts': UPSTREAM.replace('/[a-z]+/', '/[0-9]+/'),
      'index.ts': "export * from './css.ts'\n",
      'css-entry.ts': "export * from './css.ts'\n",
      'less-entry.ts': "export * from './less.ts'\n",
    })
    await buildEntries(root, { index: 'index.ts', css: 'css-entry.ts', less: 'less-entry.ts' }, 'lib')
    const word = (file: string): string | undefined =>
      (exportsOf(root, file)?.base?.[0] as { ir?: string } | undefined)?.ir?.match(/\[(?:a-z|0-9)\]\+/)?.[0]
    expect(word('lib/css.js')).toBe('[a-z]+')
    expect(word('lib/index.js')).toBe('[a-z]+')
    expect(word('lib/less.js')).toBe('[0-9]+')
  })

  it('are followed through two export * paths to the same declaration', async () => {
    // `index` reaches `core`'s `base` through both `a` and `b`. ESM exports it: the
    // two paths name one binding, so it is not ambiguous.
    const root = sources('diamond', {
      'core.ts': UPSTREAM,
      'a.ts': "export * from './core.ts'\n",
      'b.ts': "export * from './core.ts'\n",
      'index.ts': "export * from './a.ts'\nexport * from './b.ts'\n",
    })
    await buildEntries(root, { index: 'index.ts' }, 'lib')
    expect(exportsOf(root, 'lib/index.js')?.base).toHaveLength(1)
  })

  it('drop what a module recorded on an earlier build of the same session', async () => {
    const root = sources('watch', { 'vendor.js': vendored(), 'old.ts': UPSTREAM, 'index.ts': "export { base } from './old.ts'\n" })
    const plugin = parseman.rolldown({})
    await buildEntries(root, { index: 'index.ts' }, 'v1', plugin)
    expect(exportsOf(root, 'v1/index.js')?.base).toHaveLength(1)
    // The edit takes `old.ts` out of the graph; its pieces must not follow the name.
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), "export { base } from './vendor.js'\n")
    await buildEntries(root, { index: 'index.ts' }, 'v2', plugin)
    expect(exportsOf(root, 'v2/index.js')).toBeNull()
    // A module that stays in the graph but no longer declares a grammar loses its record too.
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), "export { base } from './old.ts'\n")
    await buildEntries(root, { index: 'index.ts' }, 'v3', plugin)
    expect(exportsOf(root, 'v3/index.js')?.base).toHaveLength(1)
    fs.writeFileSync(path.join(root, 'src', 'old.ts'), 'export const base = 1\n')
    await buildEntries(root, { index: 'index.ts' }, 'v4', plugin)
    expect(exportsOf(root, 'v4/index.js')).toBeNull()
  })

  it('fail the downstream build, not fall back to runtime, for a facade whose pieces cannot be found', async () => {
    // `css.js` is a facade over the shared chunk `css.ts` landed in. Without its
    // sidecar, the shared chunk has none either: a runtime compose() of a compiled
    // grammar would throw at import, so the build must fail instead.
    const root = path.join(dir, 'pkgs', 'star')
    const consumer = path.join(root, 'src', 'consumer.ts')
    const downstream = `import { compose, rules, regex, trivia } from 'parseman' with { type: 'macro' }
import { base } from '../lib/css.js'
const ws = trivia(regex(/[ \\t\\n]*/))
export const more = compose([base, rules({ trivia: ws }, g => ({ Word: regex(/[a-z0-9]+/) }))])
`
    expect(transformMacro(downstream, consumer, new Set(['parseman']))?.code).toMatch(/tableRules\(/)
    const sidecar = path.join(root, 'lib', 'css.js.parseman.json')
    const kept = fs.readFileSync(sidecar, 'utf8')
    try {
      fs.rmSync(sidecar)
      expect(() => transformMacro(downstream, consumer.replace('consumer', 'consumer2'), new Set(['parseman'])))
        .toThrow(/is a build-compiled grammar whose carried pieces could not be resolved/)
    } finally {
      fs.writeFileSync(sidecar, kept)
    }
  })

  it('record the artifact they were written for, and a downstream build refuses a stale one', async () => {
    const root = sources('stale', { 'index.ts': UPSTREAM })
    await buildEntries(root, { index: 'index.ts' }, 'lib', undefined, { sourcemap: true })
    const artifact = path.join(root, 'lib', 'index.js')
    expect(fs.readFileSync(artifact, 'utf8')).toMatch(/sourceMappingURL=/)
    const recorded = (JSON.parse(fs.readFileSync(artifact + '.parseman.json', 'utf8')) as { artifact?: string }).artifact
    expect(recorded).toMatch(/^[0-9a-f]{32}$/)
    const consumer = path.join(root, 'src', 'consumer.ts')
    const downstream = `import { compose, rules, regex, trivia } from 'parseman' with { type: 'macro' }
import { base } from '../lib/index.js'
const ws = trivia(regex(/[ \\t\\n]*/))
export const more = compose([base, rules({ trivia: ws }, g => ({ Word: regex(/[a-z0-9]+/) }))])
`
    // The sidecar matches its artifact, sourcemap comment and all.
    expect(transformMacro(downstream, consumer, new Set(['parseman']))?.code).toMatch(/tableRules\(/)
    // Another build's artifact beside this sidecar: the build fails rather than
    // composing pieces the artifact was not built from.
    fs.appendFileSync(artifact, '\nexport const rebuilt = 1\n')
    expect(() => transformMacro(downstream, consumer.replace('consumer', 'consumer2'), new Set(['parseman'])))
      .toThrow(/was written for a different build of index\.js/)
  })

  it('write a bundled ancestor out, and keep an external one a reference', async () => {
    // Its own upstream package: an earlier test removes `up`'s sidecar.
    const upstream = sources('up3', { 'index.ts': UPSTREAM })
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ name: 'up3', type: 'module', exports: { '.': './lib/index.js' } }))
    fs.symlinkSync(upstream, path.join(dir, 'node_modules', 'up3'), 'dir')
    await buildEntries(upstream, { index: 'index.ts' }, 'lib')
    const root = sources('bundled', { 'grammar.ts': DOWNSTREAM.replace("from 'up'", "from 'up3'"), 'index.ts': "export { digits } from './grammar.ts'\n" })
    await buildEntries(root, { index: 'index.ts' }, 'external')
    await buildEntries(root, { index: 'index.ts' }, 'inlined', undefined, { external: id => id.startsWith('parseman') })
    expect(exportsOf(root, 'external/index.js')?.digits?.[0]).toEqual({ from: 'up3', name: 'base' })
    expect(fs.readFileSync(path.join(root, 'inlined', 'index.js'), 'utf8')).not.toMatch(/from\s*["']up3["']/)
    const inlined = exportsOf(root, 'inlined/index.js')?.digits as Array<{ ir?: string; from?: string }>
    expect(inlined).toHaveLength(2)
    expect(inlined.every(item => typeof item.ir === 'string' && item.from === undefined)).toBe(true)
  })

  it('record the digest of the code Vite writes, after its own generateBundle rewrites', async () => {
    // Vite rewrites a dynamic import() through its preload helper in generateBundle.
    // The digest must be taken after that, or every such artifact reads as stale.
    const root = sources('vite', { 'index.ts': UPSTREAM + "export const later = () => import('./other.ts')\n", 'other.ts': 'export const x = 1\n' })
    const { build } = await import('vite')
    await build({
      root, configFile: false, logLevel: 'silent', plugins: [parseman.vite({})],
      build: {
        outDir: path.join(root, 'lib'), emptyOutDir: true, minify: false,
        rollupOptions: {
          input: path.join(root, 'src', 'index.ts'), preserveEntrySignatures: 'strict',
          output: { entryFileNames: 'index.js' }, external: id => id.startsWith('parseman'),
        },
      },
    })
    const artifact = path.join(root, 'lib', 'index.js')
    expect(fs.readFileSync(artifact, 'utf8')).toMatch(/__vitePreload/)
    const recorded = (JSON.parse(fs.readFileSync(artifact + '.parseman.json', 'utf8')) as { artifact?: string }).artifact
    expect(recorded).toBe(artifactDigest(fs.readFileSync(artifact, 'utf8')))
  })
})
