#!/usr/bin/env node
// Local smoke test: loads the plugin through OpenClaw's own TS loader (jiti), registers
// it against a fake API, and calls the node command handler directly.
//
//   node scripts/smoke.mjs                         # status + text + JSON schema + oversize
//   node scripts/smoke.mjs --ocr /abs/file.pdf     # OCR, polling jobs like the Gateway would
//   node scripts/smoke.mjs --image /abs/photo.png  # respond with one image
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const openclawRoot = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "openclaw");
const { createJiti } = await import(join(openclawRoot, "node_modules/jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, { alias: { "openclaw/plugin-sdk": join(openclawRoot, "dist/plugin-sdk") } });
const entry = (await jiti.import(join(root, "src/index.ts"))).default;

const commands = [];
entry.register({ pluginConfig: {}, registerNodeHostCommand: (c) => commands.push(c), logger: console });
const command = commands[0];
if (!command.isAvailable({ config: {}, env: process.env })) {
  console.error("apple_fm unavailable: needs /usr/bin/fm and an accepted license (sudo fm license)");
  process.exit(1);
}

async function call(params) {
  const started = Date.now();
  let out = JSON.parse(await command.handle(JSON.stringify(params)));
  while (out.details?.status === "running") {
    console.error(`  running: ${out.details.progress.stage} ${out.details.progress.done}/${out.details.progress.total}`);
    out = JSON.parse(await command.handle(JSON.stringify({ action: "result", jobId: out.details.jobId })));
  }
  return { out, ms: Date.now() - started };
}

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
let failures = 0;
const check = (label, ok, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${info ? ` ${info}` : ""}`);
  if (!ok) failures += 1;
};

if (flag("--ocr")) {
  const { out, ms } = await call({ action: "ocr", path: flag("--ocr"), pages: flag("--pages") });
  const text = out.content[0].text;
  check("ocr", text.length > 0, `${ms}ms ${JSON.stringify({ ...out.details, status: undefined })}`);
  if (args.includes("--print")) console.log(text);
} else if (flag("--image")) {
  const { out, ms } = await call({ action: "respond", prompt: "Describe this image in one sentence.", images: [flag("--image")] });
  check("respond+image", out.details.images === 1, `${ms}ms ${out.content[0].text}`);
} else {
  const status = await call({ action: "status" });
  check("status", status.out.details.license === "agreed");
  const text = await call({ action: "respond", prompt: "Reply with the single word: ok", maxTokens: 8 });
  check("respond", /ok/i.test(text.out.content[0].text), `${text.ms}ms`);
  const schema = JSON.stringify({
    type: "object", additionalProperties: false, required: ["carrier", "tracking"],
    properties: { carrier: { type: "string" }, tracking: { type: "string" } },
  });
  const structured = await call({ action: "respond", prompt: "Extract: shipped via UPS 1Z999AA10123456784", jsonSchema: schema });
  check("respond+jsonSchema(string)", structured.out.details.structured?.carrier === "UPS", `${structured.ms}ms`);
  try {
    await call({ action: "respond", prompt: "x".repeat(25_000) });
    check("oversize rejected", false);
  } catch (error) {
    check("oversize rejected", /token window/.test(error.message));
  }
  try {
    await call({ action: "ocr", path: "relative/file.pdf" });
    check("relative path rejected", false);
  } catch (error) {
    check("relative path rejected", /absolute/.test(error.message));
  }
}
process.exit(failures ? 1 : 0);
