import { jobsFor, type RunningTestSites, SITES, startTestSites } from "@jobtrace/test-sites";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRecording } from "./run.ts";
import { fastOptions, loadExample, sanitizeJobs } from "./testing.ts";

let sites: RunningTestSites;
let browser: Browser;

beforeAll(async () => {
  sites = await startTestSites();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
});

const run = (name: string, overrides: Parameters<typeof fastOptions>[1] = {}) =>
  runRecording(loadExample(name), fastOptions(sites.origin, { browser, ...overrides }));

const golden = (name: string) => `./__golden__/${name}.json`;

async function expectGolden(name: string, jobs: Awaited<ReturnType<typeof run>>["jobs"]) {
  const text = `${JSON.stringify(sanitizeJobs(jobs, sites.origin), null, 2)}\n`;
  await expect(text).toMatchFileSnapshot(golden(name));
}

describe("hand-written recordings against the fixture sites", () => {
  it("site 1: static list", async () => {
    const result = await run("static-list");
    const expected = jobsFor("staticList");
    expect(result).toMatchObject({ status: "succeeded", stats: { pages: 1, itemErrors: 0 } });
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
    expect(result.jobs.map((job) => job.location)).toEqual(expected.map((job) => job.location));
    expect(result.jobs.map((job) => job.salaryText)).toEqual(expected.map((job) => job.salary));
    expect(result.jobs.map((job) => job.postedAt?.slice(0, 10))).toEqual(
      expected.map((job) => job.postedAt),
    );
    // Headings, not links: no URL, so the dedup key is a hash of the identifying fields.
    expect(result.jobs.every((job) => job.url === null && job.dedupKey.startsWith("sha256:"))).toBe(
      true,
    );
    expect(result.jobs[0]).toMatchObject({
      company: "Acme Robotics",
      salaryMin: 85000,
      salaryMax: 110000,
      salaryCurrency: "EUR",
      salaryPeriod: "year",
    });
    expect(result.jobs.find((job) => job.location === "Remote (EU)")?.remote).toBe("remote");
    await expectGolden("static-list", result.jobs);
  });

  it("site 1 with fill, select, press and a URL wait", async () => {
    const result = await run("static-list-search", { params: { keyword: "engineer" } });
    const expected = jobsFor("staticList").filter(
      (job) => /engineer/i.test(job.title) && job.employmentType === "Full-time",
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(result.status).toBe("succeeded");
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
  });

  it("site 2: pagination with a Next button, details in a new tab", async () => {
    const result = await run("paginated");
    const expected = jobsFor("paginated");
    expect(result).toMatchObject({ status: "succeeded", stats: { pages: 3, itemsSeen: 12 } });
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
    expect(result.jobs.map((job) => job.description)).toEqual(
      expected.map((job) => job.description),
    );
    expect(result.jobs.map((job) => job.url)).toEqual(
      expected.map((job) => sites.url(`${SITES.paginated}jobs/${job.id}`)),
    );
    expect(result.events.some((event) => event.message === "Next-page control is disabled")).toBe(
      true,
    );
    await expectGolden("paginated", result.jobs);
  });

  it("site 3: infinite scroll", async () => {
    const result = await run("infinite-scroll");
    const expected = jobsFor("infinite");
    expect(result.status).toBe("succeeded");
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
    expect(result.stats.pages).toBeGreaterThan(1);
    expect(result.stats.itemsSeen).toBe(expected.length);
    await expectGolden("infinite-scroll", result.jobs);
  });

  it("site 4: list -> detail in the same tab", async () => {
    const result = await run("list-detail");
    const expected = jobsFor("detail");
    expect(result).toMatchObject({ status: "succeeded", stats: { itemsSeen: 8, itemErrors: 0 } });
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
    expect(result.jobs.map((job) => job.description)).toEqual(
      expected.map((job) => job.description),
    );
    expect(result.jobs.map((job) => job.salaryText)).toEqual(expected.map((job) => job.salary));
    expect(result.events.some((event) => event.type === "locator_drift")).toBe(false);
    await expectGolden("list-detail", result.jobs);
  });

  it("site 5: SPA with client-side routing and delayed rendering", async () => {
    const result = await run("spa");
    const expected = jobsFor("spa");
    expect(result).toMatchObject({ status: "succeeded", stats: { itemErrors: 0 } });
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
    expect(result.jobs.map((job) => job.description)).toEqual(
      expected.map((job) => job.description),
    );
    expect(result.jobs.map((job) => job.url)).toEqual(
      expected.map((job) => sites.url(`${SITES.spa}jobs/${job.id}`)),
    );
    await expectGolden("spa", result.jobs);
  });

  it("site 7: board inside an iframe", async () => {
    const result = await run("iframe");
    const expected = jobsFor("iframe");
    expect(result.status).toBe("succeeded");
    expect(result.jobs.map((job) => job.title)).toEqual(expected.map((job) => job.title));
    expect(result.jobs.map((job) => job.salaryText)).toEqual(expected.map((job) => job.salary));
    await expectGolden("iframe", result.jobs);
  });

  it("site 9: the site-4 recording survives changed class names via fallback locators", async () => {
    const original = await run("list-detail");
    const drifted = await run("list-detail", { params: { path: SITES.detailV2 } });
    expect(drifted).toMatchObject({ status: "succeeded", stats: { itemsSeen: 8, itemErrors: 0 } });

    const comparable = (jobs: typeof original.jobs) =>
      jobs.map(({ url, dedupKey, contentHash, ...rest }) => rest);
    expect(comparable(drifted.jobs)).toEqual(comparable(original.jobs));
    expect(drifted.jobs[0]?.url).toBe(
      sites.url(`${SITES.detailV2}jobs/${jobsFor("detail")[0]?.id}`),
    );

    const drift = drifted.events.filter((event) => event.type === "locator_drift");
    // One warning per drifted target, not one per item.
    expect(drift.length).toBeGreaterThanOrEqual(5);
    expect(drift.length).toBeLessThan(12);
    expect(drift.map((event) => (event.data?.used as { kind: string } | undefined)?.kind)).toEqual(
      expect.arrayContaining(["role", "xpath"]),
    );
  });
});
