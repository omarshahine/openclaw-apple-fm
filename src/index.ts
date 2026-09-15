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
import { prepareDocument } from "./images.js";
import { awaitJob, getJob, startJob, type JobProgress } from "./jobs.js";

export const APPLE_FM_COMMAND = "applefm.run";
export const APPLE_FM_CAPABILITY = "apple-foundation-models";

// fm's system model has an 8,192-token window shared by prompt and output.
const CONTEXT_TOKENS = 8192;
const MAX_INPUT_CHARS = 20_000;
const MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const LICENSE_POLL_MS = 30_000;
// Gateway node tool calls time out at 30s; answer or hand back a jobId before that.
const DEFAULT_WAIT_MS = 20_000;
const MAX_WAIT_MS = 25_000;
const MAX_RESPOND_IMAGES = 4;
const MAX_OCR_PAGES = 20;
const OCR_STRIP_MAX_TOKENS = 1500;
const MAX_TRANSCRIPT_CHARS = 60_000;
const OCR_INSTRUCTION =
  "Transcribe all text in this image exactly, preserving line order. Output only the transcription.";

type Action = "status" | "respond" | "ocr" | "result";

type RunParams = {
  action: Action;
  prompt?: string;
  system?: string;
  jsonSchema?: unknown;
  temperature?: number;
  maxTokens?: number;
  images?: string[];
  path?: string;
  pages?: string;
  jobId?: string;
  waitMs?: number;
};

type PluginConfig = { socketPath?: string; defaultMaxTokens?: number; requestTimeoutMs?: number };

const toolParameters = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["status", "respond", "ocr", "result"],
      description:
        "status: check the model. respond: run a prompt, optionally about images. " +
        "ocr: transcribe a PDF or image on the node, optionally answering prompt/jsonSchema over the text. " +
        "result: fetch a running job by jobId.",
    },
    prompt: {
      type: "string",
      description: "Prompt for respond (required) or ocr (optional question/extraction over the transcript).",
    },
    system: { type: "string", description: "Optional instructions for respond/ocr." },
    // A string, not an object: strict tool-schema providers (OpenAI) collapse a
    // property-less object parameter to {}, so the schema never arrives.
    jsonSchema: {
      type: "string",
      description:
        'Optional JSON Schema, JSON-encoded as a string, with a root "type", e.g. "{\\"type\\":\\"object\\",\\"properties\\":{\\"name\\":{\\"type\\":\\"string\\"}},\\"required\\":[\\"name\\"]}". The model returns JSON matching it.',
    },
    images: {
      type: "array",
      maxItems: MAX_RESPOND_IMAGES,
      items: { type: "string" },
      description:
        "respond only: absolute image paths on the node or data:image/...;base64 URLs, sent whole (photos, diagrams). Use ocr for documents.",
    },
    path: {
      type: "string",
      description: "ocr only: absolute path on the node to a PDF or image (or a data:image/...;base64 URL).",
    },
    pages: { type: "string", description: 'ocr only: page or range for PDFs, e.g. "1" or "2-4". Default: all (max 20).' },
    jobId: { type: "string", description: "result only: jobId returned by a running respond/ocr call." },
    waitMs: {
      type: "integer",
      minimum: 0,
      maximum: MAX_WAIT_MS,
      description: "How long to wait for completion before returning a jobId (default 20000).",
    },
    temperature: { type: "number", minimum: 0, maximum: 2 },
    maxTokens: { type: "integer", minimum: 1, maximum: MAX_OUTPUT_TOKENS },
  },
} as const;

function textResult(text: string, details: Record<string, unknown>): string {
  return JSON.stringify({ content: [{ type: "text", text }], details });
}

function parseParams(paramsJSON?: string | null): RunParams {
  const parsed: unknown = paramsJSON ? JSON.parse(paramsJSON) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("apple_fm params must be a JSON object");
  }
  const params = parsed as RunParams;
  if (!["status", "respond", "ocr", "result"].includes(params.action)) {
    throw new Error("action must be status, respond, ocr, or result");
  }
  return params;
}

function parsePages(pages?: string): { firstPage?: number; lastPage?: number } {
  if (!pages?.trim()) {
    return {};
  }
  const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(pages);
  if (!match) {
    throw new Error(`pages must look like "3" or "2-5", got ${JSON.stringify(pages)}`);
  }
  const firstPage = Number(match[1]);
  const lastPage = match[2] ? Number(match[2]) : firstPage;
  if (firstPage < 1 || lastPage < firstPage) {
    throw new Error(`invalid page range ${pages}`);
  }
  return { firstPage, lastPage };
}

/**
 * fm serve requires a root keyword (type/const/$ref/anyOf). Agents often send a
 * stringified schema, an OpenAI-style {name, schema} wrapper, or an object schema
 * without "type"; accept those shapes instead of failing the call.
 */
function normalizeJsonSchema(input: unknown): Record<string, unknown> {
  let schema: unknown = input;
  if (typeof schema === "string") {
    try {
      schema = JSON.parse(schema);
    } catch {
      throw new Error("jsonSchema must be a JSON Schema object (got an unparseable string)");
    }
  }
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (isRecord(schema) && isRecord(schema.json_schema) && isRecord(schema.json_schema.schema)) {
    schema = schema.json_schema.schema;
  } else if (isRecord(schema) && isRecord(schema.schema) && !("type" in schema)) {
    schema = schema.schema;
  }
  if (!isRecord(schema)) {
    throw new Error("jsonSchema must be a JSON Schema object");
  }
  const hasRoot = ["type", "const", "$ref", "anyOf"].some((key) => key in schema);
  if (!hasRoot && isRecord(schema.properties)) {
    return { type: "object", ...schema };
  }
  if (!hasRoot) {
    throw new Error("jsonSchema needs a root 'type' (e.g. {\"type\":\"object\",\"properties\":{...}})");
  }
  return schema;
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (err && typeof err === "object" && "message" in err) {
      return String((err as { message: unknown }).message);
    }
    return JSON.stringify(err);
  }
  return `HTTP ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`;
}

type ChatUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
type ChatResult = { text: string; finishReason?: string; usage?: ChatUsage };
type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export default definePluginEntry({
  id: "apple-fm",
  name: "Apple Foundation Models",
  description: "On-device Apple Foundation Models on a paired macOS 27 node.",
  register(api) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const server = new FmServer(config.socketPath ?? DEFAULT_SOCKET_PATH);
    const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    process.once("exit", () => server.stop());

    // The on-device model serves one request at a time; queue instead of piling up.
    let modelQueue: Promise<unknown> = Promise.resolve();
    const chat = (request: {
      system?: string;
      user: string | ContentPart[];
      maxTokens?: number;
      temperature?: number;
      jsonSchema?: unknown;
    }): Promise<ChatResult> => {
      const run = async (): Promise<ChatResult> => {
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
                  json_schema: { name: "result", schema: normalizeJsonSchema(request.jsonSchema), strict: true },
                },
              }
            : {}),
        };
        const res = await server.request("POST", "/v1/chat/completions", payload, timeoutMs);
        if (res.status !== 200) {
          throw new Error(`fm serve: ${errorMessage(res.body, res.status)}`);
        }
        const body = res.body as {
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: ChatUsage;
        };
        const choice = body.choices?.[0];
        if (typeof choice?.message?.content !== "string") {
          throw new Error("fm serve response did not contain choices[0].message.content");
        }
        return { text: choice.message.content, finishReason: choice.finish_reason, usage: body.usage };
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

    const runRespond = async (params: RunParams, progress: JobProgress): Promise<string> => {
      const prompt = params.prompt?.trim();
      if (!prompt) {
        throw new Error("prompt is required for action=respond");
      }
      const inputChars = prompt.length + (params.system?.length ?? 0);
      if (inputChars > MAX_INPUT_CHARS) {
        throw new Error(
          `input is ${inputChars} characters; the on-device model has an ${CONTEXT_TOKENS}-token window (limit ${MAX_INPUT_CHARS} chars)`,
        );
      }
      const images = params.images ?? [];
      if (images.length > MAX_RESPOND_IMAGES) {
        throw new Error(`respond accepts at most ${MAX_RESPOND_IMAGES} images; use action=ocr for documents`);
      }
      const started = Date.now();
      progress.total = images.length + 1;
      progress.stage = images.length ? "preparing images" : "generating";
      const imageParts: ContentPart[] = [];
      for (const image of images) {
        const prepared = await prepareDocument(image, { tile: false, firstPage: 1, lastPage: 1 });
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

    const runOcr = async (params: RunParams, progress: JobProgress): Promise<string> => {
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
        lastPage: Math.min(range.lastPage ?? Number.MAX_SAFE_INTEGER, firstPage + MAX_OCR_PAGES - 1),
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
          const result = await chat({
            user: [
              { type: "text", text: OCR_INSTRUCTION },
              { type: "image_url", image_url: { url } },
            ],
            maxTokens: OCR_STRIP_MAX_TOKENS,
            temperature: 0,
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
        return textResult(`${clipped ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript}\n\n${meta}`, {
          ...details,
          latencyMs,
          ...(clipped ? { clippedTo: MAX_TRANSCRIPT_CHARS } : {}),
        });
      }

      progress.stage = "answering";
      const question = `${params.prompt.trim()}\n\nDocument text (OCR):\n${transcript}`;
      if (question.length + (params.system?.length ?? 0) > MAX_INPUT_CHARS) {
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
      agentTool: {
        name: "apple_fm",
        description:
          "Run Apple's on-device Foundation Model (8K context, vision, no reasoning) on this Mac node; data stays on the Mac. " +
          "respond: short private summarization, classification, extraction, rewriting, or questions about up to 4 images. " +
          "ocr: transcribe a PDF or image file on the node (e.g. ~/Downloads/scan.pdf), optionally answering prompt/jsonSchema over the text. " +
          "Long jobs return a jobId; call action=result with it. Pass jsonSchema as a JSON string for structured output.",
        parameters: toolParameters,
        defaultPlatforms: ["macos"],
      },
      handle: async (paramsJSON) => {
        const params = parseParams(paramsJSON);
        const waitMs = Math.min(Math.max(params.waitMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);

        if (params.action === "status") {
          await server.ensureRunning();
          const models = await server.request("GET", "/v1/models", undefined, 10_000);
          return textResult("Apple Foundation Models is available on this node.", {
            license: "agreed",
            contextTokens: CONTEXT_TOKENS,
            actions: ["respond", "ocr", "result"],
            models: models.body,
          });
        }
        if (params.action === "result") {
          if (!params.jobId) {
            throw new Error("jobId is required for action=result");
          }
          return await awaitJob(getJob(params.jobId), waitMs);
        }
        if (params.action === "ocr") {
          return await awaitJob(startJob("ocr", (progress) => runOcr(params, progress)), waitMs);
        }
        return await awaitJob(startJob("respond", (progress) => runRespond(params, progress)), waitMs);
      },
    });
  },
});
