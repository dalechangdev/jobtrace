import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { App } from "./deps.ts";

/** Where `pnpm build:web` puts the UI. */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/dist", import.meta.url));

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>JobTrace</title>
<body style="font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>JobTrace is running</h1>
<p>The web UI has not been built yet. Build it with <code>pnpm build:web</code> and reload,
or use the <a href="/api/docs">API</a> and the <code>jobtrace</code> command line.</p>`;

/**
 * Serves the built web UI next to the API. Any non-API path a browser asks for
 * gets the app's index page, since the UI does its own routing.
 */
export async function registerWebUi(app: App, root: string | false): Promise<void> {
  const built = root !== false && existsSync(`${root}/index.html`);
  if (built) await app.register(fastifyStatic, { root, wildcard: false, index: false });

  app.setNotFoundHandler((request, reply) => {
    const wantsPage =
      request.method === "GET" &&
      !request.url.startsWith("/api") &&
      !request.url.startsWith("/assets/");
    if (!wantsPage)
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "No such route" } });
    if (!built) return reply.code(200).type("text/html; charset=utf-8").send(NOT_BUILT);
    return reply.header("cache-control", "no-cache").sendFile("index.html");
  });
}
