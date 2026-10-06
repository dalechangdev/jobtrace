import type { Database, RunRecord } from "@jobtrace/db";
import type { Politeness } from "@jobtrace/politeness";
import { type ExecuteRunOptions, executeRun } from "./execute.ts";
import type { RunHub } from "./hub.ts";
import type { JobQueue } from "./queue.ts";

export interface WorkerOptions {
  db: Database;
  queue: JobQueue;
  hub: RunHub;
  dataDir: string;
  /** Numbers, or functions read each time so the settings can change while running. */
  artifactRetentionRuns: number | (() => number);
  maxConcurrentRuns: number | (() => number);
  politeness?: Politeness;
  /** How often to look for queued runs when nothing wakes the worker. */
  pollIntervalMs?: number;
  /** Extra replay options for every run (tests pass a shared browser and timings). */
  run?: ExecuteRunOptions["run"];
  source?: ExecuteRunOptions["source"];
  onError?: (error: unknown, run: RunRecord) => void;
}

export interface Worker {
  /** Recovers from a crash (runs left "running" are failed as interrupted) and starts polling. */
  start(): Promise<void>;
  /** Looks for queued runs now instead of at the next poll. */
  wake(): void;
  /** Cancels a run that is running here or still queued. False when it is neither. */
  cancel(runId: string): Promise<boolean>;
  /** Ids of the runs currently executing. */
  active(): string[];
  /** Resolves when nothing is running and nothing is queued. */
  idle(): Promise<void>;
  /** Stops polling, cancels running runs, and waits for them to wind down. */
  stop(): Promise<void>;
}

/**
 * Executes queued runs, up to `maxConcurrentRuns` at a time and never two on
 * the same site: a queued run for a busy site is passed over until that site is free.
 */
export function createWorker(options: WorkerOptions): Worker {
  const { db, queue, hub } = options;
  const running = new Map<
    string,
    { controller: AbortController; domain: string; done: Promise<void> }
  >();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = true;
  let ticking = false;
  let again = false;
  const read = (value: number | (() => number)) => (typeof value === "function" ? value() : value);

  async function launch(run: RunRecord, domain: string) {
    const controller = new AbortController();
    const done = executeRun(db, run.recordingId, {
      runId: run.id,
      trigger: run.trigger,
      dataDir: options.dataDir,
      artifactRetentionRuns: read(options.artifactRetentionRuns),
      ...(options.politeness ? { politeness: options.politeness } : {}),
      ...(run.scheduleId ? { scheduleId: run.scheduleId } : {}),
      run: { ...options.run, signal: controller.signal },
      ...(options.source ? { source: options.source } : {}),
      onEvent: (event) => hub.publish(run.id, event),
    })
      .then(
        () => {},
        (error) => options.onError?.(error, run),
      )
      .finally(() => {
        running.delete(run.id);
        hub.finish(run.id);
        void tick();
      });
    running.set(run.id, { controller, domain, done });
  }

  async function tick() {
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    try {
      do {
        again = false;
        while (!stopped && running.size < read(options.maxConcurrentRuns)) {
          const busy = [...running.values()].map((entry) => entry.domain);
          const run = await queue.claimNext(busy);
          if (!run) break;
          const recording = await db.recordings.get(run.recordingId);
          await launch(run, recording?.domain ?? "");
        }
      } while (again);
    } finally {
      ticking = false;
    }
  }

  return {
    async start() {
      await db.runs.failInterrupted();
      stopped = false;
      timer = setInterval(() => void tick(), options.pollIntervalMs ?? 2000);
      timer.unref();
      await tick();
    },
    wake: () => void tick(),
    async cancel(runId) {
      const entry = running.get(runId);
      if (entry) {
        entry.controller.abort();
        return true;
      }
      const cancelled = await db.runs.cancelQueued(runId);
      if (cancelled) hub.finish(runId);
      return cancelled;
    },
    active: () => [...running.keys()],
    async idle() {
      for (;;) {
        await tick();
        if (running.size === 0) {
          if ((await db.runs.list({ status: "queued", limit: 1 })).length === 0 || stopped) return;
        }
        await Promise.race([
          ...[...running.values()].map((entry) => entry.done),
          new Promise((r) => setTimeout(r, 25)),
        ]);
      }
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      for (const entry of running.values()) entry.controller.abort();
      await Promise.allSettled([...running.values()].map((entry) => entry.done));
    },
  };
}
