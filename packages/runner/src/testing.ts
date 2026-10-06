import { readFileSync } from "node:fs";
import { type NormalizedJob, parseRecordingJson, type Recording } from "@jobtrace/core";
import type { RunOptions } from "./types.ts";

/** Fixed clock so relative dates and golden files are stable. */
export const TEST_NOW = new Date("2026-10-06T12:00:00Z");

/** Loads one of the hand-written recordings from `examples/recordings`. */
export function loadExample(name: string): Recording {
  const file = new URL(`../../../examples/recordings/${name}.jobtrace.json`, import.meta.url);
  return parseRecordingJson(readFileSync(file, "utf8"));
}

/** Run options for tests: no politeness delays, short waits, fixed clock. */
export function fastOptions(origin: string, overrides: RunOptions = {}): RunOptions {
  return {
    now: TEST_NOW,
    ...overrides,
    params: { baseUrl: origin, ...overrides.params },
    settings: { minDelayMs: 0, maxDelayMs: 0, stepTimeoutMs: 5000, ...overrides.settings },
    tuning: {
      pollIntervalMs: 25,
      fallbackGraceMs: 300,
      optionalFieldTimeoutMs: 300,
      nextTimeoutMs: 500,
      emptyPageTimeoutMs: 500,
      scrollWaitMs: 800,
      scrollAttempts: 2,
      ...overrides.tuning,
    },
  };
}

/**
 * Makes jobs comparable across test runs: the fixture server listens on a random
 * port, so its origin is replaced by a placeholder, and the content hash (which
 * covers the URL) is reduced to a format check.
 */
export function sanitizeJobs(jobs: readonly NormalizedJob[], origin: string): unknown[] {
  return jobs.map((job) => {
    const text = JSON.stringify({
      ...job,
      contentHash: /^[0-9a-f]{64}$/.test(job.contentHash) ? "<sha256>" : job.contentHash,
    });
    return JSON.parse(text.replaceAll(origin, "http://test-sites"));
  });
}
