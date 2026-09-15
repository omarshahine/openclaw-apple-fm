import assert from "node:assert/strict";
import { test } from "node:test";
import { columnInkProfile, planCuts, planTiles, rowInkProfile, type GrayPage } from "../src/tiling.ts";

/** Build a grayscale page from a row/column ink map: "#" is ink, "." is blank. */
function page(rows: string[], scale = 1): GrayPage {
  const grayWidth = rows[0]?.length ?? 0;
  const grayHeight = rows.length;
  const gray = new Uint8Array(grayWidth * grayHeight).fill(255);
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      if (cell === "#") {
        gray[y * grayWidth + x] = 0;
      }
    });
  });
  return { gray, grayWidth, grayHeight, width: grayWidth * scale, height: grayHeight * scale };
}

test("rowInkProfile and columnInkProfile count dark pixels", () => {
  const p = page(["##..", "....", ".#.#"]);
  assert.deepEqual(rowInkProfile(p), [2, 0, 2]);
  assert.deepEqual(columnInkProfile(p, 0, 3), [1, 2, 0, 1]);
  assert.deepEqual(columnInkProfile(p, 2, 3), [0, 1, 0, 1]);
});

test("planCuts returns the whole range when one piece is requested", () => {
  assert.deepEqual(planCuts([1, 2, 3], 1), [0, 3]);
  assert.deepEqual(planCuts([], 4), [0, 0]);
});

test("planCuts lands in the middle of a blank run rather than on text", () => {
  // Text rows 0-3, blank 4-7, text 8-11: the cut belongs at ~6, not the ideal 6 only by luck.
  const profile = [5, 5, 5, 5, 0, 0, 0, 0, 5, 5, 5, 5];
  const cuts = planCuts(profile, 2);
  assert.equal(cuts.length, 3);
  const cut = cuts[1] as number;
  assert.ok(cut >= 4 && cut <= 7, `cut ${cut} should be inside the blank run`);
  assert.equal(profile[cut], 0);
});

test("planCuts avoids slicing a line when the ideal boundary is inked", () => {
  // Ideal cut for 2 pieces is 8; rows 7-9 are text, blank gap at 6.
  const profile = [9, 0, 9, 9, 0, 0, 0, 9, 9, 9, 9, 0, 9, 9, 9, 9];
  const cut = planCuts(profile, 2)[1] as number;
  assert.equal(profile[cut], 0, "cut should land on a blank row");
});

test("planCuts falls back to the least-ink line when nothing is blank", () => {
  const profile = [9, 9, 9, 9, 3, 9, 9, 9];
  const cut = planCuts(profile, 2)[1] as number;
  assert.equal(cut, 4);
});

test("planCuts keeps cuts ordered and inside the profile", () => {
  const profile = Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? 0 : 4));
  const cuts = planCuts(profile, 4);
  assert.equal(cuts.length, 5);
  assert.equal(cuts[0], 0);
  assert.equal(cuts.at(-1), 100);
  for (let i = 1; i < cuts.length; i += 1) {
    assert.ok((cuts[i] as number) > (cuts[i - 1] as number), `cuts must increase: ${cuts.join(",")}`);
  }
});

test("planTiles returns one full-page rect when tiling is off", () => {
  const p = page(["##", "##"], 10);
  assert.deepEqual(planTiles(p, { tile: false }), [{ x: 0, y: 0, width: 20, height: 20 }]);
});

test("planTiles splits rows and columns and skips blank bands", () => {
  // 40 wide, 12 tall: inked bands top and bottom, blank middle band. Ink per band
  // must clear the blank-band threshold, as it does on a real 300px-wide profile.
  const inked = `${"#".repeat(18)}..${"#".repeat(20)}`;
  const blank = ".".repeat(40);
  const rows = [
    inked, inked, inked, inked,
    blank, blank, blank, blank,
    inked, inked, inked, inked,
  ];
  const p = page(rows, 40); // 1600x480 render, so 2 columns at 900px
  const tiles = planTiles(p, { rowAspect: 0.43, maxTileWidth: 900 });
  assert.ok(tiles.length >= 2, `expected several tiles, got ${tiles.length}`);
  for (const tile of tiles) {
    assert.ok(tile.width > 0 && tile.height > 0);
    assert.ok(tile.x >= 0 && tile.y >= 0);
    assert.ok(tile.x + tile.width <= p.width, "tile must stay inside the page");
    assert.ok(tile.y + tile.height <= p.height, "tile must stay inside the page");
  }
  // The blank middle band must not be covered by any tile's interior.
  const blankMidY = 6 * 40;
  assert.ok(!tiles.some((t) => t.y <= blankMidY && blankMidY < t.y + t.height && t.height < 400));
});

test("planTiles falls back to the whole page when everything is blank", () => {
  const p = page(["....", "....", "....", "...."], 100);
  assert.deepEqual(planTiles(p), [{ x: 0, y: 0, width: 400, height: 400 }]);
});

test("planTiles scales gray coordinates up to the render size", () => {
  const rows = Array.from({ length: 20 }, (_, y) => (y === 10 ? "........" : "########"));
  const p = { ...page(rows), width: 800, height: 2000 }; // 100x scale on both axes
  const tiles = planTiles(p, { maxTileWidth: 900 });
  assert.ok(tiles.every((t) => t.x + t.width <= 800 && t.y + t.height <= 2000));
  assert.ok(tiles.some((t) => t.height > 100), "tiles should be scaled to render pixels");
});
