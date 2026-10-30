/**
 * Minimal typings for the parts of opentype.js v2 used by `lib/textFont.ts`.
 * v2 ships no declarations, and `@types/opentype.js` describes the v1 API.
 */
declare module 'opentype.js' {
  export type PathCommand =
    | { type: 'M' | 'L'; x: number; y: number }
    | { type: 'Q'; x1: number; y1: number; x: number; y: number }
    | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: 'Z' }

  export interface Path {
    commands: PathCommand[]
  }

  export interface Font {
    unitsPerEm: number
    ascender: number
    descender: number
    tables: { os2?: { sCapHeight?: number } }
    /** One path per glyph, kerned, in y-down coordinates from the baseline. */
    getPaths(text: string, x: number, y: number, fontSize: number): Path[]
    getAdvanceWidth(text: string, fontSize: number): number
  }

  export function parse(buffer: ArrayBuffer): Font
}
