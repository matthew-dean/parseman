/**
 * jess's four real grammars, built from the vendored snapshot in
 * `fixtures/jess-grammars/` (see `scripts/vendor-jess-grammars.mjs`) the way jess's
 * own build does — shared by the size gate and the load gate.
 *
 * `withBuiltSnapshot` copies the snapshot to a scratch directory, macro-lowers it in
 * dependency order (parser-shared, css, then the three dialects, which compose over
 * css's BUILT base module), and hands the callback three kinds of bundle:
 *
 *   - `shipped`     one variant as jess ships it: its package inline and tree-shaken,
 *                   every other package external — what the size gate measures;
 *   - `runnable`    the same variant with the table runtime inlined, so it loads;
 *   - `interpreter` the grammar's SOURCE, un-lowered (the macro import attribute
 *                   stripped), as jess's interpreter twins are built.
 *
 * `@jesscss/core` is not vendored: reducers use it at run time only. In a runnable or
 * interpreter bundle it is a stub whose members build plain objects, so an AST
 * parse — which runs reducers — is not meaningful there; a CST parse through a CST
 * host builds nodes through the host and is.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { build, type Plugin } from 'esbuild'
import { transformMacro } from '../../src/plugin/index.ts'

export const FIXTURE = resolve(import.meta.dirname, '../../fixtures/jess-grammars')

export type Dialect = 'css' | 'less' | 'scss' | 'jess'
export const DIALECTS: readonly Dialect[] = ['css', 'less', 'scss', 'jess']
/** Variant name -> export suffix, as jess's `grammar-variants.mts` ships them. */
export const VARIANTS: Readonly<Record<string, string>> = {
  'ast': 'Grammar',
  'ast/positions': 'PositionsGrammar',
  'cst': 'CstGrammar',
  'cst/positions': 'CstPositionsGrammar',
}

const SRC = resolve(import.meta.dirname, '../../src')
const CORE_STUB = 'const __core = new Proxy(function () {}, { get: (t, k) => k === "then" ? undefined : __core, apply: (t, self, args) => ({ args }), construct: (t, args) => ({ args }) });\n'

/** `import { a as b } from "@jesscss/core…"` → reads off the stub. */
function stubCore(code: string): string {
  return CORE_STUB + code.replace(/import \{([^}]*)\} from "(@jesscss\/core[^"]*)";?/g, (_w, names: string) =>
    `const {${names.replace(/\bas\b/g, ':')}} = __core;`)
}

export type Snapshot = {
  readonly root: string
  readonly warnings: readonly string[]
  shipped(dialect: Dialect, variant: string): Promise<{ file: string; bytes: number }>
  /** An ES module exporting `grammar`, `run`, `compile` and `cstBuildHost`. */
  runnable(dialect: Dialect, variant: string): Promise<string>
  /** Same exports, from the grammar's un-lowered source. */
  interpreter(dialect: Dialect, variant: string): Promise<string>
}

export async function withBuiltSnapshot<T>(fn: (snap: Snapshot) => Promise<T>, fixture = FIXTURE): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'parseman-jess-grammars-')))
  const warnings: string[] = []
  try {
    cpSync(fixture, root, { recursive: true })
    const lower = (rel: string): void => {
      const id = join(root, rel)
      const out = transformMacro(readFileSync(id, 'utf8'), id, new Set(['parseman']))
      if (out === null) throw new Error(`${rel}: the macro did not lower this module`)
      warnings.push(...out.warnings)
      writeFileSync(id.replace(/\.ts$/, '.js'), out.code)
    }
    const exportOf = (dialect: Dialect, variant: string): string => {
      const suffix = VARIANTS[variant]
      if (suffix === undefined) throw new Error(`unknown variant ${variant}`)
      return `${dialect}${suffix}`
    }
    const write = (file: string, code: string): string => {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, code)
      return file
    }

    const shippedBundle = async (pkg: string, exportName: string, outFile: string): Promise<string> => {
      const pkgDir = join(root, pkg)
      const external: Plugin = {
        name: 'other-packages-external',
        setup(b) {
          b.onResolve({ filter: /.*/ }, args => {
            if (!args.path.startsWith('.') && !args.path.startsWith('/')) return { external: true }
            const abs = resolve(args.resolveDir, args.path)
            if (abs.startsWith(`${pkgDir}/`)) return undefined
            const rel = relative(dirname(outFile), abs)
            return { path: rel.startsWith('.') ? rel : `./${rel}`, external: true }
          })
        },
      }
      const res = await build({
        stdin: { contents: `export { ${exportName} } from ${JSON.stringify(join(pkgDir, 'grammar.js'))}`, loader: 'js', resolveDir: pkgDir },
        bundle: true, format: 'esm', write: false, treeShaking: true, platform: 'neutral',
        loader: { '.js': 'ts' }, plugins: [external],
      })
      return res.outputFiles[0]!.text
    }

    /** A loadable module around one grammar export: runtime, run and compile inlined. */
    const loadable = async (entryFile: string, exportName: string, outFile: string, extra: Plugin[]): Promise<string> => {
      const res = await build({
        stdin: {
          contents: [
            `export { ${exportName} as grammar } from ${JSON.stringify(entryFile)}`,
            `export { run, compile, compose } from ${JSON.stringify(join(SRC, 'index.ts'))}`,
            `export { cstBuildHost } from ${JSON.stringify(join(SRC, 'compiler/linker.ts'))}`,
          ].join('\n'),
          loader: 'js', resolveDir: root,
        },
        bundle: true, format: 'esm', write: false, platform: 'node', loader: { '.js': 'ts' },
        external: ['oxc-parser', 'oxc-resolver', 'magic-string', 'unplugin', 'linecraft'],
        plugins: [{
          name: 'runnable',
          setup(b) {
            b.onResolve({ filter: /^parseman(\/table)?$/ }, args => ({ path: join(SRC, args.path === 'parseman' ? 'index.ts' : 'table/index.ts') }))
            b.onResolve({ filter: /^@jesscss\/core(\/.*)?$/ }, () => ({ external: true }))
          },
        }, ...extra],
      })
      return write(outFile, stubCore(res.outputFiles[0]!.text))
    }

    for (const m of ['recognition', 'pseudo-consts', 'unknown-at-rule']) lower(`parser-shared/${m}.ts`)
    lower('css/grammar.ts')
    // The dialects compose over css's BUILT base module, as they do in jess.
    write(join(root, 'css/grammar/base.js'), await shippedBundle('css', 'cssBaseRules', join(root, 'css/grammar/base.js')))
    for (const d of DIALECTS.slice(1)) lower(`${d}/grammar.ts`)

    /** Interpreter twins: every `.js` specifier to its `.ts` source, macro attribute stripped. */
    const unlowered: Plugin = {
      name: 'unlowered',
      setup(b) {
        b.onResolve({ filter: /\.js$/ }, args => {
          if (!args.path.startsWith('.')) return undefined
          const abs = resolve(args.resolveDir, args.path)
          // css's base is its grammar module's `cssBaseRules`, from source.
          if (abs === join(root, 'css/grammar/base.js')) return { path: join(root, 'css/grammar.ts') }
          return { path: abs.replace(/\.js$/, '.ts') }
        })
        b.onLoad({ filter: /\.ts$/ }, args => ({
          contents: readFileSync(args.path, 'utf8').replace(/\s+with\s*\{\s*type\s*:\s*['"]macro['"]\s*\}/g, ''),
          loader: 'ts',
        }))
      },
    }

    return await fn({
      root,
      warnings,
      async shipped(dialect, variant) {
        const file = join(root, dialect, 'shipped', `${variant}.js`)
        const code = await shippedBundle(dialect, exportOf(dialect, variant), file)
        write(file, code)
        return { file, bytes: Buffer.byteLength(code) }
      },
      runnable: (dialect, variant) => loadable(
        join(root, dialect, 'grammar.js'), exportOf(dialect, variant),
        join(root, dialect, 'runnable', `${variant.replace('/', '-')}.mjs`), []),
      interpreter: (dialect, variant) => loadable(
        join(root, dialect, 'grammar.ts'), exportOf(dialect, variant),
        join(root, dialect, 'interpreter', `${variant.replace('/', '-')}.mjs`), [unlowered]),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
