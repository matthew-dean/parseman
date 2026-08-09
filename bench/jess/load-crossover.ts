/**
 * `loadDelta` is assembled-load minus exec-load. `rateDelta` is exec-parse
 * minus assembled-parse per byte. Positive values therefore describe the
 * familiar shape: exec loads faster, assembled parses faster.
 */
export type Crossover =
  | { kind: 'positive', bytes: number, below: 'assembled' | 'exec', above: 'assembled' | 'exec' }
  | { kind: 'dominant', winner: 'assembled' | 'exec' | 'tie' }

export function solveCrossover(loadDelta: number, rateDelta: number): Crossover {
  if (!Number.isFinite(loadDelta) || !Number.isFinite(rateDelta)) {
    throw new Error('crossover deltas must be finite')
  }
  if (loadDelta === 0 && rateDelta === 0) return { kind: 'dominant', winner: 'tie' }
  if (loadDelta === 0) return { kind: 'dominant', winner: rateDelta > 0 ? 'assembled' : 'exec' }
  if (rateDelta === 0) return { kind: 'dominant', winner: loadDelta < 0 ? 'assembled' : 'exec' }
  if (Math.sign(loadDelta) !== Math.sign(rateDelta)) {
    return { kind: 'dominant', winner: loadDelta < 0 ? 'assembled' : 'exec' }
  }
  return loadDelta > 0
    ? { kind: 'positive', bytes: loadDelta / rateDelta, below: 'exec', above: 'assembled' }
    : { kind: 'positive', bytes: loadDelta / rateDelta, below: 'assembled', above: 'exec' }
}
