import { type ApiSource, type AtsProvider, parseApiSource } from "@jobtrace/core";
import {
  ATS_PATHS,
  CHANGED_SALARY,
  changingJobs,
  type RunningTestSites,
  SITES,
  startTestSites,
} from "@jobtrace/test-sites";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchSource, USER_AGENT } from "./fetch.ts";

let sites: RunningTestSites;
beforeAll(async () => {
  sites = await startTestSites();
});
afterAll(() => sites?.close());

const setVersion = (version: number) =>
  fetch(sites.url(`${SITES.changing}__version/${version}`), { method: "POST" });
beforeEach(() => setVersion(1));

const NOW = new Date("2026-10-06T12:00:00Z");

function source(
  provider: AtsProvider,
  boardToken = "acme",
  settings: ApiSource["settings"] | object = {},
): ApiSource {
  return parseApiSource({
    schemaVersion: 1,
    kind: "api",
    id: `src_${provider}`,
    name: `Acme on ${provider}`,
    provider,
    boardToken,
    baseUrl: sites.url(ATS_PATHS[provider]),
    settings,
  });
}

describe.each(["greenhouse", "lever", "ashby"] as const)("%s feed", (provider) => {
  it("maps the feed onto the core job schema", async () => {
    const expected = changingJobs(1);
    const result = await fetchSource(source(provider), { now: NOW });
    expect(result).toMatchObject({
      status: "succeeded",
      stats: { pages: 1, itemsSeen: 5, itemErrors: 0, jobs: 5 },
      artifacts: [],
    });
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
    expect(result.jobs.map((job) => job.location)).toEqual(expected.map((job) => job.location));
    expect(result.jobs.map((job) => job.postedAt?.slice(0, 10))).toEqual(
      expected.map((job) => job.postedAt),
    );

    const [first, second] = result.jobs;
    expect(first).toMatchObject({
      recordingId: `src_${provider}`,
      company: provider === "greenhouse" ? "Acme Robotics" : null,
      salaryMin: 85000,
      salaryMax: 110000,
      salaryCurrency: "EUR",
      salaryPeriod: "year",
      remote: provider === "greenhouse" ? "unknown" : "onsite",
    });
    expect(first?.url).toMatch(
      /^https:\/\/(job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com)\/acme\//,
    );
    expect(first?.dedupKey).toBe(first?.url);
    expect(first?.description).toContain(expected[0]?.description);
    expect(first?.description).not.toMatch(/<|&lt;/);
    expect(first?.descriptionHtml).toMatch(/<(p|div)[ >]/);
    // Lever groups postings by team rather than department.
    expect(first?.custom).toMatchObject({
      [provider === "lever" ? "team" : "department"]: "Operations",
      sourceId: expect.any(String),
    });
    expect(second?.remote).toBe("remote");
    if (provider !== "greenhouse") {
      expect(result.jobs.map((job) => job.employmentType)).toEqual(
        expected.map((job) => job.employmentType),
      );
    }
    if (provider === "lever")
      expect(first?.description).toMatch(/Requirements\n- Curiosity\n- Care for detail/);
  });

  it("sees the added and the modified job after the board changes", async () => {
    const before = await fetchSource(source(provider), { now: NOW });
    await setVersion(2);
    const after = await fetchSource(source(provider), { now: NOW });

    const hashes = new Map(before.jobs.map((job) => [job.dedupKey, job.contentHash]));
    const added = after.jobs.filter((job) => !hashes.has(job.dedupKey));
    const changed = after.jobs.filter(
      (job) => hashes.has(job.dedupKey) && hashes.get(job.dedupKey) !== job.contentHash,
    );
    expect(added.map((job) => job.title)).toEqual([changingJobs(2).at(-1)?.title]);
    expect(changed.map((job) => job.title)).toEqual([changingJobs(2)[1]?.title]);
    expect(changed[0]).toMatchObject({ salaryMin: 120000, salaryMax: 135000 });
    if (provider === "ashby") expect(changed[0]?.salaryText).toBe(CHANGED_SALARY);
  });

  it("skips entries it cannot read and ends partial", async () => {
    const result = await fetchSource(source(provider, "partial"), { now: NOW });
    expect(result).toMatchObject({
      status: "partial",
      reason: "item_errors",
      stats: { itemErrors: 1, jobs: 5 },
    });
    expect(result.events.find((event) => event.type === "item_error")?.message).toMatch(
      /Entry \d of the feed could not be read: (id|title|text)/,
    );
  });

  it("reports an unknown board, a refusal and an unexpected response", async () => {
    expect(await fetchSource(source(provider, "nope"))).toMatchObject({
      status: "failed",
      reason: "not_found",
      error: { message: expect.stringMatching(/No \w+ board named "nope"/) },
      jobs: [],
    });
    expect(await fetchSource(source(provider, "forbidden"))).toMatchObject({
      status: "blocked",
      reason: "bot_wall",
    });
    expect(await fetchSource(source(provider, "broken"))).toMatchObject({
      status: "failed",
      reason: "step_failed",
      error: { message: expect.stringMatching(/Unexpected response.*may have changed/) },
    });
  });
});

describe("politeness", () => {
  it("identifies itself and asks for JSON", async () => {
    let headers: Headers | undefined;
    await fetchSource(source("lever"), {
      fetch: (input, init) => {
        headers = new Headers(init?.headers);
        return fetch(input, init);
      },
    });
    expect(headers?.get("user-agent")).toBe(USER_AGENT);
    expect(headers?.get("accept")).toBe("application/json");
  });

  it("waits as long as Retry-After asks, then retries", async () => {
    const started = Date.now();
    const result = await fetchSource(source("greenhouse", "limited"));
    expect(result).toMatchObject({ status: "succeeded", stats: { pages: 2, jobs: 5 } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(result.events.find((event) => event.type === "rate_limited")).toMatchObject({
      data: { status: 429, waitMs: 1000 },
    });
  });

  it("gives up as blocked when it keeps being rate limited, or would have to wait too long", async () => {
    const persistent = await fetchSource(source("ashby", "always-limited"), { maxRetries: 1 });
    expect(persistent).toMatchObject({
      status: "blocked",
      reason: "bot_wall",
      stats: { pages: 2 },
    });
    const impatient = await fetchSource(source("ashby", "always-limited"), { maxRetryWaitMs: 500 });
    expect(impatient).toMatchObject({ status: "blocked", stats: { pages: 1 } });
  });

  it("can be cancelled, also while waiting to retry", async () => {
    expect(await fetchSource(source("lever"), { signal: AbortSignal.abort() })).toMatchObject({
      status: "cancelled",
      stats: { pages: 0 },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await fetchSource(source("lever", "always-limited"), {
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("reports an unreachable server, and applies maxItems", async () => {
    const down = parseApiSource({ ...source("lever"), baseUrl: "http://127.0.0.1:9" });
    expect(await fetchSource(down)).toMatchObject({
      status: "failed",
      reason: "navigation_failed",
    });
    const capped = await fetchSource(source("lever", "acme", { maxItems: 2 }));
    expect(capped.jobs).toHaveLength(2);
    expect(capped.events.some((event) => event.type === "limit_reached")).toBe(true);
  });

  it("respects robots.txt unless the source opts out", async () => {
    const closed = { check: async () => ({ allowed: false, reason: "robots.txt disallows /v0/" }) };
    let requests = 0;
    const counting: typeof fetch = (input, init) => {
      requests++;
      return fetch(input, init);
    };
    const refused = await fetchSource(source("lever"), { robots: closed, fetch: counting });
    expect(refused).toMatchObject({
      status: "failed",
      reason: "robots_disallowed",
      stats: { pages: 0 },
    });
    expect(requests).toBe(0);
    const optedOut = await fetchSource(source("lever", "acme", { respectRobotsTxt: false }), {
      robots: closed,
    });
    expect(optedOut.status).toBe("succeeded");
  });
});
