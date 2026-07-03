/**
 * Generate a lean favicon set for the docs site from a single source image.
 *
 * A documentation site realistically needs browser-tab icons and an iOS
 * home-screen icon — not PWA install icons, Android maskables, or Windows
 * tiles. So we emit just favicon.ico, 16/32/48 PNGs, and one 180×180 Apple
 * touch icon into docs/public/ (VitePress serves it at the site root), plus a
 * handful of <link>/<meta> tags written to docs/.vitepress/head-icons.ts as
 * VitePress HeadConfig tuples so the config stays in sync on every re-run.
 *
 * Run: pnpm docs:favicons
 */
import { favicons } from 'favicons'
import sharp from 'sharp'
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'assets', 'favicon.png')
const OUT_DIR = join(root, 'docs', 'public')
const HEAD_MODULE = join(root, 'docs', '.vitepress', 'head-icons.ts')

// GitHub Pages project site — every href needs the /parseman/ base prefix.
const BASE = '/parseman/'

/** Files this script owns in docs/public — cleaned before each run. */
const OWNED = /^(favicon.*\.(ico|png|svg)|apple-touch-icon.*\.png|android-chrome-.*\.png|mstile-.*\.png|manifest\.webmanifest|browserconfig\.xml)$/

const THEME_COLOR = '#ce2b37'

const configuration = {
  path: BASE,
  appName: 'Parséman',
  background: '#ffffff',
  theme_color: THEME_COLOR,
  icons: {
    // Browser tab icons: tight-cropped source, edge-to-edge.
    favicons: true,
    // Apple home-screen icon: full-bleed opaque square; iOS rounds the corners.
    appleIcon: { background: '#ffffff', transparent: false },
    // Everything else (Android/PWA, Windows tiles, Apple startup) is overkill
    // for a docs site and just bloats the output.
    android: false,
    windows: false,
    appleStartup: false,
    yandex: false,
  },
}

/** The only icons a docs site actually uses — everything else is filtered out. */
const KEEP = new Set([
  'favicon.ico',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon-48x48.png',
  'apple-touch-icon-180x180.png',
])

/** Hand-built head tags: tab icons, one Apple touch icon, and a theme color. */
const HEAD = [
  ['link', { rel: 'icon', type: 'image/x-icon', href: `${BASE}favicon.ico` }],
  ['link', { rel: 'icon', type: 'image/png', sizes: '16x16', href: `${BASE}favicon-16x16.png` }],
  ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${BASE}favicon-32x32.png` }],
  ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: `${BASE}apple-touch-icon-180x180.png` }],
  ['meta', { name: 'theme-color', content: THEME_COLOR }],
]

/**
 * Crop empty margin from the source and center the artwork in a square canvas.
 *
 * The favicons package scales with `fit: contain`, so any padding in the source
 * is preserved at every output size — the logo ends up noticeably small in
 * browser tabs. White/transparent margins do not trim reliably (corners match
 * the border), so we detect content by deviation from the corner color.
 */
async function cropToSquareContent(sourcePath) {
  const { data, info } = await sharp(sourcePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels: ch } = info

  const corner = (x, y) => {
    const i = (y * w + x) * ch
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }
  const bg = corner(0, 0).map((v, j) =>
    Math.round((v + corner(w - 1, 0)[j] + corner(0, h - 1)[j] + corner(w - 1, h - 1)[j]) / 4),
  )

  const isBackground = (i) => {
    const dr = Math.abs(data[i] - bg[0])
    const dg = Math.abs(data[i + 1] - bg[1])
    const db = Math.abs(data[i + 2] - bg[2])
    const da = Math.abs(data[i + 3] - bg[3])
    return dr + dg + db + da < 40
  }

  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isBackground((y * w + x) * ch)) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX) return sharp(sourcePath).png().toBuffer()

  const side = Math.max(maxX - minX + 1, maxY - minY + 1)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  let left = Math.round(cx - side / 2)
  let top = Math.round(cy - side / 2)
  left = Math.max(0, Math.min(left, w - side))
  top = Math.max(0, Math.min(top, h - side))

  return sharp(sourcePath)
    .extract({ left, top, width: side, height: side })
    .png()
    .toBuffer()
}

async function main() {
  // Clean previously generated icons so removed sizes don't linger.
  await mkdir(OUT_DIR, { recursive: true })
  for (const name of await readdir(OUT_DIR)) {
    if (OWNED.test(name)) await rm(join(OUT_DIR, name))
  }

  const cropped = await cropToSquareContent(SOURCE)
  const response = await favicons(cropped, configuration)

  const kept = response.images.filter((img) => KEEP.has(img.name))
  await Promise.all(
    kept.map((img) => writeFile(join(OUT_DIR, img.name), img.contents)),
  )

  const banner =
    '// AUTO-GENERATED by scripts/gen-favicons.mjs — do not edit.\n' +
    '// Regenerate with: pnpm docs:favicons\n' +
    "import type { HeadConfig } from 'vitepress'\n\n"
  await writeFile(
    HEAD_MODULE,
    banner + 'export const faviconHead: HeadConfig[] = ' + JSON.stringify(HEAD, null, 2) + '\n',
  )

  console.log(
    `favicons: wrote ${kept.length} images to docs/public/, ` +
      `${HEAD.length} head tags to docs/.vitepress/head-icons.ts`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
