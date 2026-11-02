import { unzipSync, strFromU8 } from 'fflate'
import {
  buildQr3mfMeshes,
  computeMinSizeMm,
  computeModuleCount,
  DEFAULT_QUIET_ZONE_COMPONENTS,
  DEFAULT_RELIEF_MM,
  generateQr3mf,
  QR3MF_LIMITS,
  textBandHeightMm,
  BADGE_FIT,
  computeMaxTextScale,
  computeQrSideMm,
  computeTotalHeightMm,
  CORNER_RADIUS_MM,
  type Qr3mfOptions,
  type TextAlign,
  type TextLine,
} from './qr3mf'
import { loadTestFont, openEdgeCount } from '../test/textFontFixture'

const FONT = loadTestFont()

const TEST_URL = 'https://badgetag.me/p/abc123def456'

const VALID_OPTIONS = {
  sizeMm: 60,
  thicknessMm: 3,
  lanyardLoop: true,
  quietZoneComponents: DEFAULT_QUIET_ZONE_COMPONENTS,
  reliefMm: DEFAULT_RELIEF_MM,
}

interface ParsedMesh {
  vertices: Array<[number, number, number]>
  triangles: Array<[number, number, number]>
}

interface ParsedObject {
  name: string
  pindex: string
  mesh: ParsedMesh
}

function parseModel(data: Uint8Array): { doc: Document; objects: ParsedObject[] } {
  const files = unzipSync(data)
  const model = files['3D/3dmodel.model']
  expect(model).toBeDefined()

  const doc = new DOMParser().parseFromString(strFromU8(model), 'text/xml')
  const objects = Array.from(doc.getElementsByTagName('object')).map((obj) => {
    const vertices = Array.from(obj.getElementsByTagName('vertex')).map(
      (v): [number, number, number] => [
        Number(v.getAttribute('x')),
        Number(v.getAttribute('y')),
        Number(v.getAttribute('z')),
      ],
    )
    const triangles = Array.from(obj.getElementsByTagName('triangle')).map(
      (t): [number, number, number] => [
        Number(t.getAttribute('v1')),
        Number(t.getAttribute('v2')),
        Number(t.getAttribute('v3')),
      ],
    )
    return {
      name: obj.getAttribute('name') ?? '',
      pindex: obj.getAttribute('pindex') ?? '',
      mesh: { vertices, triangles },
    }
  })
  return { doc, objects }
}

function boundingBox(mesh: ParsedMesh) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const v of mesh.vertices) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], v[axis])
      max[axis] = Math.max(max[axis], v[axis])
    }
  }
  return { min, max }
}

/**
 * A closed (watertight) triangle mesh has every directed edge appearing
 * exactly once, paired with its reverse. Non-manifold or open geometry
 * would fail to slice into a solid.
 */
function expectWatertight(mesh: ParsedMesh) {
  const edges = new Map<string, number>()
  for (const [a, b, c] of mesh.triangles) {
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = `${from}>${to}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  for (const [key, count] of edges) {
    expect(count).toBe(1)
    const [from, to] = key.split('>')
    expect(edges.get(`${to}>${from}`)).toBe(1)
  }
}

describe('computeMinSizeMm', () => {
  it('scales with module count so components never drop below the printable pitch', () => {
    const modules = computeModuleCount(TEST_URL)
    // Version 1 is 21 modules; any URL is larger. Default quiet zone adds 3
    // (1.5 components per side).
    expect(modules).toBeGreaterThanOrEqual(21)
    expect(computeMinSizeMm(TEST_URL)).toBe(
      Math.ceil((modules + 2 * DEFAULT_QUIET_ZONE_COMPONENTS) * QR3MF_LIMITS.minModuleMm),
    )
  })

  it('requires a larger minimum for longer URLs (denser codes)', () => {
    const longUrl = `${TEST_URL}${'x'.repeat(80)}`
    expect(computeMinSizeMm(longUrl)).toBeGreaterThan(computeMinSizeMm(TEST_URL))
  })

  it('shrinks the minimum when a smaller quiet zone is requested', () => {
    const wide = computeMinSizeMm(TEST_URL, QR3MF_LIMITS.maxQuietZoneComponents)
    const narrow = computeMinSizeMm(TEST_URL, QR3MF_LIMITS.minQuietZoneComponents)
    expect(narrow).toBeLessThan(wide)
  })
})

describe('generateQr3mf', () => {
  it('produces a valid 3MF container with required OPC parts', () => {
    const files = unzipSync(generateQr3mf(TEST_URL, VALID_OPTIONS))
    expect(files['[Content_Types].xml']).toBeDefined()
    expect(files['_rels/.rels']).toBeDefined()
    expect(files['3D/3dmodel.model']).toBeDefined()
  })

  it('contains two separately-colorable objects, both in the build', () => {
    const { doc, objects } = parseModel(generateQr3mf(TEST_URL, VALID_OPTIONS))

    expect(objects).toHaveLength(2)
    expect(objects.map((o) => o.name)).toEqual(['Base plate', 'QR code'])
    // Distinct material indices are what let slicers assign two colors.
    expect(objects[0].pindex).not.toBe(objects[1].pindex)
    expect(doc.getElementsByTagName('base')).toHaveLength(2)
    expect(doc.getElementsByTagName('item')).toHaveLength(2)
  })

  it('generates watertight meshes for both parts', () => {
    const { objects } = parseModel(generateQr3mf(TEST_URL, VALID_OPTIONS))
    for (const obj of objects) {
      expect(obj.mesh.triangles.length).toBeGreaterThan(0)
      expectWatertight(obj.mesh)
    }
  })

  it('triangle indices all reference existing vertices', () => {
    const { objects } = parseModel(generateQr3mf(TEST_URL, VALID_OPTIONS))
    for (const obj of objects) {
      for (const tri of obj.mesh.triangles) {
        for (const index of tri) {
          expect(Number.isInteger(index)).toBe(true)
          expect(index).toBeGreaterThanOrEqual(0)
          expect(index).toBeLessThan(obj.mesh.vertices.length)
        }
      }
    }
  })

  it('sizes the base plate to sizeMm x sizeMm x thicknessMm', () => {
    const { objects } = parseModel(
      generateQr3mf(TEST_URL, { ...VALID_OPTIONS, lanyardLoop: false }),
    )
    const { min, max } = boundingBox(objects[0].mesh)
    expect(min).toEqual([0, 0, 0])
    expect(max[0]).toBe(60)
    expect(max[1]).toBe(60)
    expect(max[2]).toBe(3)
  })

  it('raises the QR relief on top of the plate, inside the quiet zone', () => {
    const { objects } = parseModel(
      generateQr3mf(TEST_URL, { ...VALID_OPTIONS, lanyardLoop: false }),
    )
    const { min, max } = boundingBox(objects[1].mesh)
    // Sits on the plate surface with a thin, constant relief.
    expect(min[2]).toBe(3)
    expect(max[2]).toBeGreaterThan(3)
    expect(max[2]).toBeLessThanOrEqual(3 + DEFAULT_RELIEF_MM)
    // Quiet zone margin on all sides.
    expect(min[0]).toBeGreaterThan(0)
    expect(min[1]).toBeGreaterThan(0)
    expect(max[0]).toBeLessThan(60)
    expect(max[1]).toBeLessThan(60)
  })

  it('extends the base above the plate when the lanyard loop is enabled', () => {
    const withLoop = parseModel(
      generateQr3mf(TEST_URL, { ...VALID_OPTIONS, lanyardLoop: true }),
    )
    const withoutLoop = parseModel(
      generateQr3mf(TEST_URL, { ...VALID_OPTIONS, lanyardLoop: false }),
    )

    const loopBox = boundingBox(withLoop.objects[0].mesh)
    const plainBox = boundingBox(withoutLoop.objects[0].mesh)
    expect(plainBox.max[1]).toBe(60)
    // Tab is 9mm tall, sunk 2mm into the plate.
    expect(loopBox.max[1]).toBe(67)
    // The loop is part of the base object, not a third part.
    expect(withLoop.objects).toHaveLength(2)
  })

  it('shrinks the quiet zone margin when quietZoneComponents is reduced', () => {
    const wide = parseModel(
      generateQr3mf(TEST_URL, {
        ...VALID_OPTIONS,
        lanyardLoop: false,
        quietZoneComponents: QR3MF_LIMITS.maxQuietZoneComponents,
      }),
    )
    const narrow = parseModel(
      generateQr3mf(TEST_URL, {
        ...VALID_OPTIONS,
        lanyardLoop: false,
        quietZoneComponents: QR3MF_LIMITS.minQuietZoneComponents,
      }),
    )

    const wideMargin = boundingBox(wide.objects[1].mesh).min[0]
    const narrowMargin = boundingBox(narrow.objects[1].mesh).min[0]
    expect(narrowMargin).toBeLessThan(wideMargin)
  })

  it('raises the relief by the requested reliefMm', () => {
    const { objects } = parseModel(
      generateQr3mf(TEST_URL, {
        ...VALID_OPTIONS,
        lanyardLoop: false,
        reliefMm: 1.2,
      }),
    )
    const { min, max } = boundingBox(objects[1].mesh)
    expect(min[2]).toBe(3)
    expect(max[2]).toBe(3 + 1.2)
  })

  it('rejects sizes below the scannability minimum', () => {
    const min = computeMinSizeMm(TEST_URL)
    expect(() =>
      generateQr3mf(TEST_URL, { ...VALID_OPTIONS, sizeMm: min - 1 }),
    ).toThrow(RangeError)
    expect(() =>
      generateQr3mf(TEST_URL, { ...VALID_OPTIONS, sizeMm: min }),
    ).not.toThrow()
  })

  it('rejects sizes and thicknesses outside the printable limits', () => {
    expect(() =>
      generateQr3mf(TEST_URL, { ...VALID_OPTIONS, sizeMm: QR3MF_LIMITS.maxSizeMm + 1 }),
    ).toThrow(RangeError)
    expect(() =>
      generateQr3mf(TEST_URL, {
        ...VALID_OPTIONS,
        thicknessMm: QR3MF_LIMITS.minThicknessMm - 0.1,
      }),
    ).toThrow(RangeError)
    expect(() =>
      generateQr3mf(TEST_URL, {
        ...VALID_OPTIONS,
        thicknessMm: QR3MF_LIMITS.maxThicknessMm + 0.1,
      }),
    ).toThrow(RangeError)
    expect(() =>
      generateQr3mf(TEST_URL, { ...VALID_OPTIONS, sizeMm: Number.NaN }),
    ).toThrow(RangeError)
  })

  it('rejects quiet zones outside the printable/scannable limits', () => {
    expect(() =>
      generateQr3mf(TEST_URL, {
        ...VALID_OPTIONS,
        quietZoneComponents: QR3MF_LIMITS.minQuietZoneComponents - 0.1,
      }),
    ).toThrow(RangeError)
    expect(() =>
      generateQr3mf(TEST_URL, {
        ...VALID_OPTIONS,
        quietZoneComponents: QR3MF_LIMITS.maxQuietZoneComponents + 0.1,
      }),
    ).toThrow(RangeError)
  })

  it('rejects relief heights outside the printable limits', () => {
    expect(() =>
      generateQr3mf(TEST_URL, {
        ...VALID_OPTIONS,
        reliefMm: QR3MF_LIMITS.minReliefMm - 0.1,
      }),
    ).toThrow(RangeError)
    expect(() =>
      generateQr3mf(TEST_URL, {
        ...VALID_OPTIONS,
        reliefMm: QR3MF_LIMITS.maxReliefMm + 0.1,
      }),
    ).toThrow(RangeError)
  })
})

describe('text lines below the QR code', () => {
  const NO_LOOP = { ...VALID_OPTIONS, lanyardLoop: false }
  const small = (text: string): TextLine => ({ text, size: 'small' })
  const large = (text: string): TextLine => ({ text, size: 'large' })

  function yRange(vertices: number[]) {
    let min = Infinity
    let max = -Infinity
    for (let i = 1; i < vertices.length; i += 3) {
      min = Math.min(min, vertices[i])
      max = Math.max(max, vertices[i])
    }
    return { min, max }
  }

  /** Vertices of every text object, flattened: each line is its own mesh now. */
  function textVertices(textLines: TextLine[], extra: Partial<Qr3mfOptions> = {}) {
    const { text } = buildQr3mfMeshes(TEST_URL, { ...NO_LOOP, textLines, textFont: FONT, ...extra })
    return text.flatMap((part) => part.mesh.vertices)
  }

  /** Height of the ink in each text object, top to bottom. */
  function inkHeights(textLines: TextLine[]) {
    const { text } = buildQr3mfMeshes(TEST_URL, { ...NO_LOOP, textLines, textFont: FONT })
    return text.map(({ mesh }) => {
      const ys = mesh.vertices.filter((_, i) => i % 3 === 1)
      return Math.max(...ys) - Math.min(...ys)
    })
  }

  it('leaves the plate unchanged when no text lines are given', () => {
    const plain = buildQr3mfMeshes(TEST_URL, NO_LOOP)
    const empty = buildQr3mfMeshes(TEST_URL, { ...NO_LOOP, textLines: [] })
    expect(empty.base.vertices).toEqual(plain.base.vertices)
  })

  it('skips empty and whitespace-only lines', () => {
    expect(textBandHeightMm([small(''), large('   ')])).toBe(0)
    const meshes = buildQr3mfMeshes(TEST_URL, { ...NO_LOOP, textLines: [small('   ')] })
    expect(yRange(meshes.base.vertices).min).toBe(0)
  })

  it('gives large lines a taller band than small ones', () => {
    expect(textBandHeightMm([large('Ada')])).toBeGreaterThan(textBandHeightMm([small('Ada')]))
    expect(textBandHeightMm([small('a'), large('b')])).toBeCloseTo(
      textBandHeightMm([small('a')]) + textBandHeightMm([large('b')]),
    )
  })

  it('extends the plate downward by the bands, keeping the QR on top', () => {
    const lines = [small('badgetag.me/@ada'), large('Ada')]
    const { min, max } = yRange(buildQr3mfMeshes(TEST_URL, { ...NO_LOOP, textLines: lines }).base.vertices)
    expect(max).toBe(60)
    // Bands plus the 1 mm gap under the last line.
    expect(min).toBeCloseTo(-(textBandHeightMm(lines) + 1))
  })

  it('reserves the bands but draws no glyphs until a font is supplied', () => {
    const plain = buildQr3mfMeshes(TEST_URL, NO_LOOP)
    const noFont = buildQr3mfMeshes(TEST_URL, { ...NO_LOOP, textLines: [large('Ada')] })
    expect(noFont.qr.vertices).toEqual(plain.qr.vertices)
    expect(yRange(noFont.base.vertices).min).toBeLessThan(0)
  })

  it('raises the text in the QR (dark) part, inside its band and the plate', () => {
    const lines = [large('Ada Lovelace')]
    const added = textVertices(lines)
    expect(added.length).toBeGreaterThan(0)
    for (let i = 0; i < added.length; i += 3) {
      const [x, y, z] = [added[i], added[i + 1], added[i + 2]]
      expect(x).toBeGreaterThan(0)
      expect(x).toBeLessThan(60)
      expect(y).toBeLessThan(0)
      expect(y).toBeGreaterThan(-textBandHeightMm(lines))
      expect([3, 3 + DEFAULT_RELIEF_MM]).toContainEqual(z)
    }
  })

  it('sets large lines larger than small ones, and equal within a size', () => {
    const [url, name, pronouns] = inkHeights([small('HHH'), large('HHH'), large('HHH')])
    expect(name).toBeGreaterThan(url * 1.2)
    expect(pronouns).toBeCloseTo(name)
  })

  it('shrinks every line by the same factor when one is too wide', () => {
    const fits = inkHeights([small('HH'), large('HH')])
    const tooWide = inkHeights([small('HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH'), large('HH')])
    expect(tooWide[0]).toBeLessThan(fits[0])
    expect(tooWide[1] / tooWide[0]).toBeCloseTo(fits[1] / fits[0])

    const added = textVertices([small('badgetag.me/p/abc123def456/and-then-some-more')])
    for (let i = 0; i < added.length; i += 3) {
      expect(added[i]).toBeGreaterThanOrEqual(0)
      expect(added[i]).toBeLessThanOrEqual(60)
    }
  })

  it('aligns lines to the left margin, center, or right margin', () => {
    const xRange = (textAlign: TextAlign) => {
      const xs = textVertices([large('HOH')], { textAlign }).filter((_, i) => i % 3 === 0)
      return { min: Math.min(...xs), max: Math.max(...xs) }
    }
    const left = xRange('left')
    const center = xRange('center')
    const right = xRange('right')

    expect(right.max - right.min).toBeCloseTo(left.max - left.min)
    expect(left.min).toBeLessThan(center.min)
    expect(center.min).toBeLessThan(right.min)
    expect((center.min + center.max) / 2).toBeCloseTo(30, 0)
    expect(left.min).toBeCloseTo(60 - right.max, 0)
    expect(left.min).toBeLessThan(5)
  })

  it('keeps both parts watertight with text present', () => {
    const { base, qr, text } = buildQr3mfMeshes(TEST_URL, {
      ...VALID_OPTIONS,
      sizeMm: BADGE_FIT.widthMm,
      textLines: [small('badgetag.me/@ada'), large('Ada Lovelace'), large('she/her')],
      textFont: FONT,
    })
    expect(openEdgeCount(base)).toBe(0)
    expect(openEdgeCount(qr)).toBe(0)
    expect(text).toHaveLength(3)
    for (const part of text) expect(openEdgeCount(part.mesh)).toBe(0)
  })

  it('requires a font to export text lines', () => {
    const textLines = [large('Ada')]
    expect(() => generateQr3mf(TEST_URL, { ...NO_LOOP, textLines })).toThrow(/textFont/)
    const { objects } = parseModel(generateQr3mf(TEST_URL, { ...NO_LOOP, textLines, textFont: FONT }))
    expect(objects.map((o) => o.name)).toEqual(['Base plate', 'QR code', 'Text 1'])
  })

  it('exports each text line as its own colorable object in the build', () => {
    // Read the names, materials and build items straight from the XML: the
    // full DOM parse of the dense QR object is too slow for a test to repeat.
    const xml = strFromU8(
      unzipSync(
        generateQr3mf(TEST_URL, {
          ...NO_LOOP,
          textLines: [
            { text: 'badgetag.me/@ada', size: 'small', label: 'URL' },
            { text: 'Ada Lovelace', size: 'large', label: 'Name' },
            { text: 'she/her', size: 'large', label: 'Pronouns' },
          ],
          textFont: FONT,
        }),
      )['3D/3dmodel.model'],
    )
    const names = [...xml.matchAll(/<object [^>]*name="([^"]*)"/g)].map((m) => m[1])
    expect(names).toEqual(['Base plate', 'QR code', 'Text: URL', 'Text: Name', 'Text: Pronouns'])
    // Every object is in the build, so slicers import each as a separate part.
    expect([...xml.matchAll(/<item /g)]).toHaveLength(5)
    // The base is material 0; the QR code and every text line share material 1.
    const pindexes = [...xml.matchAll(/<object [^>]*pindex="(\d)"/g)].map((m) => m[1])
    expect(pindexes).toEqual(['0', '1', '1', '1', '1'])
  }, 20000)

  it('keeps the QR code free of text geometry', () => {
    const plain = buildQr3mfMeshes(TEST_URL, NO_LOOP)
    const withText = buildQr3mfMeshes(TEST_URL, {
      ...NO_LOOP,
      textLines: [large('Ada Lovelace')],
      textFont: FONT,
    })
    expect(withText.qr.vertices).toEqual(plain.qr.vertices)
    expect(withText.text[0].mesh.vertices.length).toBeGreaterThan(0)
  })
})

describe('text scale', () => {
  const lines: TextLine[] = [
    { text: 'ada.me', size: 'small' },
    { text: 'Ada', size: 'large' },
  ]
  const base = { ...VALID_OPTIONS, sizeMm: 52, textLines: lines, textFont: FONT }
  const bounds = (v: number[], axis: number) => {
    const values = v.filter((_, i) => i % 3 === axis)
    return { min: Math.min(...values), max: Math.max(...values) }
  }

  it('keeps the outside size the same and shrinks the QR square instead', () => {
    const scaled = { ...base, textScale: 1.3 }
    const plain = buildQr3mfMeshes(TEST_URL, base).base.vertices
    const big = buildQr3mfMeshes(TEST_URL, scaled).base.vertices
    expect(bounds(big, 0)).toEqual(bounds(plain, 0))
    expect(bounds(big, 1).max - bounds(big, 1).min).toBeCloseTo(
      bounds(plain, 1).max - bounds(plain, 1).min,
    )
    expect(computeTotalHeightMm(scaled)).toBeCloseTo(computeTotalHeightMm(base))

    const qrSide = computeQrSideMm(scaled)
    expect(qrSide).toBeCloseTo(52 - textBandHeightMm(lines) * 0.3)
  })

  it('centers the smaller QR code horizontally', () => {
    const scaled = { ...base, lanyardLoop: false, textScale: 1.3 }
    const { qr } = buildQr3mfMeshes(TEST_URL, { ...scaled, textLines: lines, textFont: undefined })
    const x = bounds(qr.vertices, 0)
    expect((x.min + x.max) / 2).toBeCloseTo(26, 0)
    expect(x.max - x.min).toBeLessThan(computeQrSideMm(scaled))
  })

  it('grows the text with the scale', () => {
    const inkHeight = (textScale: number) => {
      const { text } = buildQr3mfMeshes(TEST_URL, { ...base, textScale })
      return bounds(text.flatMap((part) => part.mesh.vertices), 1)
    }
    const small = inkHeight(1)
    const big = inkHeight(1.3)
    expect(big.max - big.min).toBeCloseTo((small.max - small.min) * 1.3, 0)
  })

  it('caps the scale where the widest line fills the width', () => {
    const wide: TextLine[] = [{ text: 'badgetag.me/@ada', size: 'small' }]
    const max = computeMaxTextScale(TEST_URL, { ...base, textLines: wide })
    expect(max).toBeGreaterThan(1)
    expect(FONT.advanceWidth('badgetag.me/@ada', 4.5 * max)).toBeCloseTo(52 - 2 * 2.4)
  })

  it('caps the scale so the QR code stays scannable', () => {
    const short: TextLine[] = [{ text: 'A', size: 'large' }]
    const max = computeMaxTextScale(TEST_URL, { ...base, textLines: short })
    expect(computeQrSideMm({ sizeMm: 52, textLines: short, textScale: max })).toBeCloseTo(
      computeMinSizeMm(TEST_URL, VALID_OPTIONS.quietZoneComponents),
    )
  })

  it('is 1 when a line already fills the width, or without text or font', () => {
    const tooWide: TextLine[] = [{ text: 'badgetag.me/p/abc123def456/more', size: 'small' }]
    expect(computeMaxTextScale(TEST_URL, { ...base, textLines: tooWide })).toBe(1)
    expect(computeMaxTextScale(TEST_URL, { ...base, textLines: [] })).toBe(1)
    expect(computeMaxTextScale(TEST_URL, { ...base, textFont: undefined })).toBe(1)
  })

  it('stays watertight when scaled up', () => {
    const { base: plate, qr, text } = buildQr3mfMeshes(TEST_URL, { ...base, textScale: 1.4 })
    expect(openEdgeCount(plate)).toBe(0)
    expect(openEdgeCount(qr)).toBe(0)
    for (const part of text) expect(openEdgeCount(part.mesh)).toBe(0)
  })

  it('rejects scales below 1 or that shrink the QR code past its minimum', () => {
    expect(() => generateQr3mf(TEST_URL, { ...base, textScale: 0.9 })).toThrow(RangeError)
    expect(() => generateQr3mf(TEST_URL, { ...base, textScale: 10 })).toThrow(RangeError)
    const max = computeMaxTextScale(TEST_URL, base)
    expect(() => generateQr3mf(TEST_URL, { ...base, textScale: max })).not.toThrow()
  })
})

describe('card badge fit', () => {
  const allLines: TextLine[] = [
    { text: 'badgetag.me/@ada', size: 'small' },
    { text: 'Ada Lovelace', size: 'large' },
    { text: 'she/her', size: 'large' },
  ]

  it('comes out exactly 52 x 82 mm with the loop and all three lines', () => {
    const options = { ...VALID_OPTIONS, sizeMm: BADGE_FIT.widthMm, textLines: allLines }
    expect(computeTotalHeightMm(options)).toBeCloseTo(BADGE_FIT.heightMm)

    const v = buildQr3mfMeshes(TEST_URL, options).base.vertices
    const xs = v.filter((_, i) => i % 3 === 0)
    const ys = v.filter((_, i) => i % 3 === 1)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(BADGE_FIT.widthMm)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(BADGE_FIT.heightMm)
  })

  it('does not cap the size: taller tags still export', () => {
    expect(() =>
      generateQr3mf(TEST_URL, {
        ...VALID_OPTIONS,
        sizeMm: QR3MF_LIMITS.maxSizeMm,
        textLines: allLines,
        textFont: FONT,
      }),
    ).not.toThrow()
  })
})

describe('rounded plate corners', () => {
  const plate = () =>
    buildQr3mfMeshes(TEST_URL, { ...VALID_OPTIONS, lanyardLoop: false }).base.vertices

  it('rounds each corner with an ID-1 card radius, keeping the outer bounds', () => {
    const v = plate()
    const points: [number, number][] = []
    for (let i = 0; i < v.length; i += 3) points.push([v[i], v[i + 1]])

    // No vertex sits in a square corner, and the straight edges still reach
    // the full 60 x 60 bounds.
    const corners: [number, number][] = [[0, 0], [60, 0], [60, 60], [0, 60]]
    for (const [cx, cy] of corners) {
      expect(points.some(([x, y]) => x === cx && y === cy)).toBe(false)
    }
    expect(Math.min(...points.map(([x]) => x))).toBe(0)
    expect(Math.max(...points.map(([x]) => x))).toBe(60)

    // Every corner vertex is exactly CORNER_RADIUS_MM from its arc center.
    const r = CORNER_RADIUS_MM
    const nearCorner = points.filter(([x, y]) => x < r && y < r)
    expect(nearCorner.length).toBeGreaterThan(2)
    for (const [x, y] of nearCorner) expect(Math.hypot(x - r, y - r)).toBeCloseTo(r)
  })

  it('keeps the QR code inside the rounded outline', () => {
    const { qr } = buildQr3mfMeshes(TEST_URL, {
      ...VALID_OPTIONS,
      lanyardLoop: false,
      quietZoneComponents: QR3MF_LIMITS.minQuietZoneComponents,
    })
    const r = CORNER_RADIUS_MM
    for (let i = 0; i < qr.vertices.length; i += 3) {
      const [x, y] = [qr.vertices[i], qr.vertices[i + 1]]
      const cx = Math.min(Math.max(x, r), 60 - r)
      const cy = Math.min(Math.max(y, r), 60 - r)
      expect(Math.hypot(x - cx, y - cy)).toBeLessThanOrEqual(r + 1e-9)
    }
  })
})

describe('buildQr3mfMeshes', () => {
  it('produces the same geometry the .3mf exporter packages', () => {
    const meshes = buildQr3mfMeshes(TEST_URL, VALID_OPTIONS)
    const { objects } = parseModel(generateQr3mf(TEST_URL, VALID_OPTIONS))
    const [base, qr] = objects

    expect(meshes.base.vertices.length / 3).toBe(base.mesh.vertices.length)
    expect(meshes.base.triangles.length / 3).toBe(base.mesh.triangles.length)
    expect(meshes.qr.vertices.length / 3).toBe(qr.mesh.vertices.length)
    expect(meshes.qr.triangles.length / 3).toBe(qr.mesh.triangles.length)
  })

  it('raises the QR relief above the base plate', () => {
    const meshes = buildQr3mfMeshes(TEST_URL, VALID_OPTIONS)
    let minZ = Infinity
    let maxZ = -Infinity
    for (let i = 2; i < meshes.qr.vertices.length; i += 3) {
      minZ = Math.min(minZ, meshes.qr.vertices[i])
      maxZ = Math.max(maxZ, meshes.qr.vertices[i])
    }
    expect(minZ).toBe(VALID_OPTIONS.thicknessMm)
    expect(maxZ).toBeCloseTo(VALID_OPTIONS.thicknessMm + VALID_OPTIONS.reliefMm)
  })

  it('only adds the lanyard tab when requested', () => {
    const withLoop = buildQr3mfMeshes(TEST_URL, VALID_OPTIONS)
    const without = buildQr3mfMeshes(TEST_URL, {
      ...VALID_OPTIONS,
      lanyardLoop: false,
    })
    // The loop adds geometry above the plate's top edge.
    const maxY = (v: number[]) => Math.max(...v.filter((_, i) => i % 3 === 1))
    expect(maxY(without.base.vertices)).toBe(VALID_OPTIONS.sizeMm)
    expect(maxY(withLoop.base.vertices)).toBeGreaterThan(VALID_OPTIONS.sizeMm)
    expect(withLoop.base.vertices.length).toBeGreaterThan(without.base.vertices.length)
  })
})
