#!/usr/bin/env node
/**
 * DIFFERENTIAL TEETH GATE — plant a defect, and prove each registered
 * differential notices.
 *
 * A differential that has never been shown to fail is not evidence. Six defects
 * shipped through a fully green 3300-test suite in one day, and every one of them
 * hid inside a comparison that COULD NOT GO RED: both legs built from the same
 * engine, a leg that threw identically on every row, a success predicate that
 * meant "did not throw", an option that selected a different artifact so the
 * harness never realised the thing under test. None of that is detectable by
 * reading the harness's output, because a vacuous harness prints a clean,
 * plausible, self-consistent result. The only way to know a comparison works is
 * to break something and watch it complain.
 *
 * WHAT THIS DOES. For each entry in `REGISTRY`:
 *   1. run it clean, and record its normalised output as the BASELINE
 *   2. for each plant it registers, apply that plant to its real implementation
 *      path, run it again,
 *      and require the output to MOVE (or, for a `blind` plant, to NOT move)
 *   3. restore every edited file exactly
 *
 * A differential whose output does not move under its plant is reported by name
 * and fails the gate. That report is the point of this script; the pass line is
 * not.
 *
 * WHAT IT DOES NOT DO. It does not re-check every corpus file — it runs the css
 * corpus (87 files) rather than less's 314 or scss's 2408, because the claim
 * under test is that the COMPARISON MECHANISM is live, not that today's corpus is
 * clean. That is what the sweeps themselves are for. It times nothing.
 *
 * Usage:
 *   node scripts/check-differentials.mjs            # gate
 *   node scripts/check-differentials.mjs --strict   # also fail on UNPROVEN entries
 *   node scripts/check-differentials.mjs --list     # print the registry, run nothing
 *   node scripts/check-differentials.mjs --only=id[,id]
 *
 * ENVIRONMENT. Four of the nine registered differentials drive JESS'S grammars
 * over JESS'S corpora, which live in a jess worktree (`JESS_ROOT`) that this repo
 * does not vendor. There is no default: a checkout nobody built (a mirror that
 * tracks `dev` while its packages' `lib/` stay at an older commit) makes every one
 * of them red before any plant. Unset, they are reported UNPROVEN — never as
 * passing. Set to a checkout whose `lib/` is older than its last source commit,
 * the gate refuses to run them and fails. `--strict` is
 * what a release runs; plain mode is what CI runs, and CI proves the three
 * self-contained ones. An UNPROVEN entry is a differential whose teeth are
 * unknown in this environment, and the summary says so on its own line so it
 * cannot be read as a green.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFECTS } from './differential-defects.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const JESS_ROOT = process.env.JESS_ROOT ?? ''

/**
 * Why `JESS_ROOT` cannot serve the jess differentials, or `undefined` when it can.
 * The grammars import jess's built packages, so a package whose `lib/` predates
 * its last source commit is a stale build, not a corpus.
 */
function jessRootProblem(root, git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()) {
  if (root === '') return 'JESS_ROOT is not set; point it at a jess worktree built with `pnpm build:release`'
  if (!existsSync(root)) return `JESS_ROOT ${root} does not exist`
  for (const pkg of ['packages/core', 'packages/parser-shared']) {
    const built = join(root, pkg, 'lib')
    if (!existsSync(built)) return `${pkg} in ${root} is not built (no lib/)`
    let srcTime
    try { srcTime = Number(git(['-C', root, 'log', '-1', '--format=%ct', '--', `${pkg}/src`])) } catch { return `${root} is not a git checkout` }
    const libTime = statSync(built).mtimeMs / 1000
    if (libTime < srcTime) return `${pkg}/lib in ${root} is older than its last source commit; rebuild it (\`pnpm build:release\`)`
  }
  return undefined
}
const REGISTER = join(REPO, 'bench/jess/register.mjs')
const NODE = process.execPath
/** One dialect, 87 files: enough corpus to drive every plant, fast enough for CI. */
const DIALECT = 'css'

const TMP = mkdtempSync(join(tmpdir(), 'pm-diffgate-'))

/* ------------------------------------------------------------------ *
 * Running a harness
 * ------------------------------------------------------------------ */

/** Run a command; return `{ code, out }` with stdout and stderr joined. */
function runCmd(argv, env = {}) {
  const r = spawnSync(NODE, argv, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, JESS_ROOT, ...env },
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

/**
 * Strip the fields that move between two runs of the SAME code — timestamps,
 * load averages, durations, and the provenance a planted tree necessarily dirties.
 *
 * This is the one place the gate could lie to itself: normalise too hard and a
 * real movement gets erased, so every rule here is anchored to a named field or a
 * known-noisy token, never to a digest or a count.
 */
function normalise(out) {
  return out
    // JSONL provenance: timestamps, load, sha, dirtiness, and the flags list that
    // records dirtiness. A planted run IS dirty; that is not the movement we want.
    .replace(/"ts":"[^"]*"/g, '"ts":"-"')
    .replace(/"load(Start|End)":[^,}]*/g, '"load$1":-')
    .replace(/"(parsemanSha|jessSha|srcRealpath|parsemanRoot|jessRoot)":"[^"]*"/g, '"$1":"-"')
    .replace(/"srcDirty":(true|false)/g, '"srcDirty":-')
    .replace(/"flags":\[[^\]]*\]/g, '"flags":[]')
    // The sweeps' own summary line reports `src-dirty` — which every planted run
    // necessarily is. Leaving it in would make EVERY plant look caught, by every
    // sweep, for a reason that has nothing to do with the defect. That is not a
    // hypothetical: the first run of this gate scored `consumed-sweep` as catching
    // a plant it is in fact blind to, on exactly this string.
    .replace(/\s*FLAGS: \S+/g, '')
    // vitest / harness noise: durations, absolute paths, and the append target.
    .replace(/\d+(\.\d+)?\s?ms\b/g, '<ms>')
    .replace(/\b\d+(\.\d+)?s\b/g, '<s>')
    .replace(new RegExp(TMP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<tmp>')
    .replace(/pm-diffgate-[A-Za-z0-9]+/g, '<tmp>')
    // The per-run sink NAME. Every sweep echoes its append target, and the target
    // is different on every run by construction — so without this line every
    // sweep "moves" under every plant and the gate reports universal teeth. This
    // was the second self-inflicted false positive found while writing it.
    .replace(/sweep-\d+\.jsonl/g, '<sink>')
    // vitest prints `Start at  13:09:10` with TWO spaces: one space here let the
    // clock leak through, so a blind plant read as caught whenever the second ticked.
    .replace(/\bat\s+\d{2}:\d{2}:\d{2}\b/g, 'at <time>')
    .trim()
}

/** A fresh append target, so no sweep ever writes into `notes/results/`. */
let nth = 0
const sink = () => join(TMP, `sweep-${nth++}.jsonl`)

/**
 * COMPARE THE ARTIFACT A SWEEP PRODUCES, NOT ITS PROGRESS LINE.
 *
 * `consumed-sweep.ts` and `tolerant-sweep.ts` write their records to a file and
 * print a one-line record count. Comparing stdout therefore compares a COUNT,
 * which no plant here changes — the differential would have been scored on a
 * string that says nothing about what was parsed.
 */
function runSweep(argv, env = {}) {
  const out = sink()
  const r = runCmd([...argv, out], env)
  return { code: r.code, out: `${r.out}\n${existsSync(out) ? readFileSync(out, 'utf8') : '(no records written)'}` }
}

/* ------------------------------------------------------------------ *
 * THE REGISTRY
 * ------------------------------------------------------------------ *
 *
 * `legs` is prose, and it is required. Three harnesses labelled a table as
 * `codegen` this cycle; naming the legs where the differential is registered is
 * the cheapest place to notice that the label and the import disagree.
 *
 * `plants` is the contract: `moves` means this differential MUST detect that
 * defect, `blind` means it MUST NOT — a blind entry is a documented limit, and
 * the gate holds it to that limit in both directions.
 */
const REGISTRY = [
  {
    id: 'scan-shape-oracle',
    needs: 'repo',
    file: 'bench/scan-shape-oracle.ts',
    legs: 'emitted straight-line scan (src/table/scan-shapes.ts) vs sticky RegExp.exec, every regex constant at every position of four workloads',
    cleanExit: 0,
    run: () => runCmd(['--import', 'tsx/esm', 'bench/scan-shape-oracle.ts']),
    plants: [{ defect: 'scan-class-narrow', expect: 'moves' }],
  },
  {
    id: 'table-lowering-identity',
    needs: 'repo',
    file: 'test/unit/table-identity.test.ts (bench/table-lowering-identity.ts)',
    legs: 'interpreted combinator graph vs compose() codegen vs tableRules (shipped) vs execRules (reference driver), digested per case',
    cleanExit: 0,
    // The vitest test, not `bench/table-lowering-sweep.ts`: the sweep prints its
    // mismatches and exits 0 whatever it finds, so it is a report, not a gate.
    // This is the subset CI actually enforces.
    run: () => runCmd(['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot', 'test/unit/table-identity.test.ts']),
    plants: [
      { defect: 'emit-node-span', expect: 'moves' },
      { defect: 'exec-node-span', expect: 'moves' },
    ],
  },
  {
    id: 'macro-optimize-contract',
    needs: 'repo',
    file: 'test/unit/macro-optimize-contract.test.ts (bench/jess/ab-protocol.ts)',
    legs: 'structured macro timing acceptance errors vs the blocking process exit status consumed by required CI',
    cleanExit: 0,
    run: () => runCmd(['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot', 'test/unit/macro-optimize-contract.test.ts']),
    plants: [{ defect: 'macro-timing-exit-off', expect: 'moves' }],
  },
  {
    id: 'lex-selected-vs-character',
    needs: 'repo',
    file: 'test/unit/lex-fixed-tree-closure.test.ts',
    legs: 'a grammar lowered to selected lexical bodies vs the same grammar plus a capability gap (CHARACTER lowering), each through execRules, closure tableRules and precompiled emitted tableRules: whole RunResult digests and completion-probe results per input',
    cleanExit: 0,
    run: () => runCmd(['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot', 'test/unit/lex-fixed-tree-closure.test.ts']),
    plants: [
      { defect: 'lex-choice-exclusive-off', expect: 'moves' },
      { defect: 'lex-repeat-min-short', expect: 'moves' },
      { defect: 'lex-rule-trivia-glued', expect: 'moves' },
    ],
  },
  {
    id: 'routed-arm-gate',
    needs: 'repo',
    file: 'test/unit/table-routed-arm-gate.test.ts',
    legs: 'a dispatch whose routed choice arms carry OP_RGATE, in execRules, closure and precompiled emitted tableRules, vs the interpreted grammar: whole RunResult digests per input',
    cleanExit: 0,
    run: () => runCmd(['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot', 'test/unit/table-routed-arm-gate.test.ts']),
    plants: [{ defect: 'rgate-miss-set-short', expect: 'moves' }],
  },
  {
    id: 'loop-continuation',
    needs: 'repo',
    file: 'test/unit/table-loop-continuation.test.ts',
    legs: 'generated padded-operator chains and separated lists (operators, prefix minus, groups, spacing, one-character defects) through execRules, closure and precompiled emitted tableRules, vs the interpreted grammar: whole RunResult digests per input',
    cleanExit: 0,
    run: () => runCmd(['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot', 'test/unit/table-loop-continuation.test.ts']),
    plants: [
      { defect: 'loop-sep-gate-before-trivia', expect: 'moves' },
      { defect: 'loop-sep-gate-before-trivia-emitted', expect: 'moves' },
      { defect: 'seq-pad-first-set-drops-rest', expect: 'moves' },
      { defect: 'seplist-first-item-set-dropped', expect: 'moves' },
      { defect: 'repeat-lead-gate-kept', expect: 'moves' },
    ],
  },
  {
    id: 'dispatch-otherwise-commit',
    needs: 'repo',
    file: 'test/unit/dispatch-otherwise-commit.test.ts',
    legs: 'a statement dispatch with a committing call case and an otherwise() fallback, committed and uncommitted, through execRules, closure and precompiled emitted tableRules, vs the interpreted grammar: whole RunResult digests per input',
    cleanExit: 0,
    run: () => runCmd(['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot', 'test/unit/dispatch-otherwise-commit.test.ts']),
    plants: [
      { defect: 'otherwise-commit-bit-dropped', expect: 'moves' },
      { defect: 'otherwise-commit-closure-routed', expect: 'moves' },
      { defect: 'otherwise-commit-emitted', expect: 'moves' },
    ],
  },
  {
    id: 'prefix-arm',
    needs: 'repo',
    file: 'test/unit/table-prefix-arm.test.ts',
    legs: 'generated argument lists over choice(sequence(X, a), X) inside a node, plus a choice whose next arm is not a prefix, through execRules, closure and precompiled emitted tableRules, vs the interpreted grammar: whole RunResult digests per input, and the shared term visit count',
    cleanExit: 0,
    run: () => runCmd(['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot', 'test/unit/table-prefix-arm.test.ts']),
    plants: [
      { defect: 'prefix-arm-any-prefix', expect: 'moves' },
      { defect: 'prefix-arm-off', expect: 'moves' },
    ],
  },
  {
    id: 'gap-gate',
    needs: 'repo',
    file: 'test/unit/table-gap-gate.test.ts',
    legs: 'generated SCSS-shaped operator chains (padded operators, a sum arm led by another level\'s gap, comments and tabs in gaps, one-character defects) through execRules, closure and precompiled emitted tableRules, vs the interpreted grammar (AST, CST host, tolerant) and vs execRules (line tracking): whole RunResult digests per input, and operator-node visit counts',
    cleanExit: 0,
    run: () => runCmd(['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot', 'test/unit/table-gap-gate.test.ts']),
    plants: [
      { defect: 'gap-scan-wrong-offset', expect: 'moves' },
      { defect: 'gap-scan-wrong-offset-emitted', expect: 'moves' },
      { defect: 'gap-follow-narrowed', expect: 'moves' },
      { defect: 'gap-slot-any-row', expect: 'moves' },
      { defect: 'gap-slot-any-row-emitted', expect: 'moves' },
      { defect: 'gap-slot-uncleared', expect: 'blind' },
    ],
  },
  {
    id: 'routed-arm-gate2',
    needs: 'repo',
    file: 'test/unit/table-routed-arm-gate2.test.ts',
    legs: 'a name-once statement dispatch whose spaced-declaration arm is gated on a colon and the gap after it (OP_RGATE2), glued and spaced heads, through execRules (one-character gate), closure and precompiled emitted tableRules, vs the interpreted grammar: whole RunResult digests per input, and arm visit counts',
    cleanExit: 0,
    run: () => runCmd(['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot', 'test/unit/table-routed-arm-gate2.test.ts']),
    plants: [
      { defect: 'rgate2-second-at-first', expect: 'moves' },
      { defect: 'rgate2-second-at-first-emitted', expect: 'moves' },
      { defect: 'rgate2-second-narrowed', expect: 'moves' },
    ],
  },
  {
    id: 'jess-oracle',
    needs: 'jess',
    file: 'bench/jess/divergence.ts (legs from bench/jess/digest.ts)',
    legs: 'interpreted fuse vs the PM_MACRO artifact (the shipped ASSEMBLER — codegen.ts was deleted in 37c57b5) vs execRules (reference), one process per leg, over jess\'s css corpus',
    // `divergence.ts` exits 0 whatever it finds — it prints outcome counts. The
    // teeth test is therefore that those counts MOVE, not that it returns non-zero.
    cleanExit: 0,
    run: () => runCmd(['--import', REGISTER, 'bench/jess/divergence.ts', DIALECT, 'ast']),
    plants: [{ defect: 'exec-node-span', expect: 'moves' }],
  },
  {
    id: 'emit-identity-one',
    needs: 'jess',
    file: 'bench/jess/emit-identity-one.ts',
    legs: 'PM_TABLE_EMIT=1 emitted assembly vs PM_TABLE_EMIT=0 closure walk, same table, same corpus',
    cleanExit: 0,
    // The harness IS one leg; the differential is the PAIR. Modelled here so the
    // gate compares what a lane compares.
    run: () => {
      const one = env => runCmd(['--import', REGISTER, 'bench/jess/emit-identity-one.ts', DIALECT, 'ast'], env)
      const a = one({ PM_TABLE_EMIT: '1' })
      const b = one({ PM_TABLE_EMIT: '0' })
      const same = normalise(a.out.split('\n').filter(l => !l.startsWith('#')).join('\n'))
        === normalise(b.out.split('\n').filter(l => !l.startsWith('#')).join('\n'))
      return { code: a.code || b.code, out: `emitted-vs-closure: ${same ? 'IDENTICAL' : 'DIFFER'}` }
    },
    plants: [{ defect: 'emit-node-span', expect: 'moves' }],
  },
  {
    id: 'consumed-sweep',
    needs: 'jess',
    file: 'bench/jess/consumed-sweep.ts',
    legs: 'one build\'s interpreted engine, bytes consumed per corpus file, appended as JSONL for comparison against another build',
    cleanExit: 0,
    run: () => runSweep(['--import', REGISTER, 'bench/jess/consumed-sweep.ts', DIALECT, 'interpreted']),
    plants: [
      { defect: 'interp-many-cap', expect: 'moves' },
      // THE DOCUMENTED LIMIT, held to in both directions: this sweep calls
      // `run(entry, input)` with no options, so the tolerant assembly is never
      // built and a defect confined to it is invisible here. See tolerant-sweep.
      { defect: 'tolerant-rec-off', expect: 'blind' },
    ],
  },
  {
    id: 'tolerant-sweep',
    needs: 'jess',
    file: 'bench/jess/tolerant-sweep.ts',
    legs: 'run-tabled.ts with { tolerant: true } — the RECOVERY assembly, which consumed-sweep never builds — errors, spans and value digest per corpus file',
    cleanExit: 0,
    run: () => runSweep(['--import', REGISTER, 'bench/jess/tolerant-sweep.ts', DIALECT]),
    plants: [{ defect: 'tolerant-rec-off', expect: 'moves' }],
  },
]

/* ------------------------------------------------------------------ *
 * Planting
 * ------------------------------------------------------------------ */

/**
 * Refuse to plant into a tree that already has local `src/` changes.
 *
 * Restoration writes back the bytes read a moment earlier, and the `finally`
 * plus the `exit` handler below cover a throw and a signal. What neither covers
 * is the operator's own uncommitted work being confused with a plant, so the gate
 * declines rather than take the risk.
 */
function assertCleanSrc() {
  let porcelain = ''
  try { porcelain = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: REPO, encoding: 'utf8' }) }
  catch { return } // not a checkout: nothing to protect
  if (porcelain.trim() !== '') {
    console.error('REFUSING TO RUN: `src/` has uncommitted changes.\n'
      + 'This gate edits `src/` in place and restores it. It will not do that on top of\n'
      + 'work it did not write. Commit or set the changes aside, then re-run.\n' + porcelain)
    process.exit(2)
  }
}

let planted = null

function plant(id) {
  const d = DEFECTS[id]
  if (d === undefined) throw new Error(`no such defect '${id}'`)
  const saved = []
  for (const e of d.edits) {
    const p = join(REPO, e.file)
    const before = readFileSync(p, 'utf8')
    const n = before.split(e.find).length - 1
    if (n !== 1) {
      for (const s of saved) writeFileSync(s.path, s.text)
      throw new Error(
        `plant '${id}': anchor occurs ${n} times in ${e.file}, expected exactly 1.\n`
        + 'The code moved out from under the plant. Re-derive it against the current source —\n'
        + 'a plant that silently stops applying turns this gate into the vacuity it detects.',
      )
    }
    saved.push({ path: p, text: before })
    writeFileSync(p, before.replace(e.find, e.replace))
  }
  planted = saved
}

function unplant() {
  if (planted === null) return
  for (const s of planted) writeFileSync(s.path, s.text)
  planted = null
}

process.on('exit', unplant)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { unplant(); process.exit(130) })

/* ------------------------------------------------------------------ *
 * Driver
 * ------------------------------------------------------------------ */

const args = process.argv.slice(2)
const STRICT = args.includes('--strict')
const onlyArg = args.find(a => a.startsWith('--only='))
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null

if (args.includes('--list')) {
  for (const d of REGISTRY) {
    console.log(`${d.id}  [${d.needs}]  ${d.file}`)
    console.log(`  legs: ${d.legs}`)
    for (const p of d.plants) console.log(`  ${p.expect === 'blind' ? 'BLIND TO' : 'must catch'}: ${p.defect} — ${DEFECTS[p.defect].why}`)
  }
  process.exit(0)
}

const jessProblem = jessRootProblem(JESS_ROOT)
const haveJess = jessProblem === undefined
const entries = REGISTRY.filter(d => ONLY === null || ONLY.has(d.id))

console.log(`differential teeth gate — ${entries.length} registered, jess corpus ${haveJess ? `at ${JESS_ROOT}` : `UNAVAILABLE: ${jessProblem}`}\n`)
// A root that was SET but is stale is an environment error, not an absence: it is
// the configuration that made four differentials red before any plant.
if (JESS_ROOT !== '' && !haveJess && entries.some(d => d.needs === 'jess')) {
  console.log(`REFUSING the jess differentials: ${jessProblem}`)
  process.exit(2)
}

const baselines = new Map()
const unproven = []
const failures = []

// Phase 1 — every differential, clean. This also records the baseline each
// planted run is compared against.
for (const d of entries) {
  if (d.needs === 'jess' && !haveJess) {
    unproven.push(`${d.id} — ${jessProblem}`)
    console.log(`  UNPROVEN  ${d.id}  (no jess corpus)`)
    continue
  }
  assertCleanSrc()
  const r = d.run()
  if (d.cleanExit !== undefined && r.code !== d.cleanExit) {
    failures.push(`${d.id}: clean run exited ${r.code}, expected ${d.cleanExit} — the differential is red BEFORE any plant, so nothing below it means anything`)
    console.log(`  ERROR     ${d.id}  clean run exited ${r.code}`)
    console.log(r.out.split('\n').slice(-25).map(l => `      ${l}`).join('\n'))
    continue
  }
  baselines.set(d.id, normalise(r.out))
  console.log(`  baseline  ${d.id}  (exit ${r.code})`)
}

console.log('')

// Phase 2 — one plant at a time, every differential registered against it.
const byDefect = new Map()
for (const d of entries) {
  if (!baselines.has(d.id)) continue
  for (const p of d.plants) {
    if (!byDefect.has(p.defect)) byDefect.set(p.defect, [])
    byDefect.get(p.defect).push({ d, expect: p.expect })
  }
}

for (const [defect, uses] of byDefect) {
  assertCleanSrc()
  console.log(`plant ${defect} — ${DEFECTS[defect].why}`)
  plant(defect)
  try {
    for (const { d, expect } of uses) {
      const r = d.run()
      const moved = normalise(r.out) !== baselines.get(d.id)
      const ok = expect === 'blind' ? !moved : moved
      const verdict = expect === 'blind'
        ? (moved ? 'LEAKED   ' : 'blind    ')
        : (moved ? 'CAUGHT   ' : 'MISSED   ')
      console.log(`  ${verdict} ${d.id}  (exit ${r.code}${expect === 'blind' ? ', must not move' : ''})`)
      if (!ok) {
        failures.push(expect === 'blind'
          ? `${d.id} MOVED under '${defect}', which it is registered as blind to. Either the plant reaches further than the catalogue says, or the two sweeps measure the same artifact.`
          : `${d.id} DID NOT MOVE under '${defect}'. This differential cannot fail: it is not evidence, and every result it has ever produced should be re-read as unproven.`)
      }
    }
  } finally {
    unplant()
  }
}

rmSync(TMP, { recursive: true, force: true })

console.log('')
if (unproven.length > 0) {
  console.log(`UNPROVEN IN THIS ENVIRONMENT (${unproven.length}) — not passing, unknown:`)
  for (const u of unproven) console.log(`  ${u}`)
}
if (failures.length > 0) {
  console.log(`\nDIFFERENTIALS WITHOUT TEETH (${failures.length}):`)
  for (const f of failures) console.log(`  ${f}`)
  process.exit(1)
}
if (STRICT && unproven.length > 0) {
  console.log('\n--strict: an UNPROVEN differential is a failure. Run where the jess corpus exists.')
  process.exit(1)
}
console.log(`every differential run (${baselines.size}) caught its planted defect`)
