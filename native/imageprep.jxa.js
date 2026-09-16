// JavaScript for Automation helper: render PDF pages / images and crop tiles.
// Built into macOS (osascript -l JavaScript), so nodes need no Xcode toolchain.
//
// Pixel access across the ObjC bridge is slow (~13k samples/s) and reading raw
// bitmapData segfaults, so this script never inspects pixels: it renders, writes a
// full-resolution PNG plus a small BMP the caller decodes (src/bmp.ts) to plan cuts
// (src/tiling.ts).
//
// stdin: {"mode":"render","input":"/abs","outDir":"/abs","dpi":200,"firstPage":1,"lastPage":10,"profileWidth":300}
//   -> {"pageCount":N,"pages":[{"page":1,"png":"/abs.png","profile":"/abs.bmp","width":W,"height":H,"grayWidth":w,"grayHeight":h}]}
//        {"mode":"crop","png":"/abs/page.png","tiles":[{"path":"/abs/t.png","x":0,"y":0,"width":10,"height":10}]}
/* eslint-disable no-unused-expressions -- JXA invokes zero-argument ObjC methods as property reads. */
ObjC.import("Quartz");
ObjC.import("AppKit");

const MAX_PIXELS = 2400;
const MEDIA_BOX = 0; // kPDFDisplayBoxMediaBox

function readStdin() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
}

function writeStdout(text) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(
    $.NSString.alloc.initWithUTF8String(text).dataUsingEncoding($.NSUTF8StringEncoding),
  );
}

function fail(message) {
  $.NSFileHandle.fileHandleWithStandardError.writeData(
    $.NSString.alloc
      .initWithUTF8String(`imageprep: ${message}\n`)
      .dataUsingEncoding($.NSUTF8StringEncoding),
  );
  $.exit(1);
}

const FILE_TYPE_BMP = 1;
const FILE_TYPE_PNG = 4;

function writeRep(rep, path, fileType) {
  const data = rep.representationUsingTypeProperties(fileType, $());
  if (!data.writeToFileAtomically(path, true)) {
    fail(`could not write ${path}`);
  }
}

function writePNG(rep, path) {
  writeRep(rep, path, FILE_TYPE_PNG);
}

/** Downscale to `width` and write a BMP the caller decodes for ink profiling. */
function writeProfile(rep, path, width) {
  const scale = Math.min(1, width / rep.pixelsWide);
  const w = Math.max(1, Math.round(rep.pixelsWide * scale));
  const h = Math.max(1, Math.round(rep.pixelsHigh * scale));
  const small =
    $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      $(),
      w,
      h,
      8,
      3,
      false,
      false,
      $.NSCalibratedRGBColorSpace,
      0,
      0,
    );
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(small);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.currentContext = ctx;
  $.NSColor.whiteColor.set;
  $.NSRectFill($.NSMakeRect(0, 0, w, h));
  rep.drawInRect($.NSMakeRect(0, 0, w, h));
  $.NSGraphicsContext.restoreGraphicsState;
  writeRep(small, path, FILE_TYPE_BMP);
  return { width: w, height: h };
}

function repFromPDFPage(page, dpi) {
  const box = page.boundsForBox(MEDIA_BOX);
  const rotated = Math.abs(page.rotation % 180) === 90;
  const pointsW = rotated ? box.size.height : box.size.width;
  const pointsH = rotated ? box.size.width : box.size.height;
  const scale = Math.min(dpi / 72, MAX_PIXELS / Math.max(pointsW, pointsH));
  const size = $.NSMakeSize(Math.round(pointsW * scale), Math.round(pointsH * scale));
  const image = page.thumbnailOfSizeForBox(size, MEDIA_BOX);
  return $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
}

function repFromImage(path) {
  const image = $.NSImage.alloc.initWithContentsOfFile(path);
  if (!image.js) {
    fail(`unreadable image ${path}`);
  }
  const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const longest = Math.max(rep.pixelsWide, rep.pixelsHigh);
  if (longest <= MAX_PIXELS) {
    return rep;
  }
  const scale = MAX_PIXELS / longest;
  const w = Math.round(rep.pixelsWide * scale),
    h = Math.round(rep.pixelsHigh * scale);
  const scaled =
    $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      $(),
      w,
      h,
      8,
      4,
      true,
      false,
      $.NSCalibratedRGBColorSpace,
      0,
      0,
    );
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(scaled);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.currentContext = ctx;
  rep.drawInRect($.NSMakeRect(0, 0, w, h));
  $.NSGraphicsContext.restoreGraphicsState;
  return scaled;
}

function render(request) {
  const dpi = request.dpi || 200;
  const profileWidth = request.profileWidth || 300;
  const isPDF = request.input.toLowerCase().endsWith(".pdf");
  const pages = [];
  let pageCount = 1;
  if (isPDF) {
    const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(request.input));
    if (!doc.js) {
      fail(`unreadable PDF ${request.input}`);
    }
    if (doc.isEncrypted && !doc.isUnlocked) {
      fail("PDF is encrypted");
    }
    pageCount = Number(doc.pageCount);
    const first = Math.max(1, request.firstPage || 1);
    const last = Math.min(pageCount, request.lastPage || pageCount);
    for (let number = first; number <= last; number++) {
      const rep = repFromPDFPage(doc.pageAtIndex(number - 1), dpi);
      const png = `${request.outDir}/page-${number}.png`;
      const profilePath = `${request.outDir}/page-${number}.bmp`;
      writePNG(rep, png);
      const gray = writeProfile(rep, profilePath, profileWidth);
      pages.push({
        page: number,
        png,
        profile: profilePath,
        width: Number(rep.pixelsWide),
        height: Number(rep.pixelsHigh),
        grayWidth: gray.width,
        grayHeight: gray.height,
      });
    }
  } else {
    const rep = repFromImage(request.input);
    const png = `${request.outDir}/page-1.png`;
    const profilePath = `${request.outDir}/page-1.bmp`;
    writePNG(rep, png);
    const gray = writeProfile(rep, profilePath, profileWidth);
    pages.push({
      page: 1,
      png,
      profile: profilePath,
      width: Number(rep.pixelsWide),
      height: Number(rep.pixelsHigh),
      grayWidth: gray.width,
      grayHeight: gray.height,
    });
  }
  return { pageCount, pages };
}

function crop(request) {
  const source = $.NSBitmapImageRep.imageRepWithContentsOfFile(request.png);
  if (!source.js) {
    fail(`unreadable render ${request.png}`);
  }
  const cg = source.CGImage;
  const written = [];
  for (const tile of request.tiles) {
    const rect = $.CGRectMake(tile.x, tile.y, tile.width, tile.height);
    const cropped = $.CGImageCreateWithImageInRect(cg, rect);
    const rep = $.NSBitmapImageRep.alloc.initWithCGImage(cropped);
    writePNG(rep, tile.path);
    written.push({
      path: tile.path,
      width: Number(rep.pixelsWide),
      height: Number(rep.pixelsHigh),
    });
  }
  return { tiles: written };
}

// Not named `run`: osascript treats a top-level run() as the entry point and would
// call it a second time, re-reading an already-drained stdin.
function main() {
  const request = readStdin();
  const result = request.mode === "crop" ? crop(request) : render(request);
  // Write stdout directly: returning the string makes osascript coerce it and fail.
  writeStdout(JSON.stringify(result));
}

main();
