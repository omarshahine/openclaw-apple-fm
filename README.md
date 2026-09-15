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

| Param | Notes |
|---|---|
| `action` | `status` or `respond` |
| `prompt` | Required for `respond` |
| `system` | Optional instructions |
| `jsonSchema` | Optional JSON Schema as a JSON-encoded string (strict tool-schema providers drop open-ended object params); enables guided generation. Objects and `{name, schema}` wrappers are also accepted. |
| `temperature` | 0 to 2 |
| `maxTokens` | 1 to 4096 (default 1024) |

## Limits

- 8,192-token window shared by input and output; inputs over 20k chars are rejected.
- No reasoning, no stop sequences, single completion. `fm serve` exposes only the
  on-device `system` model (not Private Cloud Compute).
- The command is omitted from the node declaration until `fm` exists and its
  license is agreed; availability is re-checked every 30s.
- Text only in this POC. `fm serve` accepts base64 `image_url` parts; image input is a follow-up.

## Config (`plugins.entries.apple-fm.config`)

`socketPath`, `defaultMaxTokens`, `requestTimeoutMs`.
