import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  isJobTraceError,
  JobTraceError,
  newId,
  parseRecordingJson,
  type RunStatus,
} from "@jobtrace/core";
import { runRecording } from "@jobtrace/runner";
import { executeRun } from "@jobtrace/scheduler";
import type { CliContext } from "./context.ts";

export interface RunCommandOptions {
  headed?: boolean;
  trace?: boolean;
  param: string[];
  artifacts?: string;
  maxPages?: number;
  maxItems?: number;
  summary?: boolean;
}

/** Exit codes: 0 succeeded, 2 partial (some jobs, some errors), 1 anything else. */
export function exitCodeFor(status: RunStatus): number {
  return status === "succeeded" ? 0 : status === "partial" ? 2 : 1;
}

export function parseParams(pairs: readonly string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      throw new JobTraceError("INVALID_ARGUMENT", `--param expects key=value, got "${pair}"`);
    }
    params[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return params;
}

/**
 * `jobtrace run <recording>`. A stored recording (id, id prefix or name) is
 * replayed and tracked in the database: jobs are flagged new or changed against
 * earlier runs. A path to a recording file is replayed as a one-off, and nothing
 * is stored. Either way the jobs are printed as JSON on stdout.
 */
export async function runCommand(
  ref: string,
  options: RunCommandOptions,
  ctx: CliContext,
): Promise<number> {
  const params = parseParams(options.param);
  const settings = {
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
  };
  const shared = {
    params,
    settings,
    ...(options.headed ? { headed: true } : {}),
    ...(options.trace ? { trace: true } : {}),
  };
  const print = (value: unknown) => ctx.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const file = resolve(ctx.cwd, ref);

  if (existsSync(file)) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw new JobTraceError("INVALID_RECORDING", `Cannot read recording file ${ref}`, {
        cause: error,
      });
    }
    const recording = parseRecordingJson(text);

    const result = await ctx.withInterrupt((signal) =>
      runRecording(recording, {
        ...shared,
        signal,
        artifactsDir: options.artifacts ?? join(ctx.config.dataDir, "artifacts", newId("run")),
        onEvent: (event) => ctx.logger.event(event),
      }),
    );
    const { status, reason, error, stats, artifacts, jobs } = result;
    print(options.summary ? { status, reason, error, stats, artifacts, jobs } : jobs);
    return exitCodeFor(status);
  }

  let recordingId: string;
  try {
    recordingId = (await ctx.db.recordings.resolve(ref)).id;
  } catch (error) {
    if (!isJobTraceError(error, "NOT_FOUND")) throw error;
    throw new JobTraceError("NOT_FOUND", `${error.message}, and there is no such file either`);
  }
  if (options.artifacts) {
    throw new JobTraceError(
      "INVALID_ARGUMENT",
      "--artifacts only applies to recording files; stored recordings keep artifacts in DATA_DIR/artifacts/<run>",
    );
  }
  const executed = await ctx.withInterrupt((signal) =>
    executeRun(ctx.db, recordingId, {
      trigger: "cli",
      dataDir: ctx.config.dataDir,
      artifactRetentionRuns: ctx.config.artifactRetentionRuns,
      run: { ...shared, signal },
      onEvent: (event) => ctx.logger.event(event),
    }),
  );
  const { run, jobs, artifacts } = executed;
  const stats = run.stats;
  ctx.stderr.write(
    `Run ${run.id} ${run.status}: ${jobs.length} job(s), ${stats?.newJobs ?? 0} new, ${stats?.changedJobs ?? 0} changed, ${stats?.closedJobs ?? 0} closed\n`,
  );
  print(options.summary ? { run, artifacts, jobs } : jobs);
  return exitCodeFor(run.status);
}
