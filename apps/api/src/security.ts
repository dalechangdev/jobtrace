import { timingSafeEqual } from "node:crypto";
import { type Config, isLoopbackHost } from "@jobtrace/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const hostOnly = (value: string) => {
  // "[::1]:4317" -> "[::1]", "localhost:4317" -> "localhost"
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(value.trim());
  return (match?.[1] ?? value).toLowerCase();
};

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const deny = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

/**
 * Guards for an API that can open browsers and read saved jobs:
 *  - When bound to loopback, the Host header must be a loopback name. That
 *    stops DNS rebinding, where a web page's own domain is pointed at 127.0.0.1.
 *  - Requests carrying an Origin from another site are refused (cross-site
 *    requests from pages the user happens to have open).
 *  - When an API token is configured, every /api route except /api/health needs it.
 */
export function registerSecurity(app: FastifyInstance, config: Config): void {
  const loopback = isLoopbackHost(config.host);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const host = hostOnly(request.headers.host ?? "");
    if (loopback && !isLoopbackHost(host)) {
      return deny(
        reply,
        403,
        "FORBIDDEN",
        "This server only answers requests addressed to localhost.",
      );
    }
    const origin = request.headers.origin;
    if (origin) {
      // Compare as URLs, so "localhost:80" and "localhost" are the same place for http.
      let sameSite = false;
      try {
        const from = new URL(origin);
        sameSite = from.host === new URL(`${from.protocol}//${request.headers.host ?? ""}`).host;
      } catch {
        // "null" and other non-URL origins never match.
      }
      if (!sameSite) {
        return deny(reply, 403, "FORBIDDEN", "Cross-site requests are not allowed.");
      }
    }
    if (
      !config.apiToken ||
      !request.url.startsWith("/api") ||
      request.url.startsWith("/api/health")
    )
      return;
    const header = request.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    // Browsers cannot set headers on an EventSource, so streams may pass the token in the URL.
    const query = (request.query as { access_token?: string } | undefined)?.access_token ?? "";
    const stream = request.url.includes("/events/stream");
    const given = bearer || (stream ? query : "");
    if (!given || !sameToken(given, config.apiToken)) {
      return deny(reply, 401, "UNAUTHORIZED", "A valid API token is required.");
    }
  });
}
