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
  startedAt: string | null;
  finishedAt: string | null;
  stats: StoredRunStats | null;
  error: RunFailure | null;
  createdAt: string;
}

export interface NewRun {
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
  /** Full-text search over title, company, location and description. */
  search?: string;
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
    list(filter?: { recordingId?: string; limit?: number }): Promise<RunRecord[]>;
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
