import { describe, expect, it, vi } from 'vitest'
import {
  buildQrLabelLines,
  drawQrLabel,
  LABEL_DPI,
  LABEL_PX,
  LABEL_SIZE_MM,
  type QrLabelInput,
} from './qrLabel'

const TEST_URL = 'https://badgetag.me/p/abc123'

describe('buildQrLabelLines', () => {
  it('always includes the URL line (scheme-stripped) as a small line', () => {
    const lines = buildQrLabelLines({ profileUrl: TEST_URL })
    expect(lines).toEqual([{ text: 'badgetag.me/p/abc123', size: 'small' }])
  })

  it('prefers an explicit urlLabel over the raw URL', () => {
    const lines = buildQrLabelLines({
      profileUrl: TEST_URL,
      urlLabel: 'badgetag.me/@grace',
    })
    expect(lines[0]).toEqual({ text: 'badgetag.me/@grace', size: 'small' })
  })

  it('includes name and pronouns as large lines when present, in order', () => {
    const lines = buildQrLabelLines({
      profileUrl: TEST_URL,
      urlLabel: 'badgetag.me/@grace',
      displayName: 'Grace Hopper',
      pronouns: 'she/her',
    })
    expect(lines).toEqual([
      { text: 'badgetag.me/@grace', size: 'small' },
      { text: 'Grace Hopper', size: 'large' },
      { text: 'she/her', size: 'large' },
    ])
  })

  it('omits empty / whitespace-only name and pronouns', () => {
    const lines = buildQrLabelLines({
      profileUrl: TEST_URL,
      urlLabel: 'badgetag.me/@grace',
      displayName: '   ',
      pronouns: '',
    })
    expect(lines.map((l) => l.text)).toEqual(['badgetag.me/@grace'])
  })

  it('includes pronouns even when the name is missing', () => {
    const lines = buildQrLabelLines({
      profileUrl: TEST_URL,
      pronouns: 'they/them',
    })
    expect(lines.map((l) => l.text)).toEqual(['badgetag.me/p/abc123', 'they/them'])
  })

  it('gives name and pronouns the same (large) size', () => {
    const lines = buildQrLabelLines({
      profileUrl: TEST_URL,
      displayName: 'Grace Hopper',
      pronouns: 'she/her',
    })
    const name = lines.find((l) => l.text === 'Grace Hopper')
    const pronouns = lines.find((l) => l.text === 'she/her')
    expect(name?.size).toBe('large')
    expect(pronouns?.size).toBe('large')
    expect(name?.size).toBe(pronouns?.size)
  })
})

describe('label dimensions', () => {
  it('is 50 × 80 mm portrait', () => {
    expect(LABEL_SIZE_MM).toEqual({ widthMm: 50, heightMm: 80 })
  })

  it('computes pixel size at 300 DPI', () => {
    // 50mm → ~591px, 80mm → ~945px at 300 DPI.
    expect(LABEL_DPI).toBe(300)
    expect(LABEL_PX.width).toBe(591)
    expect(LABEL_PX.height).toBe(945)
    // Portrait: taller than wide.
    expect(LABEL_PX.height).toBeGreaterThan(LABEL_PX.width)
  })
})

/** A recording 2D context stub — jsdom has no real canvas backend. */
function mockContext() {
  const fillRect = vi.fn()
  const fillText = vi.fn()
  const ctx = {
    fillStyle: '' as string,
    font: '' as string,
    textAlign: '' as CanvasTextAlign,
    textBaseline: '' as CanvasTextBaseline,
    fillRect,
    fillText,
    measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fillRect, fillText }
}

describe('drawQrLabel', () => {
  const input: QrLabelInput = {
    profileUrl: TEST_URL,
    urlLabel: 'badgetag.me/@grace',
    displayName: 'Grace Hopper',
    pronouns: 'she/her',
  }

  it('paints a white background and draws black QR modules', () => {
    const { ctx, fillRect } = mockContext()
    drawQrLabel(ctx, input)

    // First fillRect is the full-canvas white background.
    const [firstCall] = fillRect.mock.calls
    expect(firstCall).toEqual([0, 0, LABEL_PX.width, LABEL_PX.height])

    // Many more fillRects follow for the dark QR modules.
    expect(fillRect.mock.calls.length).toBeGreaterThan(50)
  })

  it('draws one centered text line per present field', () => {
    const { ctx, fillText } = mockContext()
    drawQrLabel(ctx, input)

    const drawn = fillText.mock.calls.map(([text]) => text)
    expect(drawn).toEqual(['badgetag.me/@grace', 'Grace Hopper', 'she/her'])
    // All centered on the label's horizontal midpoint.
    for (const [, x] of fillText.mock.calls) {
      expect(x).toBe(LABEL_PX.width / 2)
    }
  })

  it('omits text lines for absent fields', () => {
    const { ctx, fillText } = mockContext()
    drawQrLabel(ctx, { profileUrl: TEST_URL, urlLabel: 'badgetag.me/p/abc123' })
    const drawn = fillText.mock.calls.map(([text]) => text)
    expect(drawn).toEqual(['badgetag.me/p/abc123'])
  })

  it('centers text by default, anchored on the label midpoint', () => {
    const { ctx, fillText } = mockContext()
    drawQrLabel(ctx, input)
    expect(ctx.textAlign).toBe('center')
    for (const [, x] of fillText.mock.calls) {
      expect(x).toBe(LABEL_PX.width / 2)
    }
  })

  it('left-aligns text against the inner margin', () => {
    const { ctx, fillText } = mockContext()
    drawQrLabel(ctx, { ...input, align: 'left' })
    expect(ctx.textAlign).toBe('left')
    const xs = fillText.mock.calls.map(([, x]) => x)
    // All lines share one left anchor, strictly inside the label.
    expect(new Set(xs).size).toBe(1)
    expect(xs[0]).toBeGreaterThan(0)
    expect(xs[0]).toBeLessThan(LABEL_PX.width / 2)
  })

  it('right-aligns text against the inner margin', () => {
    const { ctx, fillText } = mockContext()
    drawQrLabel(ctx, { ...input, align: 'right' })
    expect(ctx.textAlign).toBe('right')
    const xs = fillText.mock.calls.map(([, x]) => x)
    expect(new Set(xs).size).toBe(1)
    expect(xs[0]).toBeGreaterThan(LABEL_PX.width / 2)
    expect(xs[0]).toBeLessThan(LABEL_PX.width)
  })

  it('uses only black and white fill colors (thermal-printer safe)', () => {
    const colors = new Set<string>()
    const base = mockContext()
    const ctx = new Proxy(base.ctx, {
      set(target, prop, value) {
        if (prop === 'fillStyle') colors.add(value as string)
        return Reflect.set(target, prop, value)
      },
    })
    drawQrLabel(ctx, input)
    expect([...colors].sort()).toEqual(['#000000', '#ffffff'])
  })
})
