/**
 * Node-local image preparation for the on-device model: validates the input,
 * compiles and caches the Swift `imageprep` helper, and returns base64 PNG
 * strips grouped by page.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "native", "imageprep.swift");
const HELPER_DIR = join(homedir(), ".openclaw", "apple-fm", "bin");
const MAX_INPUT_BYTES = 30 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".heic", ".heif", ".tif", ".tiff", ".gif", ".webp", ".bmp",
]);
const DATA_URL_RE = /^data:image\/(png|jpe?g|heic|heif|tiff|gif|webp|bmp);base64,([A-Za-z0-9+/=\s]+)$/i;

export type PreparedPage = { page: number; strips: string[] /* data URLs */ };
export type PreparedDocument = { pageCount: number; pages: PreparedPage[] };

type HelperResponse = {
  pageCount: number;
  pages: Array<{ page: number; strips: Array<{ path: string; width: number; height: number }> }>;
};

function execFileText(file: string, args: string[], input?: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
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

let helperPromise: Promise<string> | undefined;

/** Compile imageprep once per source revision; cached by content hash. */
export function ensureHelper(): Promise<string> {
  helperPromise ??= (async () => {
    const source = readFileSync(HELPER_SOURCE);
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
    const binary = join(HELPER_DIR, `imageprep-${hash}`);
    if (existsSync(binary)) {
      return binary;
    }
    mkdirSync(HELPER_DIR, { recursive: true, mode: 0o700 });
    const staging = `${binary}.${process.pid}.tmp`;
    try {
      await execFileText("/usr/bin/xcrun", ["swiftc", "-O", "-o", staging, HELPER_SOURCE], undefined, 300_000);
    } catch (error) {
      throw new Error(
        `apple_fm image support needs the Swift compiler (Xcode or Command Line Tools): ${(error as Error).message}`,
      );
    }
    renameSync(staging, binary);
    return binary;
  })().catch((error) => {
    helperPromise = undefined;
    throw error;
  });
  return helperPromise;
}

function resolveInputPath(input: string): string {
  const expanded = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  if (!isAbsolute(expanded)) {
    throw new Error(`image path must be absolute on the node: ${input}`);
  }
  const ext = extname(expanded).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`unsupported file type ${ext || "(none)"}; use PDF or a common image format`);
  }
  let size: number;
  try {
    const stat = statSync(expanded);
    if (!stat.isFile()) {
      throw new Error("not a file");
    }
    size = stat.size;
  } catch (error) {
    throw new Error(`cannot read ${expanded}: ${(error as Error).message}`);
  }
  if (size > MAX_INPUT_BYTES) {
    throw new Error(`${expanded} is ${Math.round(size / 1024 / 1024)} MB; limit is 30 MB`);
  }
  return expanded;
}

export type PrepareOptions = {
  firstPage?: number;
  lastPage?: number;
  /** Split pages into text-safe horizontal strips (OCR). False sends each page whole. */
  tile: boolean;
};

/**
 * Accepts a node-local file path (PDF or image) or a base64 image data URL and
 * returns PNG strips. Temporary files are removed before returning.
 */
export async function prepareDocument(input: string, options: PrepareOptions): Promise<PreparedDocument> {
  const helper = await ensureHelper();
  const workDir = mkdtempSync(join(tmpdir(), "apple-fm-"));
  try {
    let inputPath: string;
    const dataUrl = DATA_URL_RE.exec(input.trim());
    if (dataUrl) {
      const bytes = Buffer.from(dataUrl[2].replace(/\s+/g, ""), "base64");
      if (bytes.length > MAX_INPUT_BYTES) {
        throw new Error("image data URL exceeds 30 MB");
      }
      const ext = dataUrl[1].toLowerCase() === "jpg" ? "jpeg" : dataUrl[1].toLowerCase();
      inputPath = join(workDir, `input.${ext}`);
      writeFileSync(inputPath, bytes);
    } else if (input.trim().startsWith("data:")) {
      throw new Error("images[] data URLs must be data:image/<png|jpeg|heic|tiff|gif|webp>;base64,...");
    } else {
      inputPath = resolveInputPath(input.trim());
    }
    const outDir = join(workDir, "out");
    mkdirSync(outDir);
    const stdout = await execFileText(
      helper,
      [],
      JSON.stringify({
        input: inputPath,
        outDir,
        tile: options.tile,
        ...(options.firstPage ? { firstPage: options.firstPage } : {}),
        ...(options.lastPage ? { lastPage: options.lastPage } : {}),
      }),
    );
    const response = JSON.parse(stdout) as HelperResponse;
    return {
      pageCount: response.pageCount,
      pages: response.pages.map((page) => ({
        page: page.page,
        strips: page.strips.map((strip) => `data:image/png;base64,${readFileSync(strip.path).toString("base64")}`),
      })),
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
