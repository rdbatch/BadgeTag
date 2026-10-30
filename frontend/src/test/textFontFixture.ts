import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseTextFont } from '../lib/textFont'
import type { TextFont } from '../lib/textMesh'

/** The bundled Lato Bold, read from disk (fetch can't load it under jsdom). */
export function loadTestFont(): TextFont {
  // Under jsdom, import.meta.url isn't a file: URL; vitest runs from frontend/.
  const path = resolve(process.cwd(), 'src/assets/fonts/Lato-Bold.ttf')
  const bytes = readFileSync(path)
  return parseTextFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

/**
 * Number of directed edges without exactly one opposite partner. Zero means
 * the mesh is closed and consistently wound, so it slices as a solid.
 * Counts instead of asserting per edge, which keeps large meshes fast.
 */
export function openEdgeCount(mesh: { triangles: number[] }): number {
  const edges = new Map<string, number>()
  const t = mesh.triangles
  for (let i = 0; i < t.length; i += 3) {
    for (const [a, b] of [
      [t[i], t[i + 1]],
      [t[i + 1], t[i + 2]],
      [t[i + 2], t[i]],
    ]) {
      const key = `${a}>${b}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  let open = 0
  for (const [key, count] of edges) {
    const [a, b] = key.split('>')
    if (count !== 1 || edges.get(`${b}>${a}`) !== 1) open++
  }
  return open
}
