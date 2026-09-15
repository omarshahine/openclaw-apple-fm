import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertInputSize,
  normalizeJsonSchema,
  parseParams,
  parsePages,
  resolveWaitMs,
  errorMessage,
  MAX_WAIT_MS,
  DEFAULT_WAIT_MS,
} from "../src/params.ts";

test("parseParams rejects non-objects and unknown actions", () => {
  assert.throws(() => parseParams("[]"), /must be a JSON object/);
  assert.throws(() => parseParams('{"action":"nope"}'), /action must be one of/);
  assert.throws(() => parseParams("{}"), /action must be one of/);
});

test("parseParams requires jobId for result and cancel", () => {
  assert.throws(() => parseParams('{"action":"result"}'), /jobId is required for action=result/);
  assert.throws(() => parseParams('{"action":"cancel"}'), /jobId is required for action=cancel/);
  assert.equal(parseParams('{"action":"result","jobId":"abc"}').jobId, "abc");
});

test("parseParams rejects a non-array images value", () => {
  assert.throws(() => parseParams('{"action":"respond","images":"/tmp/a.png"}'), /images must be an array/);
});

test("resolveWaitMs clamps to the gateway tool timeout budget", () => {
  assert.equal(resolveWaitMs(undefined), DEFAULT_WAIT_MS);
  assert.equal(resolveWaitMs(999_999), MAX_WAIT_MS);
  assert.equal(resolveWaitMs(-5), 0);
  assert.equal(resolveWaitMs(1234), 1234);
});

test("parsePages accepts single pages and ranges", () => {
  assert.deepEqual(parsePages(undefined), {});
  assert.deepEqual(parsePages("  "), {});
  assert.deepEqual(parsePages("3"), { firstPage: 3, lastPage: 3 });
  assert.deepEqual(parsePages(" 2 - 5 "), { firstPage: 2, lastPage: 5 });
});

test("parsePages rejects malformed and inverted ranges", () => {
  assert.throws(() => parsePages("one"), /pages must look like/);
  assert.throws(() => parsePages("5-2"), /invalid page range/);
  assert.throws(() => parsePages("0"), /invalid page range/);
});

test("normalizeJsonSchema accepts the shapes agents actually send", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  assert.deepEqual(normalizeJsonSchema(schema), schema);
  assert.deepEqual(normalizeJsonSchema(JSON.stringify(schema)), schema);
  assert.deepEqual(normalizeJsonSchema({ name: "result", schema }), schema);
  assert.deepEqual(normalizeJsonSchema({ json_schema: { name: "r", schema } }), schema);
});

test("normalizeJsonSchema adds a root type when only properties are given", () => {
  const normalized = normalizeJsonSchema({ properties: { a: { type: "string" } }, required: ["a"] });
  assert.equal(normalized.type, "object");
  assert.deepEqual(normalized.required, ["a"]);
});

test("normalizeJsonSchema rejects schemas fm serve would refuse", () => {
  assert.throws(() => normalizeJsonSchema("{not json"), /unparseable string/);
  assert.throws(() => normalizeJsonSchema(42), /must be a JSON Schema object/);
  assert.throws(() => normalizeJsonSchema({ description: "no root keyword" }), /needs a root 'type'/);
});

test("normalizeJsonSchema keeps non-object roots that fm accepts", () => {
  assert.deepEqual(normalizeJsonSchema({ anyOf: [{ type: "string" }] }), { anyOf: [{ type: "string" }] });
  assert.deepEqual(normalizeJsonSchema({ $ref: "#/x" }), { $ref: "#/x" });
});

test("assertInputSize enforces the context budget", () => {
  assert.doesNotThrow(() => assertInputSize(19_999));
  assert.throws(() => assertInputSize(20_001), /8192-token window/);
});

test("errorMessage unwraps fm serve error bodies", () => {
  assert.equal(errorMessage({ error: { message: "bad schema" } }, 400), "bad schema");
  assert.equal(errorMessage({ error: "plain" }, 400), '"plain"');
  assert.match(errorMessage("boom", 500), /HTTP 500: boom/);
});
