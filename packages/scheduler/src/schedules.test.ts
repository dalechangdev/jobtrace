import { parseRecording } from "@jobtrace/core";
import { type Database, openDatabase } from "@jobtrace/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeCron, nextRuns, validateSchedule } from "./cron.ts";
import { createDbQueue, type JobQueue } from "./queue.ts";
import {
  createSchedule,
  createScheduler,
  type Scheduler,
  scheduleView,
  updateSchedule,
} from "./schedules.ts";

let db: Database;
let queue: JobQueue;
let scheduler: Scheduler;
let logs: Array<{ level: string; message: string; data?: Record<string, unknown> | undefined }>;

beforeEach(async () => {
  db = openDatabase(":memory:");
  queue = createDbQueue(db);
  logs = [];
  scheduler = createScheduler({
    db,
    queue,
    syncIntervalMs: 0,
    onLog: (level, message, data) => logs.push({ level, message, data }),
  });
  for (const id of ["rec_a", "rec_b"]) {
    await db.recordings.save(
      parseRecording({
        schemaVersion: 2,
        id,
        name: id,
        startUrl: "https://x.example/jobs",
        steps: [],
      }),
    );
  }
});
afterEach(() => {
  scheduler.stop();
  vi.useRealTimers();
  db.close();
});

const runsOf = async (recordingId: string) => (await db.runs.list({ recordingId })).reverse();
/** Lets the promise chain started by a timer tick (database calls) settle. */
const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

describe("cron expressions", () => {
  it("computes next runs in the schedule's time zone, across a daylight-saving change", () => {
    const from = new Date("2026-10-23T12:00:00Z");
    // 08:00 in Madrid is 06:00 UTC in summer time and 07:00 UTC after the clocks go back on 25 October.
    expect(
      nextRuns("0 8 * * *", "Europe/Madrid", 4, from).map((date) => date.toISOString()),
    ).toEqual([
      "2026-10-24T06:00:00.000Z",
      "2026-10-25T07:00:00.000Z",
      "2026-10-26T07:00:00.000Z",
      "2026-10-27T07:00:00.000Z",
    ]);
    expect(
      nextRuns("0 8 * * 1-5", "America/New_York", 2, from).map((date) => date.toISOString()),
    ).toEqual(["2026-10-26T12:00:00.000Z", "2026-10-27T12:00:00.000Z"]);
    expect(nextRuns("0 8 * * *", "UTC", 1, from)[0]?.toISOString()).toBe(
      "2026-10-24T08:00:00.000Z",
    );
  });

  it.each([
    ["0 8 * * 1-5", "Weekdays at 08:00"],
    ["30 7 * * *", "Every day at 07:30"],
    ["0 9 * * 1", "Mondays at 09:00"],
    ["0 9 * * 1,3,5", "Mondays, Wednesdays and Fridays at 09:00"],
    ["0 10 * * 0,6", "Weekends at 10:00"],
    ["0 8,18 * * *", "Every day at 08:00 and 18:00"],
    ["15 * * * *", "Every hour at :15"],
    ["0 */6 * * *", "Every 6 hours at :00"],
    ["*/30 * * * *", "Every 30 minutes"],
    ["0 6 1 * *", "On day 1 of every month at 06:00"],
    ["0 6 1,15 * *", "On day 1 and 15 of every month at 06:00"],
    ["0 8 * 6 *", "Custom schedule (0 8 * 6 *)"],
    ["0 8-10 * * *", "Custom schedule (0 8-10 * * *)"],
  ])("describes %s as %s", (cron, expected) => {
    expect(describeCron(cron, "Europe/Madrid")).toBe(`${expected} Europe/Madrid`);
  });

  it("uses the server's time zone when a schedule has none", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(describeCron("0 8 * * *", null)).toBe(`Every day at 08:00 ${zone}`);
  });

  it("rejects malformed, too frequent and impossible schedules with a useful message", () => {
    const message = (cron: string, timezone: string | null = null) => {
      try {
        validateSchedule(cron, timezone);
      } catch (error) {
        return (error as Error).message;
      }
      return "accepted";
    };
    expect(message("0 8 * * 1-5", "Europe/Madrid")).toBe("accepted");
    expect(message("*/15 * * * *")).toBe("accepted");
    expect(message("nope")).toMatch(/needs five fields/);
    expect(message("0 0 8 * * *")).toMatch(/needs five fields/);
    expect(message("61 8 * * *")).toMatch(/is not a valid schedule/);
    expect(message("0 8 * * *", "Mars/Olympus")).toMatch(
      /"Mars\/Olympus" is not a known time zone/,
    );
    expect(message("* * * * *")).toMatch(
      /would run every 1 minute\(s\)\. Schedules may fire at most every 15 minutes/,
    );
    expect(message("*/5 * * * *")).toMatch(/every 5 minute/);
    // Twice an hour is fine on its own, but 0 and 10 past are only ten minutes apart.
    expect(message("0,10 * * * *")).toMatch(/every 10 minute/);
  });
});

describe("schedule storage", () => {
  it("validates on create and update, normalizes spacing, and shows the schedule in words", async () => {
    const created = await createSchedule(db, {
      recordingId: "rec_a",
      cron: " 0  8 * * 1-5 ",
      timezone: "Europe/Madrid",
      params: { q: "rust" },
    });
    expect(created).toMatchObject({
      cron: "0 8 * * 1-5",
      timezone: "Europe/Madrid",
      enabled: true,
      params: { q: "rust" },
      lastRunAt: null,
    });
    expect(created.id).toMatch(/^sch_/);
    const view = scheduleView(created, new Date("2026-10-06T12:00:00Z"));
    expect(view).toMatchObject({
      description: "Weekdays at 08:00 Europe/Madrid",
      effectiveTimezone: "Europe/Madrid",
    });
    expect(view.nextRuns).toEqual([
      "2026-10-07T06:00:00.000Z",
      "2026-10-08T06:00:00.000Z",
      "2026-10-09T06:00:00.000Z",
      "2026-10-12T06:00:00.000Z",
      "2026-10-13T06:00:00.000Z",
    ]);

    await expect(
      createSchedule(db, { recordingId: "rec_nope", cron: "0 8 * * *" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createSchedule(db, { recordingId: "rec_a", cron: "* * * * *" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const paused = await updateSchedule(db, created.id, { enabled: false, cron: "0 9 * * *" });
    expect(paused).toMatchObject({
      enabled: false,
      cron: "0 9 * * *",
      timezone: "Europe/Madrid",
      params: { q: "rust" },
    });
    expect(scheduleView(paused).nextRuns).toEqual([]);
    await expect(updateSchedule(db, created.id, { timezone: "Nowhere/Land" })).rejects.toThrow(
      /not a known time zone/,
    );
    await expect(updateSchedule(db, "sch_nope", { enabled: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await db.schedules.get(created.id))?.timezone).toBe("Europe/Madrid");

    expect(await db.schedules.list({ recordingId: "rec_b" })).toEqual([]);
    expect(await db.schedules.delete(created.id)).toBe(true);
    expect(await db.schedules.delete(created.id)).toBe(false);
  });

  it("goes away with its recording", async () => {
    await createSchedule(db, { recordingId: "rec_a", cron: "0 8 * * *" });
    await db.recordings.delete("rec_a");
    expect(await db.schedules.list()).toEqual([]);
  });
});

describe("scheduler", () => {
  it("fires each schedule at its own times, in its own time zone", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-06T05:30:00Z") });
    const madrid = await createSchedule(db, {
      recordingId: "rec_a",
      cron: "0 8 * * *",
      timezone: "Europe/Madrid",
    });
    const tokyo = await createSchedule(db, {
      recordingId: "rec_b",
      cron: "0 8 * * *",
      timezone: "Asia/Tokyo",
    });
    await scheduler.start();
    expect(scheduler.registered().sort()).toEqual([madrid.id, tokyo.id].sort());
    expect((await db.schedules.get(madrid.id))?.nextRunAt).toBe("2026-10-06T06:00:00.000Z");
    expect((await db.schedules.get(tokyo.id))?.nextRunAt).toBe("2026-10-06T23:00:00.000Z");

    // 08:00 in Madrid is 06:00 UTC: only that schedule fires in the next hour.
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    await settle();
    expect(await runsOf("rec_a")).toMatchObject([
      { status: "queued", trigger: "schedule", scheduleId: madrid.id },
    ]);
    expect(await runsOf("rec_b")).toEqual([]);
    expect(await db.schedules.get(madrid.id)).toMatchObject({
      lastRunAt: "2026-10-06T06:00:00.000Z",
      nextRunAt: "2026-10-07T06:00:00.000Z",
    });

    // 08:00 in Tokyo is 23:00 UTC the same day.
    await vi.advanceTimersByTimeAsync(17 * 3_600_000);
    await settle();
    expect(await runsOf("rec_b")).toMatchObject([{ trigger: "schedule", scheduleId: tokyo.id }]);
    expect(logs.filter((entry) => entry.message === "Queued a scheduled run")).toHaveLength(2);
  });

  it("skips a tick while the recording still has a run queued or running", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-06T07:50:00Z") });
    const schedule = await createSchedule(db, {
      recordingId: "rec_a",
      cron: "0 * * * *",
      timezone: "UTC",
      params: { q: "go" },
    });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await settle();
    const [first] = await runsOf("rec_a");
    expect(first).toMatchObject({ status: "queued", params: { q: "go" } });

    // Nothing has executed that run an hour later: the next tick does not pile another one on.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await settle();
    expect(await runsOf("rec_a")).toHaveLength(1);
    expect(logs.at(-1)).toMatchObject({
      level: "warn",
      message: expect.stringMatching(/^Skipped a scheduled run/),
      data: { scheduleId: schedule.id },
    });
    expect(await db.schedules.get(schedule.id)).toMatchObject({
      lastRunAt: "2026-10-06T08:00:00.000Z",
      nextRunAt: "2026-10-06T10:00:00.000Z",
    });

    // Still skipped while it is running; resumed once it has finished.
    await db.runs.markRunning(first?.id ?? "");
    expect(await scheduler.fire(schedule.id)).toBe("skipped");
    await db.runs.cancelQueued(first?.id ?? "");
    await queue.fail(first?.id ?? "", "interrupted", "test");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await settle();
    expect(await runsOf("rec_a")).toHaveLength(2);
    // A run on another recording never blocks this one.
    await queue.enqueue({ recordingId: "rec_b", trigger: "manual" });
    expect(await db.runs.hasActive("rec_b")).toBe(true);
  });

  it("follows changes: new, edited, disabled and deleted schedules", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-06T07:50:00Z") });
    await scheduler.start();
    expect(scheduler.registered()).toEqual([]);

    const schedule = await createSchedule(db, {
      recordingId: "rec_a",
      cron: "0 8 * * *",
      timezone: "UTC",
    });
    await scheduler.reload();
    expect(scheduler.registered()).toEqual([schedule.id]);

    // Moved an hour later: 08:00 passes without a run, 09:00 brings one.
    await updateSchedule(db, schedule.id, { cron: "0 9 * * *" });
    await scheduler.reload();
    expect((await db.schedules.get(schedule.id))?.nextRunAt).toBe("2026-10-06T09:00:00.000Z");
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await settle();
    expect(await runsOf("rec_a")).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await settle();
    expect(await runsOf("rec_a")).toHaveLength(1);

    await updateSchedule(db, schedule.id, { enabled: false });
    await scheduler.reload();
    expect(scheduler.registered()).toEqual([]);
    expect(await scheduler.fire(schedule.id)).toBe("gone");
    await updateSchedule(db, schedule.id, { enabled: true });
    await scheduler.reload();
    await db.schedules.delete(schedule.id);
    await scheduler.reload();
    expect(scheduler.registered()).toEqual([]);
    expect(await scheduler.fire(schedule.id)).toBe("gone");
  });

  it("picks up schedules changed by another process, by re-reading them", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-06T07:50:00Z") });
    scheduler = createScheduler({ db, queue, syncIntervalMs: 30_000 });
    await scheduler.start();
    // As the CLI would: straight into the database, without telling the scheduler.
    const schedule = await createSchedule(db, {
      recordingId: "rec_a",
      cron: "0 8 * * *",
      timezone: "UTC",
    });
    expect(scheduler.registered()).toEqual([]);
    await vi.advanceTimersByTimeAsync(31_000);
    await settle();
    expect(scheduler.registered()).toEqual([schedule.id]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(await runsOf("rec_a")).toHaveLength(1);
  });

  it("does not make up for runs missed while it was not running, but says so", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-06T07:50:00Z") });
    const schedule = await createSchedule(db, {
      recordingId: "rec_a",
      cron: "0 8 * * *",
      timezone: "UTC",
    });
    await scheduler.start();
    scheduler.stop();
    // The process is down for three days.
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    await scheduler.start();
    expect(await runsOf("rec_a")).toEqual([]);
    expect(
      logs.find((entry) => /was due while JobTrace was not running/.test(entry.message)),
    ).toMatchObject({
      level: "warn",
      data: { scheduleId: schedule.id, dueAt: "2026-10-06T08:00:00.000Z" },
    });
    expect((await db.schedules.get(schedule.id))?.nextRunAt).toBe("2026-10-10T08:00:00.000Z");
  });

  it("survives a schedule whose stored expression it cannot read", async () => {
    await db.schedules.create({ recordingId: "rec_a", cron: "not a cron", timezone: null });
    const good = await createSchedule(db, { recordingId: "rec_b", cron: "0 8 * * *" });
    await scheduler.start();
    expect(scheduler.registered()).toEqual([good.id]);
    expect(
      logs.some(
        (entry) => entry.level === "error" && /could not be registered/.test(entry.message),
      ),
    ).toBe(true);
  });
});
