/**
 * In-memory jobs so long on-device work outlives a single node invoke.
 * Gateway node tool calls time out at 30s; OCR of a multi-page document does not
 * fit, so callers get a jobId after `waitMs` and poll with action=result.
 */
import { randomUUID } from "node:crypto";

const JOB_TTL_MS = 15 * 60_000;
const MAX_JOBS = 32;
const MAX_RUNNING = 4;

export type JobProgress = { done: number; total: number; stage: string };

export type JobLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type Job = {
  id: string;
  kind: string;
  startedAt: number;
  finishedAt?: number;
  progress: JobProgress;
  promise: Promise<string>;
  controller: AbortController;
  result?: string;
  error?: string;
  cancelled?: boolean;
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
  work: (progress: JobProgress, signal: AbortSignal) => Promise<string>,
  logger?: JobLogger,
): Job {
  sweep();
  const running = [...jobs.values()].filter((job) => !job.finishedAt).length;
  if (jobs.size >= MAX_JOBS || running >= MAX_RUNNING) {
    throw new Error("too many apple_fm jobs on this node; wait for running jobs to finish");
  }
  const progress: JobProgress = { done: 0, total: 0, stage: "queued" };
  const job: Job = {
    id: randomUUID(),
    kind,
    startedAt: Date.now(),
    progress,
    controller: new AbortController(),
    promise: Promise.resolve(""),
  };
  job.promise = work(progress, job.controller.signal).then(
    (result) => {
      job.result = result;
      job.finishedAt = Date.now();
      logger?.info?.(`apple_fm ${kind} job ${job.id} done in ${job.finishedAt - job.startedAt}ms`);
      return result;
    },
    (error: unknown) => {
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = Date.now();
      logger?.warn?.(`apple_fm ${kind} job ${job.id} failed: ${job.error}`);
      throw error;
    },
  );
  job.promise.catch(() => {}); // surfaced through awaitJob, never unhandled
  jobs.set(job.id, job);
  logger?.info?.(`apple_fm ${kind} job ${job.id} started`);
  return job;
}

export function getJob(id: string): Job {
  sweep();
  const job = jobs.get(id);
  if (!job) {
    throw new Error(
      `unknown or expired jobId ${id} (results are kept ${JOB_TTL_MS / 60_000} minutes)`,
    );
  }
  return job;
}

/** Abort a running job; returns false when it had already finished. */
export function cancelJob(id: string): boolean {
  const job = getJob(id);
  if (job.finishedAt) {
    return false;
  }
  job.cancelled = true;
  job.controller.abort(new Error("cancelled"));
  return true;
}

/** Abort everything still running, e.g. when the Gateway connection drops. */
export function cancelAllJobs(reason: string): number {
  let cancelled = 0;
  for (const job of jobs.values()) {
    if (!job.finishedAt) {
      job.cancelled = true;
      job.controller.abort(new Error(reason));
      cancelled += 1;
    }
  }
  return cancelled;
}

export function runningJobCount(): number {
  return [...jobs.values()].filter((job) => !job.finishedAt).length;
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
    if (job.cancelled) {
      throw new Error(`apple_fm ${job.kind} job ${job.id} was cancelled`, { cause: error });
    }
    // SAFETY: startJob normalizes every rejection reason into an Error.
    throw new Error(`apple_fm ${job.kind} job failed: ${(error as Error).message}`, {
      cause: error,
    });
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
