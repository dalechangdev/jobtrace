import { rm } from "node:fs/promises";
import { join } from "node:path";
import { JobTraceError, type RunEvent, toJobTraceError } from "@jobtrace/core";
import type { Database, RunJobRecord, RunRecord, RunTrigger, StoredArtifact } from "@jobtrace/db";
import { type RunOptions, runRecording } from "@jobtrace/runner";

/** A job is considered closed after it was missing from this many successful runs in a row. */
export const DEFAULT_CLOSE_AFTER_MISSED_RUNS = 3;

export interface ExecuteRunOptions {
  trigger: RunTrigger;
  /** Root of JobTrace's data; artifacts go to `<dataDir>/artifacts/<runId>`. */
  dataDir: string;
  /** Artifacts are kept for this many of the recording's newest runs. */
  artifactRetentionRuns: number;
  closeAfterMissedRuns?: number;
  scheduleId?: string;
  /** Execute this already-queued run instead of creating one. */
  runId?: string;
  /** Options passed through to the replay engine. */
  run?: Omit<RunOptions, "artifactsDir" | "onEvent">;
  /** Called for every run event, after it was stored. */
  onEvent?: (event: RunEvent) => void;
}

export interface ExecutedRun {
  run: RunRecord;
  /** The jobs this run saw, each flagged as new or changed. */
  jobs: RunJobRecord[];
  artifacts: StoredArtifact[];
}

export const artifactsDirFor = (dataDir: string, runId: string) =>
  join(dataDir, "artifacts", runId);

/** Deletes the artifact directories of the given runs. Missing directories are fine. */
export async function removeRunArtifacts(
  dataDir: string,
  runIds: readonly string[],
): Promise<void> {
  await Promise.all(
    runIds.map((runId) => rm(artifactsDirFor(dataDir, runId), { recursive: true, force: true })),
  );
}

/**
 * Replays a stored recording and persists everything about it: the run and its
 * event log, the jobs with their new/changed flags, artifacts, jobs that have
 * disappeared, and artifact retention. This is what `jobtrace run <id>` and the
 * worker both call.
 */
export async function executeRun(
  db: Database,
  recordingId: string,
  options: ExecuteRunOptions,
): Promise<ExecutedRun> {
  const stored = await db.recordings.get(recordingId);
  if (!stored) throw new JobTraceError("NOT_FOUND", `No recording ${recordingId}`);

  let runId = options.runId;
  if (runId) await db.runs.markRunning(runId);
  else {
    const created = await db.runs.create({
      recordingId,
      recordingVersionId: stored.versionId || null,
      scheduleId: options.scheduleId ?? null,
      trigger: options.trigger,
      status: "running",
      params: options.run?.params ?? {},
    });
    runId = created.id;
  }
  const id = runId;
  const record = (event: RunEvent) => {
    void db.runs.addEvent(id, event);
    options.onEvent?.(event);
  };

  try {
    const result = await runRecording(stored.recording, {
      ...options.run,
      artifactsDir: artifactsDirFor(options.dataDir, id),
      onEvent: record,
    });

    // Whatever the run managed to read was really on the site, so it is stored
    // even when the run then failed or was cancelled.
    const jobs = await db.jobs.saveRunJobs({ runId: id, recordingId, jobs: result.jobs });
    await db.artifacts.add(id, result.artifacts);
    const newJobs = jobs.filter((job) => job.isNew).length;
    const changedJobs = jobs.filter((job) => job.isChanged).length;

    const run = await db.runs.finish(id, {
      status: result.status,
      reason: result.reason,
      error: result.error,
      stats: { ...result.stats, newJobs, changedJobs, closedJobs: 0 },
    });
    // A job only counts as gone when a run that saw the whole board missed it:
    // never after a partial or failed run.
    const closedJobs =
      result.status === "succeeded"
        ? await db.jobs.closeMissing(
            recordingId,
            options.closeAfterMissedRuns ?? DEFAULT_CLOSE_AFTER_MISSED_RUNS,
          )
        : 0;
    const finished =
      closedJobs > 0 && run.stats
        ? await db.runs.finish(id, {
            status: result.status,
            reason: result.reason,
            error: result.error,
            stats: { ...run.stats, closedJobs },
            ...(run.finishedAt ? { at: new Date(run.finishedAt) } : {}),
          })
        : run;
    record({
      ts: new Date().toISOString(),
      level: "info",
      type: "jobs_saved",
      message: `${jobs.length} job(s): ${newJobs} new, ${changedJobs} changed, ${closedJobs} closed`,
      data: { jobs: jobs.length, newJobs, changedJobs, closedJobs },
    });

    const pruned = await db.artifacts.prune(recordingId, options.artifactRetentionRuns);
    await removeRunArtifacts(options.dataDir, pruned.runIds);
    return { run: finished, jobs, artifacts: await db.artifacts.forRun(id) };
  } catch (error) {
    // runRecording reports run problems in its result; getting here means a bug
    // or a storage failure. The run must not be left "running" forever.
    const failure = toJobTraceError(error);
    await db.runs
      .finish(id, {
        status: "failed",
        reason: "internal_error",
        error: failure.toJSON(),
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
      })
      .catch(() => {});
    throw error;
  }
}
