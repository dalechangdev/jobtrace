import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecording, type RecordingInput } from "@jobtrace/core";
import { type Database, openDatabase } from "@jobtrace/db";
import { createPoliteness } from "@jobtrace/politeness";
import { type RunningTestSites, SITES, startTestSites } from "@jobtrace/test-sites";
import { type Browser, chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRunHub, type RunHub } from "./hub.ts";
import { createDbQueue, type JobQueue } from "./queue.ts";
import { createWorker, type Worker, type WorkerOptions } from "./worker.ts";

let sites: RunningTestSites;
let browser: Browser;
let dataDir: string;
let db: Database;
let hub: RunHub;
let queue: JobQueue;
let worker: Worker;

beforeAll(async () => {
  sites = await startTestSites();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
});
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "jobtrace-worker-"));
  db = openDatabase(":memory:");
  hub = createRunHub();
});
afterEach(async () => {
  await worker?.stop();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function build(overrides: Partial<WorkerOptions> = {}) {
  queue = createDbQueue(db, { onEnqueue: () => worker.wake() });
  worker = createWorker({
    db,
    queue,
    hub,
    dataDir,
    artifactRetentionRuns: 20,
    maxConcurrentRuns: 2,
    pollIntervalMs: 50,
    politeness: createPoliteness(),
    run: {
      browser,
      settings: { minDelayMs: 0, maxDelayMs: 0, stepTimeoutMs: 2000 },
      tuning: { pollIntervalMs: 25, fallbackGraceMs: 100, optionalFieldTimeoutMs: 100 },
    },
    ...overrides,
  });
  return worker;
}

/** A recording that lists the static board; `origin` lets two recordings live on different hosts. */
function board(
  id: string,
  extra: RecordingInput["steps"] = [],
  origin = sites.origin,
  path: string = SITES.staticList,
) {
  return parseRecording({
    schemaVersion: 2,
    id,
    name: id,
    startUrl: `${origin}${path}`,
    params: { query: { default: "" } },
    steps: [
      { id: "s1", type: "navigate", url: `${origin}${path}?q={{params.query}}` },
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
              {
                name: "title",
                target: { locators: [{ kind: "css", value: ".title" }], relativeTo: "item" },
              },
            ],
          },
        ],
      },
    ],
  } satisfies RecordingInput);
}
const pause = (ms: number): RecordingInput["steps"] => [{ id: "wait", type: "waitFor", ms }];

describe("worker", () => {
  it("executes queued runs with their own params, and reports through the hub", async () => {
    await db.recordings.save(board("rec_a"));
    build();
    await worker.start();
    const run = await queue.enqueue({
      recordingId: "rec_a",
      trigger: "manual",
      params: { query: "designer" },
    });
    expect(run).toMatchObject({ status: "queued", params: { query: "designer" } });

    const seen: string[] = [];
    let finished = false;
    hub.subscribe(run.id, {
      onEvent: (event) => seen.push(event.type),
      onFinish: () => (finished = true),
    });
    await worker.idle();

    const done = await db.runs.get(run.id);
    expect(done).toMatchObject({
      status: "succeeded",
      trigger: "manual",
      stats: { jobs: 1, newJobs: 1 },
    });
    expect((await db.jobs.forRun(run.id)).map((job) => job.title)).toEqual(["Product Designer"]);
    expect(finished).toBe(true);
    expect(seen).toEqual(expect.arrayContaining(["for_each", "run_finished", "jobs_saved"]));
    expect(worker.active()).toEqual([]);
  });

  it("runs two recordings on the same site one after the other, and other sites alongside", async () => {
    const elsewhere = sites.origin.replace("127.0.0.1", "localhost");
    await db.recordings.save(board("rec_a", pause(300)));
    await db.recordings.save(board("rec_b", pause(300)));
    await db.recordings.save(board("rec_c", pause(300), elsewhere));
    build({ maxConcurrentRuns: 3 });
    const [a, b, c] = await Promise.all(
      ["rec_a", "rec_b", "rec_c"].map((recordingId) =>
        queue.enqueue({ recordingId, trigger: "manual" }),
      ),
    );
    await worker.start();
    // The two runs on 127.0.0.1 never overlap; the localhost one does not wait for them.
    expect(worker.active().sort()).toEqual([a?.id, c?.id].sort());
    expect((await db.runs.get(b?.id ?? ""))?.status).toBe("queued");
    await worker.idle();

    const [runA, runB, runC] = await Promise.all(
      [a, b, c].map((run) => db.runs.get(run?.id ?? "")),
    );
    expect([runA?.status, runB?.status, runC?.status]).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect((runB?.startedAt ?? "") >= (runA?.finishedAt ?? "x")).toBe(true);
    expect((runC?.startedAt ?? "x") < (runA?.finishedAt ?? "")).toBe(true);
  });

  it("never runs more than maxConcurrentRuns at once", async () => {
    const hosts = [sites.origin, sites.origin.replace("127.0.0.1", "localhost")];
    await db.recordings.save(board("rec_a", pause(300), hosts[0]));
    await db.recordings.save(board("rec_b", pause(300), hosts[1]));
    build({ maxConcurrentRuns: 1 });
    await queue.enqueue({ recordingId: "rec_a", trigger: "manual" });
    await queue.enqueue({ recordingId: "rec_b", trigger: "manual" });
    await worker.start();
    expect(worker.active()).toHaveLength(1);
    await worker.idle();
    expect((await db.runs.list()).map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("cancels a running run and a queued one", async () => {
    await db.recordings.save(board("rec_a", pause(10_000)));
    build({ maxConcurrentRuns: 1 });
    await worker.start();
    const running = await queue.enqueue({ recordingId: "rec_a", trigger: "manual" });
    const queued = await queue.enqueue({ recordingId: "rec_a", trigger: "manual" });
    await expect.poll(() => worker.active()).toEqual([running.id]);

    let queuedFinished = false;
    hub.subscribe(queued.id, { onEvent: () => {}, onFinish: () => (queuedFinished = true) });
    expect(await worker.cancel(queued.id)).toBe(true);
    expect(queuedFinished).toBe(true);
    expect(await db.runs.get(queued.id)).toMatchObject({
      status: "cancelled",
      reason: "run_cancelled",
    });

    const started = Date.now();
    expect(await worker.cancel(running.id)).toBe(true);
    await worker.idle();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await db.runs.get(running.id)).toMatchObject({
      status: "cancelled",
      reason: "run_cancelled",
    });
    // Nothing left to cancel.
    expect(await worker.cancel(running.id)).toBe(false);
    expect(await worker.cancel("run_nope")).toBe(false);
  });

  it("on start, fails runs a crashed process left running, then carries on with the queue", async () => {
    await db.recordings.save(board("rec_a"));
    const orphan = await db.runs.create({
      recordingId: "rec_a",
      trigger: "manual",
      status: "running",
    });
    build();
    const waiting = await queue.enqueue({ recordingId: "rec_a", trigger: "schedule" });
    await worker.start();
    expect(await db.runs.get(orphan.id)).toMatchObject({ status: "failed", reason: "interrupted" });
    await worker.idle();
    expect(await db.runs.get(waiting.id)).toMatchObject({
      status: "succeeded",
      trigger: "schedule",
    });
  });

  it("cancels what is running when stopped, and leaves the rest queued", async () => {
    await db.recordings.save(board("rec_a", pause(10_000)));
    build({ maxConcurrentRuns: 1 });
    await worker.start();
    const first = await queue.enqueue({ recordingId: "rec_a", trigger: "manual" });
    const second = await queue.enqueue({ recordingId: "rec_a", trigger: "manual" });
    await expect.poll(() => worker.active()).toEqual([first.id]);
    await worker.stop();
    expect((await db.runs.get(first.id))?.status).toBe("cancelled");
    expect((await db.runs.get(second.id))?.status).toBe("queued");
  });

  it("rejects runs for unknown recordings, and survives a run that crashes", async () => {
    build();
    await expect(
      queue.enqueue({ recordingId: "rec_nope", trigger: "manual" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await db.recordings.save(board("rec_a"));
    const errors: unknown[] = [];
    const broken: Database = {
      ...db,
      jobs: { ...db.jobs, saveRunJobs: async () => Promise.reject(new Error("disk full")) },
    };
    queue = createDbQueue(db);
    worker = createWorker({
      db: broken,
      queue,
      hub,
      dataDir,
      artifactRetentionRuns: 20,
      maxConcurrentRuns: 1,
      pollIntervalMs: 50,
      run: { browser, settings: { minDelayMs: 0, maxDelayMs: 0 } },
      onError: (error) => errors.push(error),
    });
    const run = await queue.enqueue({ recordingId: "rec_a", trigger: "manual" });
    await worker.start();
    await worker.idle();
    expect(errors).toHaveLength(1);
    expect(await db.runs.get(run.id)).toMatchObject({ status: "failed", reason: "internal_error" });
    expect((await queue.fail(run.id, "interrupted", "restart")).reason).toBe("interrupted");
  });
});
