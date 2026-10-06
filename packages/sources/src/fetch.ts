import { setTimeout as sleepFor } from "node:timers/promises";
import {
  type ApiSource,
  type AtsProvider,
  apiSourceFeedUrl,
  type FinalRunStatus,
  JobTraceError,
  type NormalizedJob,
  type RunEvent,
  type RunEventLevel,
  type RunResult,
  toJobTraceError,
} from "@jobtrace/core";
import { dedupeJobs, normalizeRecord } from "@jobtrace/extractor";
import { ZodError } from "zod";
import { ashby } from "./adapters/ashby.ts";
import { greenhouse } from "./adapters/greenhouse.ts";
import { lever } from "./adapters/lever.ts";
import type { Adapter } from "./adapters/types.ts";

export const ADAPTERS: Record<AtsProvider, Adapter> = { greenhouse, lever, ashby };

/** Sent with every request, so a site operator can tell what is calling and why. */
export const USER_AGENT = "JobTrace (open-source personal job-search tool)";

export interface FetchSourceOptions {
  fetch?: typeof fetch;
  /** Cancels the run. */
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
  /** Reference time for relative dates. Defaults to the run start. */
  now?: Date;
  requestTimeoutMs?: number;
  /** A Retry-After longer than this ends the run instead of waiting. */
  maxRetryWaitMs?: number;
  /** How often a rate-limited request is retried. */
  maxRetries?: number;
  /** Wait used when a 429 or 503 carries no Retry-After. */
  defaultRetryWaitMs?: number;
}

/** Retry-After as milliseconds: either seconds or an HTTP date. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Reads an API source's feed and returns the jobs, in the same shape a browser
 * replay returns. Like `runRecording` it never throws for run problems: they
 * are reported through `status`, `reason` and `error`.
 */
export async function fetchSource(
  source: ApiSource,
  options: FetchSourceOptions = {},
): Promise<RunResult> {
  const startedAt = new Date();
  const now = options.now ?? startedAt;
  const request = options.fetch ?? fetch;
  const maxRetries = options.maxRetries ?? 2;
  const maxRetryWaitMs = options.maxRetryWaitMs ?? 60_000;
  const url = apiSourceFeedUrl(source);
  const events: RunEvent[] = [];
  const emit = (
    level: RunEventLevel,
    type: string,
    message: string,
    data?: Record<string, unknown>,
  ) => {
    const event: RunEvent = {
      ts: new Date().toISOString(),
      level,
      type,
      message,
      ...(data ? { data } : {}),
    };
    events.push(event);
    try {
      options.onEvent?.(event);
    } catch {
      // A faulty listener must not break the run.
    }
  };
  const cancelled = () => new JobTraceError("RUN_CANCELLED", "Run was cancelled");

  let jobs: NormalizedJob[] = [];
  let requests = 0;
  let itemsSeen = 0;
  let itemErrors = 0;
  let failure: JobTraceError | undefined;
  emit("info", "run_started", `Reading "${source.name}" from ${source.provider}`, {
    sourceId: source.id,
  });

  try {
    let payload: unknown;
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw cancelled();
      requests++;
      emit("info", "request", `GET ${url}`, { url, attempt: attempt + 1 });
      const signals = [AbortSignal.timeout(options.requestTimeoutMs ?? 30_000)];
      if (options.signal) signals.push(options.signal);
      let response: Response;
      try {
        response = await request(url, {
          headers: { accept: "application/json", "user-agent": USER_AGENT },
          signal: AbortSignal.any(signals),
          redirect: "follow",
        });
      } catch (error) {
        if (options.signal?.aborted) throw cancelled();
        throw new JobTraceError(
          "NAVIGATION_FAILED",
          `Could not reach ${url}: ${(error as Error).message}`,
          {
            cause: error,
            details: { url },
          },
        );
      }

      if (response.status === 429 || response.status === 503) {
        const wait =
          retryAfterMs(response.headers.get("retry-after")) ?? options.defaultRetryWaitMs ?? 2000;
        if (attempt < maxRetries && wait <= maxRetryWaitMs) {
          emit(
            "warn",
            "rate_limited",
            `HTTP ${response.status}; retrying in ${Math.ceil(wait / 1000)}s`,
            {
              status: response.status,
              waitMs: wait,
            },
          );
          await response.body?.cancel().catch(() => {});
          try {
            await sleepFor(wait, undefined, options.signal ? { signal: options.signal } : {});
          } catch {
            throw cancelled();
          }
          continue;
        }
      }
      if (response.status === 403 || response.status === 429) {
        // Asked to stay away or to slow down more than is reasonable: stop, do not push.
        throw new JobTraceError(
          "BOT_WALL",
          `${source.provider} refused the request (HTTP ${response.status})`,
          {
            details: { url, status: response.status },
          },
        );
      }
      if (response.status === 404) {
        throw new JobTraceError(
          "NOT_FOUND",
          `No ${source.provider} board named "${source.boardToken}" (HTTP 404). Check the board token.`,
          { details: { url, status: 404 } },
        );
      }
      if (!response.ok) {
        throw new JobTraceError(
          "NAVIGATION_FAILED",
          `${url} responded with HTTP ${response.status}`,
          {
            details: { url, status: response.status },
          },
        );
      }
      try {
        payload = await response.json();
      } catch (error) {
        throw new JobTraceError("STEP_FAILED", `${source.provider} did not return JSON`, {
          cause: error,
          details: { url },
        });
      }
      break;
    }

    let adapted: ReturnType<Adapter>;
    try {
      adapted = ADAPTERS[source.provider](payload, url);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      const issue = error.issues[0];
      throw new JobTraceError(
        "STEP_FAILED",
        `Unexpected response from ${source.provider} (${issue?.path.join(".") || "root"}: ${issue?.message}). The API may have changed.`,
        { details: { url } },
      );
    }
    itemsSeen = adapted.records.length + adapted.skipped.length;
    itemErrors = adapted.skipped.length;
    for (const skipped of adapted.skipped) {
      emit(
        "error",
        "item_error",
        `Entry ${skipped.index + 1} of the feed could not be read: ${skipped.reason}`,
        skipped,
      );
    }
    const records = adapted.records.slice(0, source.settings.maxItems);
    if (records.length < adapted.records.length) {
      emit("info", "limit_reached", `Stopped at maxItems (${source.settings.maxItems})`);
    }
    const normalized = records
      .map((record) =>
        normalizeRecord(record, {
          recordingId: source.id,
          now,
          defaults: { company: source.settings.company },
        }),
      )
      .filter((job): job is NormalizedJob => job !== null);
    jobs = dedupeJobs(normalized);
    emit("info", "feed_read", `${jobs.length} job(s) in the feed`, { jobs: jobs.length });
  } catch (error) {
    failure = toJobTraceError(error);
    emit("error", "run_error", failure.message, { error: failure.toJSON() });
  }

  let status: FinalRunStatus;
  if (failure?.code === "RUN_CANCELLED") status = "cancelled";
  else if (failure?.code === "BOT_WALL") status = "blocked";
  else if (failure) status = "failed";
  else status = itemErrors > 0 ? (jobs.length > 0 ? "partial" : "failed") : "succeeded";
  const reason = failure ? failure.code.toLowerCase() : itemErrors > 0 ? "item_errors" : undefined;
  const finishedAt = new Date();
  const stats = {
    pages: requests,
    itemsSeen,
    itemErrors,
    jobs: jobs.length,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
  emit(
    status === "succeeded" ? "info" : "warn",
    "run_finished",
    `Run ${status}: ${jobs.length} job(s)`,
    {
      status,
      ...(reason === undefined ? {} : { reason }),
      stats,
    },
  );
  return {
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(failure === undefined ? {} : { error: failure.toJSON() }),
    jobs,
    stats,
    events,
    artifacts: [],
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}
