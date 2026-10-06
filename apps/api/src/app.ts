import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { type ErrorCode, isJobTraceError } from "@jobtrace/core";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import type { App, AppDeps } from "./deps.ts";
import { authRoutes } from "./routes/auth.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { recordingRoutes } from "./routes/recordings.ts";
import { runRoutes } from "./routes/runs.ts";
import { scheduleRoutes } from "./routes/schedules.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { registerSecurity } from "./security.ts";
import { createSessions, type Sessions } from "./sessions.ts";
import { DEFAULT_WEB_ROOT, registerWebUi } from "./static.ts";

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  NOT_FOUND: 404,
  INVALID_ARGUMENT: 400,
  INVALID_RECORDING: 400,
  TEMPLATE_ERROR: 400,
};

export interface BuiltApp {
  app: App;
  sessions: Sessions;
}

/** Assembles the HTTP API. It does not listen; `startServer` or a test does that. */
export async function buildApp(
  deps: AppDeps,
  options: FastifyServerOptions = {},
): Promise<BuiltApp> {
  const app = Fastify({ logger: false, ...options }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerSecurity(app, deps.config);

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (isJobTraceError(error)) {
      const status = STATUS_BY_CODE[error.code] ?? 500;
      return reply.code(status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const message = error.validation
        .map(
          (issue) =>
            `${issue.instancePath.replace(/^\//, "").replaceAll("/", ".") || "request"}: ${issue.message}`,
        )
        .join("; ");
      return reply.code(400).send({ error: { code: "INVALID_ARGUMENT", message } });
    }
    const status =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    if (status === 500) request.log.error(error);
    return reply.code(status).send({
      error: {
        code: status === 500 ? "INTERNAL" : "INVALID_ARGUMENT",
        message: status === 500 ? "Something went wrong on the server." : error.message,
      },
    });
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "JobTrace API",
        version: "0.1.0",
        description:
          "Manage recordings and API sources, trigger and watch runs, and browse the jobs they find.",
      },
      ...(deps.config.apiToken
        ? {
            components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } },
            security: [{ token: [] }],
          }
        : {}),
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/api/docs" });

  const sessions = createSessions(deps.db, deps.config, deps.runtime, deps.sessionHooks);
  const ctx = { ...deps, sessions };

  app.get(
    "/api/health",
    {
      schema: {
        tags: ["server"],
        summary: "Liveness and a little status",
        response: {
          200: z.object({
            status: z.literal("ok"),
            activeRuns: z.number(),
            queuedRuns: z.number(),
          }),
        },
      },
    },
    async () => ({
      status: "ok" as const,
      activeRuns: deps.worker.active().length,
      queuedRuns: (await deps.db.runs.list({ status: "queued", limit: 500 })).length,
    }),
  );
  recordingRoutes(app, ctx);
  runRoutes(app, ctx);
  jobRoutes(app, ctx);
  authRoutes(app, ctx);
  scheduleRoutes(app, ctx);
  settingsRoutes(app, ctx);
  await registerWebUi(app, deps.webRoot ?? DEFAULT_WEB_ROOT);

  await app.ready();
  return { app, sessions };
}
