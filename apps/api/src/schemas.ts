import { jobSchema, REMOTE_VALUES, RUN_STATUSES } from "@jobtrace/core";
import { z } from "zod";
import { runtimeSettingsSchema } from "./runtime.ts";

/**
 * Request and response shapes of the HTTP API. They validate input, shape
 * output, and generate the OpenAPI document served at /api/docs.
 */

export const errorSchema = z.object({
  error: z.object({
    /** A stable code such as NOT_FOUND or INVALID_ARGUMENT. */
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

/**
 * A recording (PLAN.md section 5) or an API source definition. Validated in
 * full by the handlers; described loosely here because the step tree is recursive.
 */
export const definitionSchema = z.record(z.string(), z.unknown());

export const idParams = z.object({ id: z.string().min(1) });

const kind = z.enum(["browser", "api"]);
const runStatus = z.enum(RUN_STATUSES);

const statsSchema = z.object({
  pages: z.number(),
  itemsSeen: z.number(),
  itemErrors: z.number(),
  jobs: z.number(),
  durationMs: z.number(),
  newJobs: z.number(),
  changedJobs: z.number(),
  closedJobs: z.number(),
});

export const runSchema = z.object({
  id: z.string(),
  recordingId: z.string(),
  recordingVersionId: z.string().nullable(),
  scheduleId: z.string().nullable(),
  trigger: z.enum(["manual", "schedule", "cli"]),
  status: runStatus,
  reason: z.string().nullable(),
  params: z.record(z.string(), z.string()),
  options: z.object({ headed: z.boolean().optional(), trace: z.boolean().optional() }),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  stats: statsSchema.nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      stepId: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable(),
  createdAt: z.string(),
});

export const recordingSummarySchema = z.object({
  id: z.string(),
  kind,
  name: z.string(),
  startUrl: z.string(),
  domain: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const recordingListItemSchema = recordingSummarySchema.extend({
  openJobs: z.number(),
  lastRun: runSchema.nullable(),
});

export const recordingDetailSchema = recordingSummarySchema.extend({
  versionId: z.string(),
  openJobs: z.number(),
  definition: definitionSchema,
});

export const versionSchema = z.object({
  id: z.string(),
  recordingId: z.string(),
  createdAt: z.string(),
  note: z.string().nullable(),
});

export const jobRecordSchema = z.object({
  ...jobSchema.shape,
  id: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  firstSeenRunId: z.string().nullable(),
  closedAt: z.string().nullable(),
});

export const runJobSchema = jobRecordSchema.extend({ isNew: z.boolean(), isChanged: z.boolean() });

export const artifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  type: z.enum(["screenshot", "dom", "trace"]),
  path: z.string(),
  createdAt: z.string(),
});

export const runDetailSchema = z.object({
  run: runSchema,
  jobs: z.array(runJobSchema),
  artifacts: z.array(artifactSchema),
});

export const eventSchema = z.object({
  ts: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  type: z.string(),
  message: z.string(),
  stepId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const authProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  createdAt: z.string(),
  lastVerifiedAt: z.string().nullable(),
  usedBy: z.number(),
});

/** A browser window opened on the host: recording a board, or capturing a login. */
export const sessionSchema = z.object({
  id: z.string(),
  kind: z.enum(["recording", "auth"]),
  /** active while the window is open; finished or failed afterwards; cancelled when nothing was saved. */
  status: z.enum(["active", "finished", "cancelled", "failed"]),
  url: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Live progress of a recording session. */
  progress: z
    .object({ mode: z.string(), steps: z.number(), fields: z.array(z.string()), scope: z.string() })
    .nullable(),
  /** Id of the recording or auth profile that was saved. */
  resultId: z.string().nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
});

const flag = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1")
  .optional();

export const jobsQuerySchema = z.object({
  recording: z.string().optional(),
  /** Only jobs that were new in the latest run of their recording. */
  new: flag,
  q: z.string().optional(),
  /** First seen at or after / before these ISO timestamps. */
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  /** Include jobs that have disappeared from the site. */
  closed: flag,
  remote: z.enum(REMOTE_VALUES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number(), page: z.number(), pageSize: z.number() });

export const testStepResultSchema = z.object({
  ok: z.boolean(),
  reached: z.boolean(),
  error: runSchema.shape.error.unwrap().optional(),
  fields: z.record(z.string(), z.string().nullable()).optional(),
  events: z.array(eventSchema),
  durationMs: z.number(),
});

export const settingsViewSchema = runtimeSettingsSchema.extend({
  /** Whether ANTHROPIC_API_KEY is set in the server's environment. Never the key itself. */
  aiFallbackKeyConfigured: z.boolean(),
  dataDir: z.string(),
  /** False when the server is reachable from other machines (windows cannot be opened then). */
  local: z.boolean(),
});
