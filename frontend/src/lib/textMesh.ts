import earcut from 'earcut'
import type { Mesh } from './qr3mf'

/**
 * Extrudes font glyph outlines into watertight relief for the 3D print
 * tag. Font parsing lives in `textFont.ts`; this module only sees closed
 * polylines, so it has no font-library dependency and the geometry is
 * testable on its own.
 */

export type Point = readonly [number, number]
/** A closed polyline (the last point connects back to the first). */
export type Contour = Point[]

/** A font laid out in millimeters, with y pointing up from the baseline. */
export interface TextFont {
  /** Cap height as a fraction of the em size. */
  capHeight: number
  /** Descender depth below the baseline as a fraction of the em size (positive). */
  descender: number
  /** Kerned advance width of `text` at an em size of `sizeMm`. */
  advanceWidth(text: string, sizeMm: number): number
  /**
   * Closed outlines for each glyph in `text` at an em size of `sizeMm`,
   * starting at x=0 on a baseline at y=0. One entry per glyph; glyphs
   * without ink (spaces) are omitted.
   */
  glyphContours(text: string, sizeMm: number): Contour[][]
}

function signedArea(contour: Contour): number {
  let area = 0
  for (let i = 0; i < contour.length; i++) {
    const [x0, y0] = contour[i]
    const [x1, y1] = contour[(i + 1) % contour.length]
    area += x0 * y1 - x1 * y0
  }
  return area / 2
}

function pointInContour([px, py]: Point, contour: Contour): boolean {
  let inside = false
  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    const [xi, yi] = contour[i]
    const [xj, yj] = contour[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Drops repeated and exactly collinear points. earcut silently skips such
 * points, which would leave the side walls referencing vertices the caps
 * don't use and open a gap in the mesh.
 */
function cleanContour(contour: Contour): Contour {
  let points = contour.filter((p, i) => {
    const prev = contour[(i - 1 + contour.length) % contour.length]
    return p[0] !== prev[0] || p[1] !== prev[1]
  })
  let changed = true
  while (changed && points.length >= 3) {
    changed = false
    const next: Point[] = []
    for (let i = 0; i < points.length; i++) {
      const a = points[(i - 1 + points.length) % points.length]
      const b = points[i]
      const c = points[(i + 1) % points.length]
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
      if (cross === 0) {
        changed = true
        continue
      }
      next.push(b)
    }
    points = next
  }
  return points
}

/**
 * Groups one glyph's contours into outlines and their holes by nesting
 * depth: even depth is solid, odd depth is a hole in its parent. Depth is
 * used instead of winding direction so fonts with either convention work.
 */
function groupShapes(contours: Contour[]): { outer: Contour; holes: Contour[] }[] {
  const depths = contours.map((c, i) =>
    contours.reduce((d, other, j) => (j !== i && pointInContour(c[0], other) ? d + 1 : d), 0),
  )
  const shapes = contours
    .map((outer, i) => ({ outer, index: i, holes: [] as Contour[] }))
    .filter(({ index }) => depths[index] % 2 === 0)

  contours.forEach((hole, i) => {
    if (depths[i] % 2 === 0) return
    const parent = shapes
      .filter((s) => depths[s.index] === depths[i] - 1 && pointInContour(hole[0], s.outer))
      .sort((a, b) => Math.abs(signedArea(a.outer)) - Math.abs(signedArea(b.outer)))[0]
    parent?.holes.push(hole)
  })
  return shapes
}

/**
 * Adds an extruded solid for one shape (an outline plus its holes) between
 * z0 and z1. Cap and wall triangles share vertices, so the result is
 * watertight.
 */
function addExtrudedShape(
  mesh: Mesh,
  outer: Contour,
  holes: Contour[],
  dx: number,
  dy: number,
  z0: number,
  z1: number,
) {
  // Outline counter-clockwise, holes clockwise: the solid is always on the
  // left of each edge, which fixes the outward direction of every wall.
  const rings = [
    signedArea(outer) < 0 ? [...outer].reverse() : outer,
    ...holes.map((h) => (signedArea(h) > 0 ? [...h].reverse() : h)),
  ]

  const coords: number[] = []
  const holeIndices: number[] = []
  for (const [r, ring] of rings.entries()) {
    if (r > 0) holeIndices.push(coords.length / 2)
    for (const [x, y] of ring) coords.push(x, y)
  }
  const count = coords.length / 2

  const bottom = mesh.vertices.length / 3
  const top = bottom + count
  for (let i = 0; i < count; i++) mesh.vertices.push(coords[2 * i] + dx, coords[2 * i + 1] + dy, z0)
  for (let i = 0; i < count; i++) mesh.vertices.push(coords[2 * i] + dx, coords[2 * i + 1] + dy, z1)

  const tris = earcut(coords, holeIndices, 2)
  for (let t = 0; t < tris.length; t += 3) {
    let [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]]
    const cross =
      (coords[2 * b] - coords[2 * a]) * (coords[2 * c + 1] - coords[2 * a + 1]) -
      (coords[2 * b + 1] - coords[2 * a + 1]) * (coords[2 * c] - coords[2 * a])
    if (cross < 0) [b, c] = [c, b]
    mesh.triangles.push(top + a, top + b, top + c) // top cap (+z)
    mesh.triangles.push(bottom + a, bottom + c, bottom + b) // bottom cap (-z)
  }

  let start = 0
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const a = start + i
      const b = start + ((i + 1) % n)
      mesh.triangles.push(bottom + a, bottom + b, top + b, bottom + a, top + b, top + a)
    }
    start += n
  }
}

/**
 * Extrudes laid-out glyphs into `mesh`, offset by (dx, dy), from z0 to z1.
 * Each glyph is grouped separately so overlapping neighbors (tight
 * kerning) can't be mistaken for holes in each other.
 */
export function addTextRelief(
  mesh: Mesh,
  glyphs: Contour[][],
  dx: number,
  dy: number,
  z0: number,
  z1: number,
) {
  for (const glyph of glyphs) {
    const contours = glyph.map(cleanContour).filter((c) => c.length >= 3)
    for (const { outer, holes } of groupShapes(contours)) {
      addExtrudedShape(mesh, outer, holes, dx, dy, z0, z1)
    }
  }
}
