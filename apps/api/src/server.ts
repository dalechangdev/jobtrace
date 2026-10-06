import { join } from "node:path";
import { type Config, isLoopbackHost } from "@jobtrace/core";
import { type Database, openDatabase } from "@jobtrace/db";
import { createPoliteness } from "@jobtrace/politeness";
import {
  createDbQueue,
  createRunHub,
  createScheduler,
  createWorker,
  type Scheduler,
  type Worker,
  type WorkerOptions,
} from "@jobtrace/scheduler";
import type { FastifyServerOptions } from "fastify";
import { buildApp } from "./app.ts";
import type { App, AppDeps } from "./deps.ts";
import { loadRuntime } from "./runtime.ts";

export interface ServerOptions {
  config: Config;
  /** An open database to use; otherwise the one from the config is opened (and closed on shutdown). */
  db?: Database;
  logger?: FastifyServerOptions["logger"];
  /** Listen on this port instead of the configured one; 0 picks a free port. */
  port?: number;
  /**
   * Bind to this address instead of `config.host`. For tests: the security
   * rules still follow `config.host`, without really exposing the port.
   */
  listenHost?: string;
  worker?: Pick<WorkerOptions, "pollIntervalMs" | "run" | "source">;
  sessionHooks?: AppDeps["sessionHooks"];
  webRoot?: AppDeps["webRoot"];
  /** How often schedules are re-read from the database; see SchedulerOptions.syncIntervalMs. */
  scheduleSyncMs?: number;
}

export interface RunningServer {
  app: App;
  worker: Worker;
  scheduler: Scheduler;
  db: Database;
  /** e.g. `http://127.0.0.1:4317` */
  url: string;
  /** Stops accepting requests, cancels running runs, closes browser windows and the database. */
  close(): Promise<void>;
}

/**
 * Starts everything `jobtrace serve` runs in one process: the HTTP API, the
 * worker that executes queued runs, and the politeness state they share.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { config } = options;
  const db = options.db ?? openDatabase(config.databaseUrl);
  const politeness = createPoliteness({ cacheDir: join(config.dataDir, "cache", "robots") });
  const hub = createRunHub();
  const runtime = await loadRuntime(db, config);
  let worker: Worker | undefined;
  const queue = createDbQueue(db, { onEnqueue: () => worker?.wake() });
  worker = createWorker({
    db,
    queue,
    hub,
    politeness,
    dataDir: config.dataDir,
    artifactRetentionRuns: () => runtime.current.artifactRetentionRuns,
    maxConcurrentRuns: () => runtime.current.maxConcurrentRuns,
    ...options.worker,
    onError: (error, run) => app.log.error({ err: error, runId: run.id }, "run crashed"),
  });
  const scheduler = createScheduler({
    db,
    queue,
    ...(options.scheduleSyncMs === undefined ? {} : { syncIntervalMs: options.scheduleSyncMs }),
    onLog: (level, message, data) => app.log[level]({ ...data }, message),
  });
  const { app, sessions } = await buildApp(
    {
      db,
      config,
      queue,
      worker,
      scheduler,
      hub,
      politeness,
      runtime,
      ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
      ...(options.worker?.run ? { testRun: options.worker.run } : {}),
      ...(options.sessionHooks ? { sessionHooks: options.sessionHooks } : {}),
    },
    // One log line per request would drown everything else: the UI polls.
    { logger: options.logger ?? false, disableRequestLogging: true },
  );

  await worker.start();
  await scheduler.start();
  const bindHost = options.listenHost ?? config.host;
  await app.listen({ host: bindHost, port: options.port ?? config.port });
  const address = app.server.address();
  const port = address && typeof address !== "string" ? address.port : config.port;
  const host = bindHost.includes(":") && !bindHost.startsWith("[") ? `[${bindHost}]` : bindHost;
  if (!isLoopbackHost(config.host)) {
    app.log.warn(
      config.apiToken
        ? `Listening on ${config.host}, reachable from other machines. Every request must carry the API token.`
        : `Listening on ${config.host} but answering only to ${config.allowedHosts.join(", ")}. This is safe only while the port is published on this computer alone (127.0.0.1), as in the provided docker-compose.yml.`,
    );
  }
  const running = worker;
  return {
    app,
    worker: running,
    scheduler,
    db,
    // 0.0.0.0 is where it listens, not an address to open in a browser.
    url: `http://${bindHost === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    async close() {
      scheduler.stop();
      await sessions.closeAll();
      await running.stop();
      await app.close();
      if (!options.db) db.close();
    },
  };
}
