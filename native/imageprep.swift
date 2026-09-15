// imageprep: render PDF pages / images to grayscale PNG strips for on-device OCR.
//
// The system model spends a fixed image token budget per attachment, so a full
// page is downsampled until small text is unreadable. Horizontal strips keep the
// effective resolution usable: pages become rows, rows become columns (tiles read
// left to right). Cuts land on the blankest row/column near each ideal boundary so
// text is not sliced in half.
//
// stdin:  {"input": "/abs/path", "outDir": "/abs/dir", "dpi": 200,
//          "firstPage": 1, "lastPage": 10, "stripAspect": 0.43, "maxTileWidth": 900, "tile": true}
// stdout: {"pageCount": N, "pages": [{"page": 1, "strips": [{"path", "width", "height"}]}]}
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Request: Decodable {
  let input: String
  let outDir: String
  var dpi: Double? = nil
  var firstPage: Int? = nil
  var lastPage: Int? = nil
  var stripAspect: Double? = nil
  var tile: Bool? = nil
  var maxTileWidth: Int? = nil
}

struct Strip: Encodable { let path: String; let width: Int; let height: Int }
struct Page: Encodable { let page: Int; let strips: [Strip] }
struct Response: Encodable { let pageCount: Int; let pages: [Page] }

struct Failure: Error { let message: String }

let maxPixelDimension = 2400
let inkThreshold: UInt8 = 200

func grayContext(width: Int, height: Int) throws -> CGContext {
  guard let ctx = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
  else { throw Failure(message: "could not allocate \(width)x\(height) bitmap") }
  ctx.setFillColor(gray: 1, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  ctx.interpolationQuality = .high
  return ctx
}

func renderPDFPage(_ page: CGPDFPage, dpi: Double) throws -> CGContext {
  let box = page.getBoxRect(.mediaBox)
  let rotated = page.rotationAngle % 180 != 0
  let pointsW = rotated ? box.height : box.width
  let pointsH = rotated ? box.width : box.height
  var scale = dpi / 72
  scale = min(scale, Double(maxPixelDimension) / max(pointsW, pointsH))
  let width = Int((pointsW * scale).rounded())
  let height = Int((pointsH * scale).rounded())
  let ctx = try grayContext(width: width, height: height)
  let target = CGRect(x: 0, y: 0, width: width, height: height)
  // getDrawingTransform never scales up, so scale the context and map to point space.
  ctx.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
  let pointRect = CGRect(x: 0, y: 0, width: target.width / scale, height: target.height / scale)
  ctx.concatenate(page.getDrawingTransform(.mediaBox, rect: pointRect, rotate: 0, preserveAspectRatio: true))
  ctx.drawPDFPage(page)
  return ctx
}

func renderImage(at url: URL) throws -> CGContext {
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
    throw Failure(message: "unreadable image")
  }
  let options: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceCreateThumbnailWithTransform: true,
    kCGImageSourceThumbnailMaxPixelSize: maxPixelDimension,
  ]
  guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
    throw Failure(message: "could not decode image")
  }
  let ctx = try grayContext(width: image.width, height: image.height)
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  return ctx
}

/// Dark-pixel count per row, top row first (bitmap memory is top-down).
func inkProfile(_ ctx: CGContext) -> [Int] {
  let width = ctx.width, height = ctx.height
  guard let data = ctx.data?.assumingMemoryBound(to: UInt8.self) else { return [] }
  var rows = [Int](repeating: 0, count: height)
  for y in 0..<height {
    let row = data + y * ctx.bytesPerRow
    var ink = 0
    var x = 0
    while x < width {
      if row[x] < inkThreshold { ink += 1 }
      x += 2
    }
    rows[y] = ink
  }
  return rows
}

/// Cut positions splitting a 1-D ink profile into `count` pieces: middle of the longest
/// blank run near each ideal boundary, else the least-ink position.
func planCuts(profile: [Int], count: Int) -> [Int] {
  let height = profile.count
  guard count > 1 else { return [0, height] }
  var cuts = [0]
  let stripHeight = Double(height) / Double(count)
  for k in 1..<count {
    let ideal = Int(Double(k) * stripHeight)
    let window = Int(stripHeight * 0.25)
    let lo = max(cuts.last! + 1, ideal - window)
    let hi = min(height - 1, ideal + window)
    guard lo < hi else { continue }
    var bestRunStart = -1, bestRunLength = 0, runStart = -1
    for y in lo...hi {
      if profile[y] == 0 {
        if runStart < 0 { runStart = y }
        let length = y - runStart + 1
        if length > bestRunLength || (length == bestRunLength
          && abs(runStart + length / 2 - ideal) < abs(bestRunStart + bestRunLength / 2 - ideal)) {
          bestRunStart = runStart
          bestRunLength = length
        }
      } else {
        runStart = -1
      }
    }
    if bestRunLength > 0 {
      cuts.append(bestRunStart + bestRunLength / 2)
    } else {
      let slice = lo...hi
      let minRow = slice.min { profile[$0] == profile[$1] ? abs($0 - ideal) < abs($1 - ideal) : profile[$0] < profile[$1] }!
      cuts.append(minRow)
    }
  }
  cuts.append(height)
  return cuts
}

/// Dark-pixel count per column within rows [top, bottom).
func columnInkProfile(_ ctx: CGContext, top: Int, bottom: Int) -> [Int] {
  let width = ctx.width
  guard let data = ctx.data?.assumingMemoryBound(to: UInt8.self) else { return [] }
  var columns = [Int](repeating: 0, count: width)
  var y = top
  while y < bottom {
    let row = data + y * ctx.bytesPerRow
    for x in 0..<width where row[x] < inkThreshold { columns[x] += 1 }
    y += 2
  }
  return columns
}

func writePNG(_ image: CGImage, to path: String) throws {
  let url = URL(fileURLWithPath: path)
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    throw Failure(message: "could not create \(path)")
  }
  CGImageDestinationAddImage(dest, image, nil)
  guard CGImageDestinationFinalize(dest) else { throw Failure(message: "could not write \(path)") }
}

func strips(for ctx: CGContext, page: Int, request: Request) throws -> [Strip] {
  guard let full = ctx.makeImage() else { throw Failure(message: "could not snapshot page \(page)") }
  let profile = inkProfile(ctx)
  let tile = request.tile ?? true
  guard tile else {
    let path = "\(request.outDir)/p\(page)-s1.png"
    try writePNG(full, to: path)
    return [Strip(path: path, width: full.width, height: full.height)]
  }
  // Rows sized from the full width; columns keep each tile narrow enough that the
  // model's per-image downsampling leaves small text legible.
  let rowCount = max(1, Int((Double(ctx.height) / max(1, Double(ctx.width) * (request.stripAspect ?? 0.43))).rounded()))
  let columnCount = max(1, Int((Double(ctx.width) / Double(request.maxTileWidth ?? 900)).rounded(.up)))
  let rowCuts = planCuts(profile: profile, count: rowCount)
  var result: [Strip] = []
  for rowIndex in 0..<(rowCuts.count - 1) {
    let top = rowCuts[rowIndex], bottom = rowCuts[rowIndex + 1]
    if profile[top..<bottom].reduce(0, +) < 20 { continue } // blank band
    let columns = columnInkProfile(ctx, top: top, bottom: bottom)
    let columnCuts = planCuts(profile: columns, count: columnCount)
    for columnIndex in 0..<(columnCuts.count - 1) {
      let left = columnCuts[columnIndex], right = columnCuts[columnIndex + 1]
      if columns[left..<right].reduce(0, +) < 10 { continue } // blank tile
      let rect = CGRect(x: left, y: top, width: right - left, height: bottom - top)
      guard let cropped = full.cropping(to: rect) else { continue }
      let path = "\(request.outDir)/p\(page)-r\(rowIndex + 1)c\(columnIndex + 1).png"
      try writePNG(cropped, to: path)
      result.append(Strip(path: path, width: cropped.width, height: cropped.height))
    }
  }
  return result
}

func run() throws -> Response {
  let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
  let url = URL(fileURLWithPath: request.input)
  let dpi = request.dpi ?? 200
  let isPDF = UTType(filenameExtension: url.pathExtension.lowercased())?.conforms(to: .pdf) ?? false
  if isPDF {
    guard let doc = CGPDFDocument(url as CFURL) else { throw Failure(message: "unreadable PDF") }
    if doc.isEncrypted && !doc.isUnlocked { throw Failure(message: "PDF is encrypted") }
    let first = max(1, request.firstPage ?? 1)
    let last = min(doc.numberOfPages, request.lastPage ?? doc.numberOfPages)
    var pages: [Page] = []
    if first <= last {
      for number in first...last {
        guard let page = doc.page(at: number) else { continue }
        let ctx = try renderPDFPage(page, dpi: dpi)
        pages.append(Page(page: number, strips: try strips(for: ctx, page: number, request: request)))
      }
    }
    return Response(pageCount: doc.numberOfPages, pages: pages)
  }
  let ctx = try renderImage(at: url)
  return Response(pageCount: 1, pages: [Page(page: 1, strips: try strips(for: ctx, page: 1, request: request))])
}

do {
  let output = try JSONEncoder().encode(try run())
  FileHandle.standardOutput.write(output)
} catch let failure as Failure {
  FileHandle.standardError.write(Data("imageprep: \(failure.message)\n".utf8))
  exit(1)
} catch {
  FileHandle.standardError.write(Data("imageprep: \(error)\n".utf8))
  exit(1)
}
