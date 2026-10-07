import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "@jobtrace/core";
import { type Database, openDatabase } from "@jobtrace/db";
import {
  ATS_PATHS,
  changingJobs,
  jobsFor,
  LOGIN_CREDENTIALS,
  type RunningTestSites,
  SITES,
  startTestSites,
} from "@jobtrace/test-sites";
import { type Browser, chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, type ServerOptions, startServer } from "./server.ts";
import type { SessionHooks } from "./sessions.ts";

let sites: RunningTestSites;
let browser: Browser;
let dataDir: string;
let db: Database;
let server: RunningServer;
let hooks: SessionHooks;

beforeAll(async () => {
  sites = await startTestSites();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
});

async function start(
  env: Record<string, string> = {},
  extra: Pick<ServerOptions, "ai"> = {},
): Promise<Config> {
  const config = loadConfig({ DATA_DIR: dataDir, ...env });
  hooks = { recorder: { browser, headless: true, openShadow: true } };
  server = await startServer({
    config,
    db,
    port: 0,
    listenHost: "127.0.0.1",
    sessionHooks: hooks,
    ...extra,
    worker: {
      pollIntervalMs: 50,
      run: {
        browser,
        settings: { minDelayMs: 0, maxDelayMs: 0, stepTimeoutMs: 1500 },
        tuning: { pollIntervalMs: 25, fallbackGraceMs: 100, optionalFieldTimeoutMs: 100 },
      },
    },
  });
  return config;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "jobtrace-api-"));
  db = openDatabase(":memory:");
  await fetch(sites.url(`${SITES.changing}__version/1`), { method: "POST" });
  await start();
});
afterEach(async () => {
  await server.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type Method = "GET" | "POST" | "PUT" | "DELETE";
async function api(
  method: Method,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await server.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  const text = response.body;
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON (a file, an event stream).
  }
  // biome-ignore lint/suspicious/noExplicitAny: test helper; each test asserts the shape it expects
  return { status: response.statusCode, body: body as any, headers: response.headers, text };
}

const item = (css: string) => ({ locators: [{ kind: "css", value: css }], relativeTo: "item" });
/** A recording definition as a client would send it: no id, format version 1 (migrated on the way in). */
function board(path: string = SITES.changing, extra: object[] = [], name = "Changing board") {
  return {
    schemaVersion: 1,
    name,
    startUrl: sites.url(path),
    steps: [
      { id: "s1", type: "navigate", url: sites.url(path) },
      ...extra,
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
              { name: "salaryText", target: item(".salary") },
              {
                name: "url",
                target: item("a.title"),
                read: "attr",
                attr: "href",
                transforms: ["absoluteUrl"],
              },
            ],
          },
        ],
      },
    ],
  };
}
const slow = [{ id: "wait", type: "waitFor", ms: 10_000 }];

async function createBoard(...args: Parameters<typeof board>): Promise<string> {
  const created = await api("POST", "/api/recordings", board(...args));
  expect(created.status).toBe(201);
  return created.body.id as string;
}
async function runToEnd(recordingId: string, body: object = {}) {
  const queued = await api("POST", `/api/recordings/${recordingId}/runs`, body);
  expect(queued.status).toBe(202);
  await server.worker.idle();
  return (await api("GET", `/api/runs/${queued.body.id}`)).body;
}

describe("recordings", () => {
  it("creates, lists, reads, updates, versions and deletes", async () => {
    expect((await api("GET", "/api/recordings")).body).toEqual([]);
    const created = await api("POST", "/api/recordings", board());
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(id).toMatch(/^rec_/);
    expect(created.body).toMatchObject({
      kind: "browser",
      name: "Changing board",
      domain: "127.0.0.1",
      openJobs: 0,
      // Stored in the current format, with defaults filled in.
      definition: { schemaVersion: 2, id, settings: { maxPages: 20 } },
    });

    const updated = await api("PUT", `/api/recordings/${id}`, {
      ...board(),
      name: "Renamed",
      id: "ignored",
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ id, name: "Renamed" });
    const versions = await api("GET", `/api/recordings/${id}/versions`);
    expect(versions.body.map((version: { note: string }) => version.note)).toEqual([
      "edited",
      "created through the API",
    ]);
    expect(updated.body.versionId).toBe(versions.body[0].id);

    const list = await api("GET", "/api/recordings");
    expect(list.body).toMatchObject([{ id, name: "Renamed", openJobs: 0, lastRun: null }]);
    expect((await api("GET", `/api/recordings/${id}`)).body.definition.steps).toHaveLength(2);

    expect((await api("DELETE", `/api/recordings/${id}`)).status).toBe(204);
    expect((await api("GET", `/api/recordings/${id}`)).status).toBe(404);
    expect((await api("DELETE", `/api/recordings/${id}`)).body).toEqual({
      error: { code: "NOT_FOUND", message: `No recording ${id}` },
    });
  });

  it("rejects invalid definitions and duplicate ids with a readable message", async () => {
    const invalid = await api("POST", "/api/recordings", {
      ...board(),
      steps: [{ id: "s1", type: "teleport" }],
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatchObject({
      code: "INVALID_RECORDING",
      message: expect.stringMatching(/steps\[0\]/),
    });

    const id = await createBoard();
    const duplicate = await api("POST", "/api/recordings", { ...board(), id });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.message).toMatch(/already exists; use PUT/);
    expect((await api("PUT", `/api/recordings/${id}`, { ...board(), steps: "nope" })).status).toBe(
      400,
    );
    expect((await api("PUT", "/api/recordings/rec_nope", board())).status).toBe(404);
    expect(
      (
        await api("PUT", `/api/recordings/${id}`, {
          kind: "api",
          schemaVersion: 1,
          name: "x",
          provider: "lever",
          boardToken: "acme",
        })
      ).body.error.message,
    ).toMatch(/cannot be turned into an API source/);
  });

  it("adds API sources after checking the feed, and stores nothing for an unknown board", async () => {
    const added = await api("POST", "/api/sources", {
      provider: "greenhouse",
      boardToken: "acme",
      baseUrl: sites.url(ATS_PATHS.greenhouse),
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      kind: "api",
      name: "acme (greenhouse)",
      definition: { provider: "greenhouse" },
    });
    expect(added.body.id).toMatch(/^src_/);

    const missing = await api("POST", "/api/sources", {
      provider: "lever",
      boardToken: "nope",
      baseUrl: sites.url(ATS_PATHS.lever),
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toMatch(/No lever board named "nope"/);
    expect(
      (await api("POST", "/api/sources", { provider: "workday", boardToken: "acme" })).status,
    ).toBe(400);
    expect((await api("GET", "/api/recordings")).body).toHaveLength(1);

    const run = await runToEnd(added.body.id);
    expect(run.run).toMatchObject({ status: "succeeded", stats: { jobs: 5, newJobs: 5 } });
  });
});

describe("runs and jobs", () => {
  it("queues a run, executes it, and reports its jobs with new and changed flags", async () => {
    const id = await createBoard();
    const queued = await api("POST", `/api/recordings/${id}/runs`, { trace: true });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({
      status: "queued",
      trigger: "manual",
      options: { trace: true },
      stats: null,
    });
    await server.worker.idle();

    const first = (await api("GET", `/api/runs/${queued.body.id}`)).body;
    expect(first.run).toMatchObject({
      status: "succeeded",
      stats: { jobs: 5, newJobs: 5, changedJobs: 0 },
    });
    expect(first.jobs.map((job: { title: string }) => job.title)).toEqual(
      changingJobs(1).map((job) => job.title),
    );
    expect(first.artifacts.map((artifact: { type: string }) => artifact.type)).toEqual(["trace"]);

    await fetch(sites.url(`${SITES.changing}__version/2`), { method: "POST" });
    const second = await runToEnd(id);
    expect(second.run.stats).toMatchObject({ newJobs: 1, changedJobs: 1 });
    expect(second.jobs.filter((job: { isNew: boolean }) => job.isNew)).toHaveLength(1);
    expect(second.jobs.filter((job: { isChanged: boolean }) => job.isChanged)).toHaveLength(1);

    const runs = await api("GET", `/api/runs?recording=${id}`);
    expect(runs.body.map((run: { id: string }) => run.id)).toEqual([second.run.id, first.run.id]);
    expect((await api("GET", "/api/runs?status=failed")).body).toEqual([]);
    expect((await api("GET", "/api/runs?status=nope")).status).toBe(400);
    const events = await api("GET", `/api/runs/${second.run.id}/events`);
    expect(events.body.map((event: { type: string }) => event.type)).toEqual(
      expect.arrayContaining(["run_started", "for_each", "jobs_saved"]),
    );
    expect((await api("GET", "/api/recordings")).body[0]).toMatchObject({
      openJobs: 6,
      lastRun: { id: second.run.id },
    });
    expect((await api("POST", "/api/recordings/rec_nope/runs", {})).status).toBe(404);
    expect((await api("GET", "/api/runs/run_nope")).status).toBe(404);
  });

  it("searches, filters and pages jobs", async () => {
    const id = await createBoard();
    await runToEnd(id);
    const before = new Date().toISOString();
    await fetch(sites.url(`${SITES.changing}__version/2`), { method: "POST" });
    await runToEnd(id);
    const added = changingJobs(2).at(-1)?.title;

    const all = await api("GET", "/api/jobs");
    expect(all.body).toMatchObject({ total: 6, page: 1, pageSize: 50 });
    expect(all.body.items[0]).toMatchObject({
      title: added,
      company: null,
      closedAt: null,
      custom: {},
    });
    const titles = async (query: string) =>
      (await api("GET", `/api/jobs?${query}`)).body.items.map(
        (job: { title: string }) => job.title,
      );
    expect(await titles("new=true")).toEqual([added]);
    expect(await titles("q=frontend")).toEqual(["Frontend Engineer"]);
    expect(await titles(`from=${encodeURIComponent(before)}`)).toEqual([added]);
    expect(await titles(`to=${encodeURIComponent(before)}`)).toHaveLength(5);
    expect(await titles(`recording=${id}&pageSize=2&page=3`)).toHaveLength(2);
    expect(await titles("recording=rec_other")).toEqual([]);
    expect((await api("GET", "/api/jobs?pageSize=2&page=2")).body).toMatchObject({
      total: 6,
      page: 2,
      pageSize: 2,
    });

    const job = all.body.items[0];
    expect((await api("GET", `/api/jobs/${job.id}`)).body).toEqual(job);
    expect((await api("GET", "/api/jobs/job_nope")).status).toBe(404);
    const invalid = await api("GET", "/api/jobs?page=0&from=yesterday");
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringMatching(/page|from/),
    });
  });

  it("cancels a running run and a queued one, and refuses when there is nothing to cancel", async () => {
    const id = await createBoard(SITES.changing, slow);
    const running = (await api("POST", `/api/recordings/${id}/runs`, {})).body;
    const queued = (await api("POST", `/api/recordings/${id}/runs`, {})).body;
    await expect.poll(() => server.worker.active()).toEqual([running.id]);
    expect((await api("GET", "/api/health")).body).toEqual({
      status: "ok",
      activeRuns: 1,
      queuedRuns: 1,
    });

    const cancelQueued = await api("POST", `/api/runs/${queued.id}/cancel`);
    expect(cancelQueued.status).toBe(202);
    expect(cancelQueued.body).toMatchObject({ status: "cancelled", reason: "run_cancelled" });

    expect((await api("POST", `/api/runs/${running.id}/cancel`)).status).toBe(202);
    await server.worker.idle();
    expect((await api("GET", `/api/runs/${running.id}`)).body.run).toMatchObject({
      status: "cancelled",
    });

    const again = await api("POST", `/api/runs/${running.id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe("The run already ended (cancelled).");
    expect((await api("POST", "/api/runs/run_nope/cancel")).status).toBe(404);
  });

  it("serves artifacts safely: screenshots as images, captured pages as plain text", async () => {
    const id = await createBoard("/no-such-page/");
    const { run, artifacts } = await runToEnd(id);
    expect(run).toMatchObject({ status: "failed", reason: "navigation_failed" });
    const [screenshot, dom] = artifacts as Array<{ id: string; type: string }>;
    expect([screenshot?.type, dom?.type]).toEqual(["screenshot", "dom"]);

    const image = await server.app.inject({
      url: `/api/runs/${run.id}/artifacts/${screenshot?.id}`,
    });
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload.subarray(1, 4).toString()).toBe("PNG");

    const page = await api("GET", `/api/runs/${run.id}/artifacts/${dom?.id}`);
    expect(page.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["content-security-policy"]).toContain("sandbox");
    expect(page.text).toMatch(/not found/i);
    // The captured markup arrives as text, tags and all.
    expect(page.text).toContain("<html");

    expect((await api("GET", `/api/runs/${run.id}/artifacts/art_nope`)).status).toBe(404);
    // A row pointing outside the artifacts directory is never served.
    await db.artifacts.add(run.id, [{ type: "dom", path: "/etc/hosts" }]);
    const rogue = (await db.artifacts.forRun(run.id)).at(-1);
    expect((await api("GET", `/api/runs/${run.id}/artifacts/${rogue?.id}`)).status).toBe(404);
  });
});

describe("event stream", () => {
  const parse = (text: string) =>
    text
      .split("\n\n")
      .filter((block) => block.includes("data: "))
      .map((block) => ({
        id: /^id: (\d+)$/m.exec(block)?.[1],
        event: /^event: (\w+)$/m.exec(block)?.[1],
        data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null"),
      }));

  it("replays a finished run's log and ends with the run", async () => {
    const id = await createBoard();
    const { run } = await runToEnd(id);
    const stream = await api("GET", `/api/runs/${run.id}/events/stream`);
    expect(stream.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    const events = parse(stream.text);
    const stored = (await api("GET", `/api/runs/${run.id}/events`)).body;
    expect(events.filter((event) => event.event === "log").map((event) => event.data)).toEqual(
      stored,
    );
    expect(events.map((event) => event.id).filter(Boolean)).toEqual(
      stored.map((_: unknown, index: number) => String(index)),
    );
    expect(events.at(-1)).toMatchObject({
      event: "end",
      data: { id: run.id, status: "succeeded" },
    });

    // Resuming after event 2 skips what the client already has.
    const resumed = parse(
      (await api("GET", `/api/runs/${run.id}/events/stream`, undefined, { "last-event-id": "2" }))
        .text,
    );
    expect(resumed[0]?.id).toBe("3");
    expect((await api("GET", "/api/runs/run_nope/events/stream")).status).toBe(404);
  });

  it("delivers events while the run is still going, over a real connection", async () => {
    const id = await createBoard(SITES.changing, [{ id: "wait", type: "waitFor", ms: 700 }]);
    const queued = (await api("POST", `/api/recordings/${id}/runs`, {})).body;
    const response = await fetch(`${server.url}/api/runs/${queued.id}/events/stream`);
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    let statusWhenFirstEventArrived: string | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (statusWhenFirstEventArrived === undefined && text.includes("event: log")) {
        statusWhenFirstEventArrived = (await db.runs.get(queued.id))?.status;
      }
    }
    // The first log lines arrived before the run was over: the stream is live, not a replay.
    expect(statusWhenFirstEventArrived).toBe("running");
    const events = parse(text);
    expect(events.map((event) => event.data.type)).toEqual(
      expect.arrayContaining(["run_started", "for_each", "run_finished", "jobs_saved"]),
    );
    expect(events.at(-1)).toMatchObject({
      event: "end",
      data: { status: "succeeded", stats: { jobs: 5 } },
    });
    expect(events.filter((event) => event.event === "log").map((event) => event.data)).toEqual(
      await db.runs.events(queued.id),
    );
  });

  it("ends the stream of a run that is cancelled while queued", async () => {
    const id = await createBoard(SITES.changing, slow);
    const running = (await api("POST", `/api/recordings/${id}/runs`, {})).body;
    const queued = (await api("POST", `/api/recordings/${id}/runs`, {})).body;
    const pending = fetch(`${server.url}/api/runs/${queued.id}/events/stream`).then((response) =>
      response.text(),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await api("POST", `/api/runs/${queued.id}/cancel`);
    expect(parse(await pending).at(-1)).toMatchObject({
      event: "end",
      data: { status: "cancelled" },
    });
    await api("POST", `/api/runs/${running.id}/cancel`);
    await server.worker.idle();
  });
});

describe("recording and login windows", () => {
  const ui = (page: import("playwright").Page) => page.locator("#__jobtrace-overlay");
  const poll = async (id: string) => (await api("GET", `/api/record-sessions/${id}`)).body;

  it("records through the API and stores the result", async () => {
    hooks.onRecording = (session) => {
      void (async () => {
        const { page } = session;
        const press = (action: string) => ui(page).locator(`[data-action="${action}"]`).click();
        await press("list");
        await page.locator("li.job .loc").first().click();
        await press("list-use");
        await expect.poll(() => session.status().scope).toBe("list");
        await page.locator("li.job .title").first().click();
        await press("save");
        await expect.poll(() => session.status().fields).toEqual(["title"]);
      })();
    };
    const started = await api("POST", "/api/recordings/record", {
      url: sites.url(SITES.staticList),
      name: "From the UI",
    });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ kind: "recording", status: "active", resultId: null });
    const id = started.body.id as string;

    // Only one window at a time.
    const second = await api("POST", "/api/recordings/record", {
      url: sites.url(SITES.staticList),
    });
    expect(second.status).toBe(400);
    expect(second.body.error.message).toMatch(/still open/);

    await expect.poll(async () => (await poll(id)).progress?.fields).toEqual(["title"]);
    expect(await poll(id)).toMatchObject({
      status: "active",
      progress: { scope: "list", steps: 1 },
    });
    const stopped = await api("POST", `/api/record-sessions/${id}/stop`);
    expect(stopped.body).toMatchObject({ status: "finished", progress: null, warnings: [] });

    const recording = await api("GET", `/api/recordings/${stopped.body.resultId}`);
    expect(recording.body).toMatchObject({ name: "From the UI", kind: "browser" });
    const run = await runToEnd(recording.body.id);
    expect(run.jobs.map((job: { title: string }) => job.title)).toEqual(
      jobsFor("staticList").map((job) => job.title),
    );
    expect((await api("GET", "/api/record-sessions/ses_nope")).status).toBe(404);
    expect((await api("POST", "/api/recordings/record", { url: "not a url" })).status).toBe(400);
    expect(
      (
        await api("POST", "/api/recordings/record", {
          url: sites.url("/"),
          authProfileId: "auth_nope",
        })
      ).status,
    ).toBe(404);
  });

  it("captures, lists, refreshes and deletes a saved login without exposing the session file", async () => {
    hooks.onAuthCapture = (capture) => {
      void (async () => {
        const { page } = capture;
        await page.locator('input[name="username"]').fill(LOGIN_CREDENTIALS.username);
        await page.locator('input[name="password"]').fill(LOGIN_CREDENTIALS.password);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByTestId("signed-in").waitFor();
        await ui(page).locator('[data-action="auth-save"]').click();
      })();
    };
    const url = sites.url(`${SITES.login}signin`);
    const started = await api("POST", "/api/auth-profiles", { name: "Intranet", url });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ kind: "auth", status: "active" });
    await expect.poll(async () => (await poll(started.body.id)).status).toBe("finished");
    const profileId = (await poll(started.body.id)).resultId as string;

    const profiles = await api("GET", "/api/auth-profiles");
    expect(profiles.body).toEqual([
      {
        id: profileId,
        name: "Intranet",
        domain: "127.0.0.1",
        createdAt: expect.any(String),
        lastVerifiedAt: null,
        usedBy: 0,
      },
    ]);
    expect(profiles.text).not.toMatch(/storageState|\.json|auth\//);
    expect(
      (await api("POST", "/api/auth-profiles", { name: "intranet", url })).body.error.message,
    ).toMatch(/already exists/);

    const refresh = await api("POST", `/api/auth-profiles/${profileId}/refresh`, { url });
    expect(refresh.status).toBe(202);
    await expect.poll(async () => (await poll(refresh.body.id)).status).toBe("finished");
    expect((await api("POST", "/api/auth-profiles/auth_nope/refresh", {})).status).toBe(404);

    hooks.onAuthCapture = () => {};
    const abandoned = await api("POST", `/api/auth-profiles/${profileId}/refresh`, { url });
    expect((await api("POST", `/api/record-sessions/${abandoned.body.id}/stop`)).body.status).toBe(
      "cancelled",
    );

    expect((await api("DELETE", `/api/auth-profiles/${profileId}`)).status).toBe(204);
    expect((await api("GET", "/api/auth-profiles")).body).toEqual([]);
    expect((await api("DELETE", `/api/auth-profiles/${profileId}`)).status).toBe(404);
  });
});

describe("support for the web UI", () => {
  it("tries one step, reads back versions, and exports jobs", async () => {
    const id = await createBoard();
    const worked = await api("POST", `/api/recordings/${id}/test-step`, { stepId: "s3" });
    expect(worked.status).toBe(200);
    expect(worked.body).toMatchObject({
      ok: true,
      reached: true,
      fields: { title: changingJobs(1)[0]?.title, salaryText: changingJobs(1)[0]?.salary },
      events: [],
    });
    // Nothing is stored by a test.
    expect((await api("GET", "/api/runs")).body).toEqual([]);
    expect((await api("GET", "/api/jobs")).body.total).toBe(0);
    expect((await api("POST", `/api/recordings/${id}/test-step`, { stepId: "nope" })).status).toBe(
      404,
    );

    const broken = {
      ...board(),
      steps: [
        ...board().steps,
        { id: "s9", type: "click", target: { locators: [{ kind: "css", value: "#missing" }] } },
      ],
    };
    await api("PUT", `/api/recordings/${id}`, broken);
    const failed = await api("POST", `/api/recordings/${id}/test-step`, { stepId: "s9" });
    expect(failed.body).toMatchObject({
      ok: false,
      reached: true,
      error: { code: "LOCATOR_NOT_FOUND", stepId: "s9" },
    });

    const versions = (await api("GET", `/api/recordings/${id}/versions`)).body;
    const original = await api("GET", `/api/recordings/${id}/versions/${versions.at(-1).id}`);
    expect(original.body.steps).toHaveLength(2);
    expect((await api("GET", `/api/recordings/${id}/versions/rcv_nope`)).status).toBe(404);
    // Restoring is putting an old version back.
    expect(
      (await api("PUT", `/api/recordings/${id}`, original.body)).body.definition.steps,
    ).toHaveLength(2);

    await runToEnd(id);
    const csv = await api("GET", "/api/jobs/export?q=engineer");
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="jobtrace-jobs.csv"');
    const lines = csv.text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "title,company,location,remote,salaryText,salaryMin,salaryMax,salaryCurrency,salaryPeriod,employmentType,postedAt,url,firstSeenAt,lastSeenAt,closedAt,recordingId",
    );
    expect(lines).toHaveLength(
      1 + changingJobs(1).filter((job) => /engineer/i.test(job.title)).length,
    );
    expect(csv.text).toContain('"€85,000 - €110,000 per year",85000,110000,EUR,year');
    const json = await api("GET", "/api/jobs/export?format=json&remote=remote");
    expect(json.headers["content-disposition"]).toContain("jobtrace-jobs.json");
    expect(json.body).toEqual([]);
    expect((await api("GET", "/api/jobs?remote=sometimes")).status).toBe(400);
  });

  it("guards exported cells against being run as spreadsheet formulas", async () => {
    const { csvCell } = await import("./routes/jobs.ts");
    expect(csvCell('=HYPERLINK("http://evil.example","Apply")')).toBe(
      `"'=HYPERLINK(""http://evil.example"",""Apply"")"`,
    );
    expect(csvCell("+1 555 0100")).toBe("'+1 555 0100");
    expect(csvCell("-10% equity")).toBe("'-10% equity");
    expect(csvCell("@handle")).toBe("'@handle");
    expect(csvCell("Engineer, Platform")).toBe('"Engineer, Platform"');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect([csvCell(null), csvCell(undefined), csvCell(85000), csvCell("plain")]).toEqual([
      "",
      "",
      "85000",
      "plain",
    ]);
  });

  it("reads and changes settings, which take effect at once and survive a restart", async () => {
    const initial = (await api("GET", "/api/settings")).body;
    expect(initial).toMatchObject({
      maxConcurrentRuns: 2,
      artifactRetentionRuns: 20,
      defaultMinDelayMs: 1000,
      defaultMaxDelayMs: 3000,
      aiFallbackEnabled: false,
      aiFallbackKeyConfigured: false,
      aiFallbackModel: "claude-opus-5-5",
      aiFallbackMaxCalls: 10,
      aiFallbackAutoApply: false,
      dataDir,
      local: true,
    });
    const changed = await api("PUT", "/api/settings", {
      maxConcurrentRuns: 1,
      defaultMinDelayMs: 0,
      defaultMaxDelayMs: 0,
    });
    expect(changed.body).toMatchObject({
      maxConcurrentRuns: 1,
      artifactRetentionRuns: 20,
      defaultMaxDelayMs: 0,
    });
    expect((await api("PUT", "/api/settings", { maxConcurrentRuns: 0 })).status).toBe(400);
    expect(
      (await api("PUT", "/api/settings", { defaultMinDelayMs: 500 })).body.error.message,
    ).toMatch(/must not exceed/);

    // With one slot, two runs on different hosts no longer overlap.
    const here = await createBoard(SITES.changing, [{ id: "wait", type: "waitFor", ms: 300 }]);
    const there = (
      await api("POST", "/api/recordings", {
        ...board(SITES.changing, [{ id: "wait", type: "waitFor", ms: 300 }], "Elsewhere"),
        startUrl: sites.url(SITES.changing).replace("127.0.0.1", "localhost"),
      })
    ).body.id;
    await api("POST", `/api/recordings/${here}/runs`, {});
    await api("POST", `/api/recordings/${there}/runs`, {});
    await expect.poll(() => server.worker.active().length).toBe(1);
    expect((await api("GET", "/api/health")).body).toMatchObject({ activeRuns: 1, queuedRuns: 1 });
    await server.worker.idle();

    await server.close();
    await start();
    expect((await api("GET", "/api/settings")).body).toMatchObject({
      maxConcurrentRuns: 1,
      defaultMaxDelayMs: 0,
    });
  });

  it("heals a broken step with the AI fallback once it is switched on, and takes over an accepted suggestion", async () => {
    await server.close();
    let calls = 0;
    await start(
      {},
      {
        ai: {
          suggest: async () => {
            calls += 1;
            return {
              stop_reason: "end_turn",
              parsed_output: {
                found: true,
                kind: "css",
                value: ".title",
                name: null,
                reason: "The item's only link.",
              },
            };
          },
        },
      },
    );
    const id = await createBoard();
    const definition = (await api("GET", `/api/recordings/${id}`)).body.definition;
    const titleOf = (target: typeof definition) => target.steps[1].body[0].fields[0].target;
    titleOf(definition).locators = [{ kind: "css", value: ".renamed" }];
    expect((await api("PUT", `/api/recordings/${id}`, definition)).status).toBe(200);

    // Switched off (the default), nothing is sent anywhere and the run fails as it would have.
    const failed = await runToEnd(id);
    expect(failed.run.status).toBe("failed");
    expect(calls).toBe(0);
    expect((await api("GET", `/api/runs/${failed.run.id}/suggestions`)).body).toEqual([]);

    expect(
      (await api("PUT", "/api/settings", { aiFallbackEnabled: true })).body.aiFallbackEnabled,
    ).toBe(true);
    const healed = await runToEnd(id);
    expect(healed.run.status).toBe("succeeded");
    expect(healed.jobs).toHaveLength(changingJobs(1).length);
    expect(calls).toBe(1);

    const url = `/api/runs/${healed.run.id}/suggestions`;
    const open = {
      index: 0,
      stepId: "s3",
      failed: [{ kind: "css", value: ".renamed" }],
      locator: { kind: "css", value: ".title" },
      source: "ai",
      reason: "The item's only link.",
      state: "open",
    };
    expect((await api("GET", url)).body).toEqual([open]);
    // Suggested only: the recording is untouched until someone accepts.
    expect(titleOf((await api("GET", `/api/recordings/${id}`)).body.definition).locators).toEqual(
      open.failed,
    );

    const accepted = await api("POST", `${url}/0/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual([{ ...open, state: "applied" }]);
    const saved = (await api("GET", `/api/recordings/${id}`)).body.definition;
    expect(titleOf(saved).locators).toEqual([open.locator, ...open.failed]);
    // Accepting twice changes nothing more.
    expect((await api("POST", `${url}/0/accept`)).body[0].state).toBe("applied");
    expect(titleOf((await api("GET", `/api/recordings/${id}`)).body.definition).locators).toEqual([
      open.locator,
      ...open.failed,
    ]);
    expect((await api("POST", `${url}/3/accept`)).status).toBe(404);
    expect((await api("GET", "/api/runs/run_nope/suggestions")).status).toBe(404);

    // With the accepted locator the next run needs no help.
    expect((await runToEnd(id)).run.status).toBe("succeeded");
    expect(calls).toBe(1);

    // A suggestion for a target that was edited since no longer fits.
    titleOf(saved).locators = [{ kind: "css", value: "a.title" }];
    await api("PUT", `/api/recordings/${id}`, saved);
    expect((await api("GET", url)).body[0].state).toBe("stale");
    const stale = await api("POST", `${url}/0/accept`);
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/changed or removed/);
  });

  it("serves the UI's page for browser paths, and JSON errors for API paths", async () => {
    await server.close();
    await start();
    const page = await server.app.inject({ url: "/recordings/rec_123" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect((await api("GET", "/api/nope")).body.error.code).toBe("NOT_FOUND");
    expect((await api("POST", "/recordings")).status).toBe(404);
    expect((await api("GET", "/assets/missing.js")).status).toBe(404);
  });
});

describe("schedules", () => {
  it("creates, previews, lists, pauses and deletes schedules", async () => {
    const id = await createBoard();
    const preview = await api(
      "GET",
      `/api/schedules/preview?cron=${encodeURIComponent("0 8 * * 1-5")}&timezone=Europe/Madrid`,
    );
    expect(preview.body).toMatchObject({
      description: "Weekdays at 08:00 Europe/Madrid",
      effectiveTimezone: "Europe/Madrid",
    });
    expect(preview.body.nextRuns).toHaveLength(5);
    const tooOften = await api(
      "GET",
      `/api/schedules/preview?cron=${encodeURIComponent("* * * * *")}`,
    );
    expect(tooOften.status).toBe(400);
    expect(tooOften.body.error.message).toMatch(/at most every 15 minutes/);

    const created = await api("POST", "/api/schedules", {
      recordingId: id,
      cron: "0 8 * * 1-5",
      timezone: "Europe/Madrid",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      recordingId: id,
      enabled: true,
      description: "Weekdays at 08:00 Europe/Madrid",
      lastRunAt: null,
      nextRunAt: created.body.nextRuns[0],
    });
    expect(server.scheduler.registered()).toEqual([created.body.id]);
    expect(
      (await api("POST", "/api/schedules", { recordingId: "rec_nope", cron: "0 8 * * *" })).status,
    ).toBe(404);
    expect(
      (await api("POST", "/api/schedules", { recordingId: id, cron: "every morning" })).body.error
        .message,
    ).toMatch(/needs five fields/);
    expect(
      (
        await api("POST", "/api/schedules", {
          recordingId: id,
          cron: "0 8 * * *",
          timezone: "Mars/Olympus",
        })
      ).status,
    ).toBe(400);

    const paused = await api("PUT", `/api/schedules/${created.body.id}`, { enabled: false });
    expect(paused.body).toMatchObject({ enabled: false, nextRuns: [], cron: "0 8 * * 1-5" });
    expect(server.scheduler.registered()).toEqual([]);
    const moved = await api("PUT", `/api/schedules/${created.body.id}`, {
      enabled: true,
      cron: "30 7 * * *",
      timezone: null,
    });
    expect(moved.body.description).toMatch(/^Every day at 07:30 /);
    expect(moved.body.timezone).toBeNull();
    expect(server.scheduler.registered()).toEqual([created.body.id]);
    expect((await api("PUT", "/api/schedules/sch_nope", { enabled: true })).status).toBe(404);

    expect((await api("GET", "/api/schedules")).body).toHaveLength(1);
    expect((await api("GET", `/api/schedules?recording=${id}`)).body).toHaveLength(1);
    expect((await api("GET", "/api/schedules?recording=rec_other")).body).toEqual([]);
    expect((await api("DELETE", `/api/schedules/${created.body.id}`)).status).toBe(204);
    expect((await api("DELETE", `/api/schedules/${created.body.id}`)).status).toBe(404);
    expect(server.scheduler.registered()).toEqual([]);
  });

  it("a schedule tick queues a run that the worker executes, and a tick during a run is skipped", async () => {
    const id = await createBoard(SITES.changing, [{ id: "wait", type: "waitFor", ms: 400 }]);
    const schedule = (await api("POST", "/api/schedules", { recordingId: id, cron: "0 8 * * *" }))
      .body;

    expect(await server.scheduler.fire(schedule.id)).toBe("enqueued");
    // The same schedule fires again while its run is still going.
    expect(await server.scheduler.fire(schedule.id)).toBe("skipped");
    await server.worker.idle();

    const runs = (await api("GET", `/api/runs?recording=${id}`)).body;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "succeeded",
      trigger: "schedule",
      scheduleId: schedule.id,
      stats: { jobs: 5, newJobs: 5 },
    });
    const after = (await api("GET", "/api/schedules")).body[0];
    expect(after.lastRunAt).not.toBeNull();
    expect(after.nextRunAt).toBe(after.nextRuns[0]);

    // Deleting the recording takes its schedule along.
    await api("DELETE", `/api/recordings/${id}`);
    expect((await api("GET", "/api/schedules")).body).toEqual([]);
    expect(await server.scheduler.fire(schedule.id)).toBe("gone");
  });
});

describe("security and documentation", () => {
  it("only answers requests addressed to localhost, and refuses cross-site requests", async () => {
    expect((await api("GET", "/api/health")).status).toBe(200);
    const rebound = await api("GET", "/api/recordings", undefined, { host: "evil.example" });
    expect(rebound.status).toBe(403);
    expect(rebound.body.error.message).toMatch(/only answers requests addressed to localhost/);
    for (const host of ["127.0.0.1:4317", "[::1]:4317", "LOCALHOST"]) {
      expect((await api("GET", "/api/health", undefined, { host })).status).toBe(200);
    }
    const crossSite = await api("POST", "/api/recordings", board(), {
      origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
    expect(
      (await api("GET", "/api/health", undefined, { origin: "http://localhost:80" })).status,
    ).toBe(200);
    expect((await api("GET", "/api/health", undefined, { origin: "null" })).status).toBe(403);
    expect((await api("GET", "/api/nope")).body).toEqual({
      error: { code: "NOT_FOUND", message: "No such route" },
    });
  });

  it("requires the API token when one is configured, and keeps windows local", async () => {
    await server.close();
    await start({ HOST: "0.0.0.0", API_TOKEN: "s3cret-token" });
    const headers = { authorization: "Bearer s3cret-token" };
    expect((await api("GET", "/api/health")).status).toBe(200);
    expect((await api("GET", "/api/recordings")).status).toBe(401);
    expect(
      (await api("GET", "/api/recordings", undefined, { authorization: "Bearer wrong-token-xx" }))
        .status,
    ).toBe(401);
    expect((await api("GET", "/api/recordings", undefined, headers)).status).toBe(200);
    // A token in the URL is accepted for event streams only.
    expect((await api("GET", "/api/recordings?access_token=s3cret-token")).status).toBe(401);
    const id = (await api("POST", "/api/recordings", board(), headers)).body.id;
    const run = (await api("POST", `/api/recordings/${id}/runs`, {}, headers)).body;
    await server.worker.idle();
    expect(
      (await api("GET", `/api/runs/${run.id}/events/stream?access_token=s3cret-token`)).status,
    ).toBe(200);
    expect((await api("GET", `/api/runs/${run.id}/events/stream`)).status).toBe(401);

    // Not bound to localhost: opening windows on the server's screen is refused.
    const refused = await api("POST", "/api/recordings/record", { url: sites.url("/") }, headers);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(
      /only available when the server is bound to localhost/,
    );
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(/API_TOKEN is required/);
  });

  it("configured as in Docker: answers to localhost names only, without a token, and opens no windows", async () => {
    await server.close();
    await start({ HOST: "0.0.0.0", ALLOWED_HOSTS: "localhost,127.0.0.1", HEADLESS_ONLY: "true" });
    expect((await api("GET", "/api/recordings")).status).toBe(200);
    expect(
      (await api("GET", "/api/recordings", undefined, { host: "127.0.0.1:4317" })).status,
    ).toBe(200);
    expect((await api("GET", "/api/recordings", undefined, { host: "evil.example" })).status).toBe(
      403,
    );
    expect((await api("GET", "/api/recordings", undefined, { host: "[::1]:4317" })).status).toBe(
      403,
    );
    expect((await api("GET", "/api/settings")).body.local).toBe(false);

    const id = await createBoard();
    const headed = await api("POST", `/api/recordings/${id}/runs`, { headed: true });
    expect(headed.status).toBe(400);
    expect(headed.body.error.message).toMatch(/cannot show a browser window/);
    expect((await api("POST", `/api/recordings/${id}/runs`, {})).status).toBe(202);
    await server.worker.idle();

    const login = await api("POST", "/api/auth-profiles", { name: "x", url: sites.url("/") });
    expect(login.body.error.message).toMatch(/runs in a container/);
    // A login captured elsewhere can be sent in; ids are checked since they name a file.
    const state = { cookies: [{ name: "sid", value: "abc" }], origins: [] };
    const sent = await api("PUT", "/api/auth-profiles/auth_01ABC/session", {
      name: "Sent",
      domain: "x.example",
      storageState: state,
    });
    expect(sent.body).toEqual({
      id: "auth_01ABC",
      name: "Sent",
      domain: "x.example",
      createdAt: expect.any(String),
      lastVerifiedAt: null,
      usedBy: 0,
    });
    expect(
      (
        await api("PUT", "/api/auth-profiles/..%2Fescape/session", {
          name: "x",
          domain: "x",
          storageState: state,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("PUT", "/api/auth-profiles/auth_01ABC/session", {
          name: "x",
          domain: "x",
          storageState: {},
        })
      ).status,
    ).toBe(400);
  });

  it("publishes an OpenAPI description of every route", async () => {
    const spec = (await api("GET", "/api/docs/json")).body;
    expect(spec.info.title).toBe("JobTrace API");
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/api/recordings",
        "/api/recordings/{id}",
        "/api/recordings/{id}/versions",
        "/api/recordings/{id}/runs",
        "/api/recordings/record",
        "/api/record-sessions/{id}",
        "/api/sources",
        "/api/runs",
        "/api/runs/{id}",
        "/api/runs/{id}/cancel",
        "/api/runs/{id}/events/stream",
        "/api/runs/{id}/artifacts/{artifactId}",
        "/api/jobs",
        "/api/jobs/{id}",
        "/api/auth-profiles",
        "/api/schedules",
        "/api/schedules/{id}",
        "/api/schedules/preview",
        "/api/settings",
        "/api/health",
      ]),
    );
    expect(
      spec.paths["/api/jobs"].get.parameters.map((parameter: { name: string }) => parameter.name),
    ).toEqual(expect.arrayContaining(["recording", "new", "q", "from", "to", "page"]));
    expect(
      spec.paths["/api/runs/{id}"].get.responses["200"].content["application/json"].schema
        .properties,
    ).toHaveProperty("jobs");
    expect((await server.app.inject({ url: "/api/docs" })).statusCode).toBeLessThan(400);
  });
});
