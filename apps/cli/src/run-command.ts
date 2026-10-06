import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config, JobTraceError, newId, parseRecordingJson } from "@jobtrace/core";
import { type RunResult, runRecording } from "@jobtrace/runner";
import type { Logger } from "./logger.ts";

export interface RunCommandOptions {
  headed?: boolean;
  trace?: boolean;
  param: string[];
  artifacts?: string;
  maxPages?: number;
  maxItems?: number;
  summary?: boolean;
}

export interface RunCommandIo {
  stdout: NodeJS.WritableStream;
  config: Config;
  logger: Logger;
  signal?: AbortSignal;
}

/** Exit codes: 0 succeeded, 2 partial (some jobs, some errors), 1 anything else. */
export function exitCodeFor(status: RunResult["status"]): number {
  return status === "succeeded" ? 0 : status === "partial" ? 2 : 1;
}

export function parseParams(pairs: readonly string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      throw new JobTraceError("TEMPLATE_ERROR", `--param expects key=value, got "${pair}"`);
    }
    params[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return params;
}

/** `jobtrace run <file>`: replays a recording file and prints the jobs as JSON on stdout. */
export async function runCommand(
  file: string,
  options: RunCommandOptions,
  io: RunCommandIo,
): Promise<number> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new JobTraceError("INVALID_RECORDING", `Cannot read recording file ${file}`, {
      cause: error,
    });
  }
  const recording = parseRecordingJson(text);
  const params = parseParams(options.param);
  const artifactsDir = options.artifacts ?? join(io.config.dataDir, "artifacts", newId("run"));

  const result = await runRecording(recording, {
    params,
    artifactsDir,
    onEvent: (event) => io.logger.event(event),
    ...(options.headed ? { headed: true } : {}),
    ...(options.trace ? { trace: true } : {}),
    ...(io.signal ? { signal: io.signal } : {}),
    settings: {
      ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
      ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
    },
  });

  const output = options.summary
    ? {
        status: result.status,
        reason: result.reason,
        error: result.error,
        stats: result.stats,
        artifacts: result.artifacts,
        jobs: result.jobs,
      }
    : result.jobs;
  io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return exitCodeFor(result.status);
}
