# The absorbable share — measured

Shipping jess grammars, built 2026-07-30 against parseman 0.43.0. **AST path.**
61 interleaved rounds in one process, order rotated per round, batched samples.

## Census — instrument-independent (exact counts, not sampled)

| | css / `benchmark.css` | less / `benchmark.less` |
| --- | ---: | ---: |
| corpus bytes | 123,029 | 106,802 |
| `charCodeAt` | 538,533 | 1,142,228 |
| `codePointAt` | 52,404 | 106,267 |
| regex `exec` calls | 33,047 | 20,818 |
| … of which **FAILED** | **13,933 (42.2%)** | **11,803 (56.7%)** |
| regex chars consumed | 92,164 | 51,242 |
| dispatch-key char reads | 4,062 | 2,727 |
| `input.slice` calls / bytes | 10,943 / 117,427 | 46,694 / 483,251 |
| **total input char reads** | **697,034** | **1,311,540** |
| distinct positions touched | 123,029 | 106,802 |
| **coverage of the file** | **100%** | **100%** |
| **reads per input byte (R)** | **5.67** | **12.28** |

Regex objects allocated during the parse: **0** on both — the emitted regex
literals sit in a per-rule IIFE closure evaluated once at module load, not per
call. Checked because a per-call allocation would have been a real cost; it is
not there.

## Timing

| case | css ms (median / min) | share of parse | less ms (median / min) | share of parse |
| --- | ---: | ---: | ---: | ---: |
| `parse` (AST) | 5.636 / 5.205 | — | 17.234 / 15.628 | — |
| `parse-control` | 5.850 / 5.360 | +3.8% / +3.0% | 17.276 / 16.063 | +0.2% / +2.8% |
| `replay-cc` | 0.302 / 0.287 | 5.4% | 0.651 / 0.630 | 3.8% |
| `replay-ex` | 0.763 / 0.729 | 13.5% | 0.492 / 0.456 | 2.9% |
| **`replay-all`** | **1.334 / 0.969** | **23.7% / 18.6%** | **1.762 / 1.104** | **10.2% / 7.1%** |
| `replay-slice` | 0.043 / 0.040 | 0.8% | 0.208 / 0.186 | 1.2% |
| **`scan-emit`** | **0.441 / 0.410** | **7.8% / 7.9%** | **0.234 / 0.217** | **1.4%** |
| `scan1` (pure reads) | 0.187 / 0.172 | 3.3% | 0.167 / 0.157 | 1.0% |

## The answers

**§10.3 was UNKNOWN. It is now measured.**

1. **The absorbable share — char-level work a token cursor takes over — is 18.6%
   of css parse time and 7.1% of less parse time**, as a lower bound.
2. **The cursor pays 7.9% (css) and 1.4% (less)** for a context-free emitting
   scan at the finest grain, measured live in the same run.
3. **Net ceiling for a scanner-shaped change: ~10.7 points on css, ~5.7 on less.**
4. **The cursor absorbs 2.4× (css) and 5.1× (less) what a blind one-pass
   tokenizer does** by time, and 5.7× / 12.3× by read count. §10.3's open
   question — does a cursor move substantially MORE char work into the scanner? —
   is answered **yes**, and the multiple is now a number.

## The two results that were not being asked for

**The redundancy inverts against the time share.** less reads each byte **2.2×
more often** than css and yet char work is a **2.6× smaller** share of its parse
time. less's 3× slower parse is not character reading; it is the speculation and
allocation mass. The scanner headroom is a **css** result, and §9.1.1's "redirect
to the save/restore mass" is specifically the **less** prescription.

**42–57% of every regex terminal execution FAILS.** 13,933 of 33,047 on css,
11,803 of 20,818 on less. On css that failing half is inside the single largest
char-cost category (`replay-ex`, 13.5% of parse — more than twice `replay-cc`).
This is the arms-tried cost model of §3, measured: a failed arm re-reads the same
bytes the next arm will read. Token-keyed dispatch removes it by construction.
