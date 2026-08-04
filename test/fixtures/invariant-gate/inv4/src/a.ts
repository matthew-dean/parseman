export function foldA(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 65 && c <= 90) out += String.fromCharCode(c + 32)
    else if (c === 45 || c === 95) out += "_"
    else if (c === 32 || c === 9) out += "-"
    else out += s[i]
  }
  return out.length > 0 ? out : "empty"
}
