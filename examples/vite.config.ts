/**
 * Vite config for examples — shows how to register the parseman macro plugin.
 *
 * With this config, any file that imports from 'parseman' with { type: 'macro' }
 * will have its parser combinators compiled to optimized JS at build time.
 *
 * Example file using the macro:
 *
 *   import { literal, regex, sequence, choice, sepBy } from 'parseman' with { type: 'macro' }
 *
 *   const comma = literal(',')
 *   const field = regex(/[^,\n]+/)
 *   const row   = sepBy(field, comma)
 *   // ↑ at build time, `row` is replaced with an inlined compiled function —
 *   //   no runtime overhead from the interpreter
 *
 * Without the plugin (e.g. in tests via tsx), the import attribute is ignored
 * and the interpreter runs normally — same results, slightly slower.
 */
import { defineConfig } from 'vite'
import parsemanPlugin from '../src/plugin/index.ts'

export default defineConfig({
  plugins: [
    parsemanPlugin(),
  ],
  resolve: {
    alias: {
      // During local development, resolve 'parseman' to the source tree.
      // Published users don't need this — they install the package normally.
      'parseman': new URL('../src/index.ts', import.meta.url).pathname,
      'parseman/plugin': new URL('../src/plugin/index.ts', import.meta.url).pathname,
    },
  },
})
