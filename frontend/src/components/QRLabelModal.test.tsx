import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QRLabelModal } from './QRLabelModal'

// The label renderer draws to a real canvas / encodes a PNG, neither of which
// jsdom implements. Mock it: the modal's job is wiring, the drawing is covered
// by qrLabel.test.ts.
const drawQrLabel = vi.fn()
const renderQrLabel = vi.fn(async () => new Blob(['png'], { type: 'image/png' }))
vi.mock('../lib/qrLabel', async () => {
  const actual = await vi.importActual<typeof import('../lib/qrLabel')>('../lib/qrLabel')
  return {
    ...actual,
    drawQrLabel: (...args: unknown[]) => drawQrLabel(...args),
    renderQrLabel: (...args: unknown[]) => renderQrLabel(...args),
  }
})

const defaultProps = {
  profileId: 'abc123',
  isOpen: true,
  onClose: vi.fn(),
  displayName: 'Grace Hopper',
  pronouns: 'she/her',
  slug: 'grace',
}

describe('QRLabelModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // jsdom has no canvas backend; hand the preview effect a usable context.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as unknown as CanvasRenderingContext2D,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('visibility', () => {
    it('renders when isOpen is true', () => {
      render(<QRLabelModal {...defaultProps} />)
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByText('QR Label')).toBeInTheDocument()
    })

    it('does not render when isOpen is false', () => {
      render(<QRLabelModal {...defaultProps} isOpen={false} />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('renders a preview canvas and draws into it', () => {
      render(<QRLabelModal {...defaultProps} />)
      expect(screen.getByTestId('qr-label-preview')).toBeInTheDocument()
      expect(drawQrLabel).toHaveBeenCalled()
    })

    it('labels the preview with the included text lines', () => {
      render(<QRLabelModal {...defaultProps} />)
      const preview = screen.getByTestId('qr-label-preview')
      expect(preview).toHaveAccessibleName(/@grace.*Grace Hopper.*she\/her/i)
    })
  })

  describe('download', () => {
    it('renders the label PNG and triggers a download on click', async () => {
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => {})
      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn(() => 'blob:mock'),
        revokeObjectURL: vi.fn(),
      })

      render(<QRLabelModal {...defaultProps} />)
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))

      await waitFor(() => {
        expect(renderQrLabel).toHaveBeenCalledTimes(1)
        expect(clickSpy).toHaveBeenCalledTimes(1)
      })
      vi.unstubAllGlobals()
    })
  })

  describe('share button', () => {
    it('is hidden when the browser cannot share files', () => {
      // jsdom has no navigator.share — canSharePng() is false.
      render(<QRLabelModal {...defaultProps} />)
      expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
    })

    it('appears and shares the PNG when the browser supports file share', async () => {
      const share = vi.fn().mockResolvedValue(undefined)
      const canShare = vi.fn(() => true)
      vi.stubGlobal('navigator', { ...navigator, share, canShare })

      render(<QRLabelModal {...defaultProps} />)
      const shareBtn = screen.getByRole('button', { name: 'Share' })
      fireEvent.click(shareBtn)

      await waitFor(() => {
        expect(renderQrLabel).toHaveBeenCalled()
        expect(share).toHaveBeenCalledTimes(1)
      })
      const arg = share.mock.calls[0][0] as { files: File[] }
      expect(arg.files[0].name).toBe('badgetag-label-abc123.png')
      vi.unstubAllGlobals()
    })
  })

  describe('close behavior', () => {
    it('calls onClose when the close button is clicked', async () => {
      const user = userEvent.setup()
      render(<QRLabelModal {...defaultProps} />)
      await user.click(screen.getByLabelText('Close QR label modal'))
      expect(defaultProps.onClose).toHaveBeenCalledTimes(1)
    })

    it('calls onClose when Escape is pressed', () => {
      render(<QRLabelModal {...defaultProps} />)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(defaultProps.onClose).toHaveBeenCalledTimes(1)
    })

    it('calls onClose when Cancel is clicked', async () => {
      const user = userEvent.setup()
      render(<QRLabelModal {...defaultProps} />)
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(defaultProps.onClose).toHaveBeenCalledTimes(1)
    })
  })
})
