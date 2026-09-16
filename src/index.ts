/**
 * OpenClaw plugin entry for Apple Foundation Models on a node host.
 *
 * Install on the macOS 27 node only. The node publishes `applefm.run` with an
 * `apple_fm` agent tool descriptor; the Gateway exposes that tool to agents while
 * the node is connected. Inference runs on-device through a private
 * `fm serve --socket` process and never listens on TCP.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_SOCKET_PATH, FmServer, fmInstalled, fmLicenseAgreed } from "./fm-server.js";
import { defaultAllowedRoots, prepareDocument } from "./images.js";
import {
  awaitJob,
  cancelAllJobs,
  cancelJob,
  getJob,
  runningJobCount,
  startJob,
  type JobProgress,
} from "./jobs.js";
import {
  assertInputSize,
  CONTEXT_TOKENS,
  errorMessage,
  MAX_OCR_PAGES,
  MAX_OUTPUT_TOKENS,
  MAX_RESPOND_IMAGES,
  normalizeJsonSchema,
  parsePages,
  parseParams,
  resolveWaitMs,
  toolParameters,
  DEFAULT_MAX_TOKENS,
  type RunParams,
} from "./params.js";

export const APPLE_FM_COMMAND = "applefm.run";
export const APPLE_FM_CAPABILITY = "apple-foundation-models";

const DEFAULT_TIMEOUT_MS = 120_000;
const LICENSE_POLL_MS = 30_000;
const OCR_TILE_MAX_TOKENS = 1500;
const MAX_TRANSCRIPT_CHARS = 60_000;
const OCR_INSTRUCTION =
  "Transcribe all text in this image exactly, preserving line order. Output only the transcription.";

type PluginConfig = {
  socketPath?: string;
  defaultMaxTokens?: number;
  requestTimeoutMs?: number;
  /** Directories that ocr/images paths may resolve into. Default: the home directory. */
  allowedRoots?: string[];
};

type ChatUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
type ChatResult = { text: string; finishReason?: string; usage?: ChatUsage };
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function textResult(text: string, details: Record<string, unknown>): string {
  return JSON.stringify({ content: [{ type: "text", text }], details });
}

export default definePluginEntry({
  id: "apple-fm",
  name: "Apple Foundation Models",
  description: "On-device Apple Foundation Models on a paired macOS 27 node.",
  register(api) {
    // SAFETY: plugin config is validated against configSchema in openclaw.plugin.json.
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const server = new FmServer(config.socketPath ?? DEFAULT_SOCKET_PATH);
    const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const allowedRoots = config.allowedRoots?.length ? config.allowedRoots : defaultAllowedRoots();
    const logger = api.logger;
    process.once("exit", () => server.stop());

    // The on-device model serves one request at a time; queue instead of piling up.
    let modelQueue: Promise<unknown> = Promise.resolve();
    const chat = (request: {
      system?: string;
      user: string | ContentPart[];
      maxTokens?: number;
      temperature?: number;
      jsonSchema?: unknown;
      signal?: AbortSignal;
    }): Promise<ChatResult> => {
      const run = async (): Promise<ChatResult> => {
        request.signal?.throwIfAborted();
        await server.ensureRunning();
        const payload: Record<string, unknown> = {
          model: "system",
          // fm serve streams SSE unless stream is explicitly false.
          stream: false,
          messages: [
            ...(request.system ? [{ role: "system", content: request.system }] : []),
            { role: "user", content: request.user },
          ],
          max_tokens: Math.min(
            request.maxTokens ?? config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
            MAX_OUTPUT_TOKENS,
          ),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.jsonSchema !== undefined
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: "result",
                    schema: normalizeJsonSchema(request.jsonSchema),
                    strict: true,
                  },
                },
              }
            : {}),
        };
        const res = await server.request(
          "POST",
          "/v1/chat/completions",
          payload,
          timeoutMs,
          request.signal,
        );
        if (res.status !== 200) {
          throw new Error(`fm serve: ${errorMessage(res.body, res.status)}`);
        }
        // SAFETY: fm serve answers Chat Completions JSON; fields are checked below.
        const body = res.body as {
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: ChatUsage;
        };
        const choice = body.choices?.[0];
        if (typeof choice?.message?.content !== "string") {
          throw new Error("fm serve response did not contain choices[0].message.content");
        }
        return {
          text: choice.message.content,
          finishReason: choice.finish_reason,
          usage: body.usage,
        };
      };
      const next = modelQueue.then(run, run);
      modelQueue = next.catch(() => undefined);
      return next;
    };

    const parseStructured = (text: string, jsonSchema: unknown): unknown => {
      if (jsonSchema === undefined) {
        return undefined;
      }
      try {
        return JSON.parse(text);
      } catch {
        return undefined; // raw text is still returned
      }
    };

    const runRespond = async (
      params: RunParams,
      progress: JobProgress,
      signal: AbortSignal,
    ): Promise<string> => {
      const prompt = params.prompt?.trim();
      if (!prompt) {
        throw new Error("prompt is required for action=respond");
      }
      assertInputSize(prompt.length + (params.system?.length ?? 0));
      const images = params.images ?? [];
      if (images.length > MAX_RESPOND_IMAGES) {
        throw new Error(
          `respond accepts at most ${MAX_RESPOND_IMAGES} images; use action=ocr for documents`,
        );
      }
      const started = Date.now();
      progress.total = images.length + 1;
      progress.stage = images.length ? "preparing images" : "generating";
      const imageParts: ContentPart[] = [];
      for (const image of images) {
        const prepared = await prepareDocument(image, {
          tile: false,
          firstPage: 1,
          lastPage: 1,
          allowedRoots,
          signal,
        });
        for (const url of prepared.pages[0]?.strips ?? []) {
          imageParts.push({ type: "image_url", image_url: { url } });
        }
        progress.done += 1;
      }
      progress.stage = "generating";
      const result = await chat({
        system: params.system,
        user: imageParts.length ? [{ type: "text", text: prompt }, ...imageParts] : prompt,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        jsonSchema: params.jsonSchema,
        signal,
      });
      progress.done += 1;
      const latencyMs = Date.now() - started;
      const structured = parseStructured(result.text, params.jsonSchema);
      const meta = `[apple_fm on-device: ${latencyMs}ms, ${result.usage?.total_tokens ?? "?"} tokens, finish=${result.finishReason ?? "?"}]`;
      return textResult(`${result.text}\n\n${meta}`, {
        status: "done",
        model: "system",
        images: imageParts.length,
        finishReason: result.finishReason,
        usage: result.usage,
        latencyMs,
        ...(structured !== undefined ? { structured } : {}),
      });
    };

    const runOcr = async (
      params: RunParams,
      progress: JobProgress,
      signal: AbortSignal,
    ): Promise<string> => {
      const input = params.path?.trim() || params.images?.[0]?.trim();
      if (!input) {
        throw new Error("path is required for action=ocr");
      }
      const range = parsePages(params.pages);
      const started = Date.now();
      progress.stage = "rendering";
      const firstPage = range.firstPage ?? 1;
      const doc = await prepareDocument(input, {
        tile: true,
        firstPage,
        lastPage: Math.min(
          range.lastPage ?? Number.MAX_SAFE_INTEGER,
          firstPage + MAX_OCR_PAGES - 1,
        ),
        allowedRoots,
        signal,
      });
      const tiles = doc.pages.reduce((sum, page) => sum + page.strips.length, 0);
      progress.total = tiles + (params.prompt ? 1 : 0);
      progress.stage = "transcribing";

      let promptTokens = 0;
      let completionTokens = 0;
      let truncatedTiles = 0;
      const pageTexts: string[] = [];
      for (const page of doc.pages) {
        const lines: string[] = [];
        for (const url of page.strips) {
          signal.throwIfAborted();
          const result = await chat({
            user: [
              { type: "text", text: OCR_INSTRUCTION },
              { type: "image_url", image_url: { url } },
            ],
            maxTokens: OCR_TILE_MAX_TOKENS,
            temperature: 0,
            signal,
          });
          promptTokens += result.usage?.prompt_tokens ?? 0;
          completionTokens += result.usage?.completion_tokens ?? 0;
          if (result.finishReason === "length") {
            truncatedTiles += 1;
          }
          lines.push(result.text.trim());
          progress.done += 1;
        }
        pageTexts.push(`--- page ${page.page} ---\n${lines.filter(Boolean).join("\n")}`);
      }
      const transcript = pageTexts.join("\n\n");
      const lastPage = doc.pages.at(-1)?.page;
      const details: Record<string, unknown> = {
        status: "done",
        pageCount: doc.pageCount,
        pagesProcessed: doc.pages.map((page) => page.page),
        ...(lastPage !== undefined && lastPage < doc.pageCount && !range.lastPage
          ? { note: `stopped after ${MAX_OCR_PAGES} pages; pass pages to continue` }
          : {}),
        tiles,
        truncatedTiles,
        transcriptChars: transcript.length,
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      };

      if (!params.prompt?.trim()) {
        const latencyMs = Date.now() - started;
        const clipped = transcript.length > MAX_TRANSCRIPT_CHARS;
        const meta = `[apple_fm on-device OCR: ${doc.pages.length} page(s), ${tiles} tiles, ${latencyMs}ms, ${promptTokens + completionTokens} tokens]`;
        return textResult(
          `${clipped ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript}\n\n${meta}`,
          {
            ...details,
            latencyMs,
            ...(clipped ? { clippedTo: MAX_TRANSCRIPT_CHARS } : {}),
          },
        );
      }

      progress.stage = "answering";
      const question = `${params.prompt.trim()}\n\nDocument text (OCR):\n${transcript}`;
      try {
        assertInputSize(question.length + (params.system?.length ?? 0));
      } catch {
        throw new Error(
          `OCR transcript is ${transcript.length} characters, too long to answer in the ${CONTEXT_TOKENS}-token window; use a smaller pages range or omit prompt`,
        );
      }
      const answer = await chat({
        system: params.system,
        user: question,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        jsonSchema: params.jsonSchema,
        signal,
      });
      progress.done += 1;
      const latencyMs = Date.now() - started;
      const structured = parseStructured(answer.text, params.jsonSchema);
      const meta = `[apple_fm on-device OCR+answer: ${doc.pages.length} page(s), ${tiles} tiles, ${latencyMs}ms, finish=${answer.finishReason ?? "?"}]`;
      return textResult(`${answer.text}\n\n${meta}`, {
        ...details,
        latencyMs,
        answerUsage: answer.usage,
        finishReason: answer.finishReason,
        ...(structured !== undefined ? { structured } : {}),
      });
    };

    api.registerNodeHostCommand({
      command: APPLE_FM_COMMAND,
      cap: APPLE_FM_CAPABILITY,
      isAvailable: () => fmInstalled() && fmLicenseAgreed(),
      watchAvailability: (_context, onChange) => {
        let last = fmLicenseAgreed();
        const timer = setInterval(() => {
          const next = fmLicenseAgreed();
          if (next !== last) {
            last = next;
            onChange();
          }
        }, LICENSE_POLL_MS);
        timer.unref();
        return () => clearInterval(timer);
      },
      onDisconnect: () => {
        // Nothing can collect these results any more; stop burning the ANE on them.
        const cancelled = cancelAllJobs("gateway disconnected");
        if (cancelled) {
          logger?.info?.(`apple_fm cancelled ${cancelled} running job(s) after gateway disconnect`);
        }
      },
      agentTool: {
        name: "apple_fm",
        description:
          "Run Apple's on-device Foundation Model (8K context, vision, no reasoning) on this Mac node; data stays on the Mac. " +
          "respond: short private summarization, classification, extraction, rewriting, or questions about up to 4 images. " +
          "ocr: transcribe a PDF or image file on the node (e.g. ~/Downloads/scan.pdf), optionally answering prompt/jsonSchema over the text. " +
          "Long jobs return a jobId; call action=result with it, or action=cancel to stop. Pass jsonSchema as a JSON string for structured output.",
        parameters: toolParameters,
        defaultPlatforms: ["macos"],
      },
      handle: async (paramsJSON) => {
        const params = parseParams(paramsJSON);
        const waitMs = resolveWaitMs(params.waitMs);
        // parseParams guarantees jobId for result/cancel.
        const jobId = params.jobId ?? "";

        switch (params.action) {
          case "status": {
            await server.ensureRunning();
            const models = await server.request("GET", "/v1/models", undefined, 10_000);
            return textResult("Apple Foundation Models is available on this node.", {
              license: "agreed",
              contextTokens: CONTEXT_TOKENS,
              actions: ["respond", "ocr", "result", "cancel"],
              runningJobs: runningJobCount(),
              allowedRoots,
              models: models.body,
            });
          }
          case "result":
            return await awaitJob(getJob(jobId), waitMs);
          case "cancel": {
            const cancelled = cancelJob(jobId);
            return textResult(
              cancelled
                ? `Cancelled job ${params.jobId}.`
                : `Job ${params.jobId} had already finished.`,
              { status: "done", cancelled },
            );
          }
          case "ocr":
            return await awaitJob(
              startJob("ocr", (progress, signal) => runOcr(params, progress, signal), logger),
              waitMs,
            );
          default:
            return await awaitJob(
              startJob(
                "respond",
                (progress, signal) => runRespond(params, progress, signal),
                logger,
              ),
              waitMs,
            );
        }
      },
    });
  },
});
