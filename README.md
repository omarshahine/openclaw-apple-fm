# openclaw-apple-fm

POC OpenClaw **node-host** plugin that runs Apple's on-device Foundation Model
(macOS 27, `SystemLanguageModel`, AFM 3 Core or Core Advanced depending on hardware)
on a paired Mac and exposes it to agents on a remote Gateway as the `apple_fm` tool.

It follows the same pattern as the bundled Ollama plugin's node inference: the
Gateway runs the agent loop; the model runs on the node.

```
agent (remote Gateway) ──node.invoke applefm.run──▶ node host (this Mac)
                                                      └─ fm serve --socket ~/.openclaw/apple-fm/fm.sock
                                                           └─ FoundationModels (on-device)
```

## Requirements

- macOS 27 with Apple Intelligence enabled
- OpenClaw >= 2026.9.4 running `openclaw node run`
- Xcode or Command Line Tools (for the image/OCR helper)
- Apple Foundation Models CLI license accepted once per machine: `sudo fm license`

## Install (node only)

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/node-host.json \
  openclaw plugins install --link ~/GitHub/openclaw-apple-fm --force --accept-capabilities
launchctl kickstart -k gui/$(id -u)/ai.openclaw.node
```

The node's new command surface needs re-approval on the Gateway (Control UI, or
`openclaw nodes approve`). No Gateway plugin is required.

## Tool

`apple_fm` (command `applefm.run`, capability `apple-foundation-models`)

| Action | What it does |
|---|---|
| `status` | Checks the model and license |
| `respond` | Runs `prompt` (+ optional `system`, `jsonSchema`), optionally about up to 4 `images` sent whole |
| `ocr` | Transcribes a PDF or image at `path` on the node (`pages` like `"2-4"`); with `prompt`/`jsonSchema`, answers over the transcript |
| `result` | Fetches a running job by `jobId` |
| `cancel` | Aborts a running job by `jobId` |

- `images` / `path`: absolute node-local paths (PDF, PNG, JPEG, HEIC, TIFF, GIF, WebP, BMP; 30 MB max) or `data:image/...;base64` URLs. Paths are resolved through symlinks and must land inside `allowedRoots`.
- `jsonSchema`: a JSON-encoded string (strict tool-schema providers drop open-ended object params). Objects and `{name, schema}` wrappers are also accepted.
- Gateway node tool calls time out at 30s. Every `respond`/`ocr` call runs as a job: the handler waits up to `waitMs` (default 20000) and otherwise returns `details.status: "running"` with a `jobId` for `action=result`. Results are kept 15 minutes; at most 4 jobs run at once. Jobs are cancelled when the Gateway connection drops.
- The model sees only `content`, so latency and token counts are appended as a bracketed line.

## How OCR works

The system model spends a fixed ~215-token image budget per attachment and downsamples to fit, so a whole page is unreadable (12% word recall on a test superbill). `native/imageprep.swift` renders pages at 200 dpi in grayscale and splits them into rows, then columns (max ~900 px wide), cutting at the blankest row/column so text is not sliced. Blank tiles are skipped. Each tile is transcribed separately through a single serial model queue, then joined per page.

Measured on a 2-page Prawn-generated superbill against its PDF text layer:

| Layout | Word recall (page 1) |
|---|---|
| Whole page | 12% |
| 3 full-width strips | 87% |
| 3 rows x 2 columns (shipped) | 99% (page 2: 100%) |

Cost: ~5 s per tile on an M5, so ~40 s for 2 pages (10 tiles). The Swift helper compiles once on first use with `xcrun swiftc` (needs Xcode or Command Line Tools) and is cached in `~/.openclaw/apple-fm/bin/` by source hash.

## Limits

- 8,192-token window shared by input and output; text inputs over 20k chars are rejected, and `ocr` + `prompt` needs the transcript to fit.
- No reasoning, no stop sequences, single completion. `fm serve` exposes only the on-device `system` model (not Private Cloud Compute).
- The small model is a weak counter: extraction over the superbill got totals right but miscounted table rows (6 vs 8).
- The command is omitted from the node declaration until `fm` exists and its license is agreed; availability is re-checked every 30s.

## Security

The tool is callable by any agent on the paired Gateway, so node-local reads are bounded:

- Paths are resolved with `realpath` and must sit inside `allowedRoots` (default: the node user's home directory). Symlinks pointing outside are rejected.
- Only PDF and common image extensions are accepted, 30 MB max.
- `fm serve` listens on a Unix socket under `~/.openclaw/apple-fm/`, never on TCP, and prompts never leave the Mac.
- Nothing is written outside a per-request temp directory (removed in a `finally`) and the compiled helper cache.

Note that an agent asking this tool to transcribe a document receives the transcript, which then lives in that agent's context and its model provider. For sensitive documents, call the node directly (`openclaw nodes invoke`) instead of through an agent turn.

## Testing

```bash
npm test          # unit tests (no fm required): params, jobs, path validation
npm run typecheck # tsc against the installed OpenClaw SDK types
npm run check     # both

# Model paths: need macOS 27 + accepted license
npm run smoke                                   # status, text, JSON schema, input validation
node scripts/smoke.mjs --image /abs/photo.png   # respond with an image
node scripts/smoke.mjs --ocr /abs/file.pdf      # OCR with job polling (--print to show text)
```

CI runs the unit tests and typecheck; the model paths run manually because they need macOS 27, the Apple license, and the Swift toolchain.

## Config (`plugins.entries.apple-fm.config`)

| Key | Default | Purpose |
|---|---|---|
| `socketPath` | `~/.openclaw/apple-fm/fm.sock` | Unix socket for the private `fm serve` |
| `defaultMaxTokens` | 1024 | `max_tokens` when the caller omits `maxTokens` |
| `requestTimeoutMs` | 120000 | Per-request timeout for `fm serve` |
| `allowedRoots` | home directory | Directories `ocr`/`images` paths may resolve into |

## Gateway setup

A node-only plugin is not allowlisted by default. On the Gateway:

```bash
openclaw config set gateway.nodes.commands.allow '["applefm.run", ...existing]' --strict-json
```

If the calling agent restricts tools (a `tools.profile` plus `alsoAllow`), add `apple_fm` to that agent's `alsoAllow`; otherwise the tool is filtered out of the agent's tool set even though the node publishes it. Then reconnect the node and approve its new command surface.
