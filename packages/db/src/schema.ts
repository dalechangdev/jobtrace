import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Database schema (PLAN.md section 11). Timestamps are ISO 8601 strings, which
 * sort correctly as text. After changing this file, generate a migration with
 * `pnpm --filter @jobtrace/db generate`; never edit an applied migration.
 */

export const authProfiles = sqliteTable("auth_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  domain: text("domain").notNull(),
  storageStatePath: text("storage_state_path").notNull(),
  createdAt: text("created_at").notNull(),
  lastVerifiedAt: text("last_verified_at"),
});

export const recordings = sqliteTable("recordings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  startUrl: text("start_url").notNull(),
  domain: text("domain").notNull(),
  definitionJson: text("definition_json").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  authProfileId: text("auth_profile_id").references(() => authProfiles.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** A snapshot of the definition on every save, for undo and diffs. */
export const recordingVersions = sqliteTable(
  "recording_versions",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    definitionJson: text("definition_json").notNull(),
    createdAt: text("created_at").notNull(),
    note: text("note"),
  },
  (table) => [index("recording_versions_recording_idx").on(table.recordingId, table.createdAt)],
);

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  recordingId: text("recording_id")
    .notNull()
    .references(() => recordings.id, { onDelete: "cascade" }),
  cron: text("cron").notNull(),
  timezone: text("timezone"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  paramsJson: text("params_json").notNull().default("{}"),
  lastRunAt: text("last_run_at"),
  nextRunAt: text("next_run_at"),
  createdAt: text("created_at").notNull(),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    recordingVersionId: text("recording_version_id").references(() => recordingVersions.id, {
      onDelete: "set null",
    }),
    scheduleId: text("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
    /** manual | schedule | cli */
    trigger: text("trigger").notNull(),
    /** queued | running | succeeded | partial | failed | blocked | cancelled */
    status: text("status").notNull(),
    reason: text("reason"),
    paramsJson: text("params_json").notNull().default("{}"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    statsJson: text("stats_json"),
    errorJson: text("error_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("runs_recording_created_idx").on(table.recordingId, table.createdAt),
    index("runs_status_idx").on(table.status),
  ],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    ts: text("ts").notNull(),
    level: text("level").notNull(),
    stepId: text("step_id"),
    type: text("type").notNull(),
    message: text("message").notNull(),
    dataJson: text("data_json"),
  },
  (table) => [index("run_events_run_ts_idx").on(table.runId, table.ts)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    dedupKey: text("dedup_key").notNull(),
    title: text("title").notNull(),
    company: text("company"),
    location: text("location"),
    remote: text("remote").notNull(),
    salaryText: text("salary_text"),
    salaryMin: real("salary_min"),
    salaryMax: real("salary_max"),
    salaryCurrency: text("salary_currency"),
    salaryPeriod: text("salary_period"),
    url: text("url"),
    description: text("description"),
    descriptionHtml: text("description_html"),
    postedAt: text("posted_at"),
    employmentType: text("employment_type"),
    customJson: text("custom_json").notNull().default("{}"),
    contentHash: text("content_hash").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    firstSeenRunId: text("first_seen_run_id").references(() => runs.id, { onDelete: "set null" }),
    /** Set when the job was missing from several successful runs in a row. */
    closedAt: text("closed_at"),
  },
  (table) => [
    uniqueIndex("jobs_recording_dedup_idx").on(table.recordingId, table.dedupKey),
    index("jobs_last_seen_idx").on(table.lastSeenAt),
    index("jobs_first_seen_idx").on(table.firstSeenAt),
  ],
);

/** Which jobs a run saw, and whether each was new or changed in that run. */
export const runJobs = sqliteTable(
  "run_jobs",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    isNew: integer("is_new", { mode: "boolean" }).notNull(),
    isChanged: integer("is_changed", { mode: "boolean" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.jobId] }),
    index("run_jobs_job_idx").on(table.jobId),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** screenshot | dom | trace */
    type: text("type").notNull(),
    path: text("path").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("artifacts_run_idx").on(table.runId)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});
