import type { CSSProperties } from 'react'

interface RangeSliderProps {
  id: string
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
  disabled?: boolean
  /** Values to mark with a tick under the track. Marks outside [min, max] are skipped. */
  marks?: number[]
}

/** Where a value sits along the track, from 0 (min) to 1 (max). */
function fraction(value: number, min: number, max: number): number {
  if (max <= min) return 0
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}

/**
 * A native range input with a fixed-size handle (styled by `.range-slider`
 * in index.css), so tick marks line up with the handle in every browser.
 */
export function RangeSlider({
  id,
  min,
  max,
  step,
  value,
  onChange,
  disabled,
  marks = [],
}: RangeSliderProps) {
  const style = { '--range-pct': fraction(value, min, max) } as CSSProperties
  return (
    <div className="relative">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range-slider block"
        style={style}
      />
      {marks
        .filter((mark) => mark > min && mark < max)
        .map((mark) => {
          // Matches the handle's center: half the 16px handle in from the
          // left edge, then the value's share of the remaining width.
          const pct = fraction(mark, min, max)
          return (
            <span
              key={mark}
              data-testid={`${id}-mark-${mark}`}
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-1.5 h-2 w-0.5 -translate-x-1/2 rounded-full bg-gray-400"
              style={{ left: `calc(8px + ${pct} * (100% - 16px))` }}
            />
          )
        })}
    </div>
  )
}
