/** Shared µs timing helpers for bench/run.ts and chart collection. */

export function warmUs(fn: () => unknown, iterations: number): number {
  for (let i = 0; i < Math.min(iterations / 10, 1000); i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  return (performance.now() - start) / iterations * 1000
}

export function setupUs(fn: () => unknown, iterations: number): number {
  for (let i = 0; i < Math.min(iterations / 10, 20); i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  return (performance.now() - start) / iterations * 1000
}
