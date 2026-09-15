import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { awaitJob, cancelAllJobs, cancelJob, getJob, resetJobs, runningJobCount, startJob } from "../src/jobs.ts";

const done = (text: string) => JSON.stringify({ content: [{ type: "text", text }], details: { status: "done" } });

afterEach(() => {
  cancelAllJobs("test cleanup");
  resetJobs();
});

test("a fast job returns its result inside the wait budget", async () => {
  const job = startJob("respond", async () => done("hello"));
  const out = JSON.parse(await awaitJob(job, 1_000));
  assert.equal(out.details.status, "done");
  assert.equal(out.content[0].text, "hello");
});

test("a slow job hands back a jobId and progress, then the result", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job = startJob("ocr", async (progress) => {
    progress.total = 4;
    progress.done = 1;
    progress.stage = "transcribing";
    await gate;
    return done("transcript");
  });
  const running = JSON.parse(await awaitJob(job, 20));
  assert.equal(running.details.status, "running");
  assert.equal(running.details.jobId, job.id);
  assert.deepEqual(running.details.progress, { done: 1, total: 4, stage: "transcribing" });
  assert.match(running.content[0].text, /action=result/);

  release();
  const finished = JSON.parse(await awaitJob(getJob(job.id), 1_000));
  assert.equal(finished.details.status, "done");
  assert.equal(finished.content[0].text, "transcript");
});

test("job failures surface as errors naming the job kind", async () => {
  const job = startJob("respond", async () => {
    throw new Error("fm serve: boom");
  });
  await assert.rejects(() => awaitJob(job, 1_000), /apple_fm respond job failed: fm serve: boom/);
});

test("cancel aborts the work signal and reports cancellation", async () => {
  let aborted = false;
  const job = startJob("ocr", async (_progress, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    aborted = signal.aborted;
    throw new Error("cancelled");
  });
  assert.equal(runningJobCount(), 1);
  assert.equal(cancelJob(job.id), true);
  await assert.rejects(() => awaitJob(job, 1_000), /was cancelled/);
  assert.equal(aborted, true);
  assert.equal(cancelJob(job.id), false, "already finished");
});

test("cancelAllJobs stops everything still running", async () => {
  const jobs = [1, 2].map(() =>
    startJob("ocr", async (_progress, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      throw new Error("cancelled");
    }),
  );
  assert.equal(runningJobCount(), 2);
  assert.equal(cancelAllJobs("gateway disconnected"), 2);
  await Promise.all(jobs.map((job) => assert.rejects(() => awaitJob(job, 1_000), /was cancelled/)));
  assert.equal(runningJobCount(), 0);
});

test("getJob rejects unknown ids", () => {
  assert.throws(() => getJob("missing"), /unknown or expired jobId missing/);
});

test("too many running jobs is refused rather than queued forever", () => {
  const started = [1, 2, 3, 4].map(() =>
    startJob("ocr", async (_progress, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      throw new Error("cancelled");
    }),
  );
  assert.equal(started.length, 4);
  assert.throws(() => startJob("ocr", async () => done("x")), /too many apple_fm jobs/);
});
