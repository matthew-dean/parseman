import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'plugin/index': 'src/plugin/index.ts',
    'spec/index': 'src/spec/index.ts',
    'language-service/index': 'src/language-service/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
})
