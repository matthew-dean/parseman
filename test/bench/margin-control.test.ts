import { describe, expect, it } from 'vitest'
import { marginRoundSlots, pairedControlSpread } from '../../bench/margin-control.ts'

describe('comparison-chart A/A control', () => {
  it('measures aligned rounds instead of dividing unrelated minima', () => {
    const subject = [511.913, 352.097, 353.871]
    const control = [359.970, 421.695, 351.004]

    expect(pairedControlSpread(subject, control)).toBeCloseTo(421.695 / 352.097, 12)
    expect(pairedControlSpread(subject, control)).toBeGreaterThan(1.19)
  })

  it('uses the typical paired spread instead of letting one loaded child veto the run', () => {
    const subject = [1.08759168, 1.14635, 1.12735916]
    const control = [1.09871668, 1.13448334, 1.44430084]

    expect(pairedControlSpread(subject, control)).toBeCloseTo(1.14635 / 1.13448334, 12)
    expect(pairedControlSpread(subject, control)).toBeLessThan(1.02)
  })

  it('places the control beside the subject and alternates their order', () => {
    const real = ['subject', 'a', 'b', 'c', 'd', 'e', 'f'].map(slot => ({ slot, key: slot }))
    const control = { slot: 'control', key: 'subject' }
    const shift = 2

    for (let round = 0; round < 4; round++) {
      const slots = marginRoundSlots(real, round, shift, 'subject', control)
      const subjectAt = slots.findIndex(s => s.slot === 'subject')
      const controlAt = slots.findIndex(s => s.slot === 'control')
      expect(Math.abs(subjectAt - controlAt)).toBe(1)
      expect(controlAt > subjectAt).toBe(round % 2 === 0)
      expect(slots.filter(s => s.slot !== 'control').map(s => s.slot))
        .toEqual(real.map((_, k) => real[(k + round * shift) % real.length]!.slot))
    }
  })
})
