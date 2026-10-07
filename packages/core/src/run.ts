import type { SerializedError } from "./errors.ts";
import type { NormalizedJob } from "./job.ts";
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

/** What one run produced, whether it replayed a recording in a browser or read an API feed. */
export interface RunResult {
  status: FinalRunStatus;
  /** Short machine-readable cause when the run did not fully succeed, e.g. `locator_not_found`. */
  reason?: string;
  error?: RunFailure;
  jobs: NormalizedJob[];
  stats: RunStats;
  events: RunEvent[];
  artifacts: RunArtifact[];
  startedAt: string;
  finishedAt: string;
}

/** A locator proposed by a LocatorResolver after every recorded locator failed. */
export interface ResolvedLocator {
  locator: Locator;
  /** Where the suggestion came from, e.g. "ai". */
  source: string;
  /** Why the resolver picked it, in a sentence. Shown next to the suggestion. */
  reason?: string;
}

export interface LocatorResolverContext {
  /**
   * Trimmed HTML of the area the target lives in: the page, the innermost
   * frame, or the current list item. Never contains input values or cookies.
   */
  pageSnapshot: string;
  /** What `pageSnapshot` covers. A suggested locator is resolved inside it. */
  scope: "page" | "frame" | "item";
  url: string;
  stepId: string;
  /** True when the target must match a list of elements rather than exactly one. */
  list: boolean;
  /** Fires when the run is cancelled. */
  signal?: AbortSignal;
}

/** Last-resort locator healing, implemented by the optional ai-fallback plugin. */
export interface LocatorResolver {
  resolve(target: Target, context: LocatorResolverContext): Promise<ResolvedLocator | null>;
}

/** How runs heal broken locators: a fresh resolver per run, and what to do with what it finds. */
export interface Healing {
  /** A resolver for one run, or undefined while healing is switched off. */
  createResolver(): LocatorResolver | undefined;
  /** Whether healed locators are written into the recording without asking. */
  autoApply: boolean;
}

export interface RobotsVerdict {
  allowed: boolean;
  /** Why not, in words fit for an error message. */
  reason?: string;
  /** The site's requested minimum pause between requests, when it states one. */
  crawlDelayMs?: number;
}

/** Answers whether a URL may be fetched according to the site's robots.txt. */
export interface RobotsPolicy {
  check(url: string): Promise<RobotsVerdict>;
}

/** What bot-wall detection looks at; collected from the live page by the runner. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** The start of the page's visible text. */
  text: string;
  /** Length of the page's whole visible text. */
  textLength: number;
  /** Sources of iframes that are actually visible on the page. */
  visibleFrameUrls: string[];
  /** Other challenge traces: script sources and widget markers found in the page. */
  challengeMarkers: string[];
}
