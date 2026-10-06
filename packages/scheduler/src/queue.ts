import { JobTraceError } from "@jobtrace/core";
import type { Database, RunLaunchOptions, RunOutcome, RunRecord, RunTrigger } from "@jobtrace/db";

export interface EnqueueInput {
  recordingId: string;
  trigger: RunTrigger;
  params?: Record<string, string>;
  options?: RunLaunchOptions;
  scheduleId?: string;
}

/**
 * The run queue. In v1 it is the `runs` table itself (status `queued`); the
 * interface exists so another backend (pg-boss) can replace it later.
 */
export interface JobQueue {
  enqueue(input: EnqueueInput): Promise<RunRecord>;
  /** Takes the oldest queued run whose site is not in `busyDomains`, marking it running. */
  claimNext(busyDomains?: readonly string[]): Promise<RunRecord | null>;
  complete(runId: string, outcome: RunOutcome): Promise<RunRecord>;
  fail(runId: string, reason: string, message: string): Promise<RunRecord>;
}

export function createDbQueue(
  db: Database,
  hooks: { onEnqueue?: (run: RunRecord) => void } = {},
): JobQueue {
  return {
    async enqueue(input) {
      const stored = await db.recordings.get(input.recordingId);
      if (!stored) throw new JobTraceError("NOT_FOUND", `No recording ${input.recordingId}`);
      const run = await db.runs.create({
        recordingId: stored.id,
        recordingVersionId: stored.versionId || null,
        scheduleId: input.scheduleId ?? null,
        trigger: input.trigger,
        status: "queued",
        params: input.params ?? {},
        options: input.options ?? {},
      });
      hooks.onEnqueue?.(run);
      return run;
    },
    claimNext: (busyDomains) => db.runs.claimNext(busyDomains),
    complete: (runId, outcome) => db.runs.finish(runId, outcome),
    fail: (runId, reason, message) =>
      db.runs.finish(runId, {
        status: "failed",
        reason,
        error: { code: "STEP_FAILED", message },
        stats: {
          pages: 0,
          itemsSeen: 0,
          itemErrors: 0,
          jobs: 0,
          durationMs: 0,
          newJobs: 0,
          changedJobs: 0,
          closedJobs: 0,
        },
      }),
  };
}
