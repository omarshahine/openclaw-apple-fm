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

export const APPLE_FM_COMMAND = "applefm.run";
export const APPLE_FM_CAPABILITY = "apple-foundation-models";

// fm's system model has an 8,192-token window shared by prompt and output.
const CONTEXT_TOKENS = 8192;
const MAX_INPUT_CHARS = 20_000;
const MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const LICENSE_POLL_MS = 30_000;

type RunParams = {
  action: "status" | "respond";
  prompt?: string;
  system?: string;
  jsonSchema?: unknown;
  temperature?: number;
  maxTokens?: number;
};

type PluginConfig = { socketPath?: string; defaultMaxTokens?: number; requestTimeoutMs?: number };

const toolParameters = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["status", "respond"],
      description: "status: check the on-device model. respond: run a prompt.",
    },
    prompt: { type: "string", description: "User prompt for action=respond." },
    system: { type: "string", description: "Optional instructions for action=respond." },
    // A string, not an object: strict tool-schema providers (OpenAI) collapse a
    // property-less object parameter to {}, so the schema never arrives.
    jsonSchema: {
      type: "string",
      description:
        'Optional JSON Schema, JSON-encoded as a string, with a root "type", e.g. "{\\"type\\":\\"object\\",\\"properties\\":{\\"name\\":{\\"type\\":\\"string\\"}},\\"required\\":[\\"name\\"]}". The model returns JSON matching it.',
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
  if (params.action !== "status" && params.action !== "respond") {
    throw new Error("action must be status or respond");
  }
  return params;
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

export default definePluginEntry({
  id: "apple-fm",
  name: "Apple Foundation Models",
  description: "On-device Apple Foundation Models on a paired macOS 27 node.",
  register(api) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const server = new FmServer(config.socketPath ?? DEFAULT_SOCKET_PATH);
    const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    process.once("exit", () => server.stop());

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
          "Run Apple's on-device Foundation Model (8K context, no reasoning) on this Mac node. " +
          "Good for short private summarization, classification, extraction, and rewriting. " +
          "Pass jsonSchema for structured output. Keep prompt+system under ~20k characters.",
        parameters: toolParameters,
        defaultPlatforms: ["macos"],
      },
      handle: async (paramsJSON, _io, context) => {
        const params = parseParams(paramsJSON);
        await server.ensureRunning();

        if (params.action === "status") {
          const models = await server.request("GET", "/v1/models", undefined, 10_000);
          return textResult("Apple Foundation Models is available on this node.", {
            license: "agreed",
            contextTokens: CONTEXT_TOKENS,
            models: models.body,
          });
        }

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

        const messages = [
          ...(params.system ? [{ role: "system", content: params.system }] : []),
          { role: "user", content: prompt },
        ];
        const payload: Record<string, unknown> = {
          model: "system",
          // fm serve streams SSE unless stream is explicitly false.
          stream: false,
          messages,
          max_tokens: Math.min(params.maxTokens ?? config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS, MAX_OUTPUT_TOKENS),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          ...(params.jsonSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: { name: "result", schema: normalizeJsonSchema(params.jsonSchema), strict: true },
                },
              }
            : {}),
        };

        const started = Date.now();
        const res = await server.request("POST", "/v1/chat/completions", payload, timeoutMs, context?.signal);
        if (res.status !== 200) {
          throw new Error(`fm serve: ${errorMessage(res.body, res.status)}`);
        }
        const body = res.body as {
          model?: string;
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: unknown;
        };
        const choice = body.choices?.[0];
        const text = choice?.message?.content;
        if (typeof text !== "string") {
          throw new Error("fm serve response did not contain choices[0].message.content");
        }
        let structured: unknown;
        if (params.jsonSchema) {
          try {
            structured = JSON.parse(text);
          } catch {
            // Leave structured undefined; the raw text is still returned.
          }
        }
        const totalTokens = (body.usage as { total_tokens?: number } | undefined)?.total_tokens;
        const meta = `[apple_fm on-device: ${Date.now() - started}ms, ${totalTokens ?? "?"} tokens, finish=${choice?.finish_reason ?? "?"}]`;
        return textResult(`${text}\n\n${meta}`, {
          model: body.model ?? "system",
          finishReason: choice?.finish_reason,
          usage: body.usage,
          latencyMs: Date.now() - started,
          ...(structured !== undefined ? { structured } : {}),
        });
      },
    });
  },
});
