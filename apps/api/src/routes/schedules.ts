import { JobTraceError } from "@jobtrace/core";
import {
  createSchedule,
  describeCron,
  nextRuns,
  resolveTimezone,
  scheduleView,
  updateSchedule,
  validateSchedule,
} from "@jobtrace/scheduler";
import { z } from "zod";
import type { App, RouteContext } from "../deps.ts";
import { errorSchema, idParams, scheduleSchema } from "../schemas.ts";

const tags = ["schedules"];
const cron = z.string().min(1).describe('Five-field cron expression, e.g. "0 8 * * 1-5"');
const timezone = z
  .string()
  .min(1)
  .nullable()
  .describe("IANA time zone such as Europe/Madrid; null for the server's own");
const params = z.record(z.string(), z.string());

export function scheduleRoutes(app: App, ctx: RouteContext): void {
  const { db } = ctx;

  app.get(
    "/api/schedules",
    {
      schema: {
        tags,
        summary: "List schedules, each in words and with its next runs",
        querystring: z.object({ recording: z.string().optional() }),
        response: { 200: z.array(scheduleSchema) },
      },
    },
    async (request) => {
      const { recording } = request.query;
      return (await db.schedules.list(recording ? { recordingId: recording } : {})).map(
        (schedule) => scheduleView(schedule),
      );
    },
  );

  app.get(
    "/api/schedules/preview",
    {
      schema: {
        tags,
        summary: "Check a schedule before saving it: what it means and when it would run next",
        querystring: z.object({ cron, timezone: z.string().optional() }),
        response: {
          200: z.object({
            description: z.string(),
            effectiveTimezone: z.string(),
            nextRuns: z.array(z.string()),
          }),
          400: errorSchema,
        },
      },
    },
    async (request) => {
      const zone = request.query.timezone || null;
      const expression = request.query.cron.trim().replace(/\s+/g, " ");
      validateSchedule(expression, zone);
      return {
        description: describeCron(expression, zone),
        effectiveTimezone: resolveTimezone(zone),
        nextRuns: nextRuns(expression, zone, 5).map((date) => date.toISOString()),
      };
    },
  );

  app.post(
    "/api/schedules",
    {
      schema: {
        tags,
        summary: "Run a recording or source on a schedule",
        description:
          "Schedules fire only while the server is running, and at most every 15 minutes.",
        body: z.object({
          recordingId: z.string().min(1),
          cron,
          timezone: timezone.optional(),
          params: params.optional(),
          enabled: z.boolean().optional(),
        }),
        response: { 201: scheduleSchema, 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const {
        recordingId,
        cron: expression,
        timezone: zone,
        params: values,
        enabled,
      } = request.body;
      const schedule = await createSchedule(db, {
        recordingId,
        cron: expression,
        ...(zone === undefined ? {} : { timezone: zone }),
        ...(values ? { params: values } : {}),
        ...(enabled === undefined ? {} : { enabled }),
      });
      await ctx.scheduler.reload();
      return reply.code(201).send(scheduleView((await db.schedules.get(schedule.id)) ?? schedule));
    },
  );

  app.put(
    "/api/schedules/:id",
    {
      schema: {
        tags,
        summary: "Change, pause or resume a schedule",
        params: idParams,
        body: z.object({
          cron: cron.optional(),
          timezone: timezone.optional(),
          params: params.optional(),
          enabled: z.boolean().optional(),
        }),
        response: { 200: scheduleSchema, 400: errorSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const { cron: expression, timezone: zone, params: values, enabled } = request.body;
      const schedule = await updateSchedule(db, request.params.id, {
        ...(expression === undefined ? {} : { cron: expression }),
        ...(zone === undefined ? {} : { timezone: zone }),
        ...(values === undefined ? {} : { params: values }),
        ...(enabled === undefined ? {} : { enabled }),
      });
      await ctx.scheduler.reload();
      return scheduleView((await db.schedules.get(schedule.id)) ?? schedule);
    },
  );

  app.delete(
    "/api/schedules/:id",
    {
      schema: {
        tags,
        summary: "Delete a schedule",
        params: idParams,
        response: { 204: z.null(), 404: errorSchema },
      },
    },
    async (request, reply) => {
      if (!(await db.schedules.delete(request.params.id))) {
        throw new JobTraceError("NOT_FOUND", `No schedule ${request.params.id}`);
      }
      await ctx.scheduler.reload();
      return reply.code(204).send(null);
    },
  );
}
