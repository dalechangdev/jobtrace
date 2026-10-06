import { JobTraceError } from "@jobtrace/core";
import type { Database, Schedule } from "@jobtrace/db";
import { Cron } from "croner";
import { describeCron, nextRuns, resolveTimezone, validateSchedule } from "./cron.ts";
import type { JobQueue } from "./queue.ts";

/** A schedule as shown to people: with its time zone resolved, in words, and its next runs. */
export interface ScheduleView extends Schedule {
  /** The time zone in effect (the server's when the schedule has none). */
  effectiveTimezone: string;
  description: string;
  /** The next five times it fires, as ISO timestamps. Empty when disabled. */
  nextRuns: string[];
}

export function scheduleView(schedule: Schedule, now: Date = new Date()): ScheduleView {
  let upcoming: string[] = [];
  try {
    if (schedule.enabled)
      upcoming = nextRuns(schedule.cron, schedule.timezone, 5, now).map((date) =>
        date.toISOString(),
      );
  } catch {
    // A stored expression this version cannot read: shown without upcoming runs.
  }
  return {
    ...schedule,
    effectiveTimezone: resolveTimezone(schedule.timezone),
    description: describeCron(schedule.cron, schedule.timezone),
    nextRuns: upcoming,
  };
}

export interface ScheduleInput {
  recordingId: string;
  cron: string;
  timezone?: string | null;
  params?: Record<string, string>;
  enabled?: boolean;
}

/** Validates and stores a new schedule. */
export async function createSchedule(db: Database, input: ScheduleInput): Promise<Schedule> {
  if (!(await db.recordings.get(input.recordingId))) {
    throw new JobTraceError("NOT_FOUND", `No recording ${input.recordingId}`);
  }
  const cron = input.cron.trim().replace(/\s+/g, " ");
  validateSchedule(cron, input.timezone ?? null);
  return db.schedules.create({
    recordingId: input.recordingId,
    cron,
    timezone: input.timezone || null,
    ...(input.params ? { params: input.params } : {}),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  });
}

/** Validates and applies changes to a schedule. Throws NOT_FOUND when it does not exist. */
export async function updateSchedule(
  db: Database,
  id: string,
  patch: Partial<Omit<ScheduleInput, "recordingId">>,
): Promise<Schedule> {
  const current = await db.schedules.get(id);
  if (!current) throw new JobTraceError("NOT_FOUND", `No schedule ${id}`);
  const cron = patch.cron === undefined ? current.cron : patch.cron.trim().replace(/\s+/g, " ");
  const timezone = patch.timezone === undefined ? current.timezone : patch.timezone || null;
  validateSchedule(cron, timezone);
  return (await db.schedules.update(id, {
    cron,
    timezone,
    ...(patch.params === undefined ? {} : { params: patch.params }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    // The stored next run belongs to the old expression.
    nextRunAt: null,
  })) as Schedule;
}

export type SchedulerLog = (
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
) => void;

export interface SchedulerOptions {
  db: Database;
  queue: JobQueue;
  onLog?: SchedulerLog;
  /**
   * How often to re-read the schedules from the database, which is how changes
   * made by another process (the CLI) are picked up. 0 turns it off.
   */
  syncIntervalMs?: number;
}

export type FireOutcome = "enqueued" | "skipped" | "gone";

export interface Scheduler {
  /** Notes runs missed while the server was down, registers every enabled schedule, and starts syncing. */
  start(): Promise<void>;
  /** Re-reads the schedules now; call after creating, changing or deleting one. */
  reload(): Promise<void>;
  /** What a schedule's tick does: queue a run, unless the recording already has one going. */
  fire(scheduleId: string): Promise<FireOutcome>;
  /** Ids of the schedules currently registered. */
  registered(): string[];
  stop(): void;
}

/**
 * Turns stored schedules into queued runs. Each enabled schedule gets a timer
 * in its own time zone; a tick queues a run with trigger `schedule`. Runs that
 * were due while the process was not running are not made up for.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { db, queue } = options;
  const log: SchedulerLog = (level, message, data) => options.onLog?.(level, message, data);
  const timers = new Map<string, { cron: Cron; signature: string }>();
  let sync: ReturnType<typeof setInterval> | undefined;
  const signatureOf = (schedule: Schedule) => `${schedule.cron}|${schedule.timezone ?? ""}`;

  async function fire(scheduleId: string): Promise<FireOutcome> {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule?.enabled) return "gone";
    const now = new Date();
    const next = timers.get(scheduleId)?.cron.nextRun(now)?.toISOString() ?? null;
    if (await db.runs.hasActive(schedule.recordingId)) {
      // The previous run is still queued or running: this tick is skipped, not stacked up.
      log("warn", "Skipped a scheduled run: the recording already has a run queued or running", {
        scheduleId,
        recordingId: schedule.recordingId,
      });
      await db.schedules.update(scheduleId, { nextRunAt: next });
      return "skipped";
    }
    const run = await queue.enqueue({
      recordingId: schedule.recordingId,
      trigger: "schedule",
      scheduleId,
      params: schedule.params,
    });
    await db.schedules.update(scheduleId, { lastRunAt: now.toISOString(), nextRunAt: next });
    log("info", "Queued a scheduled run", {
      scheduleId,
      recordingId: schedule.recordingId,
      runId: run.id,
    });
    return "enqueued";
  }

  async function reload(): Promise<void> {
    const enabled = await db.schedules.list({ enabled: true });
    const wanted = new Map(enabled.map((schedule) => [schedule.id, schedule]));
    for (const [id, timer] of timers) {
      const schedule = wanted.get(id);
      if (!schedule || signatureOf(schedule) !== timer.signature) {
        timer.cron.stop();
        timers.delete(id);
      }
    }
    for (const schedule of enabled) {
      if (timers.has(schedule.id)) continue;
      try {
        const cron = new Cron(
          schedule.cron,
          {
            timezone: resolveTimezone(schedule.timezone),
            unref: true,
            catch: (error: unknown) =>
              log("error", `A scheduled tick failed: ${(error as Error).message}`, {
                scheduleId: schedule.id,
              }),
          },
          () => fire(schedule.id).then(() => {}),
        );
        timers.set(schedule.id, { cron, signature: signatureOf(schedule) });
        const next = cron.nextRun()?.toISOString() ?? null;
        if (next !== schedule.nextRunAt)
          await db.schedules.update(schedule.id, { nextRunAt: next });
      } catch (error) {
        log(
          "error",
          `Schedule ${schedule.id} could not be registered: ${(error as Error).message}`,
          {
            scheduleId: schedule.id,
          },
        );
      }
    }
  }

  return {
    async start() {
      const now = new Date().toISOString();
      for (const schedule of await db.schedules.list({ enabled: true })) {
        if (schedule.nextRunAt && schedule.nextRunAt < now) {
          log(
            "warn",
            "A scheduled run was due while JobTrace was not running; it is not made up for",
            {
              scheduleId: schedule.id,
              recordingId: schedule.recordingId,
              dueAt: schedule.nextRunAt,
            },
          );
        }
      }
      await reload();
      const interval = options.syncIntervalMs ?? 30_000;
      if (interval > 0) {
        sync = setInterval(
          () =>
            void reload().catch((error) =>
              log("error", `Could not re-read schedules: ${(error as Error).message}`),
            ),
          interval,
        );
        sync.unref();
      }
    },
    reload,
    fire,
    registered: () => [...timers.keys()],
    stop() {
      if (sync) clearInterval(sync);
      for (const timer of timers.values()) timer.cron.stop();
      timers.clear();
    },
  };
}
