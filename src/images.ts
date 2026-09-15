/**
 * Node-local image preparation for the on-device model.
 *
 * Plain images used whole never touch the helper: they become data URLs directly.
 * PDFs and tiled OCR go through `native/imageprep.jxa.js` (JavaScript for
 * Automation, built into macOS, no Xcode toolchain), which renders pages and crops
 * planned tiles. Cut planning lives in ./tiling.ts so it stays testable.
 */
import { execFile } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBmpToGray } from "./bmp.js";
import { planTiles, type GrayPage, type Rect } from "./tiling.js";

const HELPER_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "native", "imageprep.jxa.js");
const OSASCRIPT = "/usr/bin/osascript";
const MAX_INPUT_BYTES = 30 * 1024 * 1024;
const RENDER_DPI = 200;
const PROFILE_WIDTH = 300;
const HELPER_TIMEOUT_MS = 120_000;
/** Formats NSImage/PDFKit can open. */
const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".heic", ".heif", ".tif", ".tiff", ".gif", ".webp", ".bmp",
]);
/** Sent to fm as-is when used whole; others are re-encoded to PNG by the helper. */
const DIRECT_IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".webp", "image/webp"],
]);
const DATA_URL_RE = /^data:image\/(png|jpe?g|heic|heif|tiff|gif|webp|bmp);base64,([A-Za-z0-9+/=\s]+)$/i;

export type PreparedPage = { page: number; strips: string[] /* data URLs */ };
export type PreparedDocument = { pageCount: number; pages: PreparedPage[] };

type RenderedPage = {
  page: number;
  png: string;
  /** Small BMP used only for ink profiling. */
  profile: string;
  width: number;
  height: number;
};

function execFileText(
  file: string,
  args: string[],
  input?: string,
  timeoutMs = HELPER_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const options = { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) };
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${file} failed: ${String(stderr || error.message).trim()}`));
        return;
      }
      resolvePromise(stdout);
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

async function runHelper(request: unknown, signal?: AbortSignal): Promise<unknown> {
  if (process.platform !== "darwin") {
    throw new Error("apple_fm image support requires macOS");
  }
  if (!existsSync(HELPER_SCRIPT)) {
    throw new Error(`imageprep helper missing at ${HELPER_SCRIPT}`);
  }
  const stdout = await execFileText(
    OSASCRIPT,
    ["-l", "JavaScript", HELPER_SCRIPT],
    JSON.stringify(request),
    HELPER_TIMEOUT_MS,
    signal,
  );
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error(`imageprep returned unexpected output: ${stdout.slice(0, 200)}`);
  }
}

/** Default: anything under the node user's home directory. */
export function defaultAllowedRoots(): string[] {
  return [homedir()];
}

function withinRoots(candidate: string, roots: string[]): boolean {
  return roots.some((root) => {
    let resolvedRoot = resolve(root.startsWith("~/") ? join(homedir(), root.slice(2)) : root);
    try {
      resolvedRoot = realpathSync(resolvedRoot);
    } catch {
      return false;
    }
    return candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}/`);
  });
}

/**
 * A remote agent chooses this path, so it is resolved through symlinks and must
 * land inside an allowed root before anything reads it.
 */
export function resolveInputPath(input: string, allowedRoots: string[] = defaultAllowedRoots()): string {
  const expanded = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  if (!isAbsolute(expanded)) {
    throw new Error(`image path must be absolute on the node: ${input}`);
  }
  const ext = extname(expanded).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`unsupported file type ${ext || "(none)"}; use PDF or a common image format`);
  }
  let real: string;
  let size: number;
  try {
    real = realpathSync(expanded);
    const stat = statSync(real);
    if (!stat.isFile()) {
      throw new Error("not a file");
    }
    size = stat.size;
  } catch (error) {
    throw new Error(`cannot read ${expanded}: ${(error as Error).message}`);
  }
  if (!withinRoots(real, allowedRoots)) {
    throw new Error(`${expanded} is outside the allowed roots (${allowedRoots.join(", ")})`);
  }
  if (size > MAX_INPUT_BYTES) {
    throw new Error(`${expanded} is ${Math.round(size / 1024 / 1024)} MB; limit is 30 MB`);
  }
  return real;
}

function dataUrl(path: string, mime = "image/png"): string {
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

export type PrepareOptions = {
  firstPage?: number;
  lastPage?: number;
  /** Split pages into text-safe tiles (OCR). False sends each page whole. */
  tile: boolean;
  /** Directories a node-local path may resolve into. Defaults to the home directory. */
  allowedRoots?: string[];
  signal?: AbortSignal;
};

/**
 * Accepts a node-local file path (PDF or image) or a base64 image data URL and
 * returns page images as data URLs. Temporary files are removed before returning.
 */
export async function prepareDocument(input: string, options: PrepareOptions): Promise<PreparedDocument> {
  const trimmed = input.trim();
  const allowedRoots = options.allowedRoots ?? defaultAllowedRoots();
  const dataUrlMatch = DATA_URL_RE.exec(trimmed);
  if (!dataUrlMatch && trimmed.startsWith("data:")) {
    throw new Error("data URLs must be data:image/<png|jpeg|heic|tiff|gif|webp>;base64,...");
  }

  // Whole images that fm accepts directly need no render pass at all.
  if (!dataUrlMatch && !options.tile) {
    const path = resolveInputPath(trimmed, allowedRoots);
    const mime = DIRECT_IMAGE_TYPES.get(extname(path).toLowerCase());
    if (mime) {
      return { pageCount: 1, pages: [{ page: 1, strips: [dataUrl(path, mime)] }] };
    }
  }
  if (dataUrlMatch && !options.tile) {
    return { pageCount: 1, pages: [{ page: 1, strips: [trimmed] }] };
  }

  const workDir = mkdtempSync(join(tmpdir(), "apple-fm-"));
  try {
    let inputPath: string;
    if (dataUrlMatch) {
      const [, mime = "png", payload = ""] = dataUrlMatch;
      const bytes = Buffer.from(payload.replace(/\s+/g, ""), "base64");
      if (bytes.length > MAX_INPUT_BYTES) {
        throw new Error("image data URL exceeds 30 MB");
      }
      const ext = mime.toLowerCase() === "jpg" ? "jpeg" : mime.toLowerCase();
      inputPath = join(workDir, `input.${ext}`);
      writeFileSync(inputPath, bytes);
    } else {
      inputPath = resolveInputPath(trimmed, allowedRoots);
    }
    const outDir = join(workDir, "out");
    mkdirSync(outDir);
    const rendered = (await runHelper(
      {
        mode: "render",
        input: inputPath,
        outDir,
        dpi: RENDER_DPI,
        profileWidth: PROFILE_WIDTH,
        ...(options.firstPage ? { firstPage: options.firstPage } : {}),
        ...(options.lastPage ? { lastPage: options.lastPage } : {}),
      },
      options.signal,
    )) as { pageCount: number; pages: RenderedPage[] };

    const pages: PreparedPage[] = [];
    for (const page of rendered.pages) {
      options.signal?.throwIfAborted();
      const profile = parseBmpToGray(new Uint8Array(readFileSync(page.profile)));
      const gray: GrayPage = {
        gray: profile.gray,
        grayWidth: profile.width,
        grayHeight: profile.height,
        width: page.width,
        height: page.height,
      };
      const rects: Rect[] = planTiles(gray, { tile: options.tile });
      if (rects.length === 1 && rects[0]?.width === page.width && rects[0]?.height === page.height) {
        pages.push({ page: page.page, strips: [dataUrl(page.png)] });
        continue;
      }
      const tiles = rects.map((rect, index) => ({ ...rect, path: join(outDir, `p${page.page}-t${index + 1}.png`) }));
      const cropped = (await runHelper({ mode: "crop", png: page.png, tiles }, options.signal)) as {
        tiles: Array<{ path: string }>;
      };
      pages.push({ page: page.page, strips: cropped.tiles.map((tile) => dataUrl(tile.path)) });
    }
    return { pageCount: rendered.pageCount, pages };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
