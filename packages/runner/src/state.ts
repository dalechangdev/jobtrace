import { setTimeout as sleepFor } from "node:timers/promises";
import {
  type ErrorCode,
  JobTraceError,
  type Locator as LocatorSpec,
  type RawRecord,
  type Recording,
  type RecordingSettings,
  type RunArtifact,
  type RunEvent,
  type RunEventLevel,
  type Target,
} from "@jobtrace/core";
import type { BrowserContext, Locator, Page } from "playwright";
import type { RunOptions, RunTuning } from "./types.ts";

/** Ends the run early without it being an error, e.g. when maxItems is reached. */
export class StopRun extends Error {
  readonly limit: string;
  constructor(limit: string) {
    super(`Run stopped: ${limit} reached`);
    this.name = "StopRun";
    this.limit = limit;
  }
}

/** Errors that end the whole run and must never be swallowed as a per-item failure. */
const RUN_LEVEL_CODES: ReadonlySet<ErrorCode> = new Set([
  "RUN_CANCELLED",
  "RUN_TIMEOUT",
  "BOT_WALL",
  "AUTH_EXPIRED",
  "ROBOTS_DISALLOWED",
]);

export function isRunLevelError(error: unknown): boolean {
  return (
    error instanceof StopRun || (error instanceof JobTraceError && RUN_LEVEL_CODES.has(error.code))
  );
}

/** A job record being assembled from one or more extract steps. */
export interface PendingRecord {
  fields: Record<string, string | null>;
  sourceUrl: string;
  /** Set once a nested forEach emitted records based on this one. */
  hasChildren: boolean;
}

/** Where steps currently execute: which page, and inside which list item. */
export interface Scope {
  page: Page;
  record: PendingRecord;
  /** The current forEach item; targets with `relativeTo: "item"` resolve inside it. */
  item?: Locator;
  /** The list the current item belongs to, so a detail visit can find its way back. */
  list?: { items: Locator; count: number; url: string };
  /** Infinite scroll: items already processed per forEach step id. */
  processed?: Map<string, number>;
}

export interface RunState {
  recording: Recording;
  settings: RecordingSettings;
  tuning: RunTuning;
  options: RunOptions;
  /** Template values, e.g. `params.keyword`. */
  values: Record<string, string>;
  now: Date;
  context: BrowserContext;
  records: RawRecord[];
  events: RunEvent[];
  artifacts: RunArtifact[];
  stats: { pages: number; itemsSeen: number; itemErrors: number };
  /** Index of the locator that last worked for a target. */
  locatorMemo: WeakMap<Target, number>;
  /** Locators a LocatorResolver suggested for a target and that held up. */
  healed: WeakMap<Target, LocatorSpec>;
  /** Targets the LocatorResolver was already asked about. */
  healTried: WeakSet<Target>;
  /** Errors whose failure artifacts were already captured. */
  captured: WeakSet<object>;
  /** Pages currently inside a navigation the runner itself started. */
  navigating: WeakSet<Page>;
  /** The page steps last ran on, for a screenshot when the run is stopped from outside a step. */
  activePage: Page | undefined;
  /** Set once the logged-in check has run. */
  authChecked: boolean;
  failureCaptures: number;
  timeoutSignal: AbortSignal;
  guard: RunGuard;
}

/**
 * A run-ending problem noticed outside of any step (by a page listener): a bot
 * wall after a click, a disallowed URL the page navigated to. The next
 * `checkAbort` raises it.
 */
export interface RunGuard {
  fatal?: JobTraceError;
  /** Screenshots being taken by listeners; the run waits for them before closing the browser. */
  pending: Promise<void>[];
}

export function emit(
  state: Pick<RunState, "events" | "options">,
  level: RunEventLevel,
  type: string,
  message: string,
  extra: { stepId?: string; data?: Record<string, unknown> } = {},
): void {
  const event: RunEvent = { ts: new Date().toISOString(), level, type, message, ...extra };
  state.events.push(event);
  try {
    state.options.onEvent?.(event);
  } catch {
    // A faulty listener must not break the run.
  }
}

/** Throws once the run has been aborted, timed out, or stopped by a page guard. */
export function checkAbort(state: Pick<RunState, "options" | "timeoutSignal" | "guard">): void {
  if (state.guard.fatal) throw state.guard.fatal;
  if (state.options.signal?.aborted) {
    throw new JobTraceError("RUN_CANCELLED", "Run was cancelled");
  }
  if (state.timeoutSignal.aborted) {
    throw new JobTraceError("RUN_TIMEOUT", "Run exceeded its time limit");
  }
}

/** Sleeps, waking early with the appropriate error if the run is aborted. */
export async function sleep(state: RunState, ms: number): Promise<void> {
  checkAbort(state);
  if (ms <= 0) return;
  const signals = [state.timeoutSignal, ...(state.options.signal ? [state.options.signal] : [])];
  try {
    await sleepFor(ms, undefined, { signal: AbortSignal.any(signals) });
  } catch (error) {
    checkAbort(state);
    throw error;
  }
}

/** Politeness delay before a navigation or interaction. */
export async function pace(state: RunState): Promise<void> {
  const { minDelayMs, maxDelayMs } = state.settings;
  const span = Math.max(0, maxDelayMs - minDelayMs);
  await sleep(state, minDelayMs + Math.random() * span);
}

/**
 * Calls `probe` until it returns a value other than undefined or the timeout
 * passes. Always probes at least once. Probe errors count as "not yet", since
 * pages throw while they navigate.
 */
export async function poll<T>(
  state: RunState,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    checkAbort(state);
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch {
      checkAbort(state);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await sleep(state, Math.min(state.tuning.pollIntervalMs, remaining));
  }
}
