#!/usr/bin/env node
/**
 * `parseman` — the diagnostics CLI.
 *
 * WHY A COMMAND AND NOT A FUNCTION
 * --------------------------------
 * 0.45 collapsed three functions a caller had to choose between into one
 * `diagnoseGrammar()`. That removed the wrong choice but not the real defect: it is
 * still something you must know exists, import, and write a script around. rustc and
 * clippy are commands. `parseman diagnose src/grammar.ts` is found by typing
 * `parseman --help`; a library export is found by reading the source.
 *
 * FOUR LAYERS, AND THIS IS THE FOURTH
 * -----------------------------------
 * Analysis produces data (`analysis/gating.ts`, `analysis/corpus.ts`), policy decides
 * pass/fail (`analysis/diagnose.ts` — `ok`), rendering makes it readable
 * (`analysis/*-render.ts`). This file is argument parsing and process wiring, and
 * nothing else. It must not become where logic accretes: if a rule about what counts as
 * a finding ever appears below, it is in the wrong file.
 *
 * EXIT CODES
 * ----------
 *   0  analysed, no blocking finding
 *   1  analysed, blocking findings (the established `process.exit(d.ok ? 0 : 1)` contract)
 *   2  COULD NOT ANALYSE — bad usage, unloadable grammar, unreadable corpus, I/O failure
 *
 * 2 is not a nicety. This repo's own history has the counter-example: `coverage.ts`
 * reporting 100% covered over zero analysable input. A tool that cannot measure must not
 * exit 0.
 *
 * STREAMS
 * -------
 * Output goes through the streams this process already owns. `--json` with no path
 * writes the document to stdout and sends the human rendering to stderr, so stdout stays
 * a single parseable document; `--json=<path>` writes the file and reports a real I/O
 * failure with its path and reason. It never opens a second file description on stdout —
 * `writeFileSync('/dev/stdout')` races the async writes `console.log` has already queued,
 * which is exactly how 0.45's size probe exited 1 while printing a correct table.
 *
 * The compiler is reachable from here, and deliberately not from anywhere a library
 * consumer imports: this is a separate bin entry with its own bundle, so a browser build
 * of `parseman` costs nothing for its existence.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative, join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { diagnoseGrammar, type GrammarDiagnosis } from '../analysis/diagnose.ts'
import { renderDiagnosis } from '../analysis/diagnose-render.ts'
import { firstSetToString, choiceArms, peelToLeading } from '../analysis/gating.ts'
import { armFirstSets, measureChoiceCost, type ChoiceCorpusCost, type CorpusSample } from '../analysis/corpus.ts'
import { proposeFixes, applyFixEdits } from '../analysis/fix.ts'
import { renderFixReport } from '../analysis/fix-render.ts'
import type { Combinator, ParserDef } from '../types.ts'

const USAGE = `parseman — grammar diagnostics

  parseman diagnose <grammar> [options]     analyse a grammar; exit 1 on a blocking finding
  parseman fix <grammar> [options]          propose VERIFIED rewrites; preview by default

grammar
  A module path. The default export is used, or --export <name>. A .ts module needs
  \`tsx\` installed (parseman registers it automatically when it is resolvable).

options
  --corpus <path>     File or directory of sample inputs. On \`diagnose\` it adds the
                      measured second world; on \`fix\` it is REQUIRED — a rewrite with
                      no corpus cannot be verified and is never offered.
  --ext <list>        Corpus extensions to accept (default: every file). e.g. --ext .css
  --export <name>     Named export to analyse instead of the default export.
  --accept <ids>      Comma-separated choice ids accepted as intentionally ungated.
  --source <path>     Grammar source to locate edits in (default: the grammar path).
  --apply             \`fix\` only. Write the verified edits. Off by default.
  --json[=<path>]     Machine-readable report. With no path it goes to stdout and the
                      human rendering goes to stderr.
  --limit <n>         Findings to expand (default 20).
  --color/--no-color  Force colour on/off. Default: on only when stdout is a TTY.
  -h, --help          This.

exit codes
  0 clean · 1 blocking findings · 2 could not analyse`

type Args = {
  command: string | undefined
  positional: string[]
  flags: Map<string, string | true>
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-h') { flags.set('help', true); continue }
    if (!a.startsWith('--')) { positional.push(a); continue }
    const eq = a.indexOf('=')
    if (eq !== -1) { flags.set(a.slice(2, eq), a.slice(eq + 1)); continue }
    const name = a.slice(2)
    // Value-taking flags consume the next argument; boolean flags do not.
    if (['corpus', 'export', 'accept', 'source', 'limit', 'ext'].includes(name) && i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
      flags.set(name, argv[++i]!)
    }
    else flags.set(name, true)
  }
  return { command: positional[0], positional: positional.slice(1), flags }
}

class CliError extends Error {}

/** Register the TS loader only when it is needed AND resolvable, so a JS-only user
 *  never pays for it and a TS user gets a sentence rather than a module-not-found. */
async function registerTsIfNeeded(path: string): Promise<void> {
  if (!['.ts', '.mts', '.cts', '.tsx'].includes(extname(path))) return
  try {
    const api = await import('tsx/esm/api') as { register(): unknown }
    api.register()
  }
  catch {
    throw new CliError(
      `${path} is TypeScript, and the \`tsx\` loader is not resolvable from here.\n`
      + 'Install it (`pnpm add -D tsx`), or point at a built .js module.',
    )
  }
}

async function loadGrammar(path: string, exportName: string | undefined): Promise<unknown> {
  const abs = resolve(path)
  try { statSync(abs) }
  catch { throw new CliError(`no such grammar module: ${path}`) }
  await registerTsIfNeeded(abs)
  let mod: Record<string, unknown>
  try { mod = await import(pathToFileURL(abs).href) as Record<string, unknown> }
  catch (e) {
    throw new CliError(`could not load ${path}\n  ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
  }
  if (exportName !== undefined) {
    if (!(exportName in mod)) {
      throw new CliError(`${path} has no export \`${exportName}\`. It exports: ${Object.keys(mod).join(', ') || '(nothing)'}`)
    }
    return mod[exportName]
  }
  if ('default' in mod) return mod.default
  const names = Object.keys(mod)
  if (names.length === 1) return mod[names[0]!]
  throw new CliError(
    `${path} has no default export, and ${names.length} named exports to choose between.\n`
    + `  Pick one with --export: ${names.join(', ')}`,
  )
}

function readCorpus(root: string | undefined, extFilter: string | undefined): CorpusSample[] {
  if (root === undefined) return []
  const abs = resolve(root)
  const exts = extFilter?.split(',').map(e => e.trim()).filter(e => e !== '')
  const files: string[] = []
  const walk = (p: string): void => {
    let st: ReturnType<typeof statSync>
    try { st = statSync(p) }
    catch (e) { throw new CliError(`cannot read corpus path ${p}: ${e instanceof Error ? e.message : String(e)}`) }
    if (st.isDirectory()) { for (const e of readdirSync(p).sort()) walk(join(p, e)); return }
    if (exts !== undefined && !exts.includes(extname(p))) return
    files.push(p)
  }
  walk(abs)
  if (files.length === 0) throw new CliError(`corpus ${root} contains no files${exts ? ` matching ${exts.join(',')}` : ''}`)
  // Names are cwd-relative: an absolute path in a report breaks diffability.
  return files.map(f => ({ name: relative(process.cwd(), f), text: readFileSync(f, 'utf8') }))
}

/** The entry combinator to analyse. A `rules()` map or `compose()` result has no single
 *  root to parse with, so `fix` needs the rule the caller parses with, named explicitly. */
function asCombinator(g: unknown): Combinator<unknown> | null {
  return typeof g === 'object' && g !== null && '_def' in (g as object) ? g as Combinator<unknown> : null
}

const leadLabel = (raw: Combinator<unknown>): string => {
  const arm = peelToLeading(raw)
  const d = arm._def as ParserDef
  switch (d.tag) {
    case 'literal': return `literal('${d.value}')`
    case 'regex': return `regex(/${d.source}/)`
    case 'keywords': return d.words.length === 1 ? `word('${d.words[0]}')` : `keywords([${d.words.length}])`
    case 'lazy': {
      const own = (arm as { _ruleName?: string })._ruleName
      if (own !== undefined) return own
      // An unnamed ref is not a useful label; resolve it once and describe what it
      // actually leads with, which is the thing the reader is looking for.
      try {
        const t = d.thunk()
        return (t as { _ruleName?: string })._ruleName ?? `→ ${leadLabel(t)}`
      }
      catch { return 'ref(unbound)' }
    }
    default: return d.tag
  }
}

function writeJson(target: string | true, doc: unknown): void {
  const text = `${JSON.stringify(doc, null, 2)}\n`
  if (target === true) { process.stdout.write(text); return }
  try { writeFileSync(target, text) }
  catch (e) { throw new CliError(`could not write ${target}: ${e instanceof Error ? e.message : String(e)}`) }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.flags.has('help') || args.command === undefined || args.command === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return args.command === undefined && !args.flags.has('help') ? 2 : 0
  }
  const color = args.flags.has('color') ? args.flags.get('color') !== 'false'
    : args.flags.has('no-color') ? false
      : process.stdout.isTTY === true && process.env.NO_COLOR === undefined
  const json = args.flags.get('json')
  // JSON on stdout means stdout is a document; the human rendering moves to stderr so it
  // stays one. Both go through streams this process already owns.
  const human = (s: string): void => { (json === true ? process.stderr : process.stdout).write(`${s}\n`) }

  const grammarPath = args.positional[0]
  if (grammarPath === undefined) throw new CliError(`\`parseman ${args.command}\` needs a grammar module path.\n\n${USAGE}`)
  const exportName = args.flags.get('export')
  const grammar = await loadGrammar(grammarPath, typeof exportName === 'string' ? exportName : undefined)
  const label = relative(process.cwd(), resolve(grammarPath)) || grammarPath
  const acceptFlag = args.flags.get('accept')
  const accept = typeof acceptFlag === 'string' ? acceptFlag.split(',').map(s => s.trim()).filter(s => s !== '') : undefined
  const corpusFlag = args.flags.get('corpus')
  const extFlag = args.flags.get('ext')
  const corpus = readCorpus(typeof corpusFlag === 'string' ? corpusFlag : undefined, typeof extFlag === 'string' ? extFlag : undefined)

  if (args.command === 'diagnose') {
    const d: GrammarDiagnosis = diagnoseGrammar(grammar as Parameters<typeof diagnoseGrammar>[0], accept === undefined ? {} : { accept })
    const cost = new Map<string, ChoiceCorpusCost>()
    const sets = new Map<string, readonly string[]>()
    const labels = new Map<string, readonly string[]>()
    for (const c of d.gating.choices) {
      const a = choiceArms(c)
      if (a === undefined) continue
      const fs = armFirstSets(a)
      sets.set(c.id, fs.map(x => firstSetToString(x.firstSet)))
      labels.set(c.id, a.map(x => leadLabel(x)))
      if (corpus.length > 0) cost.set(c.id, measureChoiceCost(c, corpus, fs))
    }
    const limitFlag = args.flags.get('limit')
    human(renderDiagnosis(d, {
      color, name: label, cost, armFirstSets: sets, armLabels: labels,
      ...(typeof limitFlag === 'string' ? { limit: Number(limitFlag) } : {}),
    }))
    if (json !== undefined) writeJson(json, d)
    return d.ok ? 0 : 1
  }

  if (args.command === 'fix') {
    const root = asCombinator(grammar)
    if (root === null) {
      throw new CliError(
        `${label} exported a rule map or a composed grammar, which has no single root to parse with.\n`
        + '  `fix` verifies by re-parsing, so it needs the rule you parse with: --export <RuleName>.',
      )
    }
    const sourceFlag = args.flags.get('source')
    const sourcePath = typeof sourceFlag === 'string' ? sourceFlag : grammarPath
    let source: { path: string; text: string } | undefined
    try { source = { path: relative(process.cwd(), resolve(sourcePath)), text: readFileSync(resolve(sourcePath), 'utf8') } }
    catch (e) { throw new CliError(`could not read grammar source ${sourcePath}: ${e instanceof Error ? e.message : String(e)}`) }
    const report = proposeFixes(root, {
      corpus,
      ...(source === undefined ? {} : { source }),
      ...(accept === undefined ? {} : { accept }),
    })
    const apply = args.flags.get('apply') === true
    let applied = 0
    if (apply && report.verified.length > 0) {
      const { text, applied: n } = applyFixEdits(source.text, report.verified)
      applied = n
      if (n > 0) {
        try { writeFileSync(resolve(sourcePath), text) }
        catch (e) { throw new CliError(`could not write ${sourcePath}: ${e instanceof Error ? e.message : String(e)}`) }
      }
    }
    human(renderFixReport(report, { color, name: label, applied: apply && applied > 0 }))
    if (apply) human(`  ${applied} edit(s) written to ${source.path}`)
    if (json !== undefined) writeJson(json, report)
    // Fails closed: a loop that could not run is not a pass.
    return report.ok ? 0 : 2
  }

  throw new CliError(`unknown command \`${args.command}\`.\n\n${USAGE}`)
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code })
  .catch((e) => {
    process.stderr.write(`${e instanceof CliError ? e.message : e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`)
    process.exitCode = 2
  })
