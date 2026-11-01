import { render, screen, fireEvent } from '@testing-library/react'
import { RangeSlider } from './RangeSlider'

function renderSlider(props: Partial<Parameters<typeof RangeSlider>[0]> = {}) {
  const onChange = vi.fn()
  render(
    <>
      <label htmlFor="s">Size</label>
      <RangeSlider id="s" min={0} max={100} step={1} value={25} onChange={onChange} {...props} />
    </>,
  )
  return { onChange, slider: screen.getByLabelText('Size') as HTMLInputElement }
}

describe('RangeSlider', () => {
  it('renders a labelled native range input with its bounds and value', () => {
    const { slider } = renderSlider()
    expect(slider).toHaveAttribute('type', 'range')
    expect(slider).toHaveAttribute('min', '0')
    expect(slider).toHaveAttribute('max', '100')
    expect(slider).toHaveValue('25')
  })

  it('reports changes as numbers', () => {
    const { slider, onChange } = renderSlider()
    fireEvent.change(slider, { target: { value: '60' } })
    expect(onChange).toHaveBeenCalledWith(60)
  })

  it('exposes the filled fraction of the track for the styling', () => {
    const { slider } = renderSlider({ min: 20, max: 120, value: 45 })
    expect(slider.style.getPropertyValue('--range-pct')).toBe('0.25')
  })

  it('places marks at the handle center for their value, with the fixed handle inset', () => {
    renderSlider({ min: 20, max: 120, marks: [45] })
    expect(screen.getByTestId('s-mark-45').style.left).toBe('calc(8px + 0.25 * (100% - 16px))')
  })

  it('skips marks outside the range and hides marks from assistive tech', () => {
    renderSlider({ min: 20, max: 120, marks: [10, 50, 130] })
    expect(screen.queryByTestId('s-mark-10')).not.toBeInTheDocument()
    expect(screen.queryByTestId('s-mark-130')).not.toBeInTheDocument()
    expect(screen.getByTestId('s-mark-50')).toHaveAttribute('aria-hidden', 'true')
  })

  it('can be disabled', () => {
    const { slider } = renderSlider({ disabled: true })
    expect(slider).toBeDisabled()
  })
})
