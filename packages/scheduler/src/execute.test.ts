import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseApiSource,
  parseRecording,
  type Recording,
  type RecordingInput,
} from "@jobtrace/core";
import { type Database, openDatabase } from "@jobtrace/db";
import { createPoliteness } from "@jobtrace/politeness";
import { captureAuth } from "@jobtrace/recorder";
import {
  ATS_PATHS,
  CHANGED_SALARY,
  changingJobs,
  LOGIN_CREDENTIALS,
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
    schemaVersion: 2,
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
              { name: "title", target: item(".title"), required: true },
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

  it.each(["greenhouse", "lever", "ashby"] as const)(
    "%s feed: flags the added and the modified job on the second run, without a browser",
    async (provider) => {
      const id = `src_${provider}`;
      await db.recordings.save(
        parseApiSource({
          schemaVersion: 1,
          kind: "api",
          id,
          name: `Acme on ${provider}`,
          provider,
          boardToken: "acme",
          baseUrl: sites.url(ATS_PATHS[provider]),
        }),
      );
      // No browser is passed: a feed run must not need one.
      const run = () => executeRun(db, id, { trigger: "cli", dataDir, artifactRetentionRuns: 20 });

      const one = await run();
      expect(one.run).toMatchObject({
        status: "succeeded",
        stats: { jobs: 5, newJobs: 5, changedJobs: 0 },
      });
      await setVersion(2);
      const two = await run();
      expect(two.run.stats).toMatchObject({ jobs: 5, newJobs: 1, changedJobs: 1, closedJobs: 0 });
      const [, second] = changingJobs(1).map((job) => job.title);
      expect(flagged(two.jobs)).toMatchObject({
        [second as string]: "changed",
        [changingJobs(2).at(-1)?.title ?? ""]: "new",
      });
      expect(Object.values(flagged(two.jobs)).filter((flag) => flag === "same")).toHaveLength(3);
      expect(two.artifacts).toEqual([]);
      expect((await db.runs.events(two.run.id)).map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "run_started",
          "request",
          "feed_read",
          "run_finished",
          "jobs_saved",
        ]),
      );

      // Two more successful runs without the fifth job: it is closed.
      await run();
      expect((await run()).run.stats?.closedJobs).toBe(1);
    },
  );

  it("stores a blocked feed run as blocked", async () => {
    await db.recordings.save(
      parseApiSource({
        schemaVersion: 1,
        kind: "api",
        id: "src_blocked",
        name: "Blocked",
        provider: "lever",
        boardToken: "forbidden",
        baseUrl: sites.url(ATS_PATHS.lever),
      }),
    );
    const { run } = await executeRun(db, "src_blocked", {
      trigger: "cli",
      dataDir,
      artifactRetentionRuns: 20,
    });
    expect(run).toMatchObject({ status: "blocked", reason: "bot_wall", stats: { jobs: 0 } });
  });

  it("refuses a site that robots.txt disallows, and stores a blocked run with its screenshot", async () => {
    const politeness = createPoliteness();
    await db.recordings.save(boardRecording("rec_disallowed", SITES.robotsDisallowed));
    const refused = await execute("rec_disallowed", { politeness });
    expect(refused.run).toMatchObject({
      status: "failed",
      reason: "robots_disallowed",
      stats: { jobs: 0 },
    });
    // Without politeness nothing is checked, which is what the other tests rely on.
    expect((await execute("rec_disallowed")).run.status).toBe("succeeded");

    await db.recordings.save(boardRecording("rec_walled", SITES.botWall));
    const blocked = await execute("rec_walled", { politeness });
    expect(blocked.run).toMatchObject({ status: "blocked", reason: "bot_wall" });
    expect(blocked.artifacts.map((artifact) => artifact.type)).toEqual(["screenshot", "dom"]);
    expect(existsSync(blocked.artifacts[0]?.path ?? "")).toBe(true);
  });

  it("runs on the same site take turns", async () => {
    const politeness = createPoliteness();
    await db.recordings.save(boardRecording("rec_one"));
    await db.recordings.save(boardRecording("rec_two"));
    const events: string[] = [];
    const [first, second] = await Promise.all([
      execute("rec_one", { politeness, onEvent: (event) => events.push(`one:${event.type}`) }),
      execute("rec_two", { politeness, onEvent: (event) => events.push(`two:${event.type}`) }),
    ]);
    expect([first.run.status, second.run.status]).toEqual(["succeeded", "succeeded"]);
    expect(events).toContain("two:waiting");
    // The second run only started once the first had finished.
    expect(events.indexOf("two:run_started")).toBeGreaterThan(events.indexOf("one:run_finished"));

    const controller = new AbortController();
    const release = await politeness.locks.acquire("127.0.0.1");
    const waiting = execute("rec_two", { politeness, run: { browser, signal: controller.signal } });
    controller.abort();
    expect((await waiting).run).toMatchObject({ status: "cancelled", reason: "run_cancelled" });
    release();
  });

  describe("saved logins", () => {
    const loginBoard = (authProfileId: string) =>
      parseRecording({
        ...boardRecording("rec_internal", SITES.login),
        authProfileId,
        loggedInCheck: { locators: [{ kind: "testId", value: "signed-in" }] },
      });

    async function saveLogin(name = "Intranet") {
      const storageStatePath = join(dataDir, "auth", `${name}.json`);
      const capture = await captureAuth({
        url: sites.url(`${SITES.login}signin`),
        statePath: storageStatePath,
        browser,
        headless: true,
        openShadow: true,
      });
      await capture.page.locator('input[name="username"]').fill(LOGIN_CREDENTIALS.username);
      await capture.page.locator('input[name="password"]').fill(LOGIN_CREDENTIALS.password);
      await capture.page.getByRole("button", { name: "Sign in" }).click();
      await capture.page.getByTestId("signed-in").waitFor();
      expect(await capture.save()).toEqual({ saved: true, domain: "127.0.0.1" });
      return db.authProfiles.save({
        id: `auth_${name}`,
        name,
        domain: "127.0.0.1",
        storageStatePath,
      });
    }

    it("site 6: runs with the saved login, then fails with auth_expired once it is invalidated", async () => {
      const profile = await saveLogin();
      expect(profile.lastVerifiedAt).toBeNull();
      await db.recordings.save(loginBoard(profile.id));

      const working = await execute("rec_internal");
      expect(working.run).toMatchObject({ status: "succeeded", stats: { jobs: 5 } });
      expect((await db.authProfiles.get(profile.id))?.lastVerifiedAt).not.toBeNull();
      expect((await db.authProfiles.list())[0]).toMatchObject({ name: "Intranet", usedBy: 1 });

      await fetch(sites.url(`${SITES.login}__invalidate`), { method: "POST" });
      const expired = await execute("rec_internal");
      expect(expired.run).toMatchObject({
        status: "failed",
        reason: "auth_expired",
        error: { code: "AUTH_EXPIRED" },
        stats: { jobs: 0 },
      });
      // Nothing was closed or lost because of the failed run.
      expect(await db.jobs.count()).toBe(5);
    });

    it("fails cleanly when the profile or its session file is gone", async () => {
      await db.recordings.save(loginBoard("auth_never_existed"));
      const orphaned = await execute("rec_internal");
      expect(orphaned.run).toMatchObject({
        status: "failed",
        reason: "auth_expired",
        stats: { pages: 0 },
      });
      expect(orphaned.run.error?.message).toMatch(/no longer exists/);

      const profile = await saveLogin("Gone");
      rmSync(profile.storageStatePath);
      await db.recordings.save(loginBoard(profile.id));
      expect((await execute("rec_internal")).run.error?.message).toMatch(
        /saved login of auth profile "Gone" is missing/,
      );
      const [latest] = await db.runs.list();
      expect((await db.runs.events(latest?.id ?? "")).map((event) => event.type)).toContain(
        "run_error",
      );
    });
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
