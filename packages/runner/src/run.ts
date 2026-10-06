import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type FinalRunStatus,
  type JobTraceError,
  type NormalizedJob,
  paramValues,
  type Recording,
  resolveParams,
  toJobTraceError,
} from "@jobtrace/core";
import { dedupeJobs, normalizeRecord } from "@jobtrace/extractor";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { captureFailure } from "./artifacts.ts";
import { watchPage } from "./guards.ts";
import { checkAbort, emit, type RunState, StopRun } from "./state.ts";
import { emitRecord, newRecord, runSteps } from "./steps.ts";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_TUNING,
  type RunOptions,
  type RunResult,
} from "./types.ts";

/** Failures that mean the run could not do its job at all, even if some jobs were read. */
const ALWAYS_FAILED = new Set(["AUTH_EXPIRED", "ROBOTS_DISALLOWED", "TEMPLATE_ERROR"]);

function finalStatus(
  error: JobTraceError | undefined,
  itemErrors: number,
  jobs: number,
): FinalRunStatus {
  if (error?.code === "RUN_CANCELLED") return "cancelled";
  if (error?.code === "BOT_WALL") return "blocked";
  if (error) return jobs > 0 && !ALWAYS_FAILED.has(error.code) ? "partial" : "failed";
  if (itemErrors > 0) return jobs > 0 ? "partial" : "failed";
  return "succeeded";
}

/**
 * Replays a recording and returns the extracted jobs. Never throws for run
 * problems: failures are reported through `status`, `reason` and `error`.
 * This is the single entry point used by the CLI, the worker and tests.
 */
export async function runRecording(
  recording: Recording,
  options: RunOptions = {},
): Promise<RunResult> {
  const startedAt = new Date();
  const now = options.now ?? startedAt;
  const base: Pick<RunState, "events" | "options" | "timeoutSignal" | "guard"> = {
    events: [],
    options,
    guard: { pending: [] },
    timeoutSignal: AbortSignal.timeout(options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS),
  };
  const stats = { pages: 0, itemsSeen: 0, itemErrors: 0 };
  let state: RunState | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let failure: JobTraceError | undefined;
  let tracing = false;

  const closeOnAbort = () => void context?.close().catch(() => {});
  options.signal?.addEventListener("abort", closeOnAbort, { once: true });
  base.timeoutSignal.addEventListener("abort", closeOnAbort, { once: true });

  emit(base, "info", "run_started", `Running "${recording.name}"`, {
    data: { recordingId: recording.id },
  });
  try {
    checkAbort(base);
    const values = paramValues(resolveParams(recording.params, options.params));
    browser =
      options.browser ??
      (await chromium.launch({
        headless: !options.headed,
        ...(options.slowMo === undefined ? {} : { slowMo: options.slowMo }),
      }));
    context = await browser.newContext(
      options.storageState === undefined ? {} : { storageState: options.storageState },
    );
    checkAbort(base);
    if (options.trace && options.artifactsDir) {
      await context.tracing.start({ screenshots: true, snapshots: true });
      tracing = true;
    }
    const page = await context.newPage();
    state = {
      ...base,
      recording,
      settings: { ...recording.settings, ...options.settings },
      tuning: { ...DEFAULT_TUNING, ...options.tuning },
      values,
      now,
      context,
      records: [],
      artifacts: [],
      stats,
      locatorMemo: new WeakMap(),
      captured: new WeakSet(),
      navigating: new WeakSet(),
      activePage: page,
      authChecked: false,
      failureCaptures: 0,
    };
    watchPage(state, page);
    // Detail tabs and popups opened later are watched the same way.
    const watching = state;
    context.on("page", (opened) => watchPage(watching, opened));
    const root = newRecord(recording.startUrl);
    await runSteps(state, { page, record: root }, recording.steps);
    root.sourceUrl = page.url();
    emitRecord(state, root);
  } catch (thrown) {
    if (thrown instanceof StopRun) {
      emit(
        base,
        "info",
        "limit_reached",
        thrown.limit === "maxItems"
          ? `Stopped at maxItems (${state?.settings.maxItems ?? recording.settings.maxItems})`
          : `Stopped after ${thrown.limit}`,
      );
    } else {
      try {
        // An abort surfaces as arbitrary browser errors; report the abort itself.
        checkAbort(base);
        failure = toJobTraceError(thrown);
      } catch (abort) {
        failure = toJobTraceError(abort);
      }
      await Promise.allSettled(base.guard.pending);
      // A block noticed by a page listener has no step to take its screenshot.
      if (
        state &&
        failure.code === "BOT_WALL" &&
        !state.captured.has(failure) &&
        state.activePage
      ) {
        state.captured.add(failure);
        await captureFailure(state, state.activePage, failure.stepId ?? "blocked");
      }
      emit(base, "error", "run_error", failure.message, {
        ...(failure.stepId === undefined ? {} : { stepId: failure.stepId }),
        data: { error: failure.toJSON() },
      });
    }
  } finally {
    options.signal?.removeEventListener("abort", closeOnAbort);
    base.timeoutSignal.removeEventListener("abort", closeOnAbort);
    if (tracing && context && options.artifactsDir) {
      const path = join(options.artifactsDir, "trace.zip");
      try {
        await mkdir(options.artifactsDir, { recursive: true });
        await context.tracing.stop({ path });
        state?.artifacts.push({ type: "trace", path });
      } catch {
        // The context is already gone after an abort; there is no trace to save.
      }
    }
    await context?.close().catch(() => {});
    if (!options.browser) await browser?.close().catch(() => {});
  }

  const normalized: NormalizedJob[] = [];
  for (const record of state?.records ?? []) {
    const job = normalizeRecord(record, {
      recordingId: recording.id,
      now,
      defaults: { company: recording.settings.company },
    });
    if (job) normalized.push(job);
    else {
      emit(base, "warn", "record_skipped", "Skipped a record without a title", {
        data: { fields: Object.keys(record.fields), sourceUrl: record.sourceUrl },
      });
    }
  }
  const jobs = dedupeJobs(normalized);
  if (jobs.length < normalized.length) {
    emit(
      base,
      "info",
      "duplicates_dropped",
      `Dropped ${normalized.length - jobs.length} duplicate job(s)`,
    );
  }

  const status = finalStatus(failure, stats.itemErrors, jobs.length);
  const reason = failure
    ? failure.code.toLowerCase()
    : stats.itemErrors > 0
      ? "item_errors"
      : undefined;
  const finishedAt = new Date();
  const result: RunResult = {
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(failure === undefined ? {} : { error: failure.toJSON() }),
    jobs,
    stats: {
      // A recording without pagination still visited one page of results.
      pages: Math.max(stats.pages, state ? 1 : 0),
      itemsSeen: stats.itemsSeen,
      itemErrors: stats.itemErrors,
      jobs: jobs.length,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    },
    events: base.events,
    artifacts: state?.artifacts ?? [],
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
  emit(
    base,
    status === "succeeded" ? "info" : "warn",
    "run_finished",
    `Run ${status}: ${jobs.length} job(s)`,
    {
      data: { status, ...(reason === undefined ? {} : { reason }), stats: result.stats },
    },
  );
  return result;
}
