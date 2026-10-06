import { isJobTraceError, loadConfig } from "@jobtrace/core";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { createLogger } from "./logger.ts";
import { type RecordCommandIo, recordCommand } from "./record-command.ts";
import { runCommand } from "./run-command.ts";

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
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Expected a positive whole number.");
  }
  return parsed;
}

const collect = (value: string, previous: string[]) => [...previous, value];

/** Runs the CLI and returns the process exit code. Never calls process.exit. */
export async function main(argv: readonly string[], io: MainIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  let exitCode = 0;

  /** Runs a command with a signal that fires on Ctrl+C (or the caller's own signal). */
  async function withInterrupt<T>(command: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (io.signal) return command(io.signal);
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      return await command(controller.signal);
    } finally {
      process.off("SIGINT", onSigint);
    }
  }

  const program = new Command("jobtrace")
    .description("Record how you browse a career site, then replay it to scrape job listings.")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => void stdout.write(text),
      writeErr: (text) => void stderr.write(text),
    });

  program
    .command("run")
    .description("Replay a recording file and print the extracted jobs as JSON")
    .argument("<file>", "path to a .jobtrace.json recording")
    .option("--headed", "show the browser window")
    .option("--trace", "save a Playwright trace (view with: npx playwright show-trace <zip>)")
    .option("--param <key=value>", "set a recording param; repeatable", collect, [])
    .option(
      "--artifacts <dir>",
      "where to save screenshots and traces (default: DATA_DIR/artifacts/<run>)",
    )
    .option("--max-pages <n>", "override the recording's maxPages", positiveInt)
    .option("--max-items <n>", "override the recording's maxItems", positiveInt)
    .option("--summary", "print status, stats and artifacts along with the jobs")
    .action(async (file: string, options) => {
      const config = loadConfig(env);
      const logger = createLogger(config.logLevel, stderr);
      exitCode = await withInterrupt((signal) =>
        runCommand(file, options, { stdout, config, logger, signal }),
      );
    });

  program
    .command("record")
    .description("Open a browser, record how you reach the jobs, and save a recording file")
    .argument("<url>", "career page to start from")
    .option("--name <name>", "name of the recording (default: the page title)")
    .option(
      "--out <file>",
      "file to write (default: <name>.jobtrace.json in the current directory)",
    )
    .option("--force", "overwrite the output file if it exists")
    .action(async (url: string, options) => {
      const config = loadConfig(env);
      const logger = createLogger(config.logLevel, stderr);
      exitCode = await withInterrupt((signal) =>
        recordCommand(url, options, {
          stdout,
          stderr,
          logger,
          signal,
          ...(io.cwd ? { cwd: io.cwd } : {}),
          ...(io.recorder ? { recorder: io.recorder } : {}),
          ...(io.onSession ? { onSession: io.onSession } : {}),
        }),
      );
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (isJobTraceError(error)) {
      stderr.write(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  return exitCode;
}
