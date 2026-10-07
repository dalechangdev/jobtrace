import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LocatorResolver,
  parseRecording,
  type Recording,
  type RecordingInput,
} from "@jobtrace/core";
import {
  jobsFor,
  PAGINATED_PAGE_SIZE,
  type RunningTestSites,
  SITES,
  startTestSites,
} from "@jobtrace/test-sites";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textSimilarity } from "./locators.ts";
import { runRecording } from "./run.ts";
import { fastOptions, loadExample } from "./testing.ts";

let sites: RunningTestSites;
let browser: Browser;
let artifactsRoot: string;

beforeAll(async () => {
  sites = await startTestSites();
  browser = await chromium.launch();
  artifactsRoot = mkdtempSync(join(tmpdir(), "jobtrace-test-"));
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
  rmSync(artifactsRoot, { recursive: true, force: true });
});

const css = (value: string, relativeTo: "item" | null = null) => ({
  locators: [{ kind: "css" as const, value }],
  relativeTo,
});

/** A minimal recording over a fixture site: navigate, then the given steps. */
function recording(
  path: string,
  steps: RecordingInput["steps"],
  extra: Partial<RecordingInput> = {},
): Recording {
  return parseRecording({
    schemaVersion: 2,
    id: "rec_behavior",
    name: "Behavior test",
    startUrl: sites.url(path),
    params: { baseUrl: {} },
    steps: [{ id: "nav", type: "navigate", url: `{{params.baseUrl}}${path}` }, ...steps],
    ...extra,
  } satisfies RecordingInput);
}

const titles = (required = true): RecordingInput["steps"][number] => ({
  id: "titles",
  type: "extract",
  scope: "item",
  fields: [{ name: "title", target: css(".title", "item"), required }],
});

const run = (target: Recording, overrides: Parameters<typeof fastOptions>[1] = {}) =>
  runRecording(target, fastOptions(sites.origin, { browser, ...overrides }));

describe("limits", () => {
  it("stops at maxPages", async () => {
    const result = await run(loadExample("paginated"), { settings: { maxPages: 2 } });
    expect(result.status).toBe("succeeded");
    expect(result.jobs).toHaveLength(2 * PAGINATED_PAGE_SIZE);
    expect(result.events.some((event) => event.type === "limit_reached")).toBe(true);
  });

  it("stops at maxItems", async () => {
    const result = await run(loadExample("paginated"), { settings: { maxItems: 7 } });
    expect(result.status).toBe("succeeded");
    expect(result.jobs).toHaveLength(7);
    expect(result.stats.pages).toBe(2);
  });
});

describe("pagination modes", () => {
  it("walks a URL pattern until a page repeats", async () => {
    const result = await run(
      recording(SITES.paginated, [
        {
          id: "pages",
          type: "paginate",
          mode: "urlPattern",
          urlTemplate: `{{params.baseUrl}}${SITES.paginated}?page={{page}}`,
          body: [{ id: "each", type: "forEach", items: css("li.job"), body: [titles()] }],
        },
      ]),
    );
    // The fixture clamps out-of-range pages to the last one, so page 4 repeats page 3.
    expect(result.status).toBe("succeeded");
    expect(result.stats.pages).toBe(3);
    expect(result.jobs.map((job) => job.title)).toEqual(
      jobsFor("paginated").map((job) => job.title),
    );
    expect(result.events.some((event) => /repeats an earlier page/.test(event.message))).toBe(true);
  });

  it("stops when there is no next-page control", async () => {
    const result = await run(
      recording(SITES.staticList, [
        {
          id: "pages",
          type: "paginate",
          mode: "nextButton",
          next: css("a.next-page"),
          body: [{ id: "each", type: "forEach", items: css("li.job"), body: [titles()] }],
        },
      ]),
    );
    expect(result).toMatchObject({ status: "succeeded", stats: { pages: 1 } });
    expect(result.jobs).toHaveLength(jobsFor("staticList").length);
  });
});

describe("detail pages and interactions", () => {
  it("follows detail links that open a new tab by themselves", async () => {
    const result = await run(loadExample("list-detail"), {
      params: { path: `${SITES.detail}?newtab=1` },
      settings: { maxItems: 3 },
    });
    const expected = jobsFor("detail").slice(0, 3);
    expect(result).toMatchObject({ status: "succeeded", stats: { itemErrors: 0 } });
    expect(result.jobs.map((job) => job.description)).toEqual(
      expected.map((job) => job.description),
    );
    expect(result.events.some((event) => event.type === "list_restore_fallback")).toBe(false);
  });

  it("reads a detail in place when the link does not navigate", async () => {
    const result = await run(
      recording(SITES.staticList, [
        {
          id: "each",
          type: "forEach",
          items: css("li.job"),
          body: [
            {
              id: "open",
              type: "openDetail",
              link: css(".title", "item"),
              body: [
                {
                  id: "read",
                  type: "extract",
                  scope: "page",
                  fields: [{ name: "title", target: css("li.job:first-child .title") }],
                },
              ],
            },
          ],
        },
      ]),
      { settings: { maxItems: 1 }, tuning: { detailOpenMs: 200 } },
    );
    expect(result.status).toBe("succeeded");
    expect(result.jobs.map((job) => job.title)).toEqual([jobsFor("staticList")[0]?.title]);
    expect(result.events.some((event) => event.type === "detail_in_place")).toBe(true);
  });

  it("clicks, scrolls, presses keys and waits", async () => {
    const result = await run(
      recording(SITES.staticList, [
        { id: "type", type: "fill", target: css('input[name="q"]'), value: "designer" },
        { id: "submit", type: "click", target: css('form button[type="submit"]') },
        { id: "listed", type: "waitFor", target: css("li.job") },
        { id: "down", type: "scroll", mode: "toBottom" },
        { id: "up", type: "scroll", mode: "by", amount: -200 },
        { id: "inner", type: "scroll", mode: "by", amount: 10, target: css("main") },
        { id: "key", type: "press", key: "End" },
        { id: "pause", type: "waitFor", ms: 10 },
        { id: "each", type: "forEach", items: css("li.job"), body: [titles()] },
      ]),
    );
    expect(result.status).toBe("succeeded");
    expect(result.jobs.map((job) => job.title)).toEqual(["Product Designer"]);
  });
});

describe("records", () => {
  it("emits a single record for page-level extraction without a loop", async () => {
    const job = jobsFor("detail")[2];
    const result = await run(
      recording(`${SITES.detail}jobs/${job?.id}`, [
        {
          id: "page",
          type: "extract",
          scope: "page",
          fields: [
            { name: "title", target: css("h1.job-title") },
            { name: "description", target: css(".job-body") },
            { name: "benefits", target: css(".benefits") },
          ],
        },
      ]),
    );
    expect(result.status).toBe("succeeded");
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      title: job?.title,
      description: job?.description,
      custom: { benefits: null },
    });
  });

  it("copies page-level fields into every item record", async () => {
    const result = await run(
      recording(SITES.staticList, [
        {
          id: "header",
          type: "extract",
          scope: "page",
          fields: [
            { name: "company", target: css("header strong"), transforms: ["regex:^(.*) Careers$"] },
          ],
        },
        { id: "each", type: "forEach", items: css("li.job"), body: [titles()] },
      ]),
    );
    expect(result.jobs).toHaveLength(jobsFor("staticList").length);
    expect(new Set(result.jobs.map((job) => job.company))).toEqual(new Set(["Acme Robotics"]));
  });

  it("skips records without a title and reports them", async () => {
    const result = await run(
      recording(SITES.staticList, [
        {
          id: "each",
          type: "forEach",
          items: css("li.job"),
          body: [
            {
              id: "loc",
              type: "extract",
              scope: "item",
              fields: [{ name: "location", target: css(".loc", "item") }],
            },
          ],
        },
      ]),
    );
    expect(result.jobs).toHaveLength(0);
    expect(result.events.filter((event) => event.type === "record_skipped")).toHaveLength(
      jobsFor("staticList").length,
    );
  });
});

describe("failures", () => {
  it("ends partial when some items fail, and keeps the rest", async () => {
    const result = await run(
      recording(SITES.staticList, [
        {
          id: "each",
          type: "forEach",
          items: css("li.job"),
          body: [
            {
              id: "engineers",
              type: "extract",
              scope: "item",
              fields: [
                {
                  name: "title",
                  target: css(".title", "item"),
                  transforms: ["regex:^.*Engineer$"],
                  required: true,
                },
              ],
            },
          ],
        },
      ]),
    );
    const all = jobsFor("staticList");
    const engineers = all.filter((job) => job.title.endsWith("Engineer"));
    expect(engineers.length).toBeLessThan(all.length);
    expect(result).toMatchObject({
      status: "partial",
      reason: "item_errors",
      stats: { itemErrors: all.length - engineers.length },
    });
    expect(result.jobs.map((job) => job.title)).toEqual(engineers.map((job) => job.title));
    expect(result.events.find((event) => event.type === "item_error")).toMatchObject({
      stepId: "engineers",
      data: { error: { code: "REQUIRED_FIELD_MISSING" } },
    });
  });

  it("gives up on a list after too many consecutive item failures", async () => {
    const result = await run(
      recording(SITES.staticList, [
        {
          id: "each",
          type: "forEach",
          items: css("li.job"),
          body: [
            {
              id: "never",
              type: "extract",
              scope: "item",
              fields: [{ name: "title", target: css(".nope", "item"), required: true }],
            },
          ],
        },
      ]),
      { settings: { stepTimeoutMs: 100 }, tuning: { maxConsecutiveItemErrors: 3 } },
    );
    expect(result).toMatchObject({
      status: "failed",
      reason: "step_failed",
      stats: { itemErrors: 3 },
    });
    expect(result.error?.message).toMatch(/3 items in a row failed/);
  });

  it("fails with the locators it tried, and saves a screenshot and DOM snapshot", async () => {
    const artifactsDir = join(artifactsRoot, "locator");
    const result = await run(
      recording(SITES.staticList, [
        {
          id: "missing",
          type: "click",
          target: {
            locators: [
              { kind: "css", value: "#nope" },
              { kind: "text", value: "Full-time" },
            ],
          },
        },
      ]),
      { artifactsDir, settings: { stepTimeoutMs: 400 } },
    );
    expect(result).toMatchObject({
      status: "failed",
      reason: "locator_not_found",
      error: { code: "LOCATOR_NOT_FOUND", stepId: "missing" },
    });
    // "#nope" matches nothing, and the text is ambiguous: neither is exactly one element.
    const tried = result.error?.details?.tried as Array<{
      locator: { kind: string };
      matches: number;
    }>;
    expect(tried.map((attempt) => attempt.locator.kind)).toEqual(["css", "text"]);
    expect(tried[0]?.matches).toBe(0);
    expect(tried[1]?.matches).toBeGreaterThan(1);
    expect(result.artifacts.map((artifact) => artifact.type)).toEqual(["screenshot", "dom"]);
    for (const artifact of result.artifacts) expect(existsSync(artifact.path)).toBe(true);
  });

  it("fails on HTTP errors", async () => {
    const result = await run(recording("/no-such-page/", []));
    expect(result).toMatchObject({
      status: "failed",
      reason: "navigation_failed",
      error: { details: { status: 404 } },
    });
  });

  it("fails before launching anything when params are wrong", async () => {
    const result = await runRecording(loadExample("static-list"), { params: { nope: "x" } });
    expect(result).toMatchObject({
      status: "failed",
      reason: "template_error",
      stats: { pages: 0 },
    });
  });

  it("keeps jobs collected before a fatal error and ends partial", async () => {
    const result = await run(
      recording(SITES.staticList, [
        { id: "each", type: "forEach", items: css("li.job"), body: [titles()] },
        { id: "boom", type: "click", target: css("#nope") },
      ]),
      { settings: { stepTimeoutMs: 200 } },
    );
    expect(result).toMatchObject({ status: "partial", reason: "locator_not_found" });
    expect(result.jobs).toHaveLength(jobsFor("staticList").length);
  });
});

describe("cancellation and time limits", () => {
  it("cancels a run in progress and reports what it had", async () => {
    const controller = new AbortController();
    const result = await run(loadExample("paginated"), {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "page" && event.data?.page === 2) controller.abort();
      },
    });
    expect(result).toMatchObject({ status: "cancelled", reason: "run_cancelled" });
    expect(result.jobs).toHaveLength(PAGINATED_PAGE_SIZE);
  });

  it("does nothing when cancelled up front", async () => {
    const result = await run(loadExample("static-list"), { signal: AbortSignal.abort() });
    expect(result).toMatchObject({ status: "cancelled", jobs: [] });
  });

  it("fails with run_timeout when the run takes too long", async () => {
    const result = await run(
      recording(SITES.staticList, [{ id: "wait", type: "waitFor", ms: 5000 }]),
      { runTimeoutMs: 300 },
    );
    expect(result).toMatchObject({ status: "failed", reason: "run_timeout" });
    expect(result.stats.durationMs).toBeLessThan(3000);
  });
});

describe("artifacts and healing", () => {
  it("records a Playwright trace on request", async () => {
    const artifactsDir = join(artifactsRoot, "trace");
    const result = await run(loadExample("static-list"), { trace: true, artifactsDir });
    expect(result.status).toBe("succeeded");
    expect(result.artifacts).toEqual([{ type: "trace", path: join(artifactsDir, "trace.zip") }]);
    expect(existsSync(join(artifactsDir, "trace.zip"))).toBe(true);
  });

  it("asks the locator resolver when every recorded locator fails", async () => {
    const calls: string[] = [];
    const locatorResolver: LocatorResolver = {
      async resolve(_target, context) {
        calls.push(context.stepId);
        expect(context.pageSnapshot).toContain("Open positions");
        expect(context.pageSnapshot).not.toContain("<style");
        return { locator: { kind: "css", value: "li.job" }, source: "test" };
      },
    };
    const result = await run(
      recording(SITES.staticList, [
        { id: "each", type: "forEach", items: css("li.gone"), body: [titles()] },
      ]),
      { locatorResolver, settings: { stepTimeoutMs: 200 } },
    );
    expect(result.status).toBe("succeeded");
    expect(result.jobs).toHaveLength(jobsFor("staticList").length);
    expect(calls).toEqual(["each"]);
    expect(result.events.find((event) => event.type === "locator_suggestion")).toMatchObject({
      stepId: "each",
      data: { locator: { kind: "css", value: "li.job" }, source: "test" },
    });
  });

  it("rejects a resolver suggestion that does not match", async () => {
    const result = await run(
      recording(SITES.staticList, [{ id: "click", type: "click", target: css("#nope") }]),
      {
        settings: { stepTimeoutMs: 200 },
        locatorResolver: {
          resolve: async () => ({ locator: { kind: "css", value: "li.job" }, source: "test" }),
        },
      },
    );
    expect(result).toMatchObject({ status: "failed", reason: "locator_not_found" });
    expect(result.events.some((event) => event.type === "locator_suggestion_rejected")).toBe(true);
  });

  it("asks once per broken target, not once per item, and records what failed", async () => {
    let calls = 0;
    const result = await run(
      recording(SITES.staticList, [
        {
          id: "each",
          type: "forEach",
          items: css("li.job"),
          body: [
            {
              id: "titles",
              type: "extract",
              scope: "item",
              fields: [{ name: "title", target: css(".renamed", "item"), required: true }],
            },
          ],
        },
      ]),
      {
        settings: { stepTimeoutMs: 200 },
        locatorResolver: {
          async resolve(_target, context) {
            calls += 1;
            expect(context.scope).toBe("item");
            // Only the item is sent, not the page around it.
            expect(context.pageSnapshot).toMatch(/^<li/);
            return { locator: { kind: "css", value: ".title" }, source: "test", reason: "why" };
          },
        },
      },
    );
    expect(result.status).toBe("succeeded");
    expect(result.jobs).toHaveLength(jobsFor("staticList").length);
    expect(calls).toBe(1);
    const healed = result.events.filter((event) => event.type === "locator_suggestion");
    expect(healed).toHaveLength(1);
    expect(healed[0]?.data).toMatchObject({
      failed: [{ kind: "css", value: ".renamed" }],
      locator: { kind: "css", value: ".title" },
      reason: "why",
    });
  });

  it("rejects a suggestion that points at a different kind of element", async () => {
    const target = (tag: string, text: string) => ({
      locators: [{ kind: "css" as const, value: "#nope" }],
      fingerprint: { tag, text },
    });
    const attempt = (fingerprint: ReturnType<typeof target>) =>
      run(recording(SITES.staticList, [{ id: "wait", type: "waitFor", target: fingerprint }]), {
        settings: { stepTimeoutMs: 200 },
        locatorResolver: {
          resolve: async () => ({ locator: { kind: "css", value: "h1" }, source: "test" }),
        },
      });

    // Recorded as a button saying something else: the heading is not it.
    const wrong = await attempt(target("button", "Load more jobs"));
    expect(wrong).toMatchObject({ status: "failed", reason: "locator_not_found" });
    expect(
      wrong.events.find((event) => event.type === "locator_suggestion_rejected"),
    ).toMatchObject({ data: { tag: "h1", matches: 1 } });

    // The same tag is enough, and so is the same text under a different tag.
    expect((await attempt(target("h1", "Something else entirely"))).status).toBe("succeeded");
    expect((await attempt(target("h2", "Open positions"))).status).toBe("succeeded");
  });

  it("asks about an optional field once per run", async () => {
    const asked: string[] = [];
    const result = await run(
      recording(SITES.staticList, [
        {
          id: "each",
          type: "forEach",
          items: css("li.job"),
          body: [
            {
              id: "fields",
              type: "extract",
              scope: "item",
              fields: [
                { name: "title", target: css(".title", "item"), required: true },
                { name: "salaryText", target: css(".absent", "item") },
              ],
            },
          ],
        },
      ]),
      {
        tuning: { optionalFieldTimeoutMs: 50 },
        locatorResolver: {
          async resolve(target) {
            asked.push((target.locators[0] as { value: string }).value);
            return null;
          },
        },
      },
    );
    expect(result.status).toBe("succeeded");
    expect(result.jobs).toHaveLength(jobsFor("staticList").length);
    expect(asked).toEqual([".absent"]);
  });

  it("never asks about the logged-in check", async () => {
    let asked = 0;
    const result = await run(
      recording(SITES.staticList, [], { loggedInCheck: css("#account-menu") }),
      {
        settings: { stepTimeoutMs: 200 },
        locatorResolver: {
          async resolve() {
            asked += 1;
            return { locator: { kind: "css", value: "h1" }, source: "test" };
          },
        },
      },
    );
    // Without its marker the run reports an expired login rather than guessing one.
    expect(result).toMatchObject({ status: "failed", reason: "auth_expired" });
    expect(asked).toBe(0);
  });
});

describe("textSimilarity", () => {
  it("compares texts by the words they share", () => {
    expect(textSimilarity("Next page", "next   PAGE »")).toBe(1);
    expect(textSimilarity("Load more jobs", "Show more jobs")).toBeCloseTo(2 / 3);
    expect(textSimilarity("Apply now", "Senior Engineer")).toBe(0);
    expect(textSimilarity("", "anything")).toBe(0);
  });
});
