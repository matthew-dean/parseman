import { describe, expect, it } from 'vitest'
import { solveCrossover } from '../../bench/jess/load-crossover.ts'

describe('Jess load/parse crossover', () => {
  it('reports the usual exec-load/assembled-parse crossover', () => {
    expect(solveCrossover(10, 2)).toEqual({ kind: 'positive', bytes: 5, below: 'exec', above: 'assembled' })
  })

  it('reports the reversed assembled-load/exec-parse crossover', () => {
    expect(solveCrossover(-10, -2)).toEqual({ kind: 'positive', bytes: 5, below: 'assembled', above: 'exec' })
  })

  it('reports dominance for opposite-sign and zero deltas', () => {
    expect(solveCrossover(-10, 2)).toEqual({ kind: 'dominant', winner: 'assembled' })
    expect(solveCrossover(10, -2)).toEqual({ kind: 'dominant', winner: 'exec' })
    expect(solveCrossover(0, 2)).toEqual({ kind: 'dominant', winner: 'assembled' })
    expect(solveCrossover(0, -2)).toEqual({ kind: 'dominant', winner: 'exec' })
    expect(solveCrossover(-10, 0)).toEqual({ kind: 'dominant', winner: 'assembled' })
    expect(solveCrossover(10, 0)).toEqual({ kind: 'dominant', winner: 'exec' })
    expect(solveCrossover(0, 0)).toEqual({ kind: 'dominant', winner: 'tie' })
  })
})
