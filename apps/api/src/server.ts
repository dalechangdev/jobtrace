import { join } from "node:path";
import { type Config, isLoopbackHost } from "@jobtrace/core";
import { type Database, openDatabase } from "@jobtrace/db";
import { createPoliteness } from "@jobtrace/politeness";
import {
  createDbQueue,
  createRunHub,
  createWorker,
  type Worker,
  type WorkerOptions,
} from "@jobtrace/scheduler";
import type { FastifyServerOptions } from "fastify";
import { buildApp } from "./app.ts";
import type { App, AppDeps } from "./deps.ts";

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
}

export interface RunningServer {
  app: App;
  worker: Worker;
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
  let worker: Worker | undefined;
  const queue = createDbQueue(db, { onEnqueue: () => worker?.wake() });
  worker = createWorker({
    db,
    queue,
    hub,
    politeness,
    dataDir: config.dataDir,
    artifactRetentionRuns: config.artifactRetentionRuns,
    maxConcurrentRuns: config.maxConcurrentRuns,
    ...options.worker,
    onError: (error, run) => app.log.error({ err: error, runId: run.id }, "run crashed"),
  });
  const { app, sessions } = await buildApp(
    {
      db,
      config,
      queue,
      worker,
      hub,
      politeness,
      ...(options.sessionHooks ? { sessionHooks: options.sessionHooks } : {}),
    },
    { logger: options.logger ?? false },
  );

  await worker.start();
  const bindHost = options.listenHost ?? config.host;
  await app.listen({ host: bindHost, port: options.port ?? config.port });
  const address = app.server.address();
  const port = address && typeof address !== "string" ? address.port : config.port;
  const host = bindHost.includes(":") && !bindHost.startsWith("[") ? `[${bindHost}]` : bindHost;
  if (!isLoopbackHost(config.host)) {
    app.log.warn(
      `Listening on ${config.host}, reachable from other machines. Every request must carry the API token.`,
    );
  }
  const running = worker;
  return {
    app,
    worker: running,
    db,
    url: `http://${host}:${port}`,
    async close() {
      await sessions.closeAll();
      await running.stop();
      await app.close();
      if (!options.db) db.close();
    },
  };
}
