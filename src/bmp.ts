/**
 * Minimal uncompressed-BMP reader for the ink profiles written by the JXA helper.
 *
 * The helper cannot hand back raw pixels (reading NSBitmapImageRep.bitmapData over
 * the ObjC bridge segfaults, and per-pixel bridge calls run at ~13k/s), so it writes
 * a small BMP that this module decodes to 8-bit grayscale, top row first.
 */

export type GrayImage = { gray: Uint8Array; width: number; height: number };

const BI_RGB = 0;
const BI_BITFIELDS = 3;

function luminance(r: number, g: number, b: number): number {
  // Rec. 601 luma, integer math: 0.299 / 0.587 / 0.114.
  return (r * 77 + g * 151 + b * 28) >> 8;
}

export function parseBmpToGray(buffer: Uint8Array): GrayImage {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.length < 54 || buffer[0] !== 0x42 || buffer[1] !== 0x4d) {
    throw new Error("not a BMP image");
  }
  const dataOffset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  if (compression !== BI_RGB && compression !== BI_BITFIELDS) {
    throw new Error(`unsupported BMP compression ${compression}`);
  }
  if (![8, 24, 32].includes(bpp)) {
    throw new Error(`unsupported BMP bit depth ${bpp}`);
  }
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  if (width <= 0 || height <= 0) {
    throw new Error("BMP has no pixels");
  }
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  if (dataOffset + stride * height > buffer.length) {
    throw new Error("BMP pixel data is truncated");
  }

  let palette: Uint8Array | undefined;
  if (bpp === 8) {
    const paletteStart = 14 + headerSize;
    const entries = view.getUint32(46, true) || 256;
    palette = new Uint8Array(entries);
    for (let i = 0; i < entries; i += 1) {
      const at = paletteStart + i * 4;
      palette[i] = luminance(buffer[at + 2] ?? 0, buffer[at + 1] ?? 0, buffer[at] ?? 0);
    }
  }

  const gray = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    // BMP rows run bottom-up unless the height is negative.
    const sourceRow = topDown ? row : height - 1 - row;
    const rowStart = dataOffset + sourceRow * stride;
    const target = row * width;
    for (let x = 0; x < width; x += 1) {
      if (bpp === 8) {
        gray[target + x] = palette?.[buffer[rowStart + x] ?? 0] ?? 0;
      } else {
        const at = rowStart + x * (bpp / 8);
        gray[target + x] = luminance(buffer[at + 2] ?? 0, buffer[at + 1] ?? 0, buffer[at] ?? 0);
      }
    }
  }
  return { gray, width, height };
}
