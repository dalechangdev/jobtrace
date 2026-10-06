import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRecording,
  type Recording,
  type RecordingInput,
  type RobotsPolicy,
} from "@jobtrace/core";
import { createRobots } from "@jobtrace/politeness";
import {
  jobsFor,
  LOGIN_CREDENTIALS,
  type RunningTestSites,
  SITES,
  startTestSites,
} from "@jobtrace/test-sites";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRecording } from "./run.ts";
import { fastOptions } from "./testing.ts";

let sites: RunningTestSites;
let browser: Browser;
let tmp: string;
let robots: RobotsPolicy;

beforeAll(async () => {
  sites = await startTestSites();
  browser = await chromium.launch();
  tmp = mkdtempSync(join(tmpdir(), "jobtrace-polite-"));
  robots = createRobots();
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const css = (value: string, relativeTo: "item" | null = null) => ({
  locators: [{ kind: "css" as const, value }],
  relativeTo,
});
const listTitles: RecordingInput["steps"] = [
  {
    id: "each",
    type: "forEach",
    items: css("li.job"),
    body: [
      {
        id: "titles",
        type: "extract",
        scope: "item",
        fields: [{ name: "title", target: css(".title", "item") }],
      },
    ],
  },
];

function recording(
  path: string,
  steps: RecordingInput["steps"] = listTitles,
  extra: Partial<RecordingInput> = {},
): Recording {
  return parseRecording({
    schemaVersion: 2,
    id: "rec_polite",
    name: "Politeness test",
    startUrl: sites.url(path),
    params: { baseUrl: {} },
    steps: [{ id: "nav", type: "navigate", url: `{{params.baseUrl}}${path}` }, ...steps],
    ...extra,
  } satisfies RecordingInput);
}

let runCount = 0;
const run = (target: Recording, overrides: Parameters<typeof fastOptions>[1] = {}) =>
  runRecording(
    target,
    fastOptions(sites.origin, {
      browser,
      robots,
      artifactsDir: join(tmp, `run-${++runCount}`),
      ...overrides,
    }),
  );

describe("robots.txt", () => {
  it("refuses a start URL that robots.txt disallows, without loading it", async () => {
    const result = await run(recording(SITES.robotsDisallowed));
    expect(result).toMatchObject({
      status: "failed",
      reason: "robots_disallowed",
      error: { code: "ROBOTS_DISALLOWED", stepId: "nav" },
      jobs: [],
    });
    expect(result.error?.message).toMatch(/robots\.txt disallows \/disallowed\/.*respectRobotsTxt/);
    // Not a page problem: there is nothing to take a screenshot of.
    expect(result.artifacts).toEqual([]);
  });

  it("runs anyway when the recording opts out, or when no robots knowledge is given", async () => {
    const optedOut = await run(
      recording(SITES.robotsDisallowed, listTitles, { settings: { respectRobotsTxt: false } }),
    );
    expect(optedOut.status).toBe("succeeded");
    expect(optedOut.jobs).toHaveLength(jobsFor("staticList").length);
    const unaware = await runRecording(
      recording(SITES.robotsDisallowed),
      fastOptions(sites.origin, { browser }),
    );
    expect(unaware.status).toBe("succeeded");
  });

  it("stops when a click leads to a disallowed page", async () => {
    const result = await run(
      recording(`${SITES.botWall}links`, [
        { id: "go", type: "click", target: css("#to-disallowed") },
        { id: "wait", type: "waitFor", target: css("li.job") },
        ...listTitles,
      ]),
    );
    expect(result).toMatchObject({ status: "failed", reason: "robots_disallowed", jobs: [] });
  });

  it("slows down to the pause robots.txt asks for", async () => {
    const slow: RobotsPolicy = { check: async () => ({ allowed: true, crawlDelayMs: 400 }) };
    const started = Date.now();
    const result = await run(recording(SITES.staticList), { robots: slow });
    expect(result.status).toBe("succeeded");
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(result.events.find((event) => event.type === "crawl_delay")?.data).toEqual({
      crawlDelayMs: 400,
    });
  });
});

describe("bot walls and refusals", () => {
  it("site 8: ends blocked on a challenge page, with a screenshot", async () => {
    const result = await run(recording(SITES.botWall));
    expect(result).toMatchObject({
      status: "blocked",
      reason: "bot_wall",
      error: { code: "BOT_WALL", stepId: "nav" },
      jobs: [],
    });
    expect(result.error?.message).toMatch(
      /anti-bot check \(page title "Just a moment\.\.\."\).*does not try to get past it/,
    );
    expect(result.artifacts.map((artifact) => artifact.type)).toEqual(["screenshot", "dom"]);
    for (const artifact of result.artifacts) expect(existsSync(artifact.path)).toBe(true);
  });

  it("ends blocked on HTTP 403, and on a 429 that asks to wait too long", async () => {
    const forbidden = await run(recording(`${SITES.botWall}forbidden`));
    expect(forbidden).toMatchObject({ status: "blocked", error: { details: { status: 403 } } });
    expect(forbidden.artifacts.map((artifact) => artifact.type)).toContain("screenshot");

    const started = Date.now();
    // The fixture asks for 30 seconds; the run is only willing to wait 0.2.
    const limited = await run(recording(`${SITES.botWall}rate-limited`), {
      tuning: { maxRetryAfterMs: 200 },
    });
    expect(limited).toMatchObject({ status: "blocked", error: { details: { status: 429 } } });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("waits as long as a 429 asks, then tries once more", async () => {
    const started = Date.now();
    const result = await run(recording(`${SITES.botWall}once-limited`));
    expect(result.status).toBe("succeeded");
    expect(result.jobs).toHaveLength(jobsFor("staticList").length);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(result.events.find((event) => event.type === "rate_limited")?.data).toMatchObject({
      waitMs: 1000,
    });
  });

  it.each([
    ["#to-forbidden", /refused the request \(HTTP 403\)/],
    ["#to-challenge", /anti-bot check/],
  ])(
    "ends blocked when a click on %s leads to a refusal or challenge",
    async (selector, message) => {
      const result = await run(
        recording(`${SITES.botWall}links`, [
          { id: "go", type: "click", target: css(selector) },
          { id: "wait", type: "waitFor", target: css("li.job") },
        ]),
        { settings: { stepTimeoutMs: 3000 } },
      );
      expect(result).toMatchObject({ status: "blocked", reason: "bot_wall" });
      expect(result.error?.message).toMatch(message);
      expect(result.artifacts.map((artifact) => artifact.type)).toContain("screenshot");
      // Noticed and stopped promptly, not after the wait step timed out.
      expect(result.stats.durationMs).toBeLessThan(2500);
    },
  );
});

describe("logged-in check", () => {
  const board = () =>
    recording(SITES.login, listTitles, {
      authProfileId: "auth_demo",
      loggedInCheck: { locators: [{ kind: "testId", value: "signed-in" }] },
    });

  async function logIn(): Promise<string> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(sites.url(SITES.login));
    await page.locator('input[name="username"]').fill(LOGIN_CREDENTIALS.username);
    await page.locator('input[name="password"]').fill(LOGIN_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByTestId("signed-in").waitFor();
    const path = join(tmp, `state-${Date.now()}.json`);
    await context.storageState({ path });
    await context.close();
    return path;
  }

  it("site 6: works with a saved login, and fails with auth_expired once the session is gone", async () => {
    const storageState = await logIn();
    const loggedIn = await run(board(), { storageState });
    expect(loggedIn.status).toBe("succeeded");
    expect(loggedIn.jobs.map((job) => job.title)).toEqual(jobsFor("login").map((job) => job.title));
    expect(loggedIn.events.some((event) => event.type === "auth_verified")).toBe(true);

    await fetch(sites.url(`${SITES.login}__invalidate`), { method: "POST" });
    const expired = await run(board(), { storageState, settings: { stepTimeoutMs: 500 } });
    expect(expired).toMatchObject({
      status: "failed",
      reason: "auth_expired",
      error: { code: "AUTH_EXPIRED", stepId: "nav", details: { authProfileId: "auth_demo" } },
      jobs: [],
    });
    expect(expired.error?.message).toMatch(/saved login has expired/);
  });

  it("fails the same way when there is no saved login at all", async () => {
    const result = await run(board(), { settings: { stepTimeoutMs: 500 } });
    expect(result).toMatchObject({ status: "failed", reason: "auth_expired" });
  });
});
