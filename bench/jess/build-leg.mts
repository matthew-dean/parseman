/**
 * Builds every variant of the vendored grammars the way Jess ships them, with its real
 * core reducers, into `<out>/<dialect>-<variant>.mjs`: one leg for `leg-sweep.mjs`.
 *
 *   PM_REAL_CORE=<jess>/packages/core node --import tsx/esm bench/jess/build-leg.mts <out> [all|css,less] [fixtureRoot]
 *
 * To build a leg from a commit older than this script, copy this file and this version of
 * `bench/jess/real-grammars.ts` into that checkout first: `PM_REAL_CORE` and the
 * `digestValue` export `leg-sweep.mjs` compares with are both new there.
 */
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
const cwd = process.cwd()
type Snapshot = { warnings: string[]; shipped: (d: string, v: string) => Promise<{ file: string; bytes: number }>; runnable: (d: string, v: string) => Promise<string> }
const { withBuiltSnapshot, DIALECTS, VARIANTS, FIXTURE } = await import(join(cwd, 'bench/jess/real-grammars.ts'))
const out = resolve(process.argv[2]!)
const only = process.argv[3] === "all" ? undefined : process.argv[3]?.split(",")
const fixture = process.argv[4] ? resolve(process.argv[4]) : FIXTURE
mkdirSync(out, { recursive: true })
const rows: unknown[] = []
await withBuiltSnapshot(async (snap: Snapshot) => {
  if (snap.warnings.length) console.error(snap.warnings.join('\n'))
  for (const d of DIALECTS as string[]) {
    if (only && !only.includes(d)) continue
    for (const v of Object.keys(VARIANTS)) {
      const s = await snap.shipped(d, v)
      const code = readFileSync(s.file)
      const f = await snap.runnable(d, v)
      const name = `${d}-${v.replace('/', '-')}.mjs`
      copyFileSync(f, join(out, name))
      copyFileSync(s.file, join(out, name.replace('.mjs', '.shipped.js')))
      rows.push({ d, v, bytes: s.bytes, gz: gzipSync(code).length })
      console.log(d, v, s.bytes, gzipSync(code).length)
    }
  }
}, fixture)
writeFileSync(join(out, 'sizes.json'), JSON.stringify(rows, null, 1))
