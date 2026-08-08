import { foldA } from './a.ts'
import { foldB } from './b.ts'
export const both = (s: string): string => foldA(s) + foldB(s)
