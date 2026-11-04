type Piece = { end: number, text: string }

export function lowerAll(pieces: readonly Piece[]): number[] {
  const ends = pieces.map((piece) => {
    if (piece.end < 0) throw new RangeError('a piece ended before the start of the input')
    if (piece.end > piece.text.length) throw new RangeError('a piece ended past its text')
    return piece.end
  })
  const moreEnds = pieces.map((piece) => {
    if (piece.end < 0) throw new RangeError('a piece ended before the start of the input')
    if (piece.end > piece.text.length) throw new RangeError('a piece ended past its text')
    return piece.end
  })
  const sizes = pieces.map((piece) => {
    if (piece.text.length === 0) throw new RangeError('an empty piece has no size to report')
    if (piece.text.length > 4096) throw new RangeError('a piece is too long to report a size')
    return piece.text.length
  })
  const moreSizes = pieces.map((piece) => {
    if (piece.text.length === 0) throw new RangeError('an empty piece has no size to report')
    if (piece.text.length > 4096) throw new RangeError('a piece is too long to report a size')
    return piece.text.length
  })
  return [...ends, ...moreEnds, ...sizes, ...moreSizes]
}
