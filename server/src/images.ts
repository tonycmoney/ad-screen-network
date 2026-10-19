import { createHash } from 'node:crypto'

const SIGNATURES: { type: string; test: (b: Uint8Array) => boolean }[] = [
  {
    type: 'image/png',
    test: (b) => b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x),
  },
  { type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/webp',
    test: (b) =>
      b.length > 12 &&
      String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
  },
]

/**
 * Detect the real image type from the file's bytes. The browser supplied
 * content type and file name are ignored, so an HTML or SVG file renamed to
 * .png is rejected rather than served back to other users.
 */
export function sniffImage(bytes: Uint8Array): string | null {
  return SIGNATURES.find((s) => s.test(bytes))?.type ?? null
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
