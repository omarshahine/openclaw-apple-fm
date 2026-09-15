import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBmpToGray } from "../src/bmp.ts";

/** Build a 24-bit BMP. `rows` are top-row-first [b,g,r] triples. */
function bmp24(rows: number[][][], topDown = false): Uint8Array {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const stride = Math.floor((24 * width + 31) / 32) * 4;
  const dataOffset = 54;
  const buffer = new Uint8Array(dataOffset + stride * height);
  const view = new DataView(buffer.buffer);
  buffer[0] = 0x42;
  buffer[1] = 0x4d;
  view.setUint32(2, buffer.length, true);
  view.setUint32(10, dataOffset, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, topDown ? -height : height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(30, 0, true);
  rows.forEach((row, y) => {
    const sourceRow = topDown ? y : height - 1 - y;
    row.forEach((pixel, x) => {
      const at = dataOffset + sourceRow * stride + x * 3;
      buffer[at] = pixel[0] ?? 0;
      buffer[at + 1] = pixel[1] ?? 0;
      buffer[at + 2] = pixel[2] ?? 0;
    });
  });
  return buffer;
}

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

test("decodes a bottom-up BMP with the top row first", () => {
  const image = parseBmpToGray(bmp24([[BLACK, WHITE], [WHITE, WHITE]]));
  assert.equal(image.width, 2);
  assert.equal(image.height, 2);
  assert.equal(image.gray[0], 0, "top-left stays top-left");
  assert.equal(image.gray[1], 255);
  assert.deepEqual([...image.gray.slice(2)], [255, 255]);
});

test("decodes a top-down BMP (negative height) identically", () => {
  const rows = [[BLACK, WHITE], [WHITE, WHITE]];
  assert.deepEqual([...parseBmpToGray(bmp24(rows, true)).gray], [...parseBmpToGray(bmp24(rows)).gray]);
});

test("applies Rec. 601 luma to color pixels", () => {
  const red = [0, 0, 255];
  const green = [0, 255, 0];
  const blue = [255, 0, 0];
  const image = parseBmpToGray(bmp24([[red, green, blue]]));
  assert.deepEqual([...image.gray], [(255 * 77) >> 8, (255 * 151) >> 8, (255 * 28) >> 8]);
});

test("handles row padding for widths that are not multiples of 4", () => {
  const image = parseBmpToGray(bmp24([[BLACK, WHITE, BLACK], [WHITE, BLACK, WHITE]]));
  assert.equal(image.width, 3);
  assert.deepEqual([...image.gray], [0, 255, 0, 255, 0, 255]);
});

test("rejects data that is not a usable BMP", () => {
  assert.throws(() => parseBmpToGray(new Uint8Array(10)), /not a BMP image/);
  const truncated = bmp24([[BLACK, WHITE], [WHITE, WHITE]]).slice(0, 56);
  assert.throws(() => parseBmpToGray(truncated), /truncated/);
});

test("rejects compressed or exotic bit depths", () => {
  const compressed = bmp24([[BLACK]]);
  new DataView(compressed.buffer).setUint32(30, 1, true); // BI_RLE8
  assert.throws(() => parseBmpToGray(compressed), /unsupported BMP compression 1/);
  const odd = bmp24([[BLACK]]);
  new DataView(odd.buffer).setUint16(28, 16, true);
  assert.throws(() => parseBmpToGray(odd), /unsupported BMP bit depth 16/);
});
