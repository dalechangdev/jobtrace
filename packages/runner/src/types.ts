import type { LocatorResolver, RecordingSettings, RobotsPolicy, RunEvent } from "@jobtrace/core";
import type { Browser } from "playwright";

/** Timing knobs that are not part of the recording. Mostly overridden by tests. */
export interface RunTuning {
  /** Interval between locator and condition polls. */
  pollIntervalMs: number;
  /**
   * How long higher-ranked locators get to appear before a lower-ranked match is
   * accepted. Without it, a fallback locator would win races against a primary
   * locator whose element simply has not rendered yet.
   */
  fallbackGraceMs: number;
  /** Budget, per extract step, for optional fields that may simply be absent. */
  optionalFieldTimeoutMs: number;
  /** How long to look for the next-page control once a page has been processed. */
  nextTimeoutMs: number;
  /** urlPattern pagination: how long to wait for items on pages after the first. */
  emptyPageTimeoutMs: number;
  /** Infinite scroll: wait per scroll attempt for new items, and number of attempts. */
  scrollWaitMs: number;
  scrollAttempts: number;
  /** How long to wait for the list to come back after a same-tab detail visit. */
  listRestoreMs: number;
  /** How long a same-tab detail click may take to change the URL or open a tab. */
  detailOpenMs: number;
  /** A forEach gives up after this many items fail in a row. */
  maxConsecutiveItemErrors: number;
  /** Cap on failure screenshots and DOM snapshots per run. */
  maxFailureCaptures: number;
  /** A 429 asking to wait longer than this ends the run instead of waiting. */
  maxRetryAfterMs: number;
  /** A robots.txt Crawl-delay above this is capped (and reported). */
  maxCrawlDelayMs: number;
}

export const DEFAULT_TUNING: RunTuning = {
  pollIntervalMs: 100,
  fallbackGraceMs: 1000,
  optionalFieldTimeoutMs: 1000,
  nextTimeoutMs: 2000,
  emptyPageTimeoutMs: 3000,
  scrollWaitMs: 1500,
  scrollAttempts: 3,
  listRestoreMs: 5000,
  detailOpenMs: 5000,
  maxConsecutiveItemErrors: 5,
  maxFailureCaptures: 10,
  maxRetryAfterMs: 60_000,
  maxCrawlDelayMs: 30_000,
};

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;

export interface RunOptions {
  /** Values for the recording's declared params, overriding their defaults. */
  params?: Record<string, string>;
  /** Show the browser window. Default is headless. */
  headed?: boolean;
  slowMo?: number;
  /** Record a Playwright trace into `artifactsDir` (requires `artifactsDir`). */
  trace?: boolean;
  /** Directory for screenshots, DOM snapshots and traces. Nothing is written when omitted. */
  artifactsDir?: string;
  /** Cancels the run. */
  signal?: AbortSignal;
  runTimeoutMs?: number;
  /** Called for every run event as it happens, e.g. to log or persist it. */
  onEvent?: (event: RunEvent) => void;
  /**
   * robots.txt knowledge. When given and the recording has `respectRobotsTxt`,
   * a disallowed URL ends the run with `robots_disallowed`.
   */
  robots?: RobotsPolicy;
  /** Last-resort locator healing (the optional AI fallback plugin). */
  locatorResolver?: LocatorResolver;
  /**
   * Stop as soon as this step has run once (the first item, the first page).
   * Used to try out one step; the values an extract step read are reported in a
   * `step_result` event.
   */
  stopAfterStepId?: string;
  /** Reuse an existing browser instead of launching one. It is left open. */
  browser?: Browser;
  /** Path to a Playwright storage state file (an auth profile). */
  storageState?: string;
  /** Reference time for relative dates. Defaults to the run start. */
  now?: Date;
  /** Overrides for the recording's settings. */
  settings?: Partial<RecordingSettings>;
  tuning?: Partial<RunTuning>;
}

export type { RunResult } from "@jobtrace/core";
