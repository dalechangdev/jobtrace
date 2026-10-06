import { JobTraceError } from "@jobtrace/core";
import type { App, RouteContext } from "../deps.ts";
import { errorSchema, idParams, jobRecordSchema, jobsQuerySchema, pageOf } from "../schemas.ts";

const tags = ["jobs"];

export function jobRoutes(app: App, { db }: RouteContext): void {
  app.get(
    "/api/jobs",
    {
      schema: {
        tags,
        summary: "Search the jobs found so far, most recently found first",
        querystring: jobsQuerySchema,
        response: { 200: pageOf(jobRecordSchema) },
      },
    },
    async (request) => {
      const { recording, new: onlyNew, q, from, to, closed, page, pageSize } = request.query;
      const filter = {
        ...(recording ? { recordingId: recording } : {}),
        ...(onlyNew ? { newInLatestRun: true } : {}),
        ...(q?.trim() ? { search: q } : {}),
        ...(from ? { since: new Date(from).toISOString() } : {}),
        ...(to ? { until: new Date(to).toISOString() } : {}),
        ...(closed ? { includeClosed: true } : {}),
      };
      const [items, total] = await Promise.all([
        db.jobs.list({ ...filter, limit: pageSize, offset: (page - 1) * pageSize }),
        db.jobs.count(filter),
      ]);
      return { items, total, page, pageSize };
    },
  );

  app.get(
    "/api/jobs/:id",
    {
      schema: {
        tags,
        summary: "Get one job",
        params: idParams,
        response: { 200: jobRecordSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const job = await db.jobs.get(request.params.id);
      if (!job) throw new JobTraceError("NOT_FOUND", `No job ${request.params.id}`);
      return job;
    },
  );
}
