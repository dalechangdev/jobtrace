import { isLoopbackHost } from "@jobtrace/core";
import type { App, RouteContext } from "../deps.ts";
import { runtimeSettingsSchema } from "../runtime.ts";
import { errorSchema, settingsViewSchema } from "../schemas.ts";

export function settingsRoutes(app: App, ctx: RouteContext): void {
  const tags = ["server"];
  const view = () => ({
    ...ctx.runtime.current,
    aiFallbackKeyConfigured: Boolean(ctx.config.aiFallback.apiKey),
    dataDir: ctx.config.dataDir,
    local: isLoopbackHost(ctx.config.host),
  });

  app.get(
    "/api/settings",
    {
      schema: {
        tags,
        summary: "Settings that can be changed while the server runs",
        response: { 200: settingsViewSchema },
      },
    },
    async () => view(),
  );

  app.put(
    "/api/settings",
    {
      schema: {
        tags,
        summary: "Change settings; they take effect at once and survive restarts",
        body: runtimeSettingsSchema.partial(),
        response: { 200: settingsViewSchema, 400: errorSchema },
      },
    },
    async (request, reply) => {
      const next = { ...ctx.runtime.current, ...request.body };
      if (next.defaultMinDelayMs > next.defaultMaxDelayMs) {
        return reply.code(400).send({
          error: {
            code: "INVALID_ARGUMENT",
            message: "The minimum delay must not exceed the maximum delay.",
          },
        });
      }
      await ctx.runtime.update(request.body);
      // More room for runs may have opened up.
      ctx.worker.wake();
      return view();
    },
  );
}
