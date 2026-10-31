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
import parseman, { transformMacro } from '../../src/plugin/index.ts'
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
