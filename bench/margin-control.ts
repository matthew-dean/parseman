import { median } from './ab-harness.ts'

export function pairedControlSpread(subject: readonly number[], control: readonly number[]): number {
  if (subject.length === 0 || subject.length !== control.length) {
    throw new Error(`margin control needs equal non-empty rounds: ${subject.length} != ${control.length}`)
  }
  const spreads: number[] = []
  for (let i = 0; i < subject.length; i++) {
    const ratio = control[i]! / subject[i]!
    spreads.push(Math.max(ratio, 1 / ratio))
  }
  return median(spreads)
}

export type MarginSlot = { slot: string; key: string }

/** Rotate real bars, then keep the A/A control adjacent to its subject. */
export function marginRoundSlots(
  realSlots: readonly MarginSlot[],
  round: number,
  shift: number,
  subject: string,
  control: MarginSlot,
): MarginSlot[] {
  const rotated = realSlots.map((_, k) => realSlots[(k + round * shift) % realSlots.length]!)
  const subjectAt = rotated.findIndex(s => s.slot === subject)
  if (subjectAt < 0) throw new Error(`margin control subject '${subject}' is missing`)
  rotated.splice(subjectAt + (round % 2 === 0 ? 1 : 0), 0, control)
  return rotated
}
