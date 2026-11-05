import { useEffect, useRef, useCallback, useState } from 'react'
import QRCode from 'react-qr-code'
import { useOverlayClose } from '../hooks/useOverlayClose'

/**
 * Pixel size the QR code is rasterized to when exported, independent of the
 * small on-screen preview. The code is a vector SVG, so upscaling to this is
 * lossless and removes the pixelation seen when the preview size was exported
 * directly. The whole exported PNG is a little larger than this once padding
 * and the caption row are added.
 */
const QR_EXPORT_SIZE = 1024

/**
 * Deliver a rendered PNG to the user. On mobile browsers that support sharing
 * files (iOS Safari, Android Chrome), open the native share sheet so the user
 * can tap "Save Image" / "Save to Photos" — the closest a web app can get to
 * saving straight to the camera roll, since browsers have no direct photo
 * library write access. Everywhere else (and if the user cancels or sharing
 * fails) fall back to a normal file download.
 */
async function deliverPng(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: 'image/png' })

  const nav = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean
  }
  const canShareFile =
    typeof nav.share === 'function' &&
    typeof nav.canShare === 'function' &&
    nav.canShare({ files: [file] })

  if (canShareFile) {
    try {
      await nav.share({ files: [file], title: filename })
      return
    } catch (err) {
      // AbortError = user dismissed the share sheet; don't then force a
      // download behind their back. Any other failure falls through to the
      // download so the user still gets their file.
      if (err instanceof DOMException && err.name === 'AbortError') return
    }
  }

  downloadBlob(blob, filename)
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

interface QRModalProps {
  profileId: string
  isOpen: boolean
  onClose: () => void
  imageUrl?: string
  /**
   * Whether to show the "Show profile photo" toggle switch. Defaults to
   * true. Set to false for read-only contexts (e.g. the public card page)
   * where the photo should always be shown alongside the QR code with no
   * user-facing toggle.
   */
  showPhotoToggle?: boolean
  /** Custom vanity slug (without the `@`), if the profile has claimed one. */
  slug?: string
}

export function QRModal({
  profileId,
  isOpen,
  onClose,
  imageUrl,
  showPhotoToggle = true,
  slug,
}: QRModalProps) {
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [showPhoto, setShowPhoto] = useState(true)

  const profileUrl = `${window.location.origin}/p/${profileId}`
  // Caption shown below the QR code — the bare app domain, or the profile's
  // full vanity URL if it has a custom slug. Kept separate from the QR's
  // encoded value above: the code always still points at the stable
  // `/p/{id}` URL, this is just a human-readable label.
  const qrLabel = slug ? `${window.location.host}/@${slug}` : window.location.host

  // Focus trap and ESC key handling
  useEffect(() => {
    if (!isOpen) return

    previousFocusRef.current = document.activeElement as HTMLElement

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      // Focus trap
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

    // Focus the modal
    const firstButton = modalRef.current?.querySelector<HTMLElement>('button')
    firstButton?.focus()

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [isOpen, onClose])

  const handleDownload = useCallback(() => {
    const svg = document.getElementById('qr-code-svg')
    if (!svg) return

    const svgData = new XMLSerializer().serializeToString(svg)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Target render size for the QR code itself, independent of the small
    // on-screen preview (220px). The SVG is vector, so rasterizing it at a
    // larger size is lossless — this is what fixes the pixelated download.
    // Padding and the caption row scale off this so the layout stays in
    // proportion no matter what QR_EXPORT_SIZE is.
    const qrSize = QR_EXPORT_SIZE
    const padding = Math.round(qrSize * 0.145)
    const labelHeight = Math.round(qrSize * 0.11)
    const fontSize = Math.round(qrSize * 0.059)

    const qrImg = new Image()
    qrImg.onload = () => {
      canvas.width = qrSize + padding * 2
      canvas.height = qrSize + padding * 2 + labelHeight

      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      // Draw the SVG scaled up to the full export size regardless of its
      // intrinsic (preview) dimensions.
      ctx.drawImage(qrImg, padding, padding, qrSize, qrSize)
      drawLabel(ctx, padding, padding + qrSize)

      if (showPhoto && imageUrl) {
        // imageUrl is served same-origin (via the frontend's own CloudFront
        // distribution), so this never taints the canvas — no CORS dance
        // needed here, unlike a genuinely cross-origin image would require.
        const photoImg = new Image()
        photoImg.onload = () => {
          drawPhotoOnCanvas(ctx, photoImg, qrSize, qrSize)
          exportCanvas(canvas)
        }
        photoImg.onerror = () => {
          // If the photo fails to load, still export the plain QR code
          exportCanvas(canvas)
        }
        photoImg.src = imageUrl
      } else {
        exportCanvas(canvas)
      }
    }
    qrImg.src = `data:image/svg+xml;base64,${btoa(svgData)}`

    // Draws the domain/slug caption left-aligned just below the QR code,
    // at the given (x, y) top-left of the caption row — never overlapping
    // the QR's modules or finder patterns (see QRModal's slug prop doc).
    function drawLabel(context: CanvasRenderingContext2D, x: number, y: number) {
      context.fillStyle = '#6b7280'
      context.font = `${fontSize}px sans-serif`
      context.textAlign = 'left'
      context.textBaseline = 'top'
      context.fillText(qrLabel, x, y + Math.round(qrSize * 0.027))
    }

    function drawPhotoOnCanvas(
      context: CanvasRenderingContext2D,
      img: HTMLImageElement,
      qrWidth: number,
      qrHeight: number,
    ) {
      const photoSize = Math.round(qrWidth * 0.25)
      const borderWidth = Math.round(qrWidth * 0.023)
      const centerX = padding + qrWidth / 2
      const centerY = padding + qrHeight / 2

      // Draw white circle border
      context.beginPath()
      context.arc(centerX, centerY, photoSize / 2 + borderWidth, 0, Math.PI * 2)
      context.fillStyle = '#ffffff'
      context.fill()

      // Clip to circle and draw photo
      context.save()
      context.beginPath()
      context.arc(centerX, centerY, photoSize / 2, 0, Math.PI * 2)
      context.clip()
      context.drawImage(
        img,
        centerX - photoSize / 2,
        centerY - photoSize / 2,
        photoSize,
        photoSize,
      )
      context.restore()
    }

    function exportCanvas(c: HTMLCanvasElement) {
      c.toBlob((blob) => {
        if (!blob) return
        void deliverPng(blob, `badgetag-${profileId}.png`)
      }, 'image/png')
    }
  }, [profileId, showPhoto, imageUrl, qrLabel])

  const overlayClose = useOverlayClose(onClose)

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      {...overlayClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-modal-title"
    >
      <div
        ref={modalRef}
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 id="qr-modal-title" className="text-lg font-bold text-gray-900">
            Your QR Code
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close QR code modal"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* QR Code */}
        <div className="flex justify-center rounded-lg bg-white p-4">
          <div className="flex w-[220px] flex-col items-start">
            <div className="relative">
              <QRCode
                id="qr-code-svg"
                value={profileUrl}
                size={220}
                level="H"
                data-testid="qr-code"
              />
              {imageUrl && showPhoto && (
                <img
                  src={imageUrl}
                  alt="Profile photo overlay"
                  className="absolute top-1/2 left-1/2 h-[55px] w-[55px] -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white object-cover"
                  data-testid="qr-photo-overlay"
                />
              )}
            </div>
            <p className="mt-1.5 text-left text-[11px] text-gray-500" data-testid="qr-label">
              {qrLabel}
            </p>
          </div>
        </div>

        {/* Photo Toggle */}
        {imageUrl && showPhotoToggle && (
          <div className="mt-3 flex items-center justify-between">
            <label htmlFor="showPhoto" className="text-sm font-medium text-gray-700">
              Show profile photo
            </label>
            <button
              id="showPhoto"
              type="button"
              role="switch"
              aria-checked={showPhoto}
              onClick={() => setShowPhoto(!showPhoto)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none ${
                showPhoto ? 'bg-blue-600' : 'bg-gray-300'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
                  showPhoto ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        )}

        {/* URL Display */}
        <p className="mt-4 break-all text-center text-sm text-gray-500">
          {profileUrl}
        </p>

        {/* Actions */}
        <div className="mt-6 flex gap-3">
          <button
            onClick={handleDownload}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Download QR
          </button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(profileUrl)
            }}
            className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            Copy URL
          </button>
        </div>
      </div>
    </div>
  )
}
