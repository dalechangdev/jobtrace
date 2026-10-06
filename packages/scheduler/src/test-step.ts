import { JobTraceError, type RunEvent, type RunFailure, walkSteps } from "@jobtrace/core";
import type { Database } from "@jobtrace/db";
import type { Politeness } from "@jobtrace/politeness";
import { type RunOptions, runRecording } from "@jobtrace/runner";
import { savedLogin } from "./execute.ts";

export interface TestStepResult {
  /** True when the run got to the step and the step worked. */
  ok: boolean;
  /** Whether the step was reached at all (a step in a loop needs at least one item). */
  reached: boolean;
  error?: RunFailure;
  /** What an extract step read, by field name. */
  fields?: Record<string, string | null>;
  /** Warnings and errors along the way, e.g. a locator that needed its fallback. */
  events: RunEvent[];
  durationMs: number;
}

/**
 * Tries one step of a stored recording: replays the recording up to and
 * including that step, once, and reports how it went. Nothing is stored.
 */
export async function testStep(
  db: Database,
  recordingId: string,
  stepId: string,
  options: { politeness?: Politeness; run?: Omit<RunOptions, "stopAfterStepId" | "onEvent"> } = {},
): Promise<TestStepResult> {
  const stored = await db.recordings.get(recordingId);
  if (!stored) throw new JobTraceError("NOT_FOUND", `No recording ${recordingId}`);
  if (stored.kind !== "browser") {
    throw new JobTraceError("INVALID_ARGUMENT", "API sources have no steps to test");
  }
  if (![...walkSteps(stored.recording.steps)].some((step) => step.id === stepId)) {
    throw new JobTraceError("NOT_FOUND", `No step ${stepId} in this recording`);
  }
  const release = await options.politeness?.locks.acquire(stored.domain, options.run?.signal);
  try {
    const storageState = await savedLogin(db, stored.recording.authProfileId);
    const result = await runRecording(stored.recording, {
      ...options.run,
      ...(options.politeness ? { robots: options.politeness.robots } : {}),
      ...(storageState ? { storageState } : {}),
      stopAfterStepId: stepId,
    });
    const ran = result.events.find(
      (event) => event.type === "step_result" && event.stepId === stepId,
    );
    const fields = ran?.data?.fields as Record<string, string | null> | undefined;
    return {
      ok: ran !== undefined,
      reached: ran !== undefined || result.error?.stepId === stepId,
      ...(result.error ? { error: result.error } : {}),
      ...(fields ? { fields } : {}),
      events: result.events.filter((event) => event.level === "warn" || event.level === "error"),
      durationMs: result.stats.durationMs,
    };
  } finally {
    release?.();
  }
}
