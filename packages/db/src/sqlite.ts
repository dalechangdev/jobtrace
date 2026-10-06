import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiSourceFeedUrl,
  type Definition,
  isApiSource,
  JobTraceError,
  type NormalizedJob,
  newId,
  parseApiSource,
  parseRecording,
  type RunEvent,
  type RunStatus,
} from "@jobtrace/core";
import BetterSqlite3 from "better-sqlite3";
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";
import type {
  AuthProfile,
  Database,
  JobFilter,
  JobRecord,
  RecordingSummary,
  RunJobRecord,
  RunRecord,
  RunTrigger,
  StoredRecording,
} from "./types.ts";

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const { authProfiles, recordings, recordingVersions, runs, runEvents, jobs, runJobs, artifacts } =
  schema;

type RunRow = typeof runs.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

const iso = (date: Date = new Date()) => date.toISOString();
const parseJson = <T>(text: string | null): T | null =>
  text === null ? null : (JSON.parse(text) as T);

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    recordingId: row.recordingId,
    recordingVersionId: row.recordingVersionId,
    scheduleId: row.scheduleId,
    trigger: row.trigger as RunTrigger,
    status: row.status as RunStatus,
    reason: row.reason,
    params: parseJson(row.paramsJson) ?? {},
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    stats: parseJson(row.statsJson),
    error: parseJson(row.errorJson),
    createdAt: row.createdAt,
  };
}

function toJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    recordingId: row.recordingId,
    dedupKey: row.dedupKey,
    contentHash: row.contentHash,
    title: row.title,
    company: row.company,
    location: row.location,
    remote: row.remote as NormalizedJob["remote"],
    salaryText: row.salaryText,
    salaryMin: row.salaryMin,
    salaryMax: row.salaryMax,
    salaryCurrency: row.salaryCurrency,
    salaryPeriod: row.salaryPeriod as NormalizedJob["salaryPeriod"],
    url: row.url,
    description: row.description,
    descriptionHtml: row.descriptionHtml,
    postedAt: row.postedAt,
    employmentType: row.employmentType,
    custom: parseJson(row.customJson) ?? {},
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    firstSeenRunId: row.firstSeenRunId,
    closedAt: row.closedAt,
  };
}

/** The columns a job's content lives in (everything the runner extracted). */
function jobContent(job: NormalizedJob) {
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    remote: job.remote,
    salaryText: job.salaryText,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    salaryPeriod: job.salaryPeriod,
    url: job.url,
    description: job.description,
    descriptionHtml: job.descriptionHtml,
    postedAt: job.postedAt,
    employmentType: job.employmentType,
    customJson: JSON.stringify(job.custom),
    contentHash: job.contentHash,
  };
}

type Reader = Pick<ReturnType<typeof drizzle<typeof schema>>, "select">;

/** The auth profile a definition names, if that profile exists in this database. */
function linkedProfile(db: Reader, definition: Definition): string | null {
  if (isApiSource(definition) || !definition.authProfileId) return null;
  const found = db
    .select({ id: authProfiles.id })
    .from(authProfiles)
    .where(eq(authProfiles.id, definition.authProfileId))
    .get();
  return found ? found.id : null;
}

/** Turns free text into an FTS5 query: every word must match, as a prefix. */
function ftsQuery(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `"${word.replaceAll('"', '""')}"*`)
    .join(" ");
}

/** Escapes LIKE wildcards so an id prefix is matched literally. */
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Opens (and migrates) a SQLite database. `url` is a path, `file:<path>`, or
 * `:memory:`. All repository methods run synchronously inside, so each is atomic.
 */
export function openDatabase(url: string): Database {
  const path = url.startsWith("file:") ? url.slice("file:".length) : url;
  const inMemory = path === ":memory:";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const sqlite = new BetterSqlite3(path);
  if (!inMemory) sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });

  function loadRecording(id: string): StoredRecording | null {
    const row = db.select().from(recordings).where(eq(recordings.id, id)).get();
    if (!row) return null;
    const version = db
      .select({ id: recordingVersions.id })
      .from(recordingVersions)
      .where(eq(recordingVersions.recordingId, id))
      .orderBy(desc(sql`rowid`))
      .limit(1)
      .get();
    const summary = {
      id: row.id,
      name: row.name,
      startUrl: row.startUrl,
      domain: row.domain,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      versionId: version?.id ?? "",
    };
    const document: unknown = JSON.parse(row.definitionJson);
    if (row.kind === "api") return { ...summary, kind: "api", source: parseApiSource(document) };
    // Parsing also migrates definitions saved by an older version of the format.
    return { ...summary, kind: "browser", recording: parseRecording(document) };
  }

  /** Resolves an id, a unique id prefix, or (optionally) an exact name to one id. */
  function resolveId(
    kind: string,
    ref: string,
    byId: () => string | undefined,
    byPrefix: () => string[],
    byName?: () => string[],
  ): string {
    const exact = byId();
    if (exact) return exact;
    const named = byName?.() ?? [];
    const matches = named.length > 0 ? named : ref.length >= 4 ? byPrefix() : [];
    if (matches.length === 1) return matches[0] as string;
    if (matches.length > 1) {
      throw new JobTraceError(
        "NOT_FOUND",
        `"${ref}" matches ${matches.length} ${kind}s; be more specific`,
        {
          details: { matches },
        },
      );
    }
    throw new JobTraceError("NOT_FOUND", `No ${kind} matches "${ref}"`);
  }

  function jobConditions(filter: JobFilter): SQL | undefined {
    const conditions: SQL[] = [];
    if (filter.recordingId) conditions.push(eq(jobs.recordingId, filter.recordingId));
    if (!filter.includeClosed) conditions.push(isNull(jobs.closedAt));
    if (filter.since) conditions.push(sql`${jobs.firstSeenAt} >= ${filter.since}`);
    if (filter.search?.trim()) {
      conditions.push(
        sql`${jobs.id} IN (SELECT job_id FROM jobs_fts WHERE jobs_fts MATCH ${ftsQuery(filter.search)})`,
      );
    }
    if (filter.newInLatestRun) {
      conditions.push(sql`${jobs.id} IN (
        SELECT rj.job_id FROM run_jobs rj JOIN runs r ON r.id = rj.run_id
        WHERE rj.is_new = 1 AND r.rowid = (
          SELECT max(latest.rowid) FROM runs latest
          WHERE latest.recording_id = r.recording_id AND latest.finished_at IS NOT NULL
        )
      )`);
    }
    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  const getRun = (id: string) => {
    const row = db.select().from(runs).where(eq(runs.id, id)).get();
    return row ? toRun(row) : null;
  };

  return {
    recordings: {
      async save(definition, note) {
        // For an API source the "start URL" is the feed it reads.
        const startUrl = isApiSource(definition)
          ? apiSourceFeedUrl(definition)
          : definition.startUrl;
        return db.transaction((tx) => {
          const now = iso();
          const definitionJson = JSON.stringify(definition);
          const fields = {
            kind: isApiSource(definition) ? "api" : "browser",
            name: definition.name,
            startUrl,
            domain: domainOf(startUrl),
            definitionJson,
            schemaVersion: definition.schemaVersion,
            updatedAt: now,
            // Only link a profile that exists here; an imported recording may name one that does not.
            authProfileId: linkedProfile(tx, definition),
          };
          const existing = tx
            .select({ id: recordings.id })
            .from(recordings)
            .where(eq(recordings.id, definition.id))
            .get();
          if (existing)
            tx.update(recordings).set(fields).where(eq(recordings.id, definition.id)).run();
          else
            tx.insert(recordings)
              .values({ id: definition.id, createdAt: now, ...fields })
              .run();
          const versionId = newId("recordingVersion");
          tx.insert(recordingVersions)
            .values({
              id: versionId,
              recordingId: definition.id,
              definitionJson,
              createdAt: now,
              note: note ?? null,
            })
            .run();
          return { versionId, created: !existing };
        });
      },
      async get(id) {
        return loadRecording(id);
      },
      async resolve(ref) {
        const id = resolveId(
          "recording",
          ref,
          () =>
            db.select({ id: recordings.id }).from(recordings).where(eq(recordings.id, ref)).get()
              ?.id,
          () =>
            db
              .select({ id: recordings.id })
              .from(recordings)
              .where(sql`${recordings.id} LIKE ${likePrefix(ref)} ESCAPE '\\'`)
              .all()
              .map((row) => row.id),
          () =>
            db
              .select({ id: recordings.id })
              .from(recordings)
              .where(sql`lower(${recordings.name}) = lower(${ref})`)
              .all()
              .map((row) => row.id),
        );
        return loadRecording(id) as StoredRecording;
      },
      async list() {
        return db
          .select({
            id: recordings.id,
            kind: recordings.kind,
            name: recordings.name,
            startUrl: recordings.startUrl,
            domain: recordings.domain,
            createdAt: recordings.createdAt,
            updatedAt: recordings.updatedAt,
          })
          .from(recordings)
          .orderBy(asc(recordings.name), asc(recordings.id))
          .all()
          .map(
            (row): RecordingSummary => ({ ...row, kind: row.kind === "api" ? "api" : "browser" }),
          );
      },
      async versions(id) {
        return db
          .select({
            id: recordingVersions.id,
            recordingId: recordingVersions.recordingId,
            createdAt: recordingVersions.createdAt,
            note: recordingVersions.note,
          })
          .from(recordingVersions)
          .where(eq(recordingVersions.recordingId, id))
          .orderBy(desc(sql`rowid`))
          .all();
      },
      async delete(id) {
        return db.transaction((tx) => {
          const runIds = tx
            .select({ id: runs.id })
            .from(runs)
            .where(eq(runs.recordingId, id))
            .all();
          // Runs, events, jobs, run_jobs, artifacts and versions go with it (ON DELETE CASCADE).
          tx.delete(recordings).where(eq(recordings.id, id)).run();
          return { runIds: runIds.map((row) => row.id) };
        });
      },
    },

    runs: {
      async create(run) {
        const now = iso(run.at);
        const id = newId("run");
        db.insert(runs)
          .values({
            id,
            recordingId: run.recordingId,
            recordingVersionId: run.recordingVersionId ?? null,
            scheduleId: run.scheduleId ?? null,
            trigger: run.trigger,
            status: run.status,
            paramsJson: JSON.stringify(run.params ?? {}),
            startedAt: run.status === "running" ? now : null,
            createdAt: now,
          })
          .run();
        return getRun(id) as RunRecord;
      },
      async markRunning(id, at) {
        db.update(runs)
          .set({ status: "running", startedAt: iso(at) })
          .where(eq(runs.id, id))
          .run();
      },
      async finish(id, outcome) {
        db.update(runs)
          .set({
            status: outcome.status,
            reason: outcome.reason ?? null,
            statsJson: JSON.stringify(outcome.stats),
            errorJson: outcome.error ? JSON.stringify(outcome.error) : null,
            finishedAt: iso(outcome.at),
          })
          .where(eq(runs.id, id))
          .run();
        const run = getRun(id);
        if (!run) throw new JobTraceError("NOT_FOUND", `No run ${id}`);
        return run;
      },
      async addEvent(runId, event) {
        db.insert(runEvents)
          .values({
            runId,
            ts: event.ts,
            level: event.level,
            stepId: event.stepId ?? null,
            type: event.type,
            message: event.message,
            dataJson: event.data ? JSON.stringify(event.data) : null,
          })
          .run();
      },
      async events(runId) {
        return db
          .select()
          .from(runEvents)
          .where(eq(runEvents.runId, runId))
          .orderBy(asc(runEvents.id))
          .all()
          .map((row): RunEvent => {
            const data = parseJson<Record<string, unknown>>(row.dataJson);
            return {
              ts: row.ts,
              level: row.level as RunEvent["level"],
              type: row.type,
              message: row.message,
              ...(row.stepId === null ? {} : { stepId: row.stepId }),
              ...(data === null ? {} : { data }),
            };
          });
      },
      async get(id) {
        return getRun(id);
      },
      async resolve(ref) {
        const id = resolveId(
          "run",
          ref,
          () => db.select({ id: runs.id }).from(runs).where(eq(runs.id, ref)).get()?.id,
          () =>
            db
              .select({ id: runs.id })
              .from(runs)
              .where(sql`${runs.id} LIKE ${likePrefix(ref)} ESCAPE '\\'`)
              .all()
              .map((row) => row.id),
        );
        return getRun(id) as RunRecord;
      },
      async list(filter = {}) {
        return db
          .select()
          .from(runs)
          .where(filter.recordingId ? eq(runs.recordingId, filter.recordingId) : undefined)
          .orderBy(desc(sql`rowid`))
          .limit(filter.limit ?? 50)
          .all()
          .map(toRun);
      },
    },

    jobs: {
      async saveRunJobs({ runId, recordingId, jobs: found, at }) {
        const now = iso(at);
        return db.transaction((tx) =>
          found.map((job): RunJobRecord => {
            const existing = tx
              .select()
              .from(jobs)
              .where(and(eq(jobs.recordingId, recordingId), eq(jobs.dedupKey, job.dedupKey)))
              .get();
            let id: string;
            let isChanged = false;
            if (!existing) {
              id = newId("job");
              tx.insert(jobs)
                .values({
                  id,
                  recordingId,
                  dedupKey: job.dedupKey,
                  ...jobContent(job),
                  firstSeenAt: now,
                  lastSeenAt: now,
                  firstSeenRunId: runId,
                })
                .run();
            } else {
              id = existing.id;
              isChanged = existing.contentHash !== job.contentHash;
              // Seen again: no longer closed. Content is only rewritten when it changed.
              const seen = { lastSeenAt: now, closedAt: null, postedAt: job.postedAt };
              tx.update(jobs)
                .set(isChanged ? { ...jobContent(job), ...seen } : seen)
                .where(eq(jobs.id, id))
                .run();
            }
            tx.insert(runJobs)
              .values({ runId, jobId: id, isNew: !existing, isChanged })
              .onConflictDoNothing()
              .run();
            const row = tx.select().from(jobs).where(eq(jobs.id, id)).get() as JobRow;
            return { ...toJob(row), isNew: !existing, isChanged };
          }),
        );
      },
      async closeMissing(recordingId, missedRuns, at) {
        return db.transaction((tx) => {
          const recent = tx
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.recordingId, recordingId), eq(runs.status, "succeeded")))
            .orderBy(desc(sql`rowid`))
            .limit(missedRuns)
            .all()
            .map((row) => row.id);
          // Not enough successful runs yet to conclude that anything is gone.
          if (missedRuns < 1 || recent.length < missedRuns) return 0;
          const seen = tx
            .select({ jobId: runJobs.jobId })
            .from(runJobs)
            .where(inArray(runJobs.runId, recent));
          return tx
            .update(jobs)
            .set({ closedAt: iso(at) })
            .where(
              and(
                eq(jobs.recordingId, recordingId),
                isNull(jobs.closedAt),
                sql`${jobs.id} NOT IN ${seen}`,
              ),
            )
            .run().changes;
        });
      },
      async forRun(runId) {
        return db
          .select({ job: jobs, isNew: runJobs.isNew, isChanged: runJobs.isChanged })
          .from(runJobs)
          .innerJoin(jobs, eq(jobs.id, runJobs.jobId))
          .where(eq(runJobs.runId, runId))
          .orderBy(asc(sql`${runJobs}.rowid`))
          .all()
          .map((row) => ({ ...toJob(row.job), isNew: row.isNew, isChanged: row.isChanged }));
      },
      async list(filter = {}) {
        return db
          .select()
          .from(jobs)
          .where(jobConditions(filter))
          .orderBy(desc(jobs.firstSeenAt), desc(sql`rowid`))
          .limit(filter.limit ?? 50)
          .offset(filter.offset ?? 0)
          .all()
          .map(toJob);
      },
      async count(filter = {}) {
        const row = db
          .select({ total: sql<number>`count(*)` })
          .from(jobs)
          .where(jobConditions(filter))
          .get();
        return row?.total ?? 0;
      },
      async get(id) {
        const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
        return row ? toJob(row) : null;
      },
    },

    authProfiles: {
      async save(profile) {
        const existing = db
          .select()
          .from(authProfiles)
          .where(eq(authProfiles.id, profile.id))
          .get();
        const taken = db
          .select()
          .from(authProfiles)
          .where(eq(authProfiles.name, profile.name))
          .get();
        if (taken && taken.id !== profile.id) {
          throw new JobTraceError(
            "INVALID_ARGUMENT",
            `An auth profile named "${profile.name}" already exists`,
          );
        }
        if (existing) {
          // A refreshed login has not been verified by a run yet.
          db.update(authProfiles)
            .set({ ...profile, lastVerifiedAt: null })
            .where(eq(authProfiles.id, profile.id))
            .run();
        } else
          db.insert(authProfiles)
            .values({ ...profile, createdAt: iso() })
            .run();
        return db
          .select()
          .from(authProfiles)
          .where(eq(authProfiles.id, profile.id))
          .get() as AuthProfile;
      },
      async get(id) {
        return db.select().from(authProfiles).where(eq(authProfiles.id, id)).get() ?? null;
      },
      async resolve(ref) {
        const found =
          db.select().from(authProfiles).where(eq(authProfiles.id, ref)).get() ??
          db
            .select()
            .from(authProfiles)
            .where(sql`lower(${authProfiles.name}) = lower(${ref})`)
            .get();
        if (!found) throw new JobTraceError("NOT_FOUND", `No auth profile matches "${ref}"`);
        return found;
      },
      async list() {
        return db
          .select({
            profile: authProfiles,
            usedBy: sql<number>`(SELECT count(*) FROM recordings WHERE recordings.auth_profile_id = auth_profiles.id)`,
          })
          .from(authProfiles)
          .orderBy(asc(authProfiles.name))
          .all()
          .map((row) => ({ ...row.profile, usedBy: row.usedBy }));
      },
      async markVerified(id, at) {
        db.update(authProfiles)
          .set({ lastVerifiedAt: iso(at) })
          .where(eq(authProfiles.id, id))
          .run();
      },
      async delete(id) {
        db.delete(authProfiles).where(eq(authProfiles.id, id)).run();
      },
    },

    artifacts: {
      async add(runId, found, at) {
        if (found.length === 0) return;
        db.insert(artifacts)
          .values(
            found.map((artifact) => ({
              id: newId("artifact"),
              runId,
              type: artifact.type,
              path: artifact.path,
              createdAt: iso(at),
            })),
          )
          .run();
      },
      async forRun(runId) {
        return db
          .select()
          .from(artifacts)
          .where(eq(artifacts.runId, runId))
          .orderBy(asc(sql`rowid`))
          .all()
          .map((row) => ({ ...row, type: row.type as "screenshot" | "dom" | "trace" }));
      },
      async prune(recordingId, keepRuns) {
        return db.transaction((tx) => {
          const kept = tx
            .select({ id: runs.id })
            .from(runs)
            .where(eq(runs.recordingId, recordingId))
            .orderBy(desc(sql`rowid`))
            .limit(Math.max(keepRuns, 0));
          const stale = tx
            .selectDistinct({ runId: artifacts.runId })
            .from(artifacts)
            .innerJoin(runs, eq(runs.id, artifacts.runId))
            .where(and(eq(runs.recordingId, recordingId), sql`${runs.id} NOT IN ${kept}`))
            .all()
            .map((row) => row.runId);
          if (stale.length > 0) tx.delete(artifacts).where(inArray(artifacts.runId, stale)).run();
          return { runIds: stale };
        });
      },
    },

    close() {
      sqlite.close();
    },
  };
}
