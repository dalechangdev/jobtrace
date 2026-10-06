import type { SerializedError } from "./errors.ts";
import type { Locator, Target } from "./recording.ts";

export const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "blocked",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** Statuses a finished run can have. */
export type FinalRunStatus = Exclude<RunStatus, "queued" | "running">;

export type RunEventLevel = "debug" | "info" | "warn" | "error";

/** One entry of a run's log; persisted to `run_events` and streamed to the UI. */
export interface RunEvent {
  ts: string;
  level: RunEventLevel;
  /**
   * Machine-readable event type, e.g. `step_start`, `locator_resolved`,
   * `locator_drift`, `item_error`, `page`, `limit_reached`, `run_finished`.
   */
  type: string;
  message: string;
  stepId?: string;
  data?: Record<string, unknown>;
}

export interface RunStats {
  pages: number;
  itemsSeen: number;
  itemErrors: number;
  jobs: number;
  durationMs: number;
}

export interface RunArtifact {
  type: "screenshot" | "dom" | "trace";
  path: string;
}

export interface RunFailure extends SerializedError {}

/** A locator proposed by a LocatorResolver after every recorded locator failed. */
export interface ResolvedLocator {
  locator: Locator;
  /** Where the suggestion came from, e.g. "ai". */
  source: string;
}

export interface LocatorResolverContext {
  /** Trimmed page snapshot. Never contains input values or cookies. */
  pageSnapshot: string;
  url: string;
  stepId: string;
  /** True when the target must match a list of elements rather than exactly one. */
  list: boolean;
}

/** Last-resort locator healing, implemented by the optional ai-fallback plugin. */
export interface LocatorResolver {
  resolve(target: Target, context: LocatorResolverContext): Promise<ResolvedLocator | null>;
}
