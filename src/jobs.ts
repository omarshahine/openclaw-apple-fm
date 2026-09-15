/**
 * In-memory jobs so long on-device work outlives a single node invoke.
 * Gateway node tool calls time out at 30s; OCR of a multi-page document does not
 * fit, so callers get a jobId after `waitMs` and poll with action=result.
 */
import { randomUUID } from "node:crypto";

const JOB_TTL_MS = 15 * 60_000;
const MAX_JOBS = 32;

export type JobProgress = { done: number; total: number; stage: string };

type Job = {
  id: string;
  kind: string;
  startedAt: number;
  finishedAt?: number;
  progress: JobProgress;
  promise: Promise<string>;
  result?: string;
  error?: string;
};

const jobs = new Map<string, Job>();

function sweep(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

export function startJob(
  kind: string,
  work: (progress: JobProgress) => Promise<string>,
): Job {
  sweep();
  const running = [...jobs.values()].filter((job) => !job.finishedAt).length;
  if (jobs.size >= MAX_JOBS || running >= 4) {
    throw new Error("too many apple_fm jobs on this node; wait for running jobs to finish");
  }
  const progress: JobProgress = { done: 0, total: 0, stage: "queued" };
  const job: Job = { id: randomUUID(), kind, startedAt: Date.now(), progress, promise: Promise.resolve("") };
  job.promise = work(progress).then(
    (result) => {
      job.result = result;
      job.finishedAt = Date.now();
      return result;
    },
    (error: unknown) => {
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = Date.now();
      throw error;
    },
  );
  job.promise.catch(() => {}); // surfaced through awaitJob, never unhandled
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job {
  sweep();
  const job = jobs.get(id);
  if (!job) {
    throw new Error(`unknown or expired jobId ${id} (results are kept ${JOB_TTL_MS / 60_000} minutes)`);
  }
  return job;
}

/** Resolve with the job's tool result, or a running handle once `waitMs` elapses. */
export async function awaitJob(job: Job, waitMs: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitMs);
  });
  try {
    const outcome = await Promise.race([job.promise, timeout]);
    if (outcome !== "timeout") {
      return outcome;
    }
  } catch (error) {
    throw new Error(`apple_fm ${job.kind} job failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  const { done, total, stage } = job.progress;
  return JSON.stringify({
    content: [
      {
        type: "text",
        text:
          `apple_fm ${job.kind} job still running (${stage}, ${done}/${total || "?"} steps, ${elapsed}s). ` +
          `Call apple_fm again with action=result and jobId=${job.id}.`,
      },
    ],
    details: { status: "running", jobId: job.id, progress: job.progress, elapsedSeconds: elapsed },
  });
}
