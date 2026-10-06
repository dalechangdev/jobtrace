import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  isApiSource,
  isJobTraceError,
  JobTraceError,
  newId,
  parseDefinitionJson,
  type RunEvent,
  type RunStatus,
} from "@jobtrace/core";
import type { StoredRecording } from "@jobtrace/db";
import { runRecording } from "@jobtrace/runner";
import { executeRun } from "@jobtrace/scheduler";
import { fetchSource } from "@jobtrace/sources";
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
    const definition = parseDefinitionJson(text);
    const onEvent = (event: RunEvent) => ctx.logger.event(event);
    const result = await ctx.withInterrupt((signal) =>
      isApiSource(definition)
        ? fetchSource(definition, { signal, onEvent, robots: ctx.politeness.robots })
        : runRecording(definition, {
            ...shared,
            signal,
            robots: ctx.politeness.robots,
            artifactsDir: options.artifacts ?? join(ctx.config.dataDir, "artifacts", newId("run")),
            onEvent,
          }),
    );
    const { status, reason, error, stats, artifacts, jobs } = result;
    print(options.summary ? { status, reason, error, stats, artifacts, jobs } : jobs);
    return exitCodeFor(status);
  }

  let stored: StoredRecording;
  try {
    stored = await ctx.db.recordings.resolve(ref);
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
    executeRun(ctx.db, stored.id, {
      trigger: "cli",
      dataDir: ctx.config.dataDir,
      artifactRetentionRuns: ctx.config.artifactRetentionRuns,
      politeness: ctx.politeness,
      run: { ...shared, signal },
      onEvent: (event) => ctx.logger.event(event),
    }),
  );
  const { run, jobs, artifacts } = executed;
  const stats = run.stats;
  ctx.stderr.write(
    `Run ${run.id} ${run.status}: ${jobs.length} job(s), ${stats?.newJobs ?? 0} new, ${stats?.changedJobs ?? 0} changed, ${stats?.closedJobs ?? 0} closed\n`,
  );
  if (run.status !== "succeeded" && run.error) ctx.stderr.write(`${run.error.message}\n`);
  if (run.reason === "auth_expired") {
    const profileId = stored.kind === "browser" ? stored.recording.authProfileId : null;
    const profile = profileId ? await ctx.db.authProfiles.get(profileId) : null;
    if (profile)
      ctx.stderr.write(`Renew the login with: jobtrace auth refresh "${profile.name}"\n`);
  }
  if (run.status === "blocked") {
    const shot = artifacts.find((artifact) => artifact.type === "screenshot");
    if (shot) ctx.stderr.write(`Screenshot: ${shot.path}\n`);
  }
  print(options.summary ? { run, artifacts, jobs } : jobs);
  return exitCodeFor(run.status);
}
