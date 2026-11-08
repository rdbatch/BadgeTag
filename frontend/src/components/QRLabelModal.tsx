import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOverlayClose } from '../hooks/useOverlayClose'
import {
  buildQrLabelLines,
  drawQrLabel,
  LABEL_PX,
  LABEL_SIZE_MM,
  renderQrLabel,
  type QrLabelInput,
} from '../lib/qrLabel'

interface QRLabelModalProps {
  profileId: string
  isOpen: boolean
  onClose: () => void
  /** The profile's display name; included as a text line when present. */
  displayName?: string
  /** The profile's pronouns; included as a text line when present. */
  pronouns?: string
  /** Custom vanity slug (without the `@`), if the profile has claimed one. */
  slug?: string
}

/**
 * Whether this browser can share a PNG file via the native share sheet — true
 * on mobile browsers with Web Share file support (iOS Safari, Android Chrome).
 * Mirrors QRModal's probe so the "Share" button only appears where it works.
 */
function canSharePng(): boolean {
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean }
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') {
    return false
  }
  try {
    const probe = new File([''], 'probe.png', { type: 'image/png' })
    return nav.canShare({ files: [probe] })
  } catch {
    return false
  }
}

/** Trigger a classic browser file download of a blob. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** Open the native share sheet with the PNG so the user can save it to Photos. */
async function sharePng(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: 'image/png' })
  try {
    await navigator.share({ files: [file], title: filename })
  } catch (err) {
    // AbortError = the user dismissed the sheet; swallow everything, since the
    // download button is the always-available path.
    if (err instanceof DOMException && err.name === 'AbortError') return
  }
}

/**
 * Admin-only modal that generates a black-on-white QR label sized for an
 * 80 × 50 mm thermal label (printed portrait, 50 mm wide). Layout matches the
 * 3D-printed tag: QR code on top, then the URL, name, and pronouns beneath.
 * Present fields are auto-included — there are no toggles and no size control.
 *
 * Rendered only from the admin page; the owner's edit page never exposes it.
 */
export function QRLabelModal({
  profileId,
  isOpen,
  onClose,
  displayName,
  pronouns,
  slug,
}: QRLabelModalProps) {
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)

  const profileUrl = `${window.location.origin}/p/${profileId}`
  const trimmedSlug = slug?.trim() ?? ''
  const urlLabel = trimmedSlug
    ? `${window.location.host}/@${trimmedSlug}`
    : profileUrl.replace(/^https?:\/\//, '')

  const input: QrLabelInput = useMemo(
    () => ({ profileUrl, urlLabel, displayName, pronouns }),
    [profileUrl, urlLabel, displayName, pronouns],
  )

  const lines = useMemo(() => buildQrLabelLines(input), [input])

  // Draw the label into the on-screen preview canvas. The canvas is the full
  // print-resolution size (LABEL_PX) and scaled down with CSS, so the preview
  // matches the exported PNG exactly.
  useEffect(() => {
    if (!isOpen) return
    const canvas = previewRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx) return
    drawQrLabel(ctx, input)
  }, [isOpen, input])

  // Focus trap and ESC key handling.
  useEffect(() => {
    if (!isOpen) return

    previousFocusRef.current = document.activeElement as HTMLElement

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    const firstButton = modalRef.current?.querySelector<HTMLElement>('button')
    firstButton?.focus()

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [isOpen, onClose])

  const filename = `badgetag-label-${profileId}.png`

  const handleDownload = useCallback(() => {
    void renderQrLabel(input).then((blob) => downloadBlob(blob, filename))
  }, [input, filename])

  const handleShare = useCallback(() => {
    void renderQrLabel(input).then((blob) => sharePng(blob, filename))
  }, [input, filename])

  // Whether the native share sheet is available. Computed once on open; it
  // never changes within a session.
  const [canShare] = useState(canSharePng)

  const overlayClose = useOverlayClose(onClose)

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      {...overlayClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-label-modal-title"
    >
      <div
        ref={modalRef}
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 id="qr-label-modal-title" className="text-lg font-bold text-gray-900">
            QR Label
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close QR label modal"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mb-4 text-sm text-gray-600">
          Black-and-white label for an {LABEL_SIZE_MM.heightMm} × {LABEL_SIZE_MM.widthMm} mm
          thermal label, printed portrait. Save it to your camera roll, then print from
          your label printer app.
        </p>

        {/* Preview — the canvas is full print resolution, scaled down by CSS
            so it matches the exported PNG exactly. */}
        <div className="flex justify-center rounded-lg border border-gray-200 bg-gray-50 p-4">
          <canvas
            ref={previewRef}
            width={LABEL_PX.width}
            height={LABEL_PX.height}
            data-testid="qr-label-preview"
            aria-label={`QR label preview: ${lines.map((l) => l.text).join(', ')}`}
            className="h-auto w-[150px] rounded bg-white shadow-sm"
          />
        </div>

        {/* Actions */}
        <div className="mt-6 flex gap-3">
          <button
            onClick={handleDownload}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Download
          </button>
          {/* Share only appears on mobile browsers that can share a file —
              the native share sheet is where "Save to Photos" lives. */}
          {canShare && (
            <button
              onClick={handleShare}
              className="flex-1 rounded-lg border border-blue-600 px-4 py-2.5 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50"
            >
              Share
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
