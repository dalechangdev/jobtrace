import { join } from "node:path";
import { startServer } from "@jobtrace/api";
import { type Config, isJobTraceError, loadConfig } from "@jobtrace/core";
import { type Database, openDatabase } from "@jobtrace/db";
import { createPoliteness, type Politeness } from "@jobtrace/politeness";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { registerAuth } from "./commands/auth.ts";
import { registerJobs } from "./commands/jobs.ts";
import { registerRecordings } from "./commands/recordings.ts";
import { registerRuns } from "./commands/runs.ts";
import { registerSchedule } from "./commands/schedule.ts";
import { registerSource } from "./commands/source.ts";
import type { CliContext, MainIo } from "./context.ts";
import { createLogger, type Logger } from "./logger.ts";
import { recordCommand } from "./record-command.ts";
import { remoteFrom } from "./remote.ts";
import { runCommand } from "./run-command.ts";

export type { MainIo } from "./context.ts";

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
  let config: Config | undefined;
  let logger: Logger | undefined;
  let database: Database | undefined;
  let politeness: Politeness | undefined;

  const ctx: CliContext = {
    stdout,
    stderr,
    env,
    io,
    cwd: io.cwd ?? process.cwd(),
    get config() {
      config ??= loadConfig(env);
      return config;
    },
    get logger() {
      logger ??= createLogger(ctx.config.logLevel, stderr);
      return logger;
    },
    get db() {
      database ??= openDatabase(ctx.config.databaseUrl);
      return database;
    },
    get politeness() {
      politeness ??= createPoliteness({ cacheDir: join(ctx.config.dataDir, "cache", "robots") });
      return politeness;
    },
    async withInterrupt(command) {
      if (io.signal) return command(io.signal);
      const controller = new AbortController();
      const onSigint = () => controller.abort();
      process.once("SIGINT", onSigint);
      try {
        return await command(controller.signal);
      } finally {
        process.off("SIGINT", onSigint);
      }
    },
    setExitCode(code) {
      exitCode = code;
    },
  };

  const program = new Command("jobtrace")
    .description("Record how you browse a career site, then replay it to scrape job listings.")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => void stdout.write(text),
      writeErr: (text) => void stderr.write(text),
    });

  program
    .command("record")
    .description("Open a browser, record how you reach the jobs, and store the recording")
    .argument("<url>", "career page to start from")
    .option("--name <name>", "name of the recording (default: the page title)")
    .option(
      "--auth <profile>",
      "record while logged in with a saved login (see: jobtrace auth create)",
    )
    .option(
      "--server <url>",
      "store the recording on a JobTrace server (e.g. one in Docker) instead of here",
    )
    .option("--out <file>", "write a .jobtrace.json file instead of storing the recording")
    .option("--force", "with --out: overwrite the file if it exists")
    .action(async (url: string, options) => {
      exitCode = await ctx.withInterrupt((signal) =>
        recordCommand(url, options, {
          stdout,
          stderr,
          logger: ctx.logger,
          database: () => ctx.db,
          remote: remoteFrom(options.server, env),
          signal,
          cwd: ctx.cwd,
          ...(io.recorder ? { recorder: io.recorder } : {}),
          ...(io.onSession ? { onSession: io.onSession } : {}),
        }),
      );
    });

  program
    .command("run")
    .description("Run a recording or API source and print the jobs it finds as JSON")
    .argument(
      "<recording>",
      "a stored recording or source (id, id prefix or name), or a .jobtrace.json file",
    )
    .option("--headed", "show the browser window")
    .option("--trace", "save a Playwright trace (view with: npx playwright show-trace <zip>)")
    .option("--param <key=value>", "set a recording param; repeatable", collect, [])
    .option("--artifacts <dir>", "for recording files: where to save screenshots and traces")
    .option("--max-pages <n>", "override the recording's maxPages", positiveInt)
    .option("--max-items <n>", "override the recording's maxItems", positiveInt)
    .option("--summary", "print status, stats and artifacts along with the jobs")
    .option("--queue", "do not run now: queue the run for a running `jobtrace serve` to execute")
    .option("--now", "run in this process right away (the default)")
    .action(async (ref: string, options) => {
      exitCode = await runCommand(ref, options, ctx);
    });

  registerAuth(program, ctx);
  registerSource(program, ctx);
  registerRecordings(program, ctx);
  registerSchedule(program, ctx);
  registerRuns(program, ctx, positiveInt);
  registerJobs(program, ctx, positiveInt);

  program
    .command("serve")
    .description("Run the HTTP API and the worker that executes queued runs")
    .option("--port <port>", "port to listen on (default: PORT or 4317)", positiveInt)
    .option("--host <host>", "address to bind (default: HOST or 127.0.0.1)")
    .action(async (options: { port?: number; host?: string }) => {
      // Flags override the environment; the result is validated as a whole.
      const serveConfig = loadConfig({
        ...env,
        ...(options.port ? { PORT: String(options.port) } : {}),
        ...(options.host ? { HOST: options.host } : {}),
      });
      await ctx.withInterrupt(async (signal) => {
        const server = await startServer({
          config: serveConfig,
          logger: { level: serveConfig.logLevel, stream: stderr },
          ...io.server,
        });
        stderr.write(
          `JobTrace is listening on ${server.url}\n  API docs: ${server.url}/api/docs\n  Press Ctrl+C to stop.\n`,
        );
        io.onServer?.(server);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        stderr.write("Stopping: cancelling running runs and closing.\n");
        await server.close();
      });
    });

  program
    .command("db")
    .description("Database maintenance")
    .command("migrate")
    .description("Create or upgrade the database (also happens automatically on first use)")
    .action(() => {
      void ctx.db;
      stderr.write(`Database is up to date: ${ctx.config.databaseUrl}\n`);
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
  } finally {
    database?.close();
  }
  return exitCode;
}
