/** Shared µs timing helpers for bench/run.ts and chart collection. */

export function warmUs(fn: () => unknown, iterations: number): number {
  for (let i = 0; i < Math.min(iterations / 10, 1000); i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  return (performance.now() - start) / iterations * 1000
}

/**
 * warmUs with a real warmup and a median over several passes.
 *
 * A single timed window right after a short warmup can catch the function before
 * V8 has optimized it — measured on a low-iteration case, the first pass read
 * ~5.2µs against a ~2.2µs steady state. Use an ODD pass count: median() of an
 * even list returns the upper element, i.e. the cold pass.
 */
export function warmUsRobust(fn: () => unknown, iterations: number, passes = 5): number {
  for (let i = 0; i < Math.max(2000, Math.min(iterations, 20_000)); i++) fn()
  const perPass: number[] = []
  for (let p = 0; p < passes; p++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) fn()
    perPass.push((performance.now() - start) / iterations * 1000)
  }
  perPass.sort((a, b) => a - b)
  return perPass[Math.floor(perPass.length / 2)]!
}

export function setupUs(fn: () => unknown, iterations: number): number {
  for (let i = 0; i < Math.min(iterations / 10, 20); i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  return (performance.now() - start) / iterations * 1000
}
