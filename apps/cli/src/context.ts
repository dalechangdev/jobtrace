import type { RunningServer, ServerOptions } from "@jobtrace/api";
import type { Config } from "@jobtrace/core";
import type { Database } from "@jobtrace/db";
import type { Politeness } from "@jobtrace/politeness";
import type { AuthCapture } from "@jobtrace/recorder";
import type { Logger } from "./logger.ts";
import type { RecordCommandIo } from "./record-command.ts";

export interface MainIo {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream & { isTTY?: boolean };
  env?: Record<string, string | undefined>;
  /** Cancels a run, or ends a recording. The real CLI wires this to Ctrl+C. */
  signal?: AbortSignal;
  cwd?: string;
  /** Tests: recorder overrides and a hook to drive the recording session. */
  recorder?: RecordCommandIo["recorder"];
  onSession?: RecordCommandIo["onSession"];
  /** Tests: a hook to drive a login capture. */
  onAuthCapture?: (capture: AuthCapture) => void;
  /** Tests: server overrides, and a hook called once `serve` is listening. */
  server?: Pick<ServerOptions, "port" | "worker" | "sessionHooks">;
  onServer?: (server: RunningServer) => void;
}

/** What every command gets. Config, logger and database are created on first use. */
export interface CliContext {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
  cwd: string;
  io: MainIo;
  readonly config: Config;
  readonly logger: Logger;
  /** The database, opened (and migrated) on first access and closed when the CLI exits. */
  readonly db: Database;
  /** robots.txt knowledge (cached under DATA_DIR) and per-domain turns. */
  readonly politeness: Politeness;
  /** Runs `command` with a signal that fires on Ctrl+C. */
  withInterrupt<T>(command: (signal: AbortSignal) => Promise<T>): Promise<T>;
  setExitCode(code: number): void;
}
