import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PageSnapshot } from "@jobtrace/core";
import { type RunningTestSites, SITES, startTestSites } from "@jobtrace/test-sites";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectBotWall } from "./botwall.ts";
import { DomainLocks } from "./locks.ts";
import { retryAfterMs } from "./retry.ts";
import { createRobots } from "./robots.ts";

let sites: RunningTestSites;
beforeAll(async () => {
  sites = await startTestSites();
});
afterAll(() => sites?.close());

/** A fetch that serves the given robots.txt bodies (or statuses) by host and counts requests. */
function fakeFetch(hosts: Record<string, string | number | Error>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.href);
    const answer = hosts[url.host];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return new Response("nope", { status: answer });
    return new Response(answer ?? "", { status: answer === undefined ? 404 : 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("robots.txt", () => {
  it("allows and disallows according to the fixture site's robots.txt", async () => {
    const robots = createRobots();
    expect(await robots.check(sites.url(SITES.staticList))).toEqual({ allowed: true });
    const verdict = await robots.check(sites.url(`${SITES.robotsDisallowed}?page=2`));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe(`${sites.origin}/robots.txt disallows ${SITES.robotsDisallowed}`);
  });

  it("fetches each origin once and applies the most specific group", async () => {
    const { impl, calls } = fakeFetch({
      "a.example":
        "User-agent: *\nDisallow: /\n\nUser-agent: JobTrace\nDisallow: /private/\nCrawl-delay: 2",
      "b.example": "User-agent: *\nDisallow: /search\nAllow: /search/jobs",
    });
    const robots = createRobots({ fetch: impl });
    expect(await robots.check("https://a.example/jobs")).toEqual({
      allowed: true,
      crawlDelayMs: 2000,
    });
    expect((await robots.check("https://a.example/private/x")).allowed).toBe(false);
    expect((await robots.check("https://b.example/search?q=1")).allowed).toBe(false);
    expect((await robots.check("https://b.example/search/jobs")).allowed).toBe(true);
    expect((await robots.check("http://a.example/jobs")).allowed).toBe(true);
    // One fetch per origin; http and https are different origins.
    expect(calls).toEqual([
      "https://a.example/robots.txt",
      "https://b.example/robots.txt",
      "http://a.example/robots.txt",
    ]);
  });

  it("treats a missing robots.txt as no restrictions, and an unreachable one as off limits", async () => {
    const { impl, calls } = fakeFetch({
      "none.example": 404,
      "auth.example": 401,
      "down.example": 503,
      "gone.example": new Error("getaddrinfo ENOTFOUND"),
    });
    const robots = createRobots({ fetch: impl });
    expect(await robots.check("https://none.example/jobs")).toEqual({ allowed: true });
    expect(await robots.check("https://auth.example/jobs")).toEqual({ allowed: true });
    const down = await robots.check("https://down.example/jobs");
    expect(down).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/could not be retrieved \(HTTP 503\)/),
    });
    expect((await robots.check("https://gone.example/jobs")).reason).toMatch(/ENOTFOUND/);
    // A failure is not remembered: the next check asks again.
    await robots.check("https://down.example/jobs");
    expect(calls.filter((url) => url.includes("down.example"))).toHaveLength(2);
    expect(calls.filter((url) => url.includes("none.example"))).toHaveLength(1);
  });

  it("refetches after the cache lifetime, and shares the cache across instances on disk", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "jobtrace-robots-"));
    try {
      let time = Date.now();
      const { impl, calls } = fakeFetch({ "a.example": "User-agent: *\nDisallow: /x" });
      const options = { fetch: impl, cacheDir, ttlMs: 1000, now: () => time };
      const first = createRobots(options);
      await first.check("https://a.example/");
      await first.check("https://a.example/x");
      expect(calls).toHaveLength(1);
      expect(readdirSync(cacheDir)).toHaveLength(1);

      // Another process: served from disk.
      expect((await createRobots(options).check("https://a.example/x")).allowed).toBe(false);
      expect(calls).toHaveLength(1);

      time += 5000;
      await first.check("https://a.example/");
      expect(calls).toHaveLength(2);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("does not judge things that are not web URLs", async () => {
    const robots = createRobots({ fetch: fakeFetch({}).impl });
    expect(await robots.check("about:blank")).toEqual({ allowed: true });
    expect(await robots.check("not a url")).toEqual({ allowed: true });
  });
});

describe("domain locks", () => {
  it("lets one run per domain proceed at a time, in arrival order", async () => {
    const locks = new DomainLocks();
    const order: string[] = [];
    const run = async (name: string, domain: string, ms: number) => {
      const release = await locks.acquire(domain);
      order.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name} end`);
      release();
    };
    await Promise.all([
      run("a1", "A.example", 40),
      run("a2", "a.example", 5),
      run("b1", "b.example", 10),
    ]);
    expect(order).toEqual(["a1 start", "b1 start", "b1 end", "a1 end", "a2 start", "a2 end"]);
    expect(locks.isBusy("a.example")).toBe(false);
  });

  it("gives a cancelled waiter's turn to the next in line", async () => {
    const locks = new DomainLocks();
    const release = await locks.acquire("a.example");
    expect(locks.isBusy("a.example")).toBe(true);
    const controller = new AbortController();
    const cancelled = locks.acquire("a.example", controller.signal);
    const third = locks.acquire("a.example");
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "RUN_CANCELLED" });
    release();
    (await third)();
    expect(locks.isBusy("a.example")).toBe(false);
    await expect(locks.acquire("a.example", AbortSignal.abort())).rejects.toMatchObject({
      code: "RUN_CANCELLED",
    });
    (await locks.acquire("a.example"))();
  });
});

describe("bot-wall detection", () => {
  const page = (overrides: Partial<PageSnapshot>): PageSnapshot => ({
    url: "https://x.example/",
    title: "Jobs at Acme",
    text: "",
    textLength: 0,
    visibleFrameUrls: [],
    challengeMarkers: [],
    ...overrides,
  });
  const article = "Open positions. ".repeat(200);

  it.each([
    ["Just a moment...", /page title/],
    ["Attention Required! | Cloudflare", /page title/],
    ["Access Denied", /page title/],
    ["Pardon Our Interruption", /page title/],
  ])("recognizes the interstitial titled %s", (title, signal) => {
    expect(detectBotWall(page({ title }))?.signal).toMatch(signal);
  });

  it("recognizes an active challenge even on a full page", () => {
    const verdict = detectBotWall(
      page({
        text: article,
        textLength: article.length,
        visibleFrameUrls: ["https://www.google.com/recaptcha/api2/bframe?hl=en&k=abc"],
      }),
    );
    expect(verdict?.signal).toMatch(/active CAPTCHA challenge \(www\.google\.com\)/);
  });

  it("recognizes a CAPTCHA or challenge wording on an otherwise empty page", () => {
    expect(
      detectBotWall(
        page({ text: "One more step", textLength: 13, challengeMarkers: ["hcaptcha.com"] }),
      )?.signal,
    ).toMatch(/CAPTCHA on an otherwise empty page/);
    const text = "Please verify you are a human to continue.";
    expect(detectBotWall(page({ text, textLength: text.length }))?.signal).toMatch(
      /challenge wording \(verify you are a human\)/,
    );
  });

  it("does not mistake ordinary pages for a wall", () => {
    // A job page with an application form protected by a CAPTCHA widget.
    expect(
      detectBotWall(
        page({
          text: article,
          textLength: article.length,
          visibleFrameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=abc"],
          challengeMarkers: ["https://www.google.com/recaptcha/api.js", "google.com/recaptcha/"],
        }),
      ),
    ).toBeNull();
    // A long description that happens to mention the phrase.
    const text = `${article} We verify you are human during onboarding.`;
    expect(detectBotWall(page({ text, textLength: text.length }))).toBeNull();
    expect(detectBotWall(page({ text: "No results", textLength: 10 }))).toBeNull();
    expect(
      detectBotWall(
        page({ title: "Security Engineer – Acme", text: article, textLength: article.length }),
      ),
    ).toBeNull();
  });
});

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    expect(retryAfterMs("30", now)).toBe(30_000);
    expect(retryAfterMs("Tue, 06 Oct 2026 12:00:10 GMT", now)).toBe(10_000);
    expect(retryAfterMs("Tue, 06 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs("soon", now)).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
  });
});
