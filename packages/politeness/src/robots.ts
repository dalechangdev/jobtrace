import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RobotsPolicy, RobotsVerdict } from "@jobtrace/core";
import robotsParserModule from "robots-parser";

// The package is CommonJS: its default import is the parser function itself, but
// its type declarations describe an ES module default export.
interface Robots {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
}
const robotsParser = robotsParserModule as unknown as (url: string, body: string) => Robots;

/** The product token matched against robots.txt groups; `*` groups apply as well. */
export const ROBOTS_USER_AGENT = "JobTrace";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RobotsOptions {
  fetch?: typeof fetch;
  /** Directory for robots.txt files cached between processes. In-memory only when omitted. */
  cacheDir?: string;
  ttlMs?: number;
  /** Sent when fetching robots.txt itself. */
  userAgent?: string;
  requestTimeoutMs?: number;
  now?: () => number;
}

/** What is known about one origin's robots.txt. */
type Rules =
  | { kind: "rules"; body: string }
  /** No robots.txt (4xx): everything may be fetched. */
  | { kind: "none" }
  /** robots.txt could not be retrieved (5xx, network): assume nothing may be fetched. */
  | { kind: "unreachable"; why: string };

interface Entry {
  rules: Rules;
  fetchedAt: number;
}

/**
 * Answers "may this URL be fetched?" from each origin's robots.txt, fetched
 * once and cached for a day (in memory, and on disk when `cacheDir` is set).
 * Follows RFC 9309: no robots.txt means no restrictions, while a robots.txt
 * that cannot be retrieved because of a server or network error means "stay out".
 */
export function createRobots(options: RobotsOptions = {}): RobotsPolicy {
  const request = options.fetch ?? fetch;
  const ttl = options.ttlMs ?? DAY_MS;
  const now = options.now ?? Date.now;
  const memory = new Map<string, Promise<Entry>>();

  const cacheFile = (origin: string) =>
    options.cacheDir
      ? join(
          options.cacheDir,
          `${createHash("sha256").update(origin).digest("hex").slice(0, 32)}.json`,
        )
      : null;

  async function fromDisk(origin: string): Promise<Entry | null> {
    const file = cacheFile(origin);
    if (!file) return null;
    try {
      const info = await stat(file);
      if (now() - info.mtimeMs > ttl) return null;
      return { rules: JSON.parse(await readFile(file, "utf8")) as Rules, fetchedAt: info.mtimeMs };
    } catch {
      return null;
    }
  }

  async function download(origin: string): Promise<Rules> {
    try {
      const response = await request(`${origin}/robots.txt`, {
        headers: {
          "user-agent": options.userAgent ?? ROBOTS_USER_AGENT,
          accept: "text/plain,*/*;q=0.1",
        },
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? 10_000),
        redirect: "follow",
      });
      if (response.ok) return { kind: "rules", body: (await response.text()).slice(0, 500_000) };
      await response.body?.cancel().catch(() => {});
      if (response.status >= 500) return { kind: "unreachable", why: `HTTP ${response.status}` };
      return { kind: "none" };
    } catch (error) {
      return { kind: "unreachable", why: (error as Error).message };
    }
  }

  async function load(origin: string): Promise<Entry> {
    const cached = await fromDisk(origin);
    if (cached) return cached;
    const rules = await download(origin);
    const file = cacheFile(origin);
    // A failure to fetch is not cached on disk: the next run should try again.
    if (file && options.cacheDir && rules.kind !== "unreachable") {
      await mkdir(options.cacheDir, { recursive: true })
        .then(() => writeFile(file, JSON.stringify(rules)))
        .catch(() => {});
    }
    return { rules, fetchedAt: now() };
  }

  return {
    async check(url): Promise<RobotsVerdict> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { allowed: true };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { allowed: true };
      const { origin } = parsed;

      let pending = memory.get(origin);
      if (pending && now() - (await pending).fetchedAt > ttl) pending = undefined;
      if (!pending) {
        pending = load(origin);
        memory.set(origin, pending);
      }
      const { rules } = await pending;
      if (rules.kind === "none") return { allowed: true };
      if (rules.kind === "unreachable") {
        memory.delete(origin);
        return {
          allowed: false,
          reason: `${origin}/robots.txt could not be retrieved (${rules.why}), so the site is treated as off limits`,
        };
      }
      const robots = robotsParser(`${origin}/robots.txt`, rules.body);
      // Unknown to the parser (e.g. another origin) counts as allowed.
      if (robots.isAllowed(url, ROBOTS_USER_AGENT) !== false) {
        const delay = Number(robots.getCrawlDelay(ROBOTS_USER_AGENT));
        return {
          allowed: true,
          ...(Number.isFinite(delay) && delay > 0 ? { crawlDelayMs: delay * 1000 } : {}),
        };
      }
      return { allowed: false, reason: `${origin}/robots.txt disallows ${parsed.pathname}` };
    },
  };
}
