/**
 * Tile planning for on-device OCR.
 *
 * The model spends a fixed image-token budget per attachment and downsamples to
 * fit, so a full page loses its body text (12% word recall on a test superbill
 * versus 99% tiled). Pages are split into rows, then columns, with each cut placed
 * on the blankest line near the ideal boundary so text is never sliced.
 *
 * Input is the small 8-bit grayscale dump written by the JXA helper; coordinates
 * are scaled back to the full-resolution render.
 */

export const INK_THRESHOLD = 200;
/** Rows are sized relative to page width: 0.43 gives ~3 rows for a letter page. */
export const DEFAULT_ROW_ASPECT = 0.43;
/** Keep tiles narrow enough that downsampling leaves small text legible. */
export const DEFAULT_MAX_TILE_WIDTH = 900;
const BLANK_ROW_INK = 20;
const BLANK_TILE_INK = 10;

export type Rect = { x: number; y: number; width: number; height: number };

export type GrayPage = {
  /** Raw 8-bit grayscale bytes, row-major, top row first. */
  gray: Uint8Array;
  grayWidth: number;
  grayHeight: number;
  /** Full-resolution render dimensions the tiles are expressed in. */
  width: number;
  height: number;
};

export type TilePlanOptions = {
  rowAspect?: number;
  maxTileWidth?: number;
  /** false plans a single tile covering the whole page. */
  tile?: boolean;
};

export function rowInkProfile(page: GrayPage): number[] {
  const rows = new Array<number>(page.grayHeight).fill(0);
  for (let y = 0; y < page.grayHeight; y += 1) {
    const offset = y * page.grayWidth;
    let ink = 0;
    for (let x = 0; x < page.grayWidth; x += 1) {
      if ((page.gray[offset + x] ?? 255) < INK_THRESHOLD) {
        ink += 1;
      }
    }
    rows[y] = ink;
  }
  return rows;
}

export function columnInkProfile(page: GrayPage, top: number, bottom: number): number[] {
  const columns = new Array<number>(page.grayWidth).fill(0);
  for (let y = top; y < bottom; y += 1) {
    const offset = y * page.grayWidth;
    for (let x = 0; x < page.grayWidth; x += 1) {
      if ((page.gray[offset + x] ?? 255) < INK_THRESHOLD) {
        columns[x] = (columns[x] ?? 0) + 1;
      }
    }
  }
  return columns;
}

/**
 * Split a 1-D ink profile into `count` pieces. Each interior cut lands in the
 * middle of the longest blank run near the ideal boundary, or on the least-ink
 * line when the window has no blank run at all.
 */
export function planCuts(profile: readonly number[], count: number): number[] {
  const length = profile.length;
  if (count <= 1 || length === 0) {
    return [0, length];
  }
  const cuts = [0];
  const piece = length / count;
  for (let k = 1; k < count; k += 1) {
    const ideal = Math.floor(k * piece);
    const window = Math.floor(piece * 0.25);
    const lo = Math.max((cuts.at(-1) ?? 0) + 1, ideal - window);
    const hi = Math.min(length - 1, ideal + window);
    if (lo >= hi) {
      continue;
    }
    let bestRunStart = -1;
    let bestRunLength = 0;
    let runStart = -1;
    let minInk = Number.POSITIVE_INFINITY;
    let minInkAt = ideal;
    for (let y = lo; y <= hi; y += 1) {
      const ink = profile[y] ?? 0;
      if (ink < minInk || (ink === minInk && Math.abs(y - ideal) < Math.abs(minInkAt - ideal))) {
        minInk = ink;
        minInkAt = y;
      }
      if (ink === 0) {
        if (runStart < 0) {
          runStart = y;
        }
        const runLength = y - runStart + 1;
        const closer =
          Math.abs(runStart + Math.floor(runLength / 2) - ideal) <
          Math.abs(bestRunStart + Math.floor(bestRunLength / 2) - ideal);
        if (runLength > bestRunLength || (runLength === bestRunLength && closer)) {
          bestRunStart = runStart;
          bestRunLength = runLength;
        }
      } else {
        runStart = -1;
      }
    }
    cuts.push(bestRunLength > 0 ? bestRunStart + Math.floor(bestRunLength / 2) : minInkAt);
  }
  cuts.push(length);
  return cuts;
}

function scaleRect(rect: Rect, scaleX: number, scaleY: number, page: GrayPage): Rect {
  const x = Math.round(rect.x * scaleX);
  const y = Math.round(rect.y * scaleY);
  return {
    x,
    y,
    width: Math.max(1, Math.min(page.width - x, Math.round(rect.width * scaleX))),
    height: Math.max(1, Math.min(page.height - y, Math.round(rect.height * scaleY))),
  };
}

/** Plan tiles in full-resolution coordinates, skipping blank bands and tiles. */
export function planTiles(page: GrayPage, options: TilePlanOptions = {}): Rect[] {
  if (options.tile === false) {
    return [{ x: 0, y: 0, width: page.width, height: page.height }];
  }
  const scaleX = page.width / page.grayWidth;
  const scaleY = page.height / page.grayHeight;
  const rowAspect = options.rowAspect ?? DEFAULT_ROW_ASPECT;
  const maxTileWidth = options.maxTileWidth ?? DEFAULT_MAX_TILE_WIDTH;
  const rowCount = Math.max(1, Math.round(page.height / Math.max(1, page.width * rowAspect)));
  const columnCount = Math.max(1, Math.ceil(page.width / maxTileWidth));
  const rows = rowInkProfile(page);
  const rowCuts = planCuts(rows, rowCount);
  const tiles: Rect[] = [];
  for (let index = 0; index < rowCuts.length - 1; index += 1) {
    const top = rowCuts[index] ?? 0;
    const bottom = rowCuts[index + 1] ?? page.grayHeight;
    const bandInk = rows.slice(top, bottom).reduce((sum, ink) => sum + ink, 0);
    if (bandInk < BLANK_ROW_INK) {
      continue; // nothing to read in this band
    }
    const columns = columnInkProfile(page, top, bottom);
    const columnCuts = planCuts(columns, columnCount);
    for (let column = 0; column < columnCuts.length - 1; column += 1) {
      const left = columnCuts[column] ?? 0;
      const right = columnCuts[column + 1] ?? page.grayWidth;
      const tileInk = columns.slice(left, right).reduce((sum, ink) => sum + ink, 0);
      if (tileInk < BLANK_TILE_INK) {
        continue;
      }
      tiles.push(
        scaleRect({ x: left, y: top, width: right - left, height: bottom - top }, scaleX, scaleY, page),
      );
    }
  }
  return tiles.length ? tiles : [{ x: 0, y: 0, width: page.width, height: page.height }];
}
