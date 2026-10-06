import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecording, type Recording, type RecordingInput } from "@jobtrace/core";
import { type Database, openDatabase } from "@jobtrace/db";
import {
  CHANGED_SALARY,
  changingJobs,
  type RunningTestSites,
  SITES,
  startTestSites,
} from "@jobtrace/test-sites";
import { type Browser, chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { artifactsDirFor, type ExecuteRunOptions, executeRun } from "./execute.ts";

let sites: RunningTestSites;
let browser: Browser;
let dataDir: string;
let db: Database;

beforeAll(async () => {
  sites = await startTestSites();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
});
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "jobtrace-exec-"));
  db = openDatabase(":memory:");
  await setVersion(1);
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const setVersion = (version: number) =>
  fetch(sites.url(`${SITES.changing}__version/${version}`), { method: "POST" });

const item = (css: string) => ({
  locators: [{ kind: "css" as const, value: css }],
  relativeTo: "item" as const,
});

function boardRecording(
  id = "rec_board",
  path: string = SITES.changing,
  extra: RecordingInput["steps"] = [],
): Recording {
  return parseRecording({
    schemaVersion: 1,
    id,
    name: "Changing board",
    startUrl: sites.url(path),
    settings: { company: "Acme Robotics" },
    steps: [
      { id: "s1", type: "navigate", url: sites.url(path) },
      {
        id: "s2",
        type: "forEach",
        items: { locators: [{ kind: "css", value: "li.job" }] },
        body: [
          {
            id: "s3",
            type: "extract",
            scope: "item",
            fields: [
              { name: "title", target: item("a.title"), required: true },
              {
                name: "url",
                target: item("a.title"),
                read: "attr",
                attr: "href",
                transforms: ["absoluteUrl"],
              },
              { name: "salaryText", target: item(".salary") },
            ],
          },
        ],
      },
      ...extra,
    ],
  } satisfies RecordingInput);
}

const execute = (recordingId = "rec_board", overrides: Partial<ExecuteRunOptions> = {}) =>
  executeRun(db, recordingId, {
    trigger: "cli",
    dataDir,
    artifactRetentionRuns: 20,
    ...overrides,
    run: {
      browser,
      settings: { minDelayMs: 0, maxDelayMs: 0, stepTimeoutMs: 400 },
      tuning: { pollIntervalMs: 25, fallbackGraceMs: 100, optionalFieldTimeoutMs: 100 },
      ...overrides.run,
    },
  });

const flagged = (jobs: Awaited<ReturnType<typeof execute>>["jobs"]) =>
  Object.fromEntries(
    jobs.map((job) => [job.title, job.isNew ? "new" : job.isChanged ? "changed" : "same"]),
  );

describe("executeRun", () => {
  it("flags the added and the modified job on the second run", async () => {
    await db.recordings.save(boardRecording());
    const [first, second, third, fourth, fifth] = changingJobs(1).map((job) => job.title);
    const added = changingJobs(2).at(-1)?.title ?? "";

    const one = await execute();
    expect(one.run).toMatchObject({
      status: "succeeded",
      trigger: "cli",
      stats: { jobs: 5, newJobs: 5, changedJobs: 0, closedJobs: 0, itemErrors: 0 },
    });
    expect(Object.values(flagged(one.jobs))).toEqual(["new", "new", "new", "new", "new"]);

    await setVersion(2);
    const two = await execute();
    expect(two.run.stats).toMatchObject({ jobs: 5, newJobs: 1, changedJobs: 1, closedJobs: 0 });
    expect(flagged(two.jobs)).toEqual({
      [first as string]: "same",
      [second as string]: "changed",
      [third as string]: "same",
      [fourth as string]: "same",
      [added]: "new",
    });
    expect(two.jobs.find((job) => job.isChanged)).toMatchObject({
      salaryText: CHANGED_SALARY,
      firstSeenRunId: one.run.id,
    });
    expect(two.jobs.find((job) => job.isNew)?.firstSeenRunId).toBe(two.run.id);

    // The same picture from the database, not just from the return value.
    expect(flagged(await db.jobs.forRun(two.run.id))).toEqual(flagged(two.jobs));
    expect((await db.jobs.list({ newInLatestRun: true })).map((job) => job.title)).toEqual([added]);
    expect(await db.jobs.count()).toBe(6);
    expect((await db.jobs.list()).map((job) => job.title)).toContain(fifth);
    expect((await db.runs.list()).map((run) => run.id)).toEqual([two.run.id, one.run.id]);
  });

  it("stores the event log and the recording version that was replayed", async () => {
    const { versionId } = await db.recordings.save(boardRecording());
    const seen: string[] = [];
    const { run } = await execute("rec_board", { onEvent: (event) => seen.push(event.type) });
    const stored = (await db.runs.events(run.id)).map((event) => event.type);
    expect(stored).toEqual(seen);
    expect(stored).toEqual(
      expect.arrayContaining(["run_started", "for_each", "run_finished", "jobs_saved"]),
    );
    expect(run.recordingVersionId).toBe(versionId);
    expect(run.startedAt && run.finishedAt && run.finishedAt >= run.startedAt).toBe(true);
  });

  it("closes a job after it was missing from three successful runs, and counts it", async () => {
    await db.recordings.save(boardRecording());
    const gone = changingJobs(1).at(-1)?.title;
    await execute();
    await setVersion(2);
    expect((await execute()).run.stats?.closedJobs).toBe(0);
    expect((await execute()).run.stats?.closedJobs).toBe(0);
    const fourth = await execute();
    expect(fourth.run.stats).toMatchObject({ closedJobs: 1, newJobs: 0, changedJobs: 0 });
    expect((await db.jobs.list()).map((job) => job.title)).not.toContain(gone);
    expect((await db.jobs.list({ includeClosed: true })).map((job) => job.title)).toContain(gone);

    // Back on the board: open again, and neither new nor changed.
    await setVersion(1);
    const back = await execute();
    expect(flagged(back.jobs)[gone ?? ""]).toBe("same");
    expect(back.jobs.every((job) => job.closedAt === null)).toBe(true);
  });

  it("never closes jobs after a partial run", async () => {
    await db.recordings.save(boardRecording());
    await execute();
    await setVersion(2);
    // The trailing step fails on every run: jobs are read, but the run is only partial.
    await db.recordings.save(
      boardRecording("rec_board", SITES.changing, [
        { id: "s9", type: "click", target: { locators: [{ kind: "css", value: "#missing" }] } },
      ]),
    );
    for (let index = 0; index < 4; index++) {
      const { run } = await execute("rec_board", { closeAfterMissedRuns: 1 });
      expect(run).toMatchObject({
        status: "partial",
        reason: "locator_not_found",
        stats: { closedJobs: 0 },
      });
    }
    expect(await db.jobs.count()).toBe(6);
  });

  it("keeps artifacts for the newest runs only, on disk and in the database", async () => {
    await db.recordings.save(boardRecording("rec_broken", "/no-such-page/"));
    const runs = [];
    for (let index = 0; index < 3; index++) {
      runs.push(await execute("rec_broken", { artifactRetentionRuns: 2, run: { trace: true } }));
    }
    const [oldest, middle, newest] = runs;
    expect(newest?.run).toMatchObject({ status: "failed", reason: "navigation_failed" });
    expect(newest?.artifacts.map((artifact) => artifact.type)).toEqual([
      "screenshot",
      "dom",
      "trace",
    ]);
    for (const artifact of newest?.artifacts ?? []) expect(existsSync(artifact.path)).toBe(true);

    expect(existsSync(artifactsDirFor(dataDir, oldest?.run.id ?? ""))).toBe(false);
    expect(await db.artifacts.forRun(oldest?.run.id ?? "")).toEqual([]);
    expect(existsSync(artifactsDirFor(dataDir, middle?.run.id ?? ""))).toBe(true);
    expect(await db.artifacts.forRun(middle?.run.id ?? "")).toHaveLength(3);
    // The run itself and its log are kept; only the files go.
    expect((await db.runs.events(oldest?.run.id ?? "")).length).toBeGreaterThan(0);
  });

  it("executes a run that was queued earlier", async () => {
    await db.recordings.save(boardRecording());
    const queued = await db.runs.create({
      recordingId: "rec_board",
      trigger: "manual",
      status: "queued",
    });
    const { run } = await execute("rec_board", { runId: queued.id, trigger: "manual" });
    expect(run).toMatchObject({ id: queued.id, status: "succeeded", trigger: "manual" });
    expect(await db.runs.list()).toHaveLength(1);
  });

  it("rejects unknown recordings, and never leaves a run stuck in running", async () => {
    await expect(execute("rec_nope")).rejects.toMatchObject({ code: "NOT_FOUND" });

    await db.recordings.save(boardRecording());
    const broken: Database = {
      ...db,
      jobs: {
        ...db.jobs,
        saveRunJobs: async () => {
          throw new Error("disk full");
        },
      },
    };
    await expect(
      executeRun(broken, "rec_board", {
        trigger: "cli",
        dataDir,
        artifactRetentionRuns: 20,
        run: { browser, settings: { minDelayMs: 0, maxDelayMs: 0 } },
      }),
    ).rejects.toThrow("disk full");
    expect((await db.runs.list())[0]).toMatchObject({
      status: "failed",
      reason: "internal_error",
      error: { message: "disk full" },
    });
  });
});
