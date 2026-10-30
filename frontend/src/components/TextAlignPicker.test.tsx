import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { TextAlignPicker } from './TextAlignPicker'
import type { TextAlign } from '../lib/qr3mf'

function Harness({ initial = 'center' as TextAlign }) {
  const [value, setValue] = useState<TextAlign>(initial)
  return <TextAlignPicker value={value} onChange={setValue} />
}

describe('TextAlignPicker', () => {
  it('renders left, center, and right options in a labeled radio group', () => {
    render(<Harness />)
    expect(screen.getByRole('radiogroup', { name: 'Text alignment' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual([
      'Align left',
      'Align center',
      'Align right',
    ])
  })

  it('marks only the current value as checked and makes it the single tab stop', () => {
    render(<Harness />)
    const center = screen.getByRole('radio', { name: 'Align center' })
    expect(center).toHaveAttribute('aria-checked', 'true')
    expect(center).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: 'Align left' })).toHaveAttribute('tabindex', '-1')
  })

  it('selects an option on click', () => {
    const onChange = vi.fn()
    render(<TextAlignPicker value="center" onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Align right' }))
    expect(onChange).toHaveBeenCalledWith('right')
  })

  it('moves the selection and focus with arrow keys, wrapping at the ends', () => {
    render(<Harness initial="right" />)
    const group = screen.getByRole('radiogroup')

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    const left = screen.getByRole('radio', { name: 'Align left' })
    expect(left).toHaveAttribute('aria-checked', 'true')
    expect(left).toHaveFocus()

    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    expect(screen.getByRole('radio', { name: 'Align right' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })
})
