import type { Config } from "@jobtrace/core";
import type { Database } from "@jobtrace/db";
import type { Politeness } from "@jobtrace/politeness";
import type { JobQueue, RunHub, Worker } from "@jobtrace/scheduler";
import type { FetchSourceOptions } from "@jobtrace/sources";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { SessionHooks, Sessions } from "./sessions.ts";

/** Everything the routes work with. Built by `startServer`, or by tests. */
export interface AppDeps {
  db: Database;
  config: Config;
  queue: JobQueue;
  worker: Worker;
  hub: RunHub;
  politeness?: Politeness;
  /** Test hooks for recording and login windows. */
  sessionHooks?: SessionHooks;
  /** Options for the one-time feed check when adding an API source. */
  source?: Pick<FetchSourceOptions, "fetch">;
}

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface RouteContext extends AppDeps {
  sessions: Sessions;
}
