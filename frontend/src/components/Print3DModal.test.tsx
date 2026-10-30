import { render, screen, fireEvent } from '@testing-library/react'
import { Print3DModal } from './Print3DModal'
import {
  computeMinSizeMm,
  DEFAULT_QUIET_ZONE_COMPONENTS,
  generateQr3mf,
  QR3MF_LIMITS,
  type Qr3mfOptions,
} from '../lib/qr3mf'
import { loadTestFont } from '../test/textFontFixture'

// jsdom can't fetch the bundled font URL, so serve it from disk instead.
const loadTextFont = vi.fn(() => Promise.resolve(loadTestFont()))
vi.mock('../lib/textFont', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/textFont')>()),
  loadTextFont: () => loadTextFont(),
}))

// Spy on the exporter while keeping its real behavior.
vi.mock('../lib/qr3mf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/qr3mf')>()
  return { ...actual, generateQr3mf: vi.fn(actual.generateQr3mf) }
})

const PROFILE_ID = 'abc123def456'

/**
 * Opens the modal, flips the given text switches, optionally picks an
 * alignment, clicks Download, and returns the options sent to the exporter.
 */
async function downloadWith(
  props: Partial<Parameters<typeof Print3DModal>[0]>,
  switches: RegExp[],
  alignment?: string,
): Promise<Qr3mfOptions> {
  vi.mocked(generateQr3mf).mockClear()
  const createObjectURL = vi.fn(() => 'blob:mock')
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    const { unmount } = renderModal(props)
    for (const name of switches) fireEvent.click(screen.getByRole('switch', { name }))
    if (alignment) fireEvent.click(screen.getByRole('radio', { name: alignment }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download .3mf' }))
    unmount()
    return vi.mocked(generateQr3mf).mock.calls[0][1]
  } finally {
    clickSpy.mockRestore()
    vi.unstubAllGlobals()
  }
}

function renderModal(props: Partial<Parameters<typeof Print3DModal>[0]> = {}) {
  const onClose = vi.fn()
  const result = render(
    <Print3DModal profileId={PROFILE_ID} isOpen onClose={onClose} {...props} />,
  )
  return { onClose, ...result }
}

describe('Print3DModal', () => {
  it('renders nothing when closed', () => {
    renderModal({ isOpen: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders the customizer controls when open', async () => {
    renderModal()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('3D Print Your QR Code')).toBeInTheDocument()
    expect(screen.getByLabelText('Size')).toBeInTheDocument()
    expect(screen.getByLabelText('Thickness')).toBeInTheDocument()
    expect(screen.getByLabelText('Quiet zone')).toBeInTheDocument()
    expect(screen.getByLabelText('Relief height')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /Lanyard loop/ })).toBeInTheDocument()
    expect(
      await screen.findByRole('button', { name: 'Download .3mf' }),
    ).toBeInTheDocument()
  })

  it('renders the live preview region', async () => {
    renderModal()
    // The preview is lazy-loaded; in jsdom (no WebGL) it resolves to its
    // fallback message once the chunk loads.
    expect(
      await screen.findByText(/preview isn't available/i),
    ).toBeInTheDocument()
  })

  it('uses plain "square" language rather than QR jargon like "module"/"component"', () => {
    renderModal()
    expect(screen.queryByText(/module/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/component/i)).not.toBeInTheDocument()
    expect(screen.getAllByText(/square/i).length).toBeGreaterThan(0)
  })

  it('constrains the size slider so the code stays scannable', () => {
    renderModal()
    const url = `${window.location.origin}/p/${PROFILE_ID}`
    const slider = screen.getByLabelText('Size')
    expect(slider).toHaveAttribute(
      'min',
      String(computeMinSizeMm(url, DEFAULT_QUIET_ZONE_COMPONENTS)),
    )
    expect(slider).toHaveAttribute('max', String(QR3MF_LIMITS.maxSizeMm))
  })

  it('constrains the thickness slider to printable limits', () => {
    renderModal()
    const slider = screen.getByLabelText('Thickness')
    expect(slider).toHaveAttribute('min', String(QR3MF_LIMITS.minThicknessMm))
    expect(slider).toHaveAttribute('max', String(QR3MF_LIMITS.maxThicknessMm))
  })

  it('constrains the quiet zone slider to the printable/scannable range', () => {
    renderModal()
    const slider = screen.getByLabelText('Quiet zone')
    expect(slider).toHaveAttribute('min', String(QR3MF_LIMITS.minQuietZoneComponents))
    expect(slider).toHaveAttribute('max', String(QR3MF_LIMITS.maxQuietZoneComponents))
    expect(slider).toHaveValue(String(DEFAULT_QUIET_ZONE_COMPONENTS))
  })

  it('constrains the relief height slider to the printable range', () => {
    renderModal()
    const slider = screen.getByLabelText('Relief height')
    expect(slider).toHaveAttribute('min', String(QR3MF_LIMITS.minReliefMm))
    expect(slider).toHaveAttribute('max', String(QR3MF_LIMITS.maxReliefMm))
  })

  it('raises the minimum size when the quiet zone slider is widened', () => {
    renderModal()
    const sizeSlider = screen.getByLabelText('Size')
    const initialMin = Number(sizeSlider.getAttribute('min'))

    fireEvent.change(screen.getByLabelText('Quiet zone'), {
      target: { value: String(QR3MF_LIMITS.maxQuietZoneComponents) },
    })

    const widenedMin = Number(sizeSlider.getAttribute('min'))
    expect(widenedMin).toBeGreaterThan(initialMin)
  })

  it('updates the size readout when the slider moves', () => {
    renderModal()
    fireEvent.change(screen.getByLabelText('Size'), { target: { value: '80' } })
    expect(screen.getByText('80 × 80 mm')).toBeInTheDocument()
  })

  it('updates the thickness readout when the slider moves', () => {
    renderModal()
    fireEvent.change(screen.getByLabelText('Thickness'), {
      target: { value: '4.2' },
    })
    expect(screen.getByText('4.2 mm')).toBeInTheDocument()
  })

  it('toggles the lanyard loop switch', () => {
    renderModal()
    const loopSwitch = screen.getByRole('switch', { name: /Lanyard loop/ })
    expect(loopSwitch).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(loopSwitch)
    expect(loopSwitch).toHaveAttribute('aria-checked', 'false')
  })

  it('downloads a .3mf file named after the profile', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    })

    let downloadName = ''
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadName = this.download
      })

    try {
      renderModal()
      // Waits for the font the default URL line needs.
      fireEvent.click(await screen.findByRole('button', { name: 'Download .3mf' }))

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      const blob = createObjectURL.mock.calls[0][0] as unknown as Blob
      expect(blob.type).toBe('model/3mf')
      expect(blob.size).toBeGreaterThan(0)
      expect(downloadName).toBe(`badgetag-${PROFILE_ID}.3mf`)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')
    } finally {
      clickSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  describe('text below the code', () => {
    it('offers BadgeTag URL, Name, and Pronouns toggles', () => {
      renderModal({ displayName: 'Ada Lovelace', pronouns: 'she/her' })
      expect(screen.getByRole('switch', { name: /BadgeTag URL/ })).toBeInTheDocument()
      expect(screen.getByRole('switch', { name: /Name/ })).toBeInTheDocument()
      expect(screen.getByRole('switch', { name: /Pronouns/ })).toBeInTheDocument()
    })

    it('starts with the URL line on and name and pronouns off', () => {
      renderModal({ displayName: 'Ada Lovelace', pronouns: 'she/her' })
      expect(screen.getByRole('switch', { name: /BadgeTag URL/ })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      expect(screen.getByRole('switch', { name: /Name/ })).toHaveAttribute(
        'aria-checked',
        'false',
      )
      expect(screen.getByRole('switch', { name: /Pronouns/ })).toHaveAttribute(
        'aria-checked',
        'false',
      )
    })

    it('toggles each text line independently', () => {
      renderModal({ displayName: 'Ada Lovelace', pronouns: 'she/her' })
      const urlSwitch = screen.getByRole('switch', { name: /BadgeTag URL/ })
      fireEvent.click(urlSwitch)
      expect(urlSwitch).toHaveAttribute('aria-checked', 'false')
      expect(screen.getByRole('switch', { name: /Name/ })).toHaveAttribute(
        'aria-checked',
        'false',
      )
    })

    it('disables the Name toggle when the profile has no display name', () => {
      renderModal({ pronouns: 'she/her' })
      expect(screen.getByRole('switch', { name: /Name/ })).toBeDisabled()
    })

    it('disables the Pronouns toggle when the profile has no pronouns', () => {
      renderModal({ displayName: 'Ada Lovelace' })
      expect(screen.getByRole('switch', { name: /Pronouns/ })).toBeDisabled()
    })

    it('enables the Name and Pronouns toggles when those fields are present', () => {
      renderModal({ displayName: 'Ada Lovelace', pronouns: 'she/her' })
      expect(screen.getByRole('switch', { name: /Name/ })).toBeEnabled()
      expect(screen.getByRole('switch', { name: /Pronouns/ })).toBeEnabled()
    })

    it('does not load the modal font while closed', () => {
      loadTextFont.mockClear()
      renderModal({ isOpen: false })
      expect(loadTextFont).not.toHaveBeenCalled()
    })

    it('loads the font on open for the default URL line, then enables download', async () => {
      loadTextFont.mockClear()
      renderModal()

      expect(screen.getByRole('button', { name: 'Loading font…' })).toBeDisabled()
      expect(
        await screen.findByRole('button', { name: 'Download .3mf' }),
      ).toBeEnabled()
      expect(loadTextFont).toHaveBeenCalledTimes(1)
    })

    it('shows an error if the font fails to load', async () => {
      loadTextFont.mockImplementationOnce(() => Promise.reject(new Error('offline')))
      renderModal()
      expect(await screen.findByRole('alert')).toHaveTextContent(/font couldn't load/)
      expect(screen.getByRole('button', { name: 'Download .3mf' })).toBeDisabled()
    })

    it('labels the section "Text" without per-line previews', () => {
      renderModal({ displayName: 'Ada Lovelace', pronouns: 'she/her' })
      expect(screen.getByRole('group', { name: 'Text' })).toBeInTheDocument()
      expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()
      expect(screen.queryByText('she/her')).not.toBeInTheDocument()
      expect(screen.queryByText(/\/p\//)).not.toBeInTheDocument()
    })

    it('shows the alignment control only while a text line is on', () => {
      renderModal({ displayName: 'Ada Lovelace' })
      expect(screen.getByRole('radiogroup', { name: 'Text alignment' })).toBeInTheDocument()

      fireEvent.click(screen.getByRole('switch', { name: /BadgeTag URL/ }))
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('switch', { name: /^Name/ }))
      expect(screen.getByRole('radiogroup', { name: 'Text alignment' })).toBeInTheDocument()
    })

    it('exports no text lines once the URL line is turned off', async () => {
      const options = await downloadWith({}, [/BadgeTag URL/])
      expect(options.textLines).toEqual([])
    })

    it('exports the custom URL as the URL line when a slug is saved', async () => {
      const options = await downloadWith({ slug: 'ada' }, [])
      expect(options.textLines).toEqual([`${window.location.host}/@ada`])
    })

    it('exports the /p/ URL without its scheme when there is no slug', async () => {
      const options = await downloadWith({}, [])
      expect(options.textLines).toEqual([
        `${window.location.origin}/p/${PROFILE_ID}`.replace(/^https?:\/\//, ''),
      ])
    })

    it('exports lines in URL, name, pronouns order', async () => {
      const options = await downloadWith(
        { displayName: 'Ada Lovelace', pronouns: 'she/her' },
        [/Pronouns/, /^Name/],
      )
      expect(options.textLines?.slice(1)).toEqual(['Ada Lovelace', 'she/her'])
    })

    it('centers text by default and exports the chosen alignment', async () => {
      const centered = await downloadWith({}, [])
      expect(centered.textAlign).toBe('center')

      const left = await downloadWith({}, [], 'Align left')
      expect(left.textAlign).toBe('left')
    })
  })

  it('closes on Escape', () => {
    const { onClose } = renderModal()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes when the backdrop is clicked', () => {
    const { onClose } = renderModal()
    const dialog = screen.getByRole('dialog')
    fireEvent.mouseDown(dialog)
    fireEvent.click(dialog)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not close when clicking inside the panel', () => {
    const { onClose } = renderModal()
    const heading = screen.getByText('3D Print Your QR Code')
    fireEvent.mouseDown(heading)
    fireEvent.click(heading)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not close when a drag starts on a slider and is released over the backdrop', () => {
    // Regression test: browsers dispatch `click` on the nearest common
    // ancestor of the mousedown/mouseup targets, so starting a drag on the
    // size slider and releasing over the backdrop used to fire a click
    // whose target was the backdrop itself, closing the modal mid-drag.
    const { onClose } = renderModal()
    const dialog = screen.getByRole('dialog')
    const slider = screen.getByLabelText('Size')

    fireEvent.mouseDown(slider)
    fireEvent.click(dialog)

    expect(onClose).not.toHaveBeenCalled()
  })
})
