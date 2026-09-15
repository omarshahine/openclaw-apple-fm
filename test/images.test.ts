import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { defaultAllowedRoots, resolveInputPath } from "../src/images.ts";

const root = mkdtempSync(join(tmpdir(), "apple-fm-test-"));
const allowed = [root];
const pdf = join(root, "doc.pdf");
writeFileSync(pdf, "%PDF-1.4 test");

after(() => rmSync(root, { recursive: true, force: true }));

test("accepts a supported file inside an allowed root", () => {
  assert.match(resolveInputPath(pdf, allowed), /doc\.pdf$/);
});

test("requires an absolute path", () => {
  assert.throws(() => resolveInputPath("relative/doc.pdf", allowed), /must be absolute/);
});

test("rejects unsupported extensions before touching the file", () => {
  const script = join(root, "payload.sh");
  writeFileSync(script, "#!/bin/sh\n");
  assert.throws(() => resolveInputPath(script, allowed), /unsupported file type \.sh/);
});

test("rejects paths outside the allowed roots", () => {
  const outside = mkdtempSync(join(tmpdir(), "apple-fm-outside-"));
  const other = join(outside, "other.pdf");
  writeFileSync(other, "%PDF-1.4");
  try {
    assert.throws(() => resolveInputPath(other, allowed), /outside the allowed roots/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlink cannot escape an allowed root", () => {
  const outside = mkdtempSync(join(tmpdir(), "apple-fm-secret-"));
  const secret = join(outside, "secret.pdf");
  writeFileSync(secret, "%PDF-1.4 secret");
  const link = join(root, "link.pdf");
  symlinkSync(secret, link);
  try {
    assert.throws(() => resolveInputPath(link, allowed), /outside the allowed roots/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(link, { force: true });
  }
});

test("rejects directories and missing files", () => {
  const dir = join(root, "folder.pdf");
  mkdirSync(dir);
  assert.throws(() => resolveInputPath(dir, allowed), /cannot read .*not a file/);
  assert.throws(() => resolveInputPath(join(root, "nope.pdf"), allowed), /cannot read/);
});

test("expands ~ against the node's home directory", () => {
  assert.throws(() => resolveInputPath("~/definitely-missing-file.pdf", allowed), /cannot read/);
});

test("the default root is the home directory", () => {
  assert.deepEqual(defaultAllowedRoots(), [homedir()]);
});
