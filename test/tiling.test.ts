// Tile planning: cuts land in blank space so no line of text is sliced.
import assert from "node:assert/strict";
import { test } from "node:test";
import { planTiles, type GrayPage } from "../src/tiling.ts";

/** Build a grayscale page from an ink map: "#" is ink, "." is blank. */
function page(rows: string[], scale = 1): GrayPage {
  const grayWidth = rows[0]?.length ?? 0;
  const grayHeight = rows.length;
  const gray = new Uint8Array(grayWidth * grayHeight).fill(255);
  rows.forEach((row, y) => {
    row.split("").forEach((cell, x) => {
      if (cell === "#") {
        gray[y * grayWidth + x] = 0;
      }
    });
  });
  return { gray, grayWidth, grayHeight, width: grayWidth * scale, height: grayHeight * scale };
}

/** Rows of text separated by blank gutters, wide enough to clear the ink thresholds. */
function textPage(bandCount: number, scale = 40): GrayPage {
  const inked = "#".repeat(40);
  const blank = ".".repeat(40);
  const rows: string[] = [];
  for (let band = 0; band < bandCount; band += 1) {
    rows.push(inked, inked, inked, inked, blank, blank);
  }
  return page(rows, scale);
}

test("returns one full-page rect when tiling is off", () => {
  assert.deepEqual(planTiles(page(["##", "##"], 10), { tile: false }), [
    { x: 0, y: 0, width: 20, height: 20 },
  ]);
});

test("falls back to the whole page when everything is blank", () => {
  assert.deepEqual(planTiles(page(["....", "....", "....", "...."], 100)), [
    { x: 0, y: 0, width: 400, height: 400 },
  ]);
});

test("splits a tall page into several tiles inside the page bounds", () => {
  const p = textPage(6);
  const tiles = planTiles(p, { rowAspect: 0.43, maxTileWidth: 900 });
  assert.ok(tiles.length > 1, `expected several tiles, got ${tiles.length}`);
  for (const tile of tiles) {
    assert.ok(tile.width > 0 && tile.height > 0);
    assert.ok(tile.x >= 0 && tile.y >= 0);
    assert.ok(tile.x + tile.width <= p.width, "tile must stay inside the page");
    assert.ok(tile.y + tile.height <= p.height, "tile must stay inside the page");
  }
});

test("cuts land on blank rows rather than through a line of text", () => {
  const p = textPage(6);
  const tiles = planTiles(p, { rowAspect: 0.43, maxTileWidth: 900 });
  const rowHeight = p.height / p.grayHeight;
  // Ink occupies rows 0-3 of each 6-row band; 4-5 are blank.
  for (const tile of tiles) {
    const bottomRow = Math.round((tile.y + tile.height) / rowHeight);
    if (bottomRow < p.grayHeight) {
      assert.ok(bottomRow % 6 >= 4, `cut at gray row ${bottomRow} slices text`);
    }
  }
});

test("skips blank bands between blocks of text", () => {
  const inked = "#".repeat(40);
  const blank = ".".repeat(40);
  // Tall enough that three row bands are planned and the blank middle is dropped.
  const rows = [
    ...Array<string>(20).fill(inked),
    ...Array<string>(20).fill(blank),
    ...Array<string>(20).fill(inked),
  ];
  const p = page(rows, 40);
  const tiles = planTiles(p, { rowAspect: 0.43, maxTileWidth: 900 });
  // Sum distinct vertical bands: columns repeat the same y range.
  const bands = new Map(tiles.map((tile) => [`${tile.y}:${tile.height}`, tile.height]));
  const covered = [...bands.values()].reduce((sum, height) => sum + height, 0);
  assert.ok(covered < p.height, `expected blank band to be skipped (covered ${covered}/${p.height})`);
});

test("splits wide pages into columns", () => {
  const p = textPage(3, 60); // 2400px wide render
  const tiles = planTiles(p, { rowAspect: 0.43, maxTileWidth: 900 });
  assert.ok(new Set(tiles.map((tile) => tile.x)).size > 1, "expected more than one column");
});

test("scales gray coordinates up to the render size", () => {
  const rows = Array.from({ length: 20 }, (_, y) => (y === 10 ? "........" : "########"));
  const p: GrayPage = { ...page(rows), width: 800, height: 2000 };
  const tiles = planTiles(p, { maxTileWidth: 900 });
  assert.ok(tiles.every((t) => t.x + t.width <= 800 && t.y + t.height <= 2000));
  assert.ok(tiles.some((t) => t.height > 100), "tiles should be scaled to render pixels");
});
