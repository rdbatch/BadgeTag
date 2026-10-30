import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  computeMinSizeMm,
  computeModuleCount,
  DEFAULT_QUIET_ZONE_COMPONENTS,
  DEFAULT_RELIEF_MM,
  generateQr3mf,
  QR3MF_LIMITS,
} from '../lib/qr3mf'
import type { TextFont } from '../lib/textMesh'
import type { TextAlign } from '../lib/qr3mf'
import { TextAlignPicker } from './TextAlignPicker'
import { useOverlayClose } from '../hooks/useOverlayClose'
import { LazyLoadErrorBoundary } from './LazyLoadErrorBoundary'

// Loaded on demand: the preview pulls in three.js, which shouldn't weigh
// down the edit page for users who never open this modal.
const Print3DPreview = lazy(() => import('./Print3DPreview'))

interface Print3DModalProps {
  profileId: string
  isOpen: boolean
  onClose: () => void
  /** The profile's display name, offered as an optional text line. */
  displayName?: string
  /** The profile's pronouns, offered as an optional text line. */
  pronouns?: string
  /** The saved custom URL slug; the URL line shows `/@slug` when set. */
  slug?: string
}

const DEFAULT_SIZE_MM = 50
const DEFAULT_THICKNESS_MM = 3

/**
 * Customizer for downloading the profile QR code as a 3D-printable .3mf
 * file. Owner-only: rendered from the edit page, never the public card.
 */
export function Print3DModal({
  profileId,
  isOpen,
  onClose,
  displayName,
  pronouns,
  slug,
}: Print3DModalProps) {
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const profileUrl = `${window.location.origin}/p/${profileId}`

  const componentCount = useMemo(() => computeModuleCount(profileUrl), [profileUrl])

  const [sizeMm, setSizeMm] = useState(() =>
    Math.max(DEFAULT_SIZE_MM, computeMinSizeMm(profileUrl, DEFAULT_QUIET_ZONE_COMPONENTS)),
  )
  const [thicknessMm, setThicknessMm] = useState(DEFAULT_THICKNESS_MM)
  const [lanyardLoop, setLanyardLoop] = useState(true)
  const [quietZoneComponents, setQuietZoneComponents] = useState(
    DEFAULT_QUIET_ZONE_COMPONENTS,
  )
  const [reliefMm, setReliefMm] = useState(DEFAULT_RELIEF_MM)

  // Optional text lines raised below the QR code. Each toggle adds one line
  // and grows the plate's height. The URL line starts on; name and
  // pronouns are opt-in.
  const [showUrlLine, setShowUrlLine] = useState(true)
  const [showNameLine, setShowNameLine] = useState(false)
  const [showPronounsLine, setShowPronounsLine] = useState(false)
  const [textAlign, setTextAlign] = useState<TextAlign>('center')

  // Text shown for the URL line, without the scheme so it stays compact.
  // Uses the custom URL when one is saved, matching the OG image label;
  // the QR itself still encodes the permanent /p/ URL.
  const trimmedSlug = slug?.trim() ?? ''
  const urlLineText = trimmedSlug
    ? `${window.location.host}/@${trimmedSlug}`
    : profileUrl.replace(/^https?:\/\//, '')
  const trimmedName = displayName?.trim() ?? ''
  const trimmedPronouns = pronouns?.trim() ?? ''

  const textLines = useMemo(() => {
    const lines: string[] = []
    if (showUrlLine) lines.push(urlLineText)
    if (showNameLine && trimmedName) lines.push(trimmedName)
    if (showPronounsLine && trimmedPronouns) lines.push(trimmedPronouns)
    return lines
  }, [
    showUrlLine,
    urlLineText,
    showNameLine,
    trimmedName,
    showPronounsLine,
    trimmedPronouns,
  ])

  // The text font (opentype.js + Lato Bold) loads only once a text line is
  // turned on, so users who never add text don't download it.
  const [textFont, setTextFont] = useState<TextFont | null>(null)
  const [fontError, setFontError] = useState(false)
  const wantsText = textLines.length > 0
  useEffect(() => {
    if (!isOpen || !wantsText || textFont) return
    let cancelled = false
    setFontError(false)
    import('../lib/textFont')
      .then(({ loadTextFont }) => loadTextFont())
      .then((font) => {
        if (!cancelled) setTextFont(font)
      })
      .catch(() => {
        if (!cancelled) setFontError(true)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, wantsText, textFont])
  const textNotReady = wantsText && !textFont

  // The URL's length decides the code's density, and a smaller quiet zone
  // needs less border — both shrink or grow the smallest plate that keeps
  // components printable and scannable.
  const minSizeMm = useMemo(
    () => computeMinSizeMm(profileUrl, quietZoneComponents),
    [profileUrl, quietZoneComponents],
  )

  // Keep the chosen size valid if a wider quiet zone raises the minimum.
  useEffect(() => {
    setSizeMm((current) => Math.max(current, minSizeMm))
  }, [minSizeMm])

  const componentPitchMm = sizeMm / (componentCount + 2 * quietZoneComponents)

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

    const firstButton = modalRef.current?.querySelector<HTMLElement>('button')
    firstButton?.focus()

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [isOpen, onClose])

  function handleDownload() {
    if (textNotReady) return
    const data = generateQr3mf(profileUrl, {
      sizeMm,
      thicknessMm,
      lanyardLoop,
      quietZoneComponents,
      reliefMm,
      textLines,
      textFont: textFont ?? undefined,
      textAlign,
    })
    const blob = new Blob([data], { type: 'model/3mf' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `badgetag-${profileId}.3mf`
    link.click()
    URL.revokeObjectURL(url)
  }

  const overlayClose = useOverlayClose(onClose)

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      {...overlayClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="print3d-modal-title"
    >
      <div
        ref={modalRef}
        className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl bg-white p-6 shadow-xl md:max-w-2xl"
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 id="print3d-modal-title" className="text-lg font-bold text-gray-900">
            3D Print Your QR Code
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close 3D print modal"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="md:flex md:items-start md:gap-6">
          {/* Live preview */}
          <div className="md:sticky md:top-0 md:w-64 md:shrink-0 lg:w-72">
            <LazyLoadErrorBoundary>
              <Suspense
                fallback={
                  <div
                    className="aspect-square w-full animate-pulse rounded-lg bg-gray-100"
                    aria-hidden="true"
                  />
                }
              >
                <Print3DPreview
                  profileUrl={profileUrl}
                  options={{
                    sizeMm,
                    thicknessMm,
                    lanyardLoop,
                    quietZoneComponents,
                    reliefMm,
                    textLines,
                    textFont: textFont ?? undefined,
                    textAlign,
                  }}
                />
              </Suspense>
            </LazyLoadErrorBoundary>
          </div>

          <div className="mt-4 md:mt-0 md:min-w-0 md:flex-1">
            <p className="text-sm text-gray-600">
              Downloads a .3mf model with the base and QR code as separate parts,
              so you can print each in its own color and keep the code scannable.
            </p>
    
            {/* Size */}
            <div className="mt-5">
              <div className="flex items-center justify-between">
                <label htmlFor="print3d-size" className="text-sm font-medium text-gray-700">
                  Size
                </label>
                <span className="text-sm text-gray-500">
                  {sizeMm} × {sizeMm} mm
                </span>
              </div>
              <input
                id="print3d-size"
                type="range"
                min={minSizeMm}
                max={QR3MF_LIMITS.maxSizeMm}
                step={1}
                value={sizeMm}
                onChange={(e) => setSizeMm(Number(e.target.value))}
                className="mt-2 w-full accent-blue-600"
              />
              <p className="mt-1 text-xs text-gray-500">
                The code won't scan reliably if its squares get smaller than{' '}
                {QR3MF_LIMITS.minModuleMm} mm, so {minSizeMm} mm is as small as
                this can go. Right now each square is about{' '}
                {componentPitchMm.toFixed(2)} mm.
              </p>
            </div>
    
            {/* Thickness */}
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <label htmlFor="print3d-thickness" className="text-sm font-medium text-gray-700">
                  Thickness
                </label>
                <span className="text-sm text-gray-500">{thicknessMm.toFixed(1)} mm</span>
              </div>
              <input
                id="print3d-thickness"
                type="range"
                min={QR3MF_LIMITS.minThicknessMm}
                max={QR3MF_LIMITS.maxThicknessMm}
                step={0.2}
                value={thicknessMm}
                onChange={(e) => setThicknessMm(Number(e.target.value))}
                className="mt-2 w-full accent-blue-600"
              />
            </div>
    
            {/* Quiet zone */}
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <label htmlFor="print3d-quiet-zone" className="text-sm font-medium text-gray-700">
                  Quiet zone
                </label>
                <span className="text-sm text-gray-500">
                  {quietZoneComponents.toFixed(1)} squares
                </span>
              </div>
              <input
                id="print3d-quiet-zone"
                type="range"
                min={QR3MF_LIMITS.minQuietZoneComponents}
                max={QR3MF_LIMITS.maxQuietZoneComponents}
                step={0.5}
                value={quietZoneComponents}
                onChange={(e) => setQuietZoneComponents(Number(e.target.value))}
                className="mt-2 w-full accent-blue-600"
              />
              <p className="mt-1 text-xs text-gray-500">
                Blank border around the code. Smaller fits more code into the
                same plate; too small can make it harder for cameras to find.
              </p>
            </div>
    
            {/* Relief height */}
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <label htmlFor="print3d-relief" className="text-sm font-medium text-gray-700">
                  Relief height
                </label>
                <span className="text-sm text-gray-500">{reliefMm.toFixed(1)} mm</span>
              </div>
              <input
                id="print3d-relief"
                type="range"
                min={QR3MF_LIMITS.minReliefMm}
                max={QR3MF_LIMITS.maxReliefMm}
                step={0.2}
                value={reliefMm}
                onChange={(e) => setReliefMm(Number(e.target.value))}
                className="mt-2 w-full accent-blue-600"
              />
              <p className="mt-1 text-xs text-gray-500">
                How far the code stands proud of the base plate.
              </p>
            </div>
    
            {/* Lanyard loop */}
            <div className="mt-4 flex items-center justify-between">
              <label htmlFor="print3d-loop" className="text-sm font-medium text-gray-700">
                Lanyard loop
                <span className="block text-xs font-normal text-gray-500">
                  14 × 3 mm slot — fits standard badge clips
                </span>
              </label>
              <button
                id="print3d-loop"
                type="button"
                role="switch"
                aria-checked={lanyardLoop}
                onClick={() => setLanyardLoop(!lanyardLoop)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none ${
                  lanyardLoop ? 'bg-blue-600' : 'bg-gray-300'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
                    lanyardLoop ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Text lines below the code */}
            <div
              role="group"
              aria-labelledby="print3d-text-heading"
              className="mt-5 border-t border-gray-200 pt-4"
            >
              <div className="flex items-center justify-between">
                <h3 id="print3d-text-heading" className="text-sm font-medium text-gray-700">
                  Text
                </h3>
                {wantsText && <TextAlignPicker value={textAlign} onChange={setTextAlign} />}
              </div>

              <div className="mt-3 space-y-3">
                <ToggleRow
                  id="print3d-text-url"
                  label="BadgeTag URL"
                  checked={showUrlLine}
                  onChange={() => setShowUrlLine((v) => !v)}
                />
                <ToggleRow
                  id="print3d-text-name"
                  label="Name"
                  checked={showNameLine}
                  disabled={!trimmedName}
                  onChange={() => setShowNameLine((v) => !v)}
                />
                <ToggleRow
                  id="print3d-text-pronouns"
                  label="Pronouns"
                  checked={showPronounsLine}
                  disabled={!trimmedPronouns}
                  onChange={() => setShowPronounsLine((v) => !v)}
                />
              </div>
              {fontError && (
                <p role="alert" className="mt-3 text-xs text-red-600">
                  The text font couldn't load. Check your connection, then
                  toggle a line off and on to retry.
                </p>
              )}
            </div>
    
            {/* Actions */}
            <div className="mt-6 flex gap-3">
              <button
                onClick={handleDownload}
                disabled={textNotReady}
                className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {textNotReady && !fontError ? 'Loading font…' : 'Download .3mf'}
              </button>
              <button
                onClick={onClose}
                className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface ToggleRowProps {
  id: string
  label: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}

/**
 * A labeled switch for an optional text line. Disabled when the underlying
 * profile field is empty, so the user can't add a blank line.
 */
function ToggleRow({
  id,
  label,
  checked,
  onChange,
  disabled = false,
}: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label
        htmlFor={id}
        className={`min-w-0 text-sm font-medium ${
          disabled ? 'text-gray-400' : 'text-gray-700'
        }`}
      >
        {label}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={onChange}
        className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none ${
          disabled
            ? 'cursor-not-allowed bg-gray-200'
            : checked
              ? 'cursor-pointer bg-blue-600'
              : 'cursor-pointer bg-gray-300'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}
