import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { JobTraceError, type RunEvent, type RunResult, toJobTraceError } from "@jobtrace/core";
import type { Database, RunJobRecord, RunRecord, RunTrigger, StoredArtifact } from "@jobtrace/db";
import type { Politeness } from "@jobtrace/politeness";
import { type RunOptions, runRecording } from "@jobtrace/runner";
import { type FetchSourceOptions, fetchSource } from "@jobtrace/sources";

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
  /**
   * robots.txt knowledge and per-domain turns, shared by all runs of the
   * process. Without it, runs neither check robots.txt nor wait for each other.
   */
  politeness?: Politeness;
  /** Options passed through to the replay engine (browser recordings). */
  run?: Omit<RunOptions, "artifactsDir" | "onEvent" | "robots" | "storageState">;
  /** Options passed through to the feed reader (API sources). */
  source?: Omit<FetchSourceOptions, "onEvent" | "signal" | "now" | "robots">;
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

const note = (
  level: RunEvent["level"],
  type: string,
  message: string,
  data?: Record<string, unknown>,
): RunEvent => ({ ts: new Date().toISOString(), level, type, message, ...(data ? { data } : {}) });

/** The storage-state file of a recording's auth profile, or AUTH_EXPIRED when it is gone. */
export async function savedLogin(
  db: Database,
  authProfileId: string | null,
): Promise<string | null> {
  if (!authProfileId) return null;
  const profile = await db.authProfiles.get(authProfileId);
  if (!profile || !existsSync(profile.storageStatePath)) {
    throw new JobTraceError(
      "AUTH_EXPIRED",
      profile
        ? `The saved login of auth profile "${profile.name}" is missing. Refresh the profile and run again.`
        : "This recording uses an auth profile that no longer exists. Record it again with --auth, or create the profile.",
      { details: { authProfileId } },
    );
  }
  return profile.storageStatePath;
}

/** The result of a run that ended before anything was fetched. */
function notStarted(error: JobTraceError): RunResult {
  const at = new Date().toISOString();
  return {
    status: error.code === "RUN_CANCELLED" ? "cancelled" : "failed",
    reason: error.code.toLowerCase(),
    error: error.toJSON(),
    jobs: [],
    stats: { pages: 0, itemsSeen: 0, itemErrors: 0, jobs: 0, durationMs: 0 },
    events: [],
    artifacts: [],
    startedAt: at,
    finishedAt: at,
  };
}

/**
 * Runs a stored recording (in a browser) or API source (by reading its feed)
 * and persists everything about it: the run and its
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
  // A queued run carries its own params and launch options; explicit ones win.
  let launch = options.run ?? {};
  if (runId) {
    const queued = await db.runs.get(runId);
    if (!queued) throw new JobTraceError("NOT_FOUND", `No run ${runId}`);
    launch = {
      params: queued.params,
      ...(queued.options.headed ? { headed: true } : {}),
      ...(queued.options.trace ? { trace: true } : {}),
      ...launch,
    };
    if (queued.status !== "running") await db.runs.markRunning(runId);
  } else {
    const created = await db.runs.create({
      recordingId,
      recordingVersionId: stored.versionId || null,
      scheduleId: options.scheduleId ?? null,
      trigger: options.trigger,
      status: "running",
      params: launch.params ?? {},
    });
    runId = created.id;
  }
  const id = runId;
  const record = (event: RunEvent) => {
    void db.runs.addEvent(id, event);
    options.onEvent?.(event);
  };

  const robots = options.politeness ? { robots: options.politeness.robots } : {};
  let release: (() => void) | undefined;
  try {
    let result: RunResult;
    try {
      // One run per site at a time: wait for any other run on the same domain.
      if (options.politeness?.locks.isBusy(stored.domain)) {
        record(note("info", "waiting", `Waiting for another run on ${stored.domain} to finish`));
      }
      release = await options.politeness?.locks.acquire(stored.domain, launch.signal);

      // The two kinds of source differ only in how the jobs are obtained.
      if (stored.kind === "api") {
        result = await fetchSource(stored.source, {
          ...options.source,
          ...robots,
          onEvent: record,
          ...(launch.signal ? { signal: launch.signal } : {}),
          ...(launch.now ? { now: launch.now } : {}),
        });
      } else {
        const storageState = await savedLogin(db, stored.recording.authProfileId);
        result = await runRecording(stored.recording, {
          ...launch,
          ...robots,
          ...(storageState ? { storageState } : {}),
          artifactsDir: artifactsDirFor(options.dataDir, id),
          onEvent: record,
        });
      }
    } catch (error) {
      // A problem before the run could start (no saved login, cancelled while
      // waiting) is an ordinary failed run, not a crash.
      if (
        !(error instanceof JobTraceError) ||
        !["AUTH_EXPIRED", "RUN_CANCELLED"].includes(error.code)
      )
        throw error;
      result = notStarted(error);
      record(note("error", "run_error", error.message, { error: error.toJSON() }));
    } finally {
      release?.();
    }
    const authProfileId = stored.kind === "browser" ? stored.recording.authProfileId : null;
    if (authProfileId && result.events.some((event) => event.type === "auth_verified")) {
      await db.authProfiles.markVerified(authProfileId);
    }

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
