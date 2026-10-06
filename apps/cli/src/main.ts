import { isJobTraceError, loadConfig } from "@jobtrace/core";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { createLogger } from "./logger.ts";
import { runCommand } from "./run-command.ts";

export interface MainIo {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream & { isTTY?: boolean };
  env?: Record<string, string | undefined>;
  /** Cancels a run in progress. The real CLI wires this to Ctrl+C. */
  signal?: AbortSignal;
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
      let signal = io.signal;
      let removeSigint = () => {};
      if (!signal) {
        const controller = new AbortController();
        const onSigint = () => controller.abort();
        process.once("SIGINT", onSigint);
        removeSigint = () => process.off("SIGINT", onSigint);
        signal = controller.signal;
      }
      try {
        exitCode = await runCommand(file, options, { stdout, config, logger, signal });
      } finally {
        removeSigint();
      }
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
