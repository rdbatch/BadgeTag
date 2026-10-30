import { commandsToContours } from './textFont'
import { loadTestFont } from '../test/textFontFixture'

describe('commandsToContours', () => {
  it('flips y to point up and drops the duplicate closing point', () => {
    const contours = commandsToContours([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 2, y: 0 },
      { type: 'L', x: 2, y: -2 },
      { type: 'L', x: 0, y: 0 },
      { type: 'Z' },
    ])
    expect(contours).toEqual([
      [
        [0, -0],
        [2, -0],
        [2, 2],
      ],
    ])
  })

  it('flattens curves into line segments that end on the curve endpoint', () => {
    const [contour] = commandsToContours([
      { type: 'M', x: 0, y: 0 },
      { type: 'Q', x1: 1, y1: -2, x: 2, y: 0 },
      { type: 'C', x1: 2, y1: 1, x2: 0, y2: 1, x: 0, y: 0.5 },
      { type: 'Z' },
    ])
    expect(contour.length).toBeGreaterThan(6)
    expect(contour).toContainEqual([2, -0])
  })

  it('splits separate subpaths into separate contours', () => {
    const contours = commandsToContours([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 1, y: 0 },
      { type: 'L', x: 1, y: -1 },
      { type: 'Z' },
      { type: 'M', x: 5, y: 0 },
      { type: 'L', x: 6, y: 0 },
      { type: 'L', x: 6, y: -1 },
      { type: 'Z' },
    ])
    expect(contours).toHaveLength(2)
  })
})

describe('parseTextFont (Lato Bold)', () => {
  const font = loadTestFont()

  it('reports sensible cap height and descender ratios', () => {
    expect(font.capHeight).toBeGreaterThan(0.6)
    expect(font.capHeight).toBeLessThan(0.8)
    expect(font.descender).toBeGreaterThan(0.1)
    expect(font.descender).toBeLessThan(0.3)
  })

  it('scales advance width linearly with size', () => {
    expect(font.advanceWidth('Ada', 10)).toBeCloseTo(2 * font.advanceWidth('Ada', 5))
  })

  it('returns one outline set per inked glyph, skipping spaces', () => {
    expect(font.glyphContours('A B', 6)).toHaveLength(2)
  })

  it('places capitals between the baseline and cap height', () => {
    const [glyph] = font.glyphContours('H', 10)
    const ys = glyph.flat().map(([, y]) => y)
    expect(Math.min(...ys)).toBeCloseTo(0, 1)
    expect(Math.max(...ys)).toBeCloseTo(font.capHeight * 10, 1)
  })
})
