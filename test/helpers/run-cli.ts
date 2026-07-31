/**
 * Run `src/cli/index.ts` IN THIS PROCESS.
 *
 * `test/unit/cli-exit-codes.test.ts` spawns the CLI as a real `tsx` subprocess, which is
 * the right shape for the end-to-end exit-code contract and the wrong shape for anything
 * else: a subprocess costs a second of boot per case and reports nothing back about which
 * branches ran. The module has no exports and self-executes `main(process.argv.slice(2))`,
 * so the only way to drive it in-process is to prepare the process the way a shell would
 * have and then import it.
 *
 * A distinct query string per call is what makes that repeatable — the module registry is
 * keyed by resolved id, so `?cliCase=7` is a module it has never seen and its top level
 * runs again. Its imports carry no query, so `src/analysis/*` is evaluated once and
 * shared; only the entry re-runs. The top-level call is a floating promise, so the run is
 * over when `process.exitCode` has been assigned — every path through `main` reaches one
 * of the two `.then` / `.catch` arms and both assign it.
 *
 * Everything mutated is restored in a `finally`, `process.exitCode` included: vitest runs
 * one process per test FILE, so a leaked non-zero exit code would fail this whole file
 * with no failing test to point at.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/cli/index.ts')

let caseId = 0

const ESC = String.fromCharCode(27)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

/** Drop SGR colour sequences so a width or a word can be asserted on the text itself.
 *  OSC-8 hyperlinks are deliberately NOT stripped — some tests assert on them. */
export const stripSgr = (s: string): string => s.replace(SGR, '')

export type CliRun = {
  /** `process.exitCode` after the run. `undefined` only if the run never settled. */
  code: number | undefined
  stdout: string
  stderr: string
}

export type RunCliOptions = {
  /** Environment overrides for the duration of the run. `undefined` deletes the key. */
  env?: Record<string, string | undefined>
  /** Pretend stdout is (or is not) a terminal. Off-TTY is the default under vitest. */
  isTTY?: boolean
  /** Terminal width to report, for the `--color` + `process.stdout.columns` branch. */
  columns?: number
}

export async function runCli(args: readonly string[], opts: RunCliOptions = {}): Promise<CliRun> {
  const out: string[] = []
  const err: string[] = []

  const prevArgv = process.argv
  const prevExitCode = process.exitCode
  const prevWrite = process.stdout.write
  const prevErrWrite = process.stderr.write
  const prevIsTTY = process.stdout.isTTY
  const prevColumns = process.stdout.columns
  const prevEnv = new Map<string, string | undefined>()

  for (const [k, v] of Object.entries(opts.env ?? {})) {
    prevEnv.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  process.argv = ['node', 'parseman', ...args]
  process.exitCode = undefined
  if (opts.isTTY !== undefined) process.stdout.isTTY = opts.isTTY
  if (opts.columns !== undefined) process.stdout.columns = opts.columns
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true }) as typeof process.stderr.write

  try {
    caseId += 1
    await import(/* @vite-ignore */ `${CLI}?cliCase=${caseId}`)
    for (let i = 0; i < 600 && process.exitCode === undefined; i++) {
      await new Promise(r => setTimeout(r, 10))
    }
    const code = process.exitCode
    return { code: typeof code === 'number' ? code : undefined, stdout: out.join(''), stderr: err.join('') }
  }
  finally {
    process.stdout.write = prevWrite
    process.stderr.write = prevErrWrite
    process.argv = prevArgv
    process.exitCode = prevExitCode
    process.stdout.isTTY = prevIsTTY
    process.stdout.columns = prevColumns
    for (const [k, v] of prevEnv) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
