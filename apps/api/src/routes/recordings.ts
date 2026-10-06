import {
  ATS_PROVIDERS,
  apiSourceFeedUrl,
  isApiSource,
  JobTraceError,
  newId,
  parseApiSource,
  parseDefinition,
} from "@jobtrace/core";
import { definitionOf, type StoredRecording } from "@jobtrace/db";
import { removeRunArtifacts, testStep } from "@jobtrace/scheduler";
import { fetchSource } from "@jobtrace/sources";
import { z } from "zod";
import type { App, RouteContext } from "../deps.ts";
import {
  definitionSchema,
  errorSchema,
  idParams,
  recordingDetailSchema,
  recordingListItemSchema,
  runSchema,
  sessionSchema,
  testStepResultSchema,
  versionSchema,
} from "../schemas.ts";

const tags = ["recordings"];

export function recordingRoutes(app: App, ctx: RouteContext): void {
  const { db } = ctx;

  async function found(id: string): Promise<StoredRecording> {
    const stored = await db.recordings.get(id);
    if (!stored) throw new JobTraceError("NOT_FOUND", `No recording ${id}`);
    return stored;
  }
  async function detail(stored: StoredRecording) {
    const { id, kind, name, startUrl, domain, createdAt, updatedAt, versionId } = stored;
    return {
      id,
      kind,
      name,
      startUrl,
      domain,
      createdAt,
      updatedAt,
      versionId,
      openJobs: await db.jobs.count({ recordingId: id }),
      definition: definitionOf(stored) as Record<string, unknown>,
    };
  }

  app.get(
    "/api/recordings",
    {
      schema: {
        tags,
        summary: "List recordings and API sources",
        response: { 200: z.array(recordingListItemSchema) },
      },
    },
    async () =>
      Promise.all(
        (await db.recordings.list()).map(async (recording) => {
          const [lastRun] = await db.runs.list({ recordingId: recording.id, limit: 1 });
          return {
            ...recording,
            openJobs: await db.jobs.count({ recordingId: recording.id }),
            lastRun: lastRun ?? null,
          };
        }),
      ),
  );

  app.post(
    "/api/recordings",
    {
      schema: {
        tags,
        summary: "Store a recording or API source definition",
        description:
          "The body is a definition as exported by JobTrace. Without an id, one is assigned.",
        body: definitionSchema,
        response: { 201: recordingDetailSchema, 400: errorSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const isApi = body.kind === "api";
      const definition = parseDefinition({
        ...body,
        id: body.id ?? newId(isApi ? "source" : "recording"),
      });
      if (await db.recordings.get(definition.id)) {
        throw new JobTraceError(
          "INVALID_ARGUMENT",
          `A recording with id ${definition.id} already exists; use PUT to update it`,
        );
      }
      await db.recordings.save(definition, "created through the API");
      return reply.code(201).send(await detail(await found(definition.id)));
    },
  );

  app.get(
    "/api/recordings/:id",
    {
      schema: {
        tags,
        summary: "Get a recording with its definition",
        params: idParams,
        response: { 200: recordingDetailSchema, 404: errorSchema },
      },
    },
    async (request) => detail(await found(request.params.id)),
  );

  app.put(
    "/api/recordings/:id",
    {
      schema: {
        tags,
        summary: "Replace a recording's definition (saved as a new version)",
        params: idParams,
        body: definitionSchema,
        response: { 200: recordingDetailSchema, 400: errorSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const current = await found(request.params.id);
      const definition = parseDefinition({ ...request.body, id: current.id });
      if (isApiSource(definition) !== (current.kind === "api")) {
        throw new JobTraceError(
          "INVALID_ARGUMENT",
          "A recording cannot be turned into an API source, or the reverse",
        );
      }
      await db.recordings.save(definition, "edited");
      return detail(await found(current.id));
    },
  );

  app.delete(
    "/api/recordings/:id",
    {
      schema: {
        tags,
        summary: "Delete a recording with its runs, jobs and artifacts",
        params: idParams,
        response: { 204: z.null(), 404: errorSchema },
      },
    },
    async (request, reply) => {
      const stored = await found(request.params.id);
      const { runIds } = await db.recordings.delete(stored.id);
      await removeRunArtifacts(ctx.config.dataDir, runIds);
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/api/recordings/:id/versions",
    {
      schema: {
        tags,
        summary: "List saved versions, newest first",
        params: idParams,
        response: { 200: z.array(versionSchema), 404: errorSchema },
      },
    },
    async (request) => db.recordings.versions((await found(request.params.id)).id),
  );

  app.get(
    "/api/recordings/:id/versions/:versionId",
    {
      schema: {
        tags,
        summary: "The definition as saved in one version (PUT it back to restore)",
        params: z.object({ id: z.string().min(1), versionId: z.string().min(1) }),
        response: { 200: definitionSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const definition = await db.recordings.version(request.params.id, request.params.versionId);
      if (!definition) throw new JobTraceError("NOT_FOUND", "No such version");
      return definition as Record<string, unknown>;
    },
  );

  app.post(
    "/api/recordings/:id/test-step",
    {
      schema: {
        tags,
        summary: "Try one step: replay the saved recording up to that step, once",
        description: "Runs in a headless browser and waits for the result. Nothing is stored.",
        params: idParams,
        body: z.object({ stepId: z.string().min(1) }),
        response: { 200: testStepResultSchema, 400: errorSchema, 404: errorSchema },
      },
    },
    async (request) =>
      testStep(db, request.params.id, request.body.stepId, {
        ...(ctx.politeness ? { politeness: ctx.politeness } : {}),
        run: { runTimeoutMs: 120_000, ...ctx.testRun },
      }),
  );

  app.post(
    "/api/recordings/:id/runs",
    {
      schema: {
        tags: ["runs"],
        summary: "Queue a run of a recording or source",
        params: idParams,
        body: z
          .object({
            params: z.record(z.string(), z.string()).optional(),
            headed: z.boolean().optional(),
            trace: z.boolean().optional(),
          })
          .default({}),
        response: { 202: runSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const stored = await found(request.params.id);
      const { params, headed, trace } = request.body;
      const run = await ctx.queue.enqueue({
        recordingId: stored.id,
        trigger: "manual",
        ...(params ? { params } : {}),
        options: { ...(headed ? { headed } : {}), ...(trace ? { trace } : {}) },
      });
      return reply.code(202).send(run);
    },
  );

  app.post(
    "/api/recordings/record",
    {
      schema: {
        tags: ["sessions"],
        summary: "Open a recorder window on the server's machine",
        description:
          "Only available when the server is bound to localhost. Poll the returned session.",
        body: z.object({
          url: z.url(),
          name: z.string().min(1).optional(),
          authProfileId: z.string().optional(),
        }),
        response: { 202: sessionSchema, 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const { url, name, authProfileId } = request.body;
      const session = await ctx.sessions.startRecording({
        url,
        ...(name ? { name } : {}),
        ...(authProfileId ? { authProfileId } : {}),
      });
      return reply.code(202).send(session);
    },
  );

  app.post(
    "/api/sources",
    {
      schema: {
        tags,
        summary: "Add a Greenhouse, Lever or Ashby board, read through its public feed",
        body: z.object({
          provider: z.enum(ATS_PROVIDERS),
          boardToken: z.string().min(1),
          name: z.string().min(1).optional(),
          company: z.string().min(1).optional(),
          baseUrl: z.url().optional(),
          /** Read the feed once first, and store nothing if that fails. */
          check: z.boolean().default(true),
        }),
        response: { 201: recordingDetailSchema, 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const { provider, boardToken, name, company, baseUrl, check } = request.body;
      const source = parseApiSource({
        schemaVersion: 1,
        kind: "api",
        id: newId("source"),
        name: name ?? `${boardToken} (${provider})`,
        provider,
        boardToken,
        ...(baseUrl ? { baseUrl } : {}),
        settings: company ? { company } : {},
      });
      if (check) {
        const result = await fetchSource(source, {
          ...ctx.source,
          ...(ctx.politeness ? { robots: ctx.politeness.robots } : {}),
        });
        if (result.status !== "succeeded" && result.status !== "partial") {
          throw new JobTraceError(
            "NOT_FOUND",
            `Could not read ${apiSourceFeedUrl(source)}: ${result.error?.message ?? result.status}`,
          );
        }
      }
      await db.recordings.save(source, "added");
      return reply.code(201).send(await detail(await found(source.id)));
    },
  );
}
