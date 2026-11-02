import { resolve as resolvePath } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { run } from '../../src/functional/run.ts'
import { JESS_ROOT, exportName, type Dialect } from '../../bench/jess/grammars.ts'
const MODULE: Record<string, string> = { css: 'packages/syntax/css/css-parser/src/grammar.ts', less: 'packages/syntax/less/less-parser/src/grammar.ts', scss: 'packages/syntax/scss/scss-parser/src/grammar.ts', jess: 'packages/syntax/jess/jess-parser/src/grammar.ts' }
const [d, file, out, rule = 'Stylesheet'] = process.argv.slice(2) as [Dialect, string, string, string]
const mod = await import(`pm-macro:${resolvePath(JESS_ROOT, MODULE[d]!)}`) as Record<string, Record<string, Parameters<typeof run>[0]>>
const r = run(mod[exportName(d, 'ast')]![rule]!, file.startsWith('=') ? file.slice(1) : readFileSync(file, 'utf8'))
const seen = new WeakSet()
writeFileSync(out, JSON.stringify(r, (_k, v) => { if (typeof v === 'object' && v !== null) { if (seen.has(v)) return '[seen]'; seen.add(v); if (!Array.isArray(v)) { const o: Record<string, unknown> = { __ctor: v.constructor?.name }; for (const k of Object.keys(v)) o[k] = (v as Record<string, unknown>)[k]; return o } } return v }, 1))
