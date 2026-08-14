/**
 * One definition of "this workload parsed its whole input" for every workload
 * instrument. Equality between A/B results is necessary, but two identical
 * partial parses are still two wrong benchmark legs.
 */

export type WorkloadParseResult = {
  ok?: boolean
  span?: { start: number; end: number }
  /** Present on `run()` results; raw compiled ParseResults omit it. */
  unconsumedFrom?: number | null
}

/**
 * Fail closed on a failed or partial parse. `ok` is deliberately checked before
 * either consumption field: a failed parse's span describes the failure, not
 * successful consumption, and `unconsumedFrom` is only meaningful on success.
 */
export function assertWorkloadFullyConsumed(
  side: string,
  id: string,
  input: string,
  result: unknown,
): void {
  const parsed = result as WorkloadParseResult | null | undefined
  if (parsed?.ok !== true) {
    throw new Error(`${side} workload ${id}: parse FAILED; refusing to benchmark an error path.`)
  }

  if (parsed.span === undefined) {
    throw new Error(`${side} workload ${id}: successful parse has no span; full consumption cannot be proved.`)
  }
  if (parsed.span.start !== 0) {
    throw new Error(`${side} workload ${id}: parse started at ${parsed.span.start}, not byte 0.`)
  }
  if (parsed.unconsumedFrom !== undefined && parsed.unconsumedFrom !== null) {
    throw new Error(
      `${side} workload ${id}: parse left input unconsumed from byte ${parsed.unconsumedFrom}`
      + ` (${input.length} bytes total).`,
    )
  }
  if (parsed.span.end !== input.length) {
    throw new Error(
      `${side} workload ${id}: parse stopped at byte ${parsed.span.end}`
      + ` of ${input.length}; refusing to benchmark a partial success.`,
    )
  }
}
