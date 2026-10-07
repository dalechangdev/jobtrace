import { createReadStream, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  applyLocatorSuggestion,
  JobTraceError,
  RUN_STATUSES,
  suggestionState,
  suggestionsFromEvents,
} from "@jobtrace/core";
import type { RunRecord } from "@jobtrace/db";
import { z } from "zod";
import type { App, RouteContext } from "../deps.ts";
import {
  errorSchema,
  eventSchema,
  idParams,
  runDetailSchema,
  runSchema,
  suggestionSchema,
} from "../schemas.ts";
import { streamRunEvents } from "../sse.ts";

const tags = ["runs"];
const CONTENT_TYPES = {
  screenshot: "image/png",
  trace: "application/zip",
  dom: "text/plain; charset=utf-8",
} as const;

export function runRoutes(app: App, ctx: RouteContext): void {
  const { db } = ctx;

  async function found(id: string): Promise<RunRecord> {
    const run = await db.runs.get(id);
    if (!run) throw new JobTraceError("NOT_FOUND", `No run ${id}`);
    return run;
  }

  app.get(
    "/api/runs",
    {
      schema: {
        tags,
        summary: "List runs, newest first",
        querystring: z.object({
          recording: z.string().optional(),
          status: z.enum(RUN_STATUSES).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(50),
        }),
        response: { 200: z.array(runSchema) },
      },
    },
    async (request) => {
      const { recording, status, limit } = request.query;
      return db.runs.list({
        limit,
        ...(recording ? { recordingId: recording } : {}),
        ...(status ? { status } : {}),
      });
    },
  );

  app.get(
    "/api/runs/:id",
    {
      schema: {
        tags,
        summary: "Get a run with its jobs and artifacts",
        params: idParams,
        response: { 200: runDetailSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const run = await found(request.params.id);
      const [jobs, artifacts] = await Promise.all([
        db.jobs.forRun(run.id),
        db.artifacts.forRun(run.id),
      ]);
      return { run, jobs, artifacts };
    },
  );

  app.get(
    "/api/runs/:id/events",
    {
      schema: {
        tags,
        summary: "The run's log so far",
        params: idParams,
        response: { 200: z.array(eventSchema), 404: errorSchema },
      },
    },
    async (request) => db.runs.events((await found(request.params.id)).id),
  );

  /** The run's healed locators, each with how it stands against the recording as it is now. */
  async function suggestionsOf(run: RunRecord) {
    const stored = await db.recordings.get(run.recordingId);
    if (stored?.kind !== "browser") return { recording: null, suggestions: [] };
    const suggestions = suggestionsFromEvents(await db.runs.events(run.id)).map(
      (suggestion, index) => ({
        index,
        ...suggestion,
        state: suggestionState(stored.recording, suggestion),
      }),
    );
    return { recording: stored.recording, suggestions };
  }

  app.get(
    "/api/runs/:id/suggestions",
    {
      schema: {
        tags,
        summary: "Locators that healed broken steps in this run",
        description:
          "When every recorded locator of a step failed and the AI fallback found the element again, the locator it used is kept here as a suggestion. Accepting one ranks it first on that step's target.",
        params: idParams,
        response: { 200: z.array(suggestionSchema), 404: errorSchema },
      },
    },
    async (request) => (await suggestionsOf(await found(request.params.id))).suggestions,
  );

  app.post(
    "/api/runs/:id/suggestions/:index/accept",
    {
      schema: {
        tags,
        summary: "Save a suggested locator into the recording, ranked first",
        params: z.object({ id: z.string().min(1), index: z.coerce.number().int().min(0) }),
        response: { 200: z.array(suggestionSchema), 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const run = await found(request.params.id);
      const { recording, suggestions } = await suggestionsOf(run);
      const suggestion = suggestions[request.params.index];
      if (!recording || !suggestion) {
        throw new JobTraceError(
          "NOT_FOUND",
          `Run ${run.id} has no suggestion ${request.params.index}`,
        );
      }
      if (suggestion.state === "open") {
        const next = applyLocatorSuggestion(recording, suggestion);
        if (next)
          await db.recordings.save(next, `Accepted a healed locator for step ${suggestion.stepId}`);
      } else if (suggestion.state === "stale") {
        return reply.code(409).send({
          error: {
            code: "INVALID_ARGUMENT",
            message:
              "The step was changed or removed since this run, so the suggestion no longer fits. Run the recording again.",
          },
        });
      }
      return (await suggestionsOf(run)).suggestions;
    },
  );

  app.get(
    "/api/runs/:id/events/stream",
    {
      schema: {
        tags,
        summary: "The run's log as Server-Sent Events, live until the run ends",
        description:
          "Sends `log` events (a run event each), then one `end` event carrying the finished run. Honors Last-Event-ID.",
        params: idParams,
        querystring: z.object({ access_token: z.string().optional() }),
      },
    },
    async (request, reply) => {
      const run = await found(request.params.id);
      await streamRunEvents(request, reply, { db, hub: ctx.hub, runId: run.id });
    },
  );

  app.post(
    "/api/runs/:id/cancel",
    {
      schema: {
        tags,
        summary: "Cancel a queued or running run",
        params: idParams,
        response: { 202: runSchema, 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const run = await found(request.params.id);
      if (!(await ctx.worker.cancel(run.id))) {
        const message =
          run.status === "running"
            ? "This run is not executing in this server (it was started from the command line), so it cannot be cancelled here."
            : `The run already ended (${run.status}).`;
        return reply.code(409).send({ error: { code: "INVALID_ARGUMENT", message } });
      }
      // A running run winds down asynchronously; the caller watches it finish.
      return reply.code(202).send(await found(run.id));
    },
  );

  app.get(
    "/api/runs/:id/artifacts/:artifactId",
    {
      schema: {
        tags,
        summary: "Download a screenshot, DOM snapshot or trace of a run",
        params: z.object({ id: z.string().min(1), artifactId: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const run = await found(request.params.id);
      const artifact = (await db.artifacts.forRun(run.id)).find(
        (item) => item.id === request.params.artifactId,
      );
      // Only files under the artifacts directory are served, whatever the row says.
      const root = resolve(ctx.config.dataDir, "artifacts") + sep;
      const file = artifact ? resolve(artifact.path) : "";
      if (!artifact || !file.startsWith(root) || !existsSync(file)) {
        throw new JobTraceError(
          "NOT_FOUND",
          "No such artifact (it may have been removed by retention)",
        );
      }
      reply
        // Captured pages are untrusted HTML: they are sent as text and never rendered from this origin.
        .header("content-type", CONTENT_TYPES[artifact.type])
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox");
      if (artifact.type === "trace")
        reply.header("content-disposition", `attachment; filename="trace-${run.id}.zip"`);
      return reply.send(createReadStream(file));
    },
  );
}
