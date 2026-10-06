import { JobTraceError } from "@jobtrace/core";
import type { JobFilter } from "@jobtrace/db";
import { z } from "zod";
import type { App, RouteContext } from "../deps.ts";
import { errorSchema, idParams, jobRecordSchema, jobsQuerySchema, pageOf } from "../schemas.ts";

const tags = ["jobs"];

const EXPORT_LIMIT = 10_000;
const CSV_COLUMNS = [
  "title",
  "company",
  "location",
  "remote",
  "salaryText",
  "salaryMin",
  "salaryMax",
  "salaryCurrency",
  "salaryPeriod",
  "employmentType",
  "postedAt",
  "url",
  "firstSeenAt",
  "lastSeenAt",
  "closedAt",
  "recordingId",
] as const;

/**
 * One CSV cell. Job text comes from other people's websites: a cell starting
 * with = + - or @ would be run as a formula by spreadsheet programs, so those
 * get a leading apostrophe.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

type JobsQuery = z.infer<typeof jobsQuerySchema>;

function filterOf({ recording, new: onlyNew, q, from, to, closed, remote }: JobsQuery): JobFilter {
  return {
    ...(recording ? { recordingId: recording } : {}),
    ...(onlyNew ? { newInLatestRun: true } : {}),
    ...(q?.trim() ? { search: q } : {}),
    ...(from ? { since: new Date(from).toISOString() } : {}),
    ...(to ? { until: new Date(to).toISOString() } : {}),
    ...(closed ? { includeClosed: true } : {}),
    ...(remote ? { remote } : {}),
  };
}

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
      const { page, pageSize } = request.query;
      const filter = filterOf(request.query);
      const [items, total] = await Promise.all([
        db.jobs.list({ ...filter, limit: pageSize, offset: (page - 1) * pageSize }),
        db.jobs.count(filter),
      ]);
      return { items, total, page, pageSize };
    },
  );

  app.get(
    "/api/jobs/export",
    {
      schema: {
        tags,
        summary: "Download the jobs matching a search as CSV or JSON",
        querystring: jobsQuerySchema.omit({ page: true, pageSize: true }).extend({
          format: z.enum(["csv", "json"]).default("csv"),
        }),
      },
    },
    async (request, reply) => {
      const { format, ...query } = request.query;
      const jobs = await db.jobs.list({
        ...filterOf({ ...query, page: 1, pageSize: 1 }),
        limit: EXPORT_LIMIT,
      });
      reply.header("content-disposition", `attachment; filename="jobtrace-jobs.${format}"`);
      if (format === "json")
        return reply.type("application/json; charset=utf-8").send(JSON.stringify(jobs, null, 2));
      const rows = [
        CSV_COLUMNS.join(","),
        ...jobs.map((job) => CSV_COLUMNS.map((column) => csvCell(job[column])).join(",")),
      ];
      return reply.type("text/csv; charset=utf-8").send(`${rows.join("\r\n")}\r\n`);
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
