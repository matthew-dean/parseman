/**
 * The PEAK-CLAUSE WAIVER — the one sanctioned way past `pnpm perf:workloads:peak`.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * `docs/design/perf-gates.md` ends with the disposition this file implements:
 *
 *   "Do not widen the threshold to make a build pass. Either fix the regression, or
 *    land it with the number visible and an explanation of why it is the price of
 *    something."
 *
 * Until now only the first two of those were executable. A change that deliberately
 * trades parse time for something else — a correctness fix, or a table-based grammar
 * lowering that buys a ~40x smaller artifact for ~2.65x the parse time — had exactly
 * one route through a red peak gate: move `peak` in `bench/workloads/config.json`, or
 * widen its `allowancePct`. Both make the SLOWER BUILD the reference. That is the
 * edit `check-changelog.mjs` §D calls "LAUNDERING RISK" by name, and it destroys the
 * record permanently to get one PR through.
 *
 * "Land it with the number visible" is the third option, and it is strictly better:
 * the peak stays where it is, the breach stays on the record, and the next PR is
 * still measured against the same bar. This is that option, executed.
 *
 * ── WHY IT IS SHAPED TO BE ANNOYING ─────────────────────────────────────────────
 * `docs/design/release-gates.md`: "A gate that fires spuriously gets bypassed, and
 * then the gates that matter get bypassed with it." The inverse is just as true — a
 * hatch that is quiet or cheap gets reached for, and then the gate is decoration. So
 * every property below is deliberate friction:
 *
 *   - It lives in CHANGELOG.md, in the OPEN section, so it is in the diff a reviewer
 *     reads and in git history forever. A PR label vanishes on merge; an env var was
 *     never visible at all. This is the same reasoning that put `--exempt` behind a
 *     PR label rather than `--no-verify`, taken one step further.
 *   - It cannot be written without STATING THE MEASURED NUMBER, and the number must
 *     itself be a breach. You cannot waive a gate without saying how badly you failed
 *     it.
 *   - It is PER-PR and NON-STICKY: the line must be absent from the base's CHANGELOG.
 *     The PR after this one inherits the text, so the identical line no longer waives
 *     anything — that PR must re-measure and state its own numbers. A waiver is spent
 *     on the diff that declares it.
 *   - It does NOT move the baseline. Waiving and re-anchoring are mutually exclusive:
 *     a PR that both waives and edits `peak` is refused. A waived breach is still a
 *     breach, against the same peak, for everyone who comes after.
 *   - The gate it waives still PRINTS THE FULL DRAWDOWN REPORT and exits loud. A
 *     waived run never renders as green.
 *
 * ── THE LINE ────────────────────────────────────────────────────────────────────
 *
 *   PERF-PEAK-WAIVER bench/workloads/config.json median -164.9% min -158.2% — <why>
 *
 * Quote the numbers as the gate printed them, load average included in the reason.
 */

/** The literal tag. Deliberately not a word that occurs in prose — contrast §D's
 *  `/\bpeak\b/i` CHANGELOG check, which the sentence "peak unchanged" satisfies. */
export const WAIVER_TAG = 'PERF-PEAK-WAIVER'

/** Free text short enough to be a shrug is not an explanation. */
const MIN_REASON_CHARS = 20

const NUM = String.raw`([+-]?\d+(?:\.\d+)?)`

/**
 * Every line in `section` that tries to be a waiver, parsed or diagnosed. A line is
 * "trying" as soon as it carries the tag — a malformed attempt is reported as a
 * FAILURE and never silently ignored, because a waiver that does not parse is a
 * contributor who believes they have waived the gate.
 *
 * @param {string} section  the CHANGELOG's open section (headings excluded)
 * @returns {{ line: string, config: string|null, medianPct: number|null,
 *             minPct: number|null, reason: string|null, problems: string[] }[]}
 */
export function parsePeakWaivers(section) {
  const out = []
  const re = new RegExp(String.raw`^[\s>*+\-]*${WAIVER_TAG}\b[ \t]*(.*)$`, 'gm')
  let m
  while ((m = re.exec(section)) !== null) {
    const rest = (m[1] ?? '').trim()
    const problems = []

    const cfg = /\b((?:[\w.-]+\/)+config\.json)\b/.exec(rest)
    if (cfg === null) {
      problems.push('names no gate config (expected e.g. `bench/workloads/config.json`)')
    }

    const med = new RegExp(String.raw`\bmedian\s+${NUM}\s*%`, 'i').exec(rest)
    if (med === null) problems.push('states no `median <n>%` — the measured drawdown must be in the line')

    const mn = new RegExp(String.raw`\bmin\s+${NUM}\s*%`, 'i').exec(rest)
    if (mn === null) problems.push('states no `min <n>%` — the peak clause breaches on median AND min, so both are quoted')

    // Everything after the last separator that follows the numbers. An em-dash is the
    // house style; `--` and `:` are accepted so the rule is about saying WHY, not
    // about typing a particular character.
    const tail = /(?:\s[—–]\s|\s--\s|:\s)([\s\S]+)$/.exec(rest)
    const reason = tail === null ? null : tail[1].trim()
    if (reason === null || reason.replace(/\s+/g, ' ').length < MIN_REASON_CHARS) {
      problems.push(
        `gives no reason (expected " — <why this cost buys something>", at least ${MIN_REASON_CHARS} characters)`,
      )
    }

    out.push({
      line: m[0].trim(),
      config: cfg?.[1] ?? null,
      medianPct: med === null ? null : Number(med[1]),
      minPct: mn === null ? null : Number(mn[1]),
      reason,
      problems,
    })
  }
  return out
}

/**
 * The CHANGELOG's open section — everything under the FIRST `##` heading, history
 * excluded. History must not be able to satisfy a claim about a change being made now;
 * this is the same slice §D already takes for the peak-edit check.
 *
 * @param {string} changelog
 * @returns {string}
 */
export function openSection(changelog) {
  const first = /^##\s+(.+)$/m.exec(changelog)
  if (first === null) return ''
  return (changelog.slice(first.index + first[0].length).split(/^##\s+/m)[0]) ?? ''
}

/**
 * A drawdown is only WAIVABLE if it is actually a breach. `allowancePct` is the
 * tolerated noise floor, so a "waiver" quoting a number inside it waives nothing and
 * is a sign the author has not read what went red.
 *
 * Magnitude, not sign: the harness prints `dMedian` as head-vs-reference where a
 * SLOWDOWN is positive (`+164.9%`), while people writing prose about a drawdown
 * reach for `-164.9%`. Both name the same breach, and rejecting one spelling would
 * be a gate about punctuation.
 *
 * @param {{ medianPct: number|null, minPct: number|null }} w
 * @param {number} allowancePct
 * @returns {boolean}
 */
export function isBreach(w, allowancePct) {
  return w.medianPct !== null && w.minPct !== null
    && Math.abs(w.medianPct) > allowancePct && Math.abs(w.minPct) > allowancePct
}

/**
 * Whether a measured, red peak run is WAIVED — the decision `workload-perf-guard.ts`
 * makes after printing its drawdown report.
 *
 * It lives here rather than inline in the guard so it is reachable by a test. The
 * guard's own failure branch needs a real measured breach to enter, which costs two
 * materialised worktrees and several minutes; the interesting logic — understatement
 * and staleness — would then be covered by nothing, which is how a hatch quietly stops
 * being checked.
 *
 * @param {object} o
 * @param {string} o.section        the CHANGELOG's open section
 * @param {string} o.config         this gate's config path, repo-relative
 * @param {{ version: string, sha: string, allowancePct: number }} o.peak
 * @param {{ dMedian: number, dMin: number }[]} o.breaching  the passes that breached
 * @param {string|null} o.base      the PR base ref, or null if not given
 * @param {string} o.baseChangelog  CHANGELOG.md at `base` ('' when unavailable)
 * @returns {{ applied: boolean, message: string }}
 */
export function decideWaiver({ section, config, peak, breaching, base, baseChangelog }) {
  const mine = parsePeakWaivers(section).filter((w) => w.config === config)
  if (mine.length === 0) return { applied: false, message: '' }
  const w = mine[0]

  const decline = (why) => ({
    applied: false,
    message: `\na ${WAIVER_TAG} for ${config} is in the CHANGELOG but is NOT honoured —\n  ${why}`,
  })

  if (w.problems.length > 0) {
    return decline(
      `it does not parse: ${w.problems.join('; ')}.`
        + '\n  Run `pnpm check:changelog --base=<ref>` — it reports the exact form.',
    )
  }
  if (!isBreach(w, peak.allowancePct)) {
    return decline(
      `it quotes median ${w.medianPct}% / min ${w.minPct}%, which is inside the`
        + ` ${peak.allowancePct}% allowance and therefore waives nothing.`,
    )
  }

  // You may not waive a breach by understating it. The bar is the MILDEST breaching
  // pass rather than the worst, so an honest quote of any breaching row is accepted and
  // this does not become a flake about which pass the author happened to copy.
  const mildestMedian = Math.min(...breaching.map((r) => Math.abs(r.dMedian)))
  const mildestMin = Math.min(...breaching.map((r) => Math.abs(r.dMin)))
  if (Math.abs(w.medianPct) < mildestMedian || Math.abs(w.minPct) < mildestMin) {
    return decline(
      `it UNDERSTATES the breach. It declares median ${w.medianPct}% / min ${w.minPct}%; the mildest`
        + ` breaching pass measured HERE is median ${mildestMedian.toFixed(1)}% / min ${mildestMin.toFixed(1)}%.`
        + '\n  A waiver is the number made visible — quote what the gate printed, not a softer figure.',
    )
  }

  if (base === null) {
    return decline(
      'freshness cannot be verified without `--base=<ref>`, so it is refused here by default.'
        + "\n  A waiver is PER-PR: it counts only while the line is ABSENT from the base's CHANGELOG."
        + '\n  Unchecked, the PR after the waiving one inherits the text and the peak clause is silently'
        + '\n  off for the rest of the release cycle. CI passes --base; pass it locally to reproduce.',
    )
  }
  if (baseChangelog.includes(w.line)) {
    return decline(
      `this exact line is ALREADY on the base (${base}), so it is not this PR's waiver.`
        + "\n  A waiver is spent on the diff that declares it. Re-run this gate and state THIS diff's"
        + '\n  numbers, or fix the drawdown.',
    )
  }

  const over = (n) => `${(Math.abs(n) / peak.allowancePct).toFixed(1)}x`
  return {
    applied: true,
    message:
      '\nPEAK CLAUSE WAIVED — the drawdown above is REAL and is NOT forgiven, it is DECLARED.'
      + `\n  declared: median ${w.medianPct}% / min ${w.minPct}%`
      + ` (${over(w.medianPct)} and ${over(w.minPct)} the ${peak.allowancePct}% allowance)`
      + `\n  reason:   ${w.reason}`
      + `\n\n  The peak record is UNCHANGED: ${peak.version} (${peak.sha}) is still the bar, and this`
      + '\n  waiver did NOT raise it. The next PR is measured against the same peak, will go red in'
      + '\n  exactly the same way, and must state its own measurement — this line will not carry.'
      + '\n  A waived breach is still a breach on the record.',
  }
}
