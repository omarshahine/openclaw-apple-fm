/**
 * Owns a private `fm serve --socket` child process and speaks the Chat
 * Completions API to it over a Unix socket. Nothing listens on TCP.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FM_BIN = "/usr/bin/fm";
export const DEFAULT_SOCKET_PATH = join(homedir(), ".openclaw", "apple-fm", "fm.sock");

const START_TIMEOUT_MS = 20_000;
const STDERR_TAIL_CHARS = 2_000;

export function fmInstalled(): boolean {
  return process.platform === "darwin" && existsSync(FM_BIN);
}

/** `fm license --status` never prompts; any "not agreed" answer means unusable. */
export function fmLicenseAgreed(): boolean {
  if (!fmInstalled()) {
    return false;
  }
  try {
    const out = execFileSync(FM_BIN, ["license", "--status"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return !/not agreed/i.test(out);
  } catch {
    return false;
  }
}

export type FmResponse = { status: number; body: unknown };

export class FmServer {
  private child: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private stderrTail = "";

  constructor(private readonly socketPath: string = DEFAULT_SOCKET_PATH) {}

  async ensureRunning(): Promise<void> {
    if (await this.isHealthy()) {
      return;
    }
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  async request(
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<FmResponse> {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    return await new Promise<FmResponse>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: data
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
            : undefined,
          timeout: timeoutMs,
          signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = text;
            try {
              body = text ? JSON.parse(text) : undefined;
            } catch {
              // Non-JSON bodies (e.g. plain-text errors) are returned as strings.
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`fm serve timed out after ${timeoutMs}ms`)));
      req.on("error", reject);
      if (data) {
        req.write(data);
      }
      req.end();
    });
  }

  stop(): void {
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }

  private async isHealthy(): Promise<boolean> {
    if (!existsSync(this.socketPath)) {
      return false;
    }
    try {
      const res = await this.request("GET", "/health", undefined, 2_000);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  private async start(): Promise<void> {
    if (!fmInstalled()) {
      throw new Error(`${FM_BIN} not found; Apple Foundation Models requires macOS 27`);
    }
    if (!fmLicenseAgreed()) {
      throw new Error(
        "Apple Foundation Models CLI license not accepted; run 'sudo fm license' on the node",
      );
    }
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath); // stale socket from a previous process
    }
    this.stderrTail = "";
    const child = spawn(FM_BIN, ["serve", "--socket", this.socketPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    child.on("exit", () => {
      if (this.child === child) {
        this.child = undefined;
      }
    });
    this.child = child;

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`fm serve exited (${child.exitCode}): ${this.stderrTail.trim()}`);
      }
      if (await this.isHealthy()) {
        return;
      }
      await new Promise<void>((settle) => {
        setTimeout(settle, 250);
      });
    }
    child.kill("SIGTERM");
    throw new Error(
      `fm serve did not become healthy in ${START_TIMEOUT_MS}ms: ${this.stderrTail.trim()}`,
    );
  }
}
