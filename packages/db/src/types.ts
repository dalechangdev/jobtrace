import type {
  ApiSource,
  Definition,
  DefinitionKind,
  NormalizedJob,
  Recording,
  RunArtifact,
  RunEvent,
  RunFailure,
  RunStats,
  RunStatus,
} from "@jobtrace/core";

export interface RecordingSummary {
  id: string;
  kind: DefinitionKind;
  name: string;
  startUrl: string;
  domain: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A stored job source: a browser recording, or an API source. Both live in the
 * `recordings` table and own runs and jobs in the same way.
 */
export type StoredRecording = RecordingSummary & {
  /** The latest saved version, which a run records as the one it replayed. */
  versionId: string;
} & ({ kind: "browser"; recording: Recording } | { kind: "api"; source: ApiSource });

/** The definition held by a stored recording, whichever kind it is. */
export function definitionOf(stored: StoredRecording): Definition {
  return stored.kind === "api" ? stored.source : stored.recording;
}

export interface RecordingVersion {
  id: string;
  recordingId: string;
  createdAt: string;
  note: string | null;
}

/** A saved browser login. The session itself is in the file; this row only points to it. */
export interface AuthProfile {
  id: string;
  name: string;
  domain: string;
  storageStatePath: string;
  createdAt: string;
  lastVerifiedAt: string | null;
}

/** When a recording or source runs by itself. */
export interface Schedule {
  id: string;
  recordingId: string;
  /** A cron expression, e.g. `0 8 * * 1-5`. */
  cron: string;
  /** IANA time zone the expression is read in; null means the server's own. */
  timezone: string | null;
  enabled: boolean;
  params: Record<string, string>;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export type RunTrigger = "manual" | "schedule" | "cli";

/** Run stats as stored: the runner's, plus what persistence learned about the jobs. */
export interface StoredRunStats extends RunStats {
  newJobs: number;
  changedJobs: number;
  closedJobs: number;
}

export interface RunRecord {
  id: string;
  recordingId: string;
  recordingVersionId: string | null;
  scheduleId: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  reason: string | null;
  params: Record<string, string>;
  options: RunLaunchOptions;
  startedAt: string | null;
  finishedAt: string | null;
  stats: StoredRunStats | null;
  error: RunFailure | null;
  createdAt: string;
}

/** How a queued run asked to be executed. */
export interface RunLaunchOptions {
  headed?: boolean;
  trace?: boolean;
}

export interface NewRun {
  options?: RunLaunchOptions;
  recordingId: string;
  recordingVersionId?: string | null;
  scheduleId?: string | null;
  trigger: RunTrigger;
  status: "queued" | "running";
  params?: Record<string, string>;
  /** Defaults to now. */
  at?: Date;
}

export interface RunOutcome {
  status: Exclude<RunStatus, "queued" | "running">;
  reason?: string | undefined;
  stats: StoredRunStats;
  error?: RunFailure | undefined;
  at?: Date;
}

export interface JobRecord extends NormalizedJob {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
  firstSeenRunId: string | null;
  closedAt: string | null;
}

/** A job as seen by one run. */
export interface RunJobRecord extends JobRecord {
  isNew: boolean;
  isChanged: boolean;
}

export interface JobFilter {
  recordingId?: string;
  /** Only jobs that were new in the latest finished run of their recording. */
  newInLatestRun?: boolean;
  /** Only jobs first seen at or after this ISO timestamp. */
  since?: string;
  /** Only jobs first seen before this ISO timestamp. */
  until?: string;
  /** Full-text search over title, company, location and description. */
  search?: string;
  /** Only jobs with this work arrangement. */
  remote?: NormalizedJob["remote"];
  /** Closed jobs are left out unless this is set. */
  includeClosed?: boolean;
  limit?: number;
  offset?: number;
}

export interface StoredArtifact extends RunArtifact {
  id: string;
  runId: string;
  createdAt: string;
}

/**
 * The storage interface the rest of the app talks to. Methods are async so a
 * Postgres implementation can be added later without touching callers; each
 * method is atomic.
 */
export interface Database {
  recordings: {
    /** Inserts or updates the recording or API source and stores a version snapshot. */
    save(definition: Definition, note?: string): Promise<{ versionId: string; created: boolean }>;
    get(id: string): Promise<StoredRecording | null>;
    /** Finds a recording by id, unique id prefix, or exact name. Throws NOT_FOUND. */
    resolve(ref: string): Promise<StoredRecording>;
    list(): Promise<RecordingSummary[]>;
    versions(id: string): Promise<RecordingVersion[]>;
    /** The definition as it was saved in one version, or null when there is no such version. */
    version(recordingId: string, versionId: string): Promise<Definition | null>;
    /** Deletes the recording with its runs, jobs and artifact rows. Returns the affected run ids. */
    delete(id: string): Promise<{ runIds: string[] }>;
  };
  runs: {
    create(run: NewRun): Promise<RunRecord>;
    markRunning(id: string, at?: Date): Promise<void>;
    finish(id: string, outcome: RunOutcome): Promise<RunRecord>;
    addEvent(runId: string, event: RunEvent): Promise<void>;
    events(runId: string): Promise<RunEvent[]>;
    get(id: string): Promise<RunRecord | null>;
    /** Finds a run by id or unique id prefix. Throws NOT_FOUND. */
    resolve(ref: string): Promise<RunRecord>;
    list(filter?: {
      recordingId?: string;
      status?: RunStatus;
      limit?: number;
    }): Promise<RunRecord[]>;
    /**
     * Atomically takes the oldest queued run and marks it running. Runs whose
     * site is in `busyDomains` are passed over, so one site's queue does not
     * hold up the others. Returns null when there is nothing to take.
     */
    claimNext(busyDomains?: readonly string[]): Promise<RunRecord | null>;
    /** True when the recording has a run that is queued or running. */
    hasActive(recordingId: string): Promise<boolean>;
    /** Cancels a run that is still queued. Returns false when it is not queued (any more). */
    cancelQueued(id: string): Promise<boolean>;
    /** After a restart: marks runs left "running" as failed with reason `interrupted`. */
    failInterrupted(): Promise<number>;
  };
  jobs: {
    /**
     * Stores what a run extracted: inserts unseen jobs, updates known ones, and
     * records per job whether it was new or changed in this run.
     */
    saveRunJobs(input: {
      runId: string;
      recordingId: string;
      jobs: readonly NormalizedJob[];
      at?: Date;
    }): Promise<RunJobRecord[]>;
    /**
     * Marks open jobs as closed when none of the recording's last `missedRuns`
     * successful runs saw them. Returns how many were closed.
     */
    closeMissing(recordingId: string, missedRuns: number, at?: Date): Promise<number>;
    forRun(runId: string): Promise<RunJobRecord[]>;
    list(filter?: JobFilter): Promise<JobRecord[]>;
    count(filter?: JobFilter): Promise<number>;
    get(id: string): Promise<JobRecord | null>;
  };
  schedules: {
    create(
      input: Pick<Schedule, "recordingId" | "cron" | "timezone"> &
        Partial<Pick<Schedule, "enabled" | "params">>,
    ): Promise<Schedule>;
    get(id: string): Promise<Schedule | null>;
    list(filter?: { recordingId?: string; enabled?: boolean }): Promise<Schedule[]>;
    update(
      id: string,
      patch: Partial<
        Pick<Schedule, "cron" | "timezone" | "enabled" | "params" | "lastRunAt" | "nextRunAt">
      >,
    ): Promise<Schedule | null>;
    delete(id: string): Promise<boolean>;
  };
  authProfiles: {
    /** Inserts the profile, or updates the one with the same id. Names are unique. */
    save(profile: Omit<AuthProfile, "createdAt" | "lastVerifiedAt">): Promise<AuthProfile>;
    get(id: string): Promise<AuthProfile | null>;
    /** Finds a profile by id or exact name. Throws NOT_FOUND. */
    resolve(ref: string): Promise<AuthProfile>;
    list(): Promise<Array<AuthProfile & { usedBy: number }>>;
    /** Records that a run just found the saved login to be working. */
    markVerified(id: string, at?: Date): Promise<void>;
    delete(id: string): Promise<void>;
  };
  /** Small key-value store for settings changed at runtime (through the UI). */
  settings: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
  };
  artifacts: {
    add(runId: string, artifacts: readonly RunArtifact[], at?: Date): Promise<void>;
    forRun(runId: string): Promise<StoredArtifact[]>;
    /**
     * Forgets the artifacts of all but the recording's newest `keepRuns` runs.
     * Returns the runs whose artifacts were dropped, so their files can be deleted.
     */
    prune(recordingId: string, keepRuns: number): Promise<{ runIds: string[] }>;
  };
  close(): void;
}
