import qrcode from 'qrcode-generator'

/**
 * Renders a QR code plus supporting text lines to a black-on-white PNG sized
 * for an 80 × 50 mm thermal label held in portrait (50 mm wide, 80 mm tall),
 * matching the vertical layout of the 3D-printed .3mf tag: QR code at the top,
 * then the URL, name, and pronouns stacked beneath it.
 *
 * Thermal label printers are monochrome, so this intentionally has no color,
 * no profile-photo overlay, and no size controls — it is a single fixed label
 * geometry rendered at print resolution.
 */

/** Physical label size in millimeters, portrait (width × height). */
export const LABEL_SIZE_MM = { widthMm: 50, heightMm: 80 } as const

/**
 * Print resolution. 300 DPI is the common native density for the small
 * thermal label printers this targets, and gives crisp QR module edges.
 */
export const LABEL_DPI = 300

const MM_PER_INCH = 25.4

/** Label pixel dimensions at {@link LABEL_DPI}. */
export const LABEL_PX = {
  width: Math.round((LABEL_SIZE_MM.widthMm / MM_PER_INCH) * LABEL_DPI),
  height: Math.round((LABEL_SIZE_MM.heightMm / MM_PER_INCH) * LABEL_DPI),
} as const

/**
 * Error correction level, matching the printed .3mf tag: 'M' yields fewer
 * modules than the on-screen 'H' (which leaves room for a photo overlay the
 * label omits), so each module prints larger and scans better.
 */
const EC_LEVEL = 'M'

/** Em height per line size, in millimeters — same scale as the .3mf text. */
const TEXT_EM_MM: Record<QrLabelLine['size'], number> = { small: 4.5, large: 6 }
/** Line box is 4/3 of the em, leaving room for descenders and line spacing. */
const BAND_PER_EM = 4 / 3

/** Outer margin around the whole label content, in millimeters. */
const MARGIN_MM = 4
/** Quiet zone around the QR code, in QR modules. */
const QUIET_ZONE_MODULES = 2
/** Vertical gap between the QR code and the first text line, in millimeters. */
const QR_TEXT_GAP_MM = 3

/** One line of text below the QR code. */
export interface QrLabelLine {
  text: string
  /** `small` for the URL, `large` for name and pronouns. */
  size: 'small' | 'large'
}

export interface QrLabelInput {
  /** The URL encoded in the QR code and shown (scheme-stripped) as the first line. */
  profileUrl: string
  /** Human-readable URL label, e.g. `host/@slug`; defaults to the scheme-stripped URL. */
  urlLabel?: string
  /** Optional display name. Omitted from the label when empty. */
  displayName?: string
  /** Optional pronouns. Omitted from the label when empty. */
  pronouns?: string
}

/**
 * Builds the ordered text lines for a label: the URL always (small), then the
 * name and pronouns (large) only when the profile has them. Mirrors the
 * "auto-include present fields" rule of the admin QR-label modal.
 */
export function buildQrLabelLines(input: QrLabelInput): QrLabelLine[] {
  const lines: QrLabelLine[] = []
  const urlText = (input.urlLabel ?? input.profileUrl.replace(/^https?:\/\//, '')).trim()
  if (urlText) lines.push({ text: urlText, size: 'small' })
  const name = input.displayName?.trim()
  if (name) lines.push({ text: name, size: 'large' })
  const pronouns = input.pronouns?.trim()
  if (pronouns) lines.push({ text: pronouns, size: 'large' })
  return lines
}

/** QR module matrix (true = dark) for the given text at {@link EC_LEVEL}. */
function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, EC_LEVEL)
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let r = 0; r < n; r++) {
    const row: boolean[] = []
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c))
    rows.push(row)
  }
  return rows
}

/**
 * Draws the label onto the given 2D context. The context's canvas must be
 * {@link LABEL_PX} in size. Factored out of {@link renderQrLabel} so tests can
 * drive it with a mock context without a real canvas/PNG encoder.
 */
export function drawQrLabel(ctx: CanvasRenderingContext2D, input: QrLabelInput): void {
  const pxPerMm = LABEL_DPI / MM_PER_INCH
  const width = LABEL_PX.width
  const height = LABEL_PX.height
  const margin = MARGIN_MM * pxPerMm
  const contentWidth = width - 2 * margin
  const centerX = width / 2

  // White background.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  // QR code: a square centered horizontally at the top. Its side is the
  // content width (capped so very wide labels still leave the vertical room
  // the text needs), snapped to a whole number of modules for crisp edges.
  const matrix = qrMatrix(input.profileUrl)
  const modules = matrix.length + 2 * QUIET_ZONE_MODULES

  const lines = buildQrLabelLines(input)
  const textBandPx = lines.reduce(
    (sum, line) => sum + TEXT_EM_MM[line.size] * BAND_PER_EM * pxPerMm,
    0,
  )
  const gapPx = lines.length > 0 ? QR_TEXT_GAP_MM * pxPerMm : 0

  // Largest QR side that fits the content width and still leaves room for the
  // text block below it.
  const maxQrByHeight = height - 2 * margin - gapPx - textBandPx
  const targetQrSide = Math.min(contentWidth, maxQrByHeight)
  const modulePx = Math.max(1, Math.floor(targetQrSide / modules))
  const qrSide = modulePx * modules
  const qrX = Math.round(centerX - qrSide / 2)
  const qrY = Math.round(margin)

  // White quiet zone + dark modules.
  ctx.fillStyle = '#000000'
  const offset = QUIET_ZONE_MODULES * modulePx
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      if (matrix[r][c]) {
        ctx.fillRect(
          qrX + offset + c * modulePx,
          qrY + offset + r * modulePx,
          modulePx,
          modulePx,
        )
      }
    }
  }

  // Text lines, centered, stacked below the QR with a gap. Each line is drawn
  // at a font size that fills its em but is shrunk to fit the content width.
  ctx.fillStyle = '#000000'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let cursorY = qrY + qrSide + gapPx
  for (const line of lines) {
    const bandPx = TEXT_EM_MM[line.size] * BAND_PER_EM * pxPerMm
    const emPx = TEXT_EM_MM[line.size] * pxPerMm
    const fontPx = fitFontSize(ctx, line.text, emPx, contentWidth)
    ctx.font = `bold ${fontPx}px sans-serif`
    ctx.fillText(line.text, centerX, cursorY + bandPx / 2)
    cursorY += bandPx
  }
}

/**
 * Returns the largest font size at or below `emPx` whose rendered width of
 * `text` fits within `maxWidth`. Keeps long names/URLs on one line by scaling
 * the glyphs down rather than wrapping.
 */
function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  emPx: number,
  maxWidth: number,
): number {
  ctx.font = `bold ${emPx}px sans-serif`
  const width = ctx.measureText(text).width
  if (width <= maxWidth || width === 0) return emPx
  return Math.max(1, Math.floor((emPx * maxWidth) / width))
}

/**
 * Renders the label to a PNG blob. Rejects if a 2D canvas context or PNG
 * encoding is unavailable (both are present in every browser this ships to).
 */
export function renderQrLabel(input: QrLabelInput): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas')
    canvas.width = LABEL_PX.width
    canvas.height = LABEL_PX.height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      reject(new Error('Canvas 2D context unavailable'))
      return
    }
    drawQrLabel(ctx, input)
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Failed to encode label PNG'))
    }, 'image/png')
  })
}
