/**
 * A pre-compiled emitted assembly for a program, built as a MODULE the way a macro
 * build ships one (`src/table/emit.ts`), then imported. For tests and benches that
 * need the emitted engine on a program they made at runtime — `backtrackProbe`'s
 * rewritten copy — without a string-to-code step in `src/`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { cfgKey, type RunCfg } from '../src/table/assemble.ts'
import { EMITTED_ABI, EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../src/table/emit-assembly.ts'
import { FACTORY_ARITY_GUARD } from '../src/table/emit.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../src/table/program.ts'

export async function withEmittedAssembly(prog: TableProgram, cfg: RunCfg): Promise<TableProgram> {
  const em = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-emitted-assembly-'))
  try {
    const file = path.join(dir, 'assembly.mjs')
    writeFileSync(file, `export default function(${EMITTED_PARAMS.join(',')}){${FACTORY_ARITY_GUARD}${em.source}\n}\n`)
    const factory = (await import(/* @vite-ignore */ pathToFileURL(file).href) as { default: EmittedFactory }).default
    return {
      ...prog,
      asm: [{ key: cfgKey(cfg), abi: EMITTED_ABI, factory, plan: em.plan, reached: [...em.reached] }],
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
