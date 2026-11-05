type Piece = (input: string, pos: number) => number

export function lowerSequence(pieces: readonly Piece[], adjacent: boolean): Piece {
  if (adjacent) {
    const runAdjacent = (input: string, pos: number): number => {
      let cur = pos
      for (let i = 0; i < pieces.length; i++) {
        const next = pieces[i]!(input, cur)
        if (next < 0) return -1
        cur = next
      }
      if (cur > input.length) throw new RangeError('a piece ran past the end of the input')
      return cur
    }
    return runAdjacent
  }
  const runDirect = (text: string, at: number): number => {
    let end = at
    for (let k = 0; k < pieces.length; k++) {
      const step = pieces[k]!(text, end)
      if (step < 0) return -1
      end = step
    }
    if (end > text.length) throw new RangeError('a piece ran past the end of the input')
    return end
  }
  return runDirect
}
