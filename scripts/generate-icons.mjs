#!/usr/bin/env node
/**
 * Generates the OpeniWatch application icons.
 *
 * The icons are committed to `public/icons/`, so this script does not run
 * during a build. It exists so the marks are reproducible rather than being
 * opaque binaries nobody can regenerate — run it after changing the palette or
 * the glyph and commit the result.
 *
 *   node scripts/generate-icons.mjs
 *
 * PNGs are written with Node's own zlib. No image library, no network, no
 * binary assets pulled from anywhere.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'icons')

/** Openi blue, matching --primary in src/index.css (hsl 216 82% 44%). */
const BRAND = hslToRgb(216, 0.82, 0.44)
/** A slightly deeper shade for the plate edge, so the mark reads on white. */
const BRAND_DEEP = hslToRgb(216, 0.82, 0.34)
const WHITE = [255, 255, 255]

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x]
  const m = l - c / 2
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255))
}

/**
 * Signed coverage of a shield silhouette at normalized coordinates.
 *
 * `x` and `y` run -1..1 with y increasing downward. Returns 1 inside, 0
 * outside, and a fractional value is produced by supersampling in `render`.
 */
function insideShield(x, y) {
  // t: 0 at the top of the shield, 1 at the point.
  const t = (y + 1) / 2
  if (t < 0 || t > 1) return false

  const SHOULDER = 0.4
  const HALF = 0.68

  let halfWidth
  if (t <= SHOULDER) {
    halfWidth = HALF
    // Soften the top corners just enough that the mark does not read as a
    // rectangle at 32px — but not so much that it loses its shoulders.
    const corner = 0.1
    if (t < corner) {
      const k = 1 - t / corner
      halfWidth = HALF * Math.sqrt(Math.max(0, 1 - k * k))
    }
  } else {
    // Flanks fall away and converge to a point. A cosine taper keeps the sides
    // nearly straight through the upper half and sharpens at the tip; an
    // elliptical one rounds the bottom off and the mark reads as a "U".
    const k = (t - SHOULDER) / (1 - SHOULDER)
    halfWidth = HALF * Math.cos((k * Math.PI) / 2) ** 0.75
  }
  return Math.abs(x) <= halfWidth
}

/** Rounded-square plate covering the full canvas, as used by Android/iOS. */
function insidePlate(x, y, radius) {
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  const limit = 1 - radius
  if (ax <= limit || ay <= limit) return ax <= 1 && ay <= 1
  const dx = ax - limit
  const dy = ay - limit
  return dx * dx + dy * dy <= radius * radius
}

/**
 * Renders one icon.
 *
 * `scale` shrinks the glyph within the canvas. Maskable icons use a smaller
 * value so the mark survives the circular crop Android applies — anything
 * outside the middle 80% can be cut off.
 */
function render(size, { scale, plate, plateRadius = 0.42, transparent = false }) {
  const pixels = Buffer.alloc(size * size * 4)
  const SS = 3 // supersampling factor per axis, for smooth edges

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let plateHits = 0
      let shieldHits = 0

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = ((px + (sx + 0.5) / SS) / size) * 2 - 1
          const y = ((py + (sy + 0.5) / SS) / size) * 2 - 1
          if (plate && insidePlate(x, y, plateRadius)) plateHits += 1
          if (insideShield(x / scale, y / scale)) shieldHits += 1
        }
      }

      const total = SS * SS
      const plateA = plate ? plateHits / total : 0
      const shieldA = shieldHits / total

      // Composite: brand plate underneath, white shield on top.
      let r
      let g
      let b
      let a
      if (plate) {
        const base = plateA > 0 ? BRAND : [0, 0, 0]
        r = base[0] * plateA
        g = base[1] * plateA
        b = base[2] * plateA
        a = plateA
        // White shield over the plate.
        r = WHITE[0] * shieldA + r * (1 - shieldA)
        g = WHITE[1] * shieldA + g * (1 - shieldA)
        b = WHITE[2] * shieldA + b * (1 - shieldA)
        a = Math.max(a, shieldA)
      } else {
        const fill = transparent ? BRAND_DEEP : BRAND
        r = fill[0]
        g = fill[1]
        b = fill[2]
        a = shieldA
      }

      const i = (py * size + px) * 4
      pixels[i] = Math.round(r)
      pixels[i + 1] = Math.round(g)
      pixels[i + 2] = Math.round(b)
      pixels[i + 3] = Math.round(a * 255)
    }
  }
  return pixels
}

/** Minimal PNG writer: 8-bit RGBA, one IDAT, no ancillary chunks. */
function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0 // filter type 0 (None)
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}

const ICONS = [
  // Standard "any" icons: brand plate, glyph filling most of it.
  { file: 'icon-192.png', size: 192, opts: { scale: 0.68, plate: true } },
  { file: 'icon-512.png', size: 512, opts: { scale: 0.68, plate: true } },
  // Maskable: the glyph sits inside the 80% safe zone so a circular crop keeps
  // it whole. The plate runs to the edges with almost no corner radius,
  // because the launcher supplies the shape.
  {
    file: 'icon-maskable-192.png',
    size: 192,
    opts: { scale: 0.46, plate: true, plateRadius: 0.02 },
  },
  {
    file: 'icon-maskable-512.png',
    size: 512,
    opts: { scale: 0.46, plate: true, plateRadius: 0.02 },
  },
  // iOS home screen. iOS applies its own rounding and does not support
  // transparency, so this is a full-bleed plate.
  { file: 'apple-touch-icon.png', size: 180, opts: { scale: 0.64, plate: true, plateRadius: 0.02 } },
  // Browser tab.
  { file: 'favicon-32.png', size: 32, opts: { scale: 0.9, plate: false, transparent: true } },
]

mkdirSync(OUT, { recursive: true })
for (const { file, size, opts } of ICONS) {
  const png = encodePng(size, render(size, opts))
  writeFileSync(join(OUT, file), png)
  console.log(`${file.padEnd(28)} ${size}x${size}  ${png.length} bytes`)
}
console.log(`\nWrote ${ICONS.length} icons to public/icons/`)
