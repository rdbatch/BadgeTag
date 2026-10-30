import { useRef, type KeyboardEvent } from 'react'
import type { TextAlign } from '../lib/qr3mf'

interface TextAlignPickerProps {
  value: TextAlign
  onChange: (value: TextAlign) => void
}

const OPTIONS: { value: TextAlign; label: string; lines: [number, number][] }[] = [
  // Each icon line is [x1, x2] on a 16-wide grid, alternating long/short
  // like the alignment buttons in a word processor.
  { value: 'left', label: 'Align left', lines: [[2, 14], [2, 10], [2, 14], [2, 10]] },
  { value: 'center', label: 'Align center', lines: [[2, 14], [4, 12], [2, 14], [4, 12]] },
  { value: 'right', label: 'Align right', lines: [[2, 14], [6, 14], [2, 14], [6, 14]] },
]

/**
 * Segmented left/center/right alignment control with word-processor style
 * icons. A radio group: one tab stop, arrow keys move the selection.
 */
export function TextAlignPicker({ value, onChange }: TextAlignPickerProps) {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([])

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key]
    if (!step) return
    e.preventDefault()
    const current = OPTIONS.findIndex((o) => o.value === value)
    const next = (current + step + OPTIONS.length) % OPTIONS.length
    onChange(OPTIONS[next].value)
    buttonsRef.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Text alignment"
      onKeyDown={handleKeyDown}
      className="inline-flex rounded-lg border border-gray-300 p-0.5"
    >
      {OPTIONS.map((option, i) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => {
              buttonsRef.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            title={option.label}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={`rounded-md p-1.5 transition-colors focus:ring-2 focus:ring-blue-500 focus:outline-none ${
              selected ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              aria-hidden="true"
            >
              {option.lines.map(([x1, x2], row) => (
                <line key={row} x1={x1} x2={x2} y1={3 + row * 3.3} y2={3 + row * 3.3} />
              ))}
            </svg>
          </button>
        )
      })}
    </div>
  )
}
