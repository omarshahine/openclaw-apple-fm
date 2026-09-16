// Path validation for node-local files an agent may point the tool at.
// Every case here is rejected before the render helper runs, so these stay
// platform independent.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { defaultAllowedRoots, prepareDocument } from "../src/images.ts";

const root = mkdtempSync(join(tmpdir(), "apple-fm-test-"));
const allowedRoots = [root];
const prepare = (input: string) => prepareDocument(input, { tile: true, allowedRoots });

after(() => rmSync(root, { recursive: true, force: true }));

test("requires an absolute path", async () => {
  await assert.rejects(prepare("relative/doc.pdf"), /must be absolute/);
});

test("rejects unsupported extensions before touching the file", async () => {
  const script = join(root, "payload.sh");
  writeFileSync(script, "#!/bin/sh\n");
  await assert.rejects(prepare(script), /unsupported file type \.sh/);
});

test("rejects paths outside the allowed roots", async () => {
  const outside = mkdtempSync(join(tmpdir(), "apple-fm-outside-"));
  const other = join(outside, "other.pdf");
  writeFileSync(other, "%PDF-1.4");
  try {
    await assert.rejects(prepare(other), /outside the allowed roots/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlink cannot escape an allowed root", async () => {
  const outside = mkdtempSync(join(tmpdir(), "apple-fm-secret-"));
  const secret = join(outside, "secret.pdf");
  writeFileSync(secret, "%PDF-1.4 secret");
  const link = join(root, "link.pdf");
  symlinkSync(secret, link);
  try {
    await assert.rejects(prepare(link), /outside the allowed roots/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(link, { force: true });
  }
});

test("rejects directories and missing files", async () => {
  const dir = join(root, "folder.pdf");
  mkdirSync(dir);
  await assert.rejects(prepare(dir), /cannot read .*not a file/);
  await assert.rejects(prepare(join(root, "nope.pdf")), /cannot read/);
});

test("expands ~ against the node's home directory", async () => {
  await assert.rejects(prepare("~/definitely-missing-file.pdf"), /cannot read/);
});

test("rejects malformed data URLs", async () => {
  await assert.rejects(prepare("data:application/pdf;base64,AAAA"), /data URLs must be/);
});

test("the default root is the home directory", () => {
  assert.deepEqual(defaultAllowedRoots(), [homedir()]);
});
