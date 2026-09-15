/** Parameter parsing and validation for the apple_fm node command (no runtime deps). */

// fm's system model has an 8,192-token window shared by prompt and output.
export const CONTEXT_TOKENS = 8192;
export const MAX_INPUT_CHARS = 20_000;
export const MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_MAX_TOKENS = 1024;
// Gateway node tool calls time out at 30s; answer or hand back a jobId before that.
export const DEFAULT_WAIT_MS = 20_000;
export const MAX_WAIT_MS = 25_000;
export const MAX_RESPOND_IMAGES = 4;
export const MAX_OCR_PAGES = 20;

export const ACTIONS = ["status", "respond", "ocr", "result", "cancel"] as const;
export type Action = (typeof ACTIONS)[number];

export type RunParams = {
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

export const toolParameters = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [...ACTIONS],
      description:
        "status: check the model. respond: run a prompt, optionally about images. " +
        "ocr: transcribe a PDF or image on the node, optionally answering prompt/jsonSchema over the text. " +
        "result: fetch a running job by jobId. cancel: stop a running job.",
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
    pages: {
      type: "string",
      description: 'ocr only: page or range for PDFs, e.g. "1" or "2-4". Default: all (max 20).',
    },
    jobId: { type: "string", description: "result/cancel only: jobId returned by a running respond/ocr call." },
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

export function parseParams(paramsJSON?: string | null): RunParams {
  const parsed: unknown = paramsJSON ? JSON.parse(paramsJSON) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("apple_fm params must be a JSON object");
  }
  const params = parsed as RunParams;
  if (!ACTIONS.includes(params.action)) {
    throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
  }
  if (params.images !== undefined && !Array.isArray(params.images)) {
    throw new Error("images must be an array of paths or data URLs");
  }
  if ((params.action === "result" || params.action === "cancel") && !params.jobId) {
    throw new Error(`jobId is required for action=${params.action}`);
  }
  return params;
}

export function resolveWaitMs(waitMs?: number): number {
  if (waitMs === undefined || Number.isNaN(waitMs)) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(Math.max(waitMs, 0), MAX_WAIT_MS);
}

export function parsePages(pages?: string): { firstPage?: number; lastPage?: number } {
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

export function assertInputSize(chars: number): void {
  if (chars > MAX_INPUT_CHARS) {
    throw new Error(
      `input is ${chars} characters; the on-device model has an ${CONTEXT_TOKENS}-token window (limit ${MAX_INPUT_CHARS} chars)`,
    );
  }
}

/**
 * fm serve requires a root keyword (type/const/$ref/anyOf). Agents often send a
 * stringified schema, an OpenAI-style {name, schema} wrapper, or an object schema
 * without "type"; accept those shapes instead of failing the call.
 */
export function normalizeJsonSchema(input: unknown): Record<string, unknown> {
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

export function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (err && typeof err === "object" && "message" in err) {
      return String((err as { message: unknown }).message);
    }
    return JSON.stringify(err);
  }
  return `HTTP ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`;
}
