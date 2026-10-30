import { parse, type PathCommand } from 'opentype.js'
import latoBoldUrl from '../assets/fonts/Lato-Bold.ttf?url'
import type { Contour, Point, TextFont } from './textMesh'

/**
 * Loads Lato Bold, the same font the backend draws the slug label with on
 * the OG image (`backend/src/og_image.rs`), and adapts it to the TextFont
 * interface the 3D print mesh builder uses. Imported dynamically by the
 * 3D print modal so opentype.js and the font file only load when the user
 * turns on a text line.
 */

/** Straight segments per curve. Enough for smooth glyphs at badge scale. */
const CURVE_SEGMENTS = 6

/** Converts one glyph's path commands (y-down) into closed y-up contours. */
export function commandsToContours(commands: PathCommand[]): Contour[] {
  const contours: Contour[] = []
  let current: Point[] = []
  let cursor: Point = [0, 0]
  const add = (x: number, y: number) => {
    cursor = [x, y]
    current.push([x, -y])
  }
  const close = () => {
    if (current.length >= 3) contours.push(current)
    current = []
  }

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        close()
        add(cmd.x, cmd.y)
        break
      case 'L':
        add(cmd.x, cmd.y)
        break
      case 'Q': {
        const [x0, y0] = cursor
        for (let i = 1; i <= CURVE_SEGMENTS; i++) {
          const t = i / CURVE_SEGMENTS
          const u = 1 - t
          add(
            u * u * x0 + 2 * u * t * cmd.x1 + t * t * cmd.x,
            u * u * y0 + 2 * u * t * cmd.y1 + t * t * cmd.y,
          )
        }
        break
      }
      case 'C': {
        const [x0, y0] = cursor
        for (let i = 1; i <= CURVE_SEGMENTS; i++) {
          const t = i / CURVE_SEGMENTS
          const u = 1 - t
          add(
            u * u * u * x0 + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t * t * t * cmd.x,
            u * u * u * y0 + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t * t * t * cmd.y,
          )
        }
        break
      }
      case 'Z':
        close()
        break
    }
  }
  close()

  // Paths usually return to their start point before closing; the closing
  // edge is implicit, so drop the duplicate.
  return contours.map((c) => {
    const [fx, fy] = c[0]
    const [lx, ly] = c[c.length - 1]
    return fx === lx && fy === ly ? c.slice(0, -1) : c
  })
}

/** Wraps parsed font bytes as a TextFont. */
export function parseTextFont(buffer: ArrayBuffer): TextFont {
  const font = parse(buffer)
  const upm = font.unitsPerEm
  return {
    capHeight: (font.tables.os2?.sCapHeight ?? font.ascender * 0.7) / upm,
    descender: Math.abs(font.descender) / upm,
    advanceWidth: (text, sizeMm) => font.getAdvanceWidth(text, sizeMm),
    glyphContours: (text, sizeMm) =>
      font
        .getPaths(text, 0, 0, sizeMm)
        .map((path) => commandsToContours(path.commands))
        .filter((glyph) => glyph.length > 0),
  }
}

let cached: Promise<TextFont> | null = null

/** Fetches and parses the font once per page load; retries after a failure. */
export function loadTextFont(): Promise<TextFont> {
  cached ??= fetch(latoBoldUrl)
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load font: HTTP ${res.status}`)
      return res.arrayBuffer()
    })
    .then(parseTextFont)
    .catch((err: unknown) => {
      cached = null
      throw err
    })
  return cached
}
