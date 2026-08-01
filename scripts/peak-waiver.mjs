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
