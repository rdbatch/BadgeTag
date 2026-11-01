import qrcode from 'qrcode-generator'
import { strToU8, zipSync } from 'fflate'
import { addExtrudedOutline, addTextRelief, type TextFont } from './textMesh'

/**
 * Generates a two-part 3MF model of a QR code for two-color 3D printing.
 *
 * The file contains two separate mesh objects sharing one coordinate space:
 *  - "Base plate": a square slab (plus an optional lanyard-loop tab)
 *  - "QR code": the dark modules, raised as a thin relief on top of the plate
 *
 * Slicers (PrusaSlicer, Bambu Studio, Cura, ...) import these as separate
 * parts of one model, so each can be assigned its own filament — or printed
 * on a single-extruder machine with a filament swap at the relief height.
 */

export interface Qr3mfOptions {
  /** Width/height of the square base plate, in millimeters. */
  sizeMm: number
  /** Thickness of the base plate, in millimeters. */
  thicknessMm: number
  /** Add a pill-shaped tab above the plate with a standard badge slot. */
  lanyardLoop: boolean
  /** Blank border around the code, in component widths. */
  quietZoneComponents: number
  /** Height of the raised QR relief above the plate, in millimeters. */
  reliefMm: number
  /**
   * Lines of text raised below the QR code, top to bottom. Each line adds a
   * band of height to the plate. Empty or whitespace-only entries are
   * skipped. Rendered in the same dark material as the QR relief so a
   * two-color print carries the text too.
   */
  textLines?: TextLine[]
  /**
   * Font for `textLines` (see `loadTextFont`). Without it the bands are
   * still reserved but no glyphs are drawn, which lets the preview show the
   * plate size while the font loads. `generateQr3mf` requires it whenever
   * there are text lines.
   */
  textFont?: TextFont
  /** Horizontal alignment of the text lines on the plate. Defaults to center. */
  textAlign?: TextAlign
  /**
   * Text size relative to the defaults, at least 1 (the default). Larger
   * text takes height from the QR square, so the tag's outside size stays
   * the same; see `computeMaxTextScale` for the upper bound.
   */
  textScale?: number
}

export type TextAlign = 'left' | 'center' | 'right'

/** One line of text below the QR code. */
export interface TextLine {
  text: string
  /** `small` for supporting text like the URL, `large` for name and pronouns. */
  size: 'small' | 'large'
}

export const QR3MF_LIMITS = {
  /**
   * Minimum printable component pitch. Below ~1.2mm an 0.4mm FDM nozzle
   * can't render component edges cleanly and phone cameras struggle to
   * resolve the code, so the overall size slider is clamped to keep
   * components above this.
   */
  minModuleMm: 1.2,
  maxSizeMm: 120,
  minThicknessMm: 1.2,
  maxThicknessMm: 4,
  /**
   * The QR spec asks for a 4-component quiet zone; it scans reliably in
   * practice down to 1. Below that, cameras can't reliably separate the
   * code from surrounding print bed / lanyard clutter.
   */
  minQuietZoneComponents: 1,
  maxQuietZoneComponents: 4,
  minReliefMm: 0.2,
  maxReliefMm: 1.5,
} as const

/**
 * The size that tucks behind a standard card-sized (CR80) conference badge
 * held vertically. A `sizeMm` of `widthMm` with the lanyard loop and all
 * three text lines (one small, two large) comes out exactly `heightMm` tall.
 */
export const BADGE_FIT = { widthMm: 52, heightMm: 81 } as const

/** Default blank border around the code, in component widths. */
export const DEFAULT_QUIET_ZONE_COMPONENTS = 1.5

/** Default height of the raised QR relief above the plate (3 layers at 0.2mm). */
export const DEFAULT_RELIEF_MM = 0.6

/**
 * Text layout below the QR code, as an em size per line size. Each line's
 * band is 4/3 of its em, leaving room for descenders and a gap between
 * lines. When the widest line would not fit between the side margins, every
 * line scales down by the same factor, so lines of one size stay equal and
 * large lines stay larger than small ones.
 */
const TEXT_EM_MM: Record<TextLine['size'], number> = { small: 4.5, large: 6 }
const BAND_PER_EM = 4 / 3
const TEXT_SIDE_MARGIN_MM = 2.4

/** Corner radius of the plate: an ID-1 (credit card) corner, ISO/IEC 7810. */
export const CORNER_RADIUS_MM = 3.18
/** Straight segments per rounded corner. */
const CORNER_SEGMENTS = 8

/** Drops empty/whitespace-only entries — those add no band to the plate. */
function usableTextLines(textLines: TextLine[] | undefined): TextLine[] {
  return (textLines ?? [])
    .map((line) => ({ ...line, text: line.text.trim() }))
    .filter((line) => line.text.length > 0)
}

function bandHeight(line: TextLine): number {
  return TEXT_EM_MM[line.size] * BAND_PER_EM
}

/** Total extra plate height (mm) the given text lines require below the QR. */
export function textBandHeightMm(textLines: TextLine[] | undefined): number {
  return usableTextLines(textLines).reduce((sum, line) => sum + bandHeight(line), 0)
}

/**
 * Lanyard slot: 14 x 3 mm is the standard ID-badge slot-punch size, so the
 * printed tag fits stock lanyard clips and badge reels.
 */
const SLOT_LENGTH_MM = 14
const SLOT_WIDTH_MM = 3
/** Material ring around the slot. */
const TAB_WALL_MM = 3
/** How far the tab sinks into the plate so the two fuse when sliced. */
const TAB_OVERLAP_MM = 2
/** Segments per semicircular cap of the pill outlines. */
const CAP_SEGMENTS = 16
/** How far the lanyard tab reaches above the top of the plate. */
const TAB_EXTENSION_MM = SLOT_WIDTH_MM + 2 * TAB_WALL_MM - TAB_OVERLAP_MM

/**
 * Side of the QR square: the full width at text scale 1, shrinking by the
 * extra height larger text takes.
 */
export function computeQrSideMm(
  options: Pick<Qr3mfOptions, 'sizeMm' | 'textLines' | 'textScale'>,
): number {
  const scale = options.textScale ?? 1
  return options.sizeMm - textBandHeightMm(options.textLines) * (scale - 1)
}

/** Largest scale at which the widest line still fits the plate's width. */
function textFitScale(font: TextFont, lines: TextLine[], sizeMm: number): number {
  const widest = Math.max(
    ...lines.map((line) => font.advanceWidth(line.text, TEXT_EM_MM[line.size])),
  )
  return widest > 0 ? (sizeMm - 2 * TEXT_SIDE_MARGIN_MM) / widest : Infinity
}

/**
 * Largest text scale for these options: the widest line must fit on one
 * line, and the QR square it shrinks must stay at or above the scannable
 * minimum. Never below 1; returns 1 when there is no text or no font.
 */
export function computeMaxTextScale(
  text: string,
  options: Pick<Qr3mfOptions, 'sizeMm' | 'quietZoneComponents' | 'textLines' | 'textFont'>,
): number {
  const lines = usableTextLines(options.textLines)
  if (!options.textFont || lines.length === 0) return 1
  const fit = textFitScale(options.textFont, lines, options.sizeMm)
  const qrRoom = options.sizeMm - computeMinSizeMm(text, options.quietZoneComponents)
  const qrLimit = 1 + Math.max(0, qrRoom) / textBandHeightMm(lines)
  return Math.max(1, Math.min(fit, qrLimit))
}

/** Height of the whole tag: lanyard tab top to last text line bottom. */
export function computeTotalHeightMm(
  options: Pick<Qr3mfOptions, 'sizeMm' | 'lanyardLoop' | 'textLines'>,
): number {
  return (
    options.sizeMm +
    textBandHeightMm(options.textLines) +
    (options.lanyardLoop ? TAB_EXTENSION_MM : 0)
  )
}

/**
 * Error correction level for the printed code. The on-screen QR uses 'H' so
 * a profile photo can overlay the center; the printed tag has no overlay,
 * and 'M' yields fewer modules — each module prints larger and scans better
 * at the same physical size.
 */
const EC_LEVEL = 'M'

function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, EC_LEVEL)
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let r = 0; r < n; r++) {
    const row: boolean[] = []
    for (let c = 0; c < n; c++) {
      row.push(qr.isDark(r, c))
    }
    rows.push(row)
  }
  return rows
}

/** Number of modules per side for the code that `text` encodes. */
export function computeModuleCount(text: string): number {
  const qr = qrcode(0, EC_LEVEL)
  qr.addData(text)
  qr.make()
  return qr.getModuleCount()
}

/**
 * Smallest plate size (mm) at which every component stays at or above the
 * printable/scannable minimum pitch, including the quiet zone.
 */
export function computeMinSizeMm(
  text: string,
  quietZoneComponents: number = DEFAULT_QUIET_ZONE_COMPONENTS,
): number {
  const modules = computeModuleCount(text) + 2 * quietZoneComponents
  return Math.ceil(modules * QR3MF_LIMITS.minModuleMm)
}

/** Simple indexed triangle mesh; vertices and triangles are flat arrays. */
export interface Mesh {
  vertices: number[]
  triangles: number[]
}

function addQuad(mesh: Mesh, a: number, b: number, c: number, d: number) {
  mesh.triangles.push(a, b, c, a, c, d)
}

/** Axis-aligned box with outward-facing (CCW from outside) triangles. */
function addBox(
  mesh: Mesh,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
) {
  const base = mesh.vertices.length / 3
  mesh.vertices.push(
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  )
  addQuad(mesh, base + 0, base + 3, base + 2, base + 1) // bottom (-z)
  addQuad(mesh, base + 4, base + 5, base + 6, base + 7) // top (+z)
  addQuad(mesh, base + 0, base + 1, base + 5, base + 4) // front (-y)
  addQuad(mesh, base + 1, base + 2, base + 6, base + 5) // right (+x)
  addQuad(mesh, base + 2, base + 3, base + 7, base + 6) // back (+y)
  addQuad(mesh, base + 3, base + 0, base + 4, base + 7) // left (-x)
}

type Point = readonly [number, number]

/**
 * CCW outline of a rectangle from (x0, y0) to (x1, y1) with quarter-circle
 * corners of radius `r`. The rectangle must be wider and taller than 2r.
 */
function roundedRectOutline(x0: number, y0: number, x1: number, y1: number, r: number): Point[] {
  const corners: [number, number, number][] = [
    [x1 - r, y0 + r, -Math.PI / 2], // bottom right
    [x1 - r, y1 - r, 0], // top right
    [x0 + r, y1 - r, Math.PI / 2], // top left
    [x0 + r, y0 + r, Math.PI], // bottom left
  ]
  const points: Point[] = []
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= CORNER_SEGMENTS; i++) {
      const a = start + (Math.PI / 2) * (i / CORNER_SEGMENTS)
      points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  }
  return points
}

/**
 * CCW outline of a stadium (pill) shape: a `length` x `width` rectangle with
 * semicircular caps. Starts at the bottom of the right cap.
 */
function stadiumOutline(
  cx: number,
  cy: number,
  length: number,
  width: number,
): Point[] {
  const r = width / 2
  const half = (length - width) / 2
  const points: Point[] = []
  for (let i = 0; i <= CAP_SEGMENTS; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / CAP_SEGMENTS
    points.push([cx + half + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  for (let i = 0; i <= CAP_SEGMENTS; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / CAP_SEGMENTS
    points.push([cx - half + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return points
}

/**
 * Extrudes the ring between two concentric CCW outlines (a solid with a
 * hole) from z0 to z1. Outlines must have the same point count with
 * corresponding indices — true for two stadiums offset by a constant wall,
 * which is how the lanyard tab is built.
 */
function addRingExtrusion(
  mesh: Mesh,
  outer: Point[],
  inner: Point[],
  z0: number,
  z1: number,
) {
  const n = outer.length
  const base = mesh.vertices.length / 3
  for (const [x, y] of outer) mesh.vertices.push(x, y, z0)
  for (const [x, y] of inner) mesh.vertices.push(x, y, z0)
  for (const [x, y] of outer) mesh.vertices.push(x, y, z1)
  for (const [x, y] of inner) mesh.vertices.push(x, y, z1)

  const ob = base
  const ib = base + n
  const ot = base + 2 * n
  const it = base + 3 * n
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    addQuad(mesh, ot + i, ot + j, it + j, it + i) // top ring (+z)
    addQuad(mesh, ob + i, ib + i, ib + j, ob + j) // bottom ring (-z)
    addQuad(mesh, ob + i, ob + j, ot + j, ot + i) // outer wall
    addQuad(mesh, ib + j, ib + i, it + i, it + j) // slot wall (faces hole)
  }
}

/** Millimeter values rounded to 1µm so XML stays free of float noise. */
function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000)
}

function meshXml(mesh: Mesh): string {
  const verts: string[] = []
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    verts.push(
      `<vertex x="${fmt(mesh.vertices[i])}" y="${fmt(mesh.vertices[i + 1])}" z="${fmt(mesh.vertices[i + 2])}" />`,
    )
  }
  const tris: string[] = []
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    tris.push(
      `<triangle v1="${mesh.triangles[i]}" v2="${mesh.triangles[i + 1]}" v3="${mesh.triangles[i + 2]}" />`,
    )
  }
  return `<mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh>`
}

/**
 * Builds the two meshes that make up the model — the base plate (with
 * optional lanyard tab) and the raised QR relief — in a shared coordinate
 * space. Used by the .3mf exporter and by the on-screen preview, so what
 * the preview shows is exactly what the slicer will import. Does not
 * validate ranges; generateQr3mf does that before packaging.
 */
export function buildQr3mfMeshes(
  text: string,
  options: Qr3mfOptions,
): { base: Mesh; qr: Mesh } {
  const { sizeMm, thicknessMm, lanyardLoop, quietZoneComponents, reliefMm } = options

  // Text lines stack below the QR code, which sits in a square at the top
  // (y in [0, qrSide]); the plate extends downward into negative y by the
  // text bands. Larger text takes its extra height from the QR square, so
  // the tag's outside size never changes with the text scale.
  const lines = usableTextLines(options.textLines)
  const textScale = options.textScale ?? 1
  const textHeight = textBandHeightMm(lines) * textScale
  const qrSide = computeQrSideMm(options)
  const qrX = (sizeMm - qrSide) / 2

  const matrix = qrMatrix(text)
  const n = matrix.length
  const pitch = qrSide / (n + 2 * quietZoneComponents)
  const margin = quietZoneComponents * pitch

  const baseMesh: Mesh = { vertices: [], triangles: [] }
  // Avoid -0 so a text-free plate starts exactly at y=0.
  const plateBottomY = textHeight > 0 ? -textHeight : 0
  addExtrudedOutline(
    baseMesh,
    roundedRectOutline(0, plateBottomY, sizeMm, qrSide, CORNER_RADIUS_MM),
    0,
    thicknessMm,
  )

  if (lanyardLoop) {
    const tabWidth = SLOT_WIDTH_MM + 2 * TAB_WALL_MM
    const tabLength = SLOT_LENGTH_MM + 2 * TAB_WALL_MM
    // Centered on the top edge, sunk TAB_OVERLAP_MM into the plate. The
    // outer and inner stadiums share cap centers (equal length - width),
    // giving the ring extrusion its required 1:1 point correspondence.
    const cy = qrSide + tabWidth / 2 - TAB_OVERLAP_MM
    const outer = stadiumOutline(sizeMm / 2, cy, tabLength, tabWidth)
    const inner = stadiumOutline(sizeMm / 2, cy, SLOT_LENGTH_MM, SLOT_WIDTH_MM)
    addRingExtrusion(baseMesh, outer, inner, 0, thicknessMm)
  }

  const qrMesh: Mesh = { vertices: [], triangles: [] }
  for (let r = 0; r < n; r++) {
    // Merge horizontal runs of dark modules into single boxes.
    let c = 0
    while (c < n) {
      if (!matrix[r][c]) {
        c++
        continue
      }
      let end = c
      while (end < n && matrix[r][end]) end++
      // Row 0 is the top of the code, which is the highest y on the plate.
      const yTop = qrSide - margin - r * pitch
      addBox(
        qrMesh,
        qrX + margin + c * pitch,
        yTop - pitch,
        thicknessMm,
        qrX + margin + end * pitch,
        yTop,
        thicknessMm + reliefMm,
      )
      c = end
    }
  }

  // Raise each text line as relief in the same mesh/material as the QR, so a
  // two-color print carries the text too. Each line is centered vertically
  // in its band and aligned horizontally per `textAlign`.
  const font = options.textFont
  const align = options.textAlign ?? 'center'
  if (font && lines.length > 0) {
    // Lines too wide for the plate at the requested scale shrink together,
    // keeping their bands; computeMaxTextScale keeps the slider below that.
    const fit = Math.min(1, textFitScale(font, lines, sizeMm) / textScale)
    let bandTop = 0
    lines.forEach((line) => {
      const em = TEXT_EM_MM[line.size] * textScale * fit
      const width = font.advanceWidth(line.text, em)
      const band = bandHeight(line) * textScale

      // Center the span from descender to cap height inside the band.
      const bandCenter = bandTop - band / 2
      const baseline = bandCenter - ((font.capHeight - font.descender) * em) / 2
      bandTop -= band

      addTextRelief(
        qrMesh,
        font.glyphContours(line.text, em),
        align === 'left'
          ? TEXT_SIDE_MARGIN_MM
          : align === 'right'
            ? sizeMm - TEXT_SIDE_MARGIN_MM - width
            : (sizeMm - width) / 2,
        baseline,
        thicknessMm,
        thicknessMm + reliefMm,
      )
    })
  }

  return { base: baseMesh, qr: qrMesh }
}

/**
 * Builds the .3mf file (a zip archive per the 3MF spec) and returns its
 * bytes. Throws RangeError when options fall outside printable limits.
 */
export function generateQr3mf(
  text: string,
  options: Qr3mfOptions,
): Uint8Array<ArrayBuffer> {
  const { sizeMm, thicknessMm, quietZoneComponents, reliefMm } = options
  const minSize = computeMinSizeMm(text, quietZoneComponents)
  if (!Number.isFinite(sizeMm) || sizeMm < minSize || sizeMm > QR3MF_LIMITS.maxSizeMm) {
    throw new RangeError(
      `sizeMm must be between ${minSize} and ${QR3MF_LIMITS.maxSizeMm}, got ${sizeMm}`,
    )
  }
  if (
    !Number.isFinite(thicknessMm) ||
    thicknessMm < QR3MF_LIMITS.minThicknessMm ||
    thicknessMm > QR3MF_LIMITS.maxThicknessMm
  ) {
    throw new RangeError(
      `thicknessMm must be between ${QR3MF_LIMITS.minThicknessMm} and ${QR3MF_LIMITS.maxThicknessMm}, got ${thicknessMm}`,
    )
  }
  if (
    !Number.isFinite(quietZoneComponents) ||
    quietZoneComponents < QR3MF_LIMITS.minQuietZoneComponents ||
    quietZoneComponents > QR3MF_LIMITS.maxQuietZoneComponents
  ) {
    throw new RangeError(
      `quietZoneComponents must be between ${QR3MF_LIMITS.minQuietZoneComponents} and ${QR3MF_LIMITS.maxQuietZoneComponents}, got ${quietZoneComponents}`,
    )
  }
  if (
    !Number.isFinite(reliefMm) ||
    reliefMm < QR3MF_LIMITS.minReliefMm ||
    reliefMm > QR3MF_LIMITS.maxReliefMm
  ) {
    throw new RangeError(
      `reliefMm must be between ${QR3MF_LIMITS.minReliefMm} and ${QR3MF_LIMITS.maxReliefMm}, got ${reliefMm}`,
    )
  }

  if (usableTextLines(options.textLines).length > 0 && !options.textFont) {
    throw new Error('textFont is required when textLines are given')
  }
  const textScale = options.textScale ?? 1
  if (!Number.isFinite(textScale) || textScale < 1) {
    throw new RangeError(`textScale must be at least 1, got ${textScale}`)
  }
  const qrSide = computeQrSideMm(options)
  if (qrSide < minSize) {
    throw new RangeError(
      `textScale ${textScale} shrinks the QR code to ${qrSide.toFixed(1)} mm, below the ${minSize} mm minimum`,
    )
  }

  const { base: baseMesh, qr: qrMesh } = buildQr3mfMeshes(text, options)

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Title">BadgeTag QR tag</metadata>` +
    `<resources>` +
    `<basematerials id="1">` +
    `<base name="Base (light)" displaycolor="#FFFFFF" />` +
    `<base name="QR code (dark)" displaycolor="#1F2937" />` +
    `</basematerials>` +
    `<object id="2" type="model" name="Base plate" pid="1" pindex="0">${meshXml(baseMesh)}</object>` +
    `<object id="3" type="model" name="QR code" pid="1" pindex="1">${meshXml(qrMesh)}</object>` +
    `</resources>` +
    `<build><item objectid="2" /><item objectid="3" /></build>` +
    `</model>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />` +
    `</Types>`

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />` +
    `</Relationships>`

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  }) as Uint8Array<ArrayBuffer>
}
