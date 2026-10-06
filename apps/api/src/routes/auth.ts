import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { JobTraceError } from "@jobtrace/core";
import { z } from "zod";
import type { App, RouteContext } from "../deps.ts";
import { authProfileSchema, errorSchema, idParams, sessionSchema } from "../schemas.ts";

export function authRoutes(app: App, ctx: RouteContext): void {
  const { db } = ctx;
  const tags = ["auth profiles"];

  app.get(
    "/api/auth-profiles",
    {
      schema: { tags, summary: "List saved logins", response: { 200: z.array(authProfileSchema) } },
    },
    // The path of the session file stays on the server.
    async () =>
      (await db.authProfiles.list()).map(({ storageStatePath: _path, ...profile }) => profile),
  );

  app.post(
    "/api/auth-profiles",
    {
      schema: {
        tags,
        summary: "Open a login window on the server's machine to create a saved login",
        description:
          "Only available when the server is bound to localhost. The user logs in by hand and presses Save login; poll the returned session.",
        body: z.object({ name: z.string().min(1), url: z.url() }),
        response: { 202: sessionSchema, 400: errorSchema },
      },
    },
    async (request, reply) => reply.code(202).send(await ctx.sessions.startAuth(request.body)),
  );

  app.post(
    "/api/auth-profiles/:id/refresh",
    {
      schema: {
        tags,
        summary: "Open a login window to renew an expired saved login",
        params: idParams,
        body: z.object({ url: z.url().optional() }).default({}),
        response: { 202: sessionSchema, 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const profile = await db.authProfiles.get(request.params.id);
      if (!profile) throw new JobTraceError("NOT_FOUND", `No auth profile ${request.params.id}`);
      const session = await ctx.sessions.startAuth({
        name: profile.name,
        profileId: profile.id,
        url: request.body.url ?? `https://${profile.domain}/`,
      });
      return reply.code(202).send(session);
    },
  );

  app.put(
    "/api/auth-profiles/:id/session",
    {
      // Sessions of sites with much local storage can be large.
      bodyLimit: 8 * 1024 * 1024,
      schema: {
        tags,
        summary: "Store a login that was captured on another computer",
        description:
          "For servers without a screen: `jobtrace auth create --server` logs in on your own computer and sends the session here. Sessions can be sent, never read back.",
        params: z.object({ id: z.string().regex(/^auth_[A-Za-z0-9]+$/) }),
        body: z.object({
          name: z.string().min(1),
          domain: z.string().min(1),
          storageState: z.object({ cookies: z.array(z.unknown()), origins: z.array(z.unknown()) }),
        }),
        response: { 200: authProfileSchema, 400: errorSchema },
      },
    },
    async (request) => {
      const { id } = request.params;
      const { name, domain, storageState } = request.body;
      const storageStatePath = join(ctx.config.dataDir, "auth", `${id}.json`);
      await mkdir(dirname(storageStatePath), { recursive: true, mode: 0o700 });
      await writeFile(storageStatePath, JSON.stringify(storageState), { mode: 0o600 });
      await chmod(storageStatePath, 0o600);
      await db.authProfiles.save({ id, name, domain, storageStatePath });
      const { storageStatePath: _path, ...saved } = (await db.authProfiles.list()).find(
        (profile) => profile.id === id,
      ) ?? {
        id,
        name,
        domain,
        storageStatePath,
        createdAt: new Date().toISOString(),
        lastVerifiedAt: null,
        usedBy: 0,
      };
      return saved;
    },
  );

  app.delete(
    "/api/auth-profiles/:id",
    {
      schema: {
        tags,
        summary: "Delete a saved login and its session file",
        params: idParams,
        response: { 204: z.null(), 404: errorSchema },
      },
    },
    async (request, reply) => {
      const profile = await db.authProfiles.get(request.params.id);
      if (!profile) throw new JobTraceError("NOT_FOUND", `No auth profile ${request.params.id}`);
      await rm(profile.storageStatePath, { force: true });
      await db.authProfiles.delete(profile.id);
      return reply.code(204).send(null);
    },
  );

  const sessionTags = ["sessions"];
  app.get(
    "/api/record-sessions/:id",
    {
      schema: {
        tags: sessionTags,
        summary: "Status of a recording or login window",
        params: idParams,
        response: { 200: sessionSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const session = ctx.sessions.get(request.params.id);
      if (!session) throw new JobTraceError("NOT_FOUND", `No session ${request.params.id}`);
      return session;
    },
  );

  app.post(
    "/api/record-sessions/:id/stop",
    {
      schema: {
        tags: sessionTags,
        summary: "End a session: a recording is saved, a login capture is cancelled",
        params: idParams,
        response: { 200: sessionSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const session = await ctx.sessions.stop(request.params.id);
      if (!session) throw new JobTraceError("NOT_FOUND", `No session ${request.params.id}`);
      return session;
    },
  );
}
