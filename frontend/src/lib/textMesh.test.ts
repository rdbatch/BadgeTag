import { addTextRelief, type Contour } from './textMesh'
import type { Mesh } from './qr3mf'
import { loadTestFont, openEdgeCount } from '../test/textFontFixture'

const square = (x0: number, y0: number, x1: number, y1: number): Contour => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]

function emptyMesh(): Mesh {
  return { vertices: [], triangles: [] }
}

describe('addTextRelief', () => {
  it('extrudes a simple outline into a closed solid between z0 and z1', () => {
    const mesh = emptyMesh()
    addTextRelief(mesh, [[square(0, 0, 4, 4)]], 10, 20, 3, 3.6)

    expect(mesh.vertices.length / 3).toBe(8)
    expect(openEdgeCount(mesh)).toBe(0)
    const zs = new Set(mesh.vertices.filter((_, i) => i % 3 === 2))
    expect([...zs].sort()).toEqual([3, 3.6])
    // Offset applied.
    expect(mesh.vertices[0]).toBe(10)
    expect(mesh.vertices[1]).toBe(20)
  })

  it('cuts a hole for a nested contour regardless of winding', () => {
    const mesh = emptyMesh()
    // Both contours wound the same way; nesting decides which is the hole.
    addTextRelief(mesh, [[square(0, 0, 10, 10), square(3, 3, 7, 7)]], 0, 0, 0, 1)
    expect(openEdgeCount(mesh)).toBe(0)

    // Top cap area equals the ring (100 - 16), so the hole wasn't filled.
    let area = 0
    const v = mesh.vertices
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      const [a, b, c] = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]]
      if (v[a * 3 + 2] !== 1 || v[b * 3 + 2] !== 1 || v[c * 3 + 2] !== 1) continue
      area +=
        ((v[b * 3] - v[a * 3]) * (v[c * 3 + 1] - v[a * 3 + 1]) -
          (v[b * 3 + 1] - v[a * 3 + 1]) * (v[c * 3] - v[a * 3])) /
        2
    }
    expect(area).toBeCloseTo(84)
  })

  it('treats overlapping glyphs separately rather than as holes', () => {
    const mesh = emptyMesh()
    addTextRelief(mesh, [[square(0, 0, 4, 4)], [square(1, 1, 3, 3)]], 0, 0, 0, 1)
    // Two independent solids: 16 vertices, both closed.
    expect(mesh.vertices.length / 3).toBe(16)
    expect(openEdgeCount(mesh)).toBe(0)
  })

  it('produces watertight relief for real Lato Bold text', () => {
    const font = loadTestFont()
    const mesh = emptyMesh()
    const text = 'Ada Lovelace she/her badgetag.me/@ada 0123456789 &?!'
    addTextRelief(mesh, font.glyphContours(text, 6), 0, 0, 3, 3.6)
    expect(mesh.triangles.length).toBeGreaterThan(0)
    expect(openEdgeCount(mesh)).toBe(0)
  })
})
