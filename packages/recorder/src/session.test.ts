import type { Recording, Step } from "@jobtrace/core";
import { runRecording } from "@jobtrace/runner";
import {
  jobsFor,
  LOGIN_CREDENTIALS,
  type RunningTestSites,
  SITES,
  startTestSites,
} from "@jobtrace/test-sites";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OVERLAY_ID } from "./injected/protocol.ts";
import {
  type RecorderEvent,
  type RecorderOptions,
  type RecordingSession,
  startRecording,
} from "./session.ts";

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

/** Starts a headless session whose overlay can be driven by the test. */
const record = (path: string, extra: Partial<RecorderOptions> = {}) =>
  startRecording({ url: sites.url(path), browser, headless: true, openShadow: true, ...extra });

const overlay = (page: Page) => page.locator(`#${OVERLAY_ID}`);
const types = (recording: Recording) => recording.steps.map((step) => step.type);
const stepOf = <T extends Step["type"]>(recording: Recording, type: T) =>
  recording.steps.find((step): step is Extract<Step, { type: T }> => step.type === type);

async function setMode(session: RecordingSession, mode: "mark" | "record") {
  await overlay(session.page).locator(`[data-action="${mode}"]`).click();
  await expect.poll(() => session.status().mode).toBe(mode === "mark" ? "markField" : "record");
}

/** Marks an element as a field through the overlay, like a user would. */
async function mark(
  session: RecordingSession,
  click: () => Promise<void>,
  name: string,
  read?: "text" | "href" | "innerHTML",
) {
  const ui = overlay(session.page);
  await click();
  await ui.locator(".dialog.open").waitFor();
  const choice = ui.locator('[data-role="name"]');
  if ((await choice.locator(`option[value="${name}"]`).count()) > 0)
    await choice.selectOption(name);
  else {
    await choice.selectOption("__custom");
    await ui.locator('[data-role="custom"]').fill(name);
  }
  if (read) await ui.locator('[data-role="read"]').selectOption(read);
  await ui.locator('[data-action="save"]').click();
  await expect.poll(() => session.status().fields).toContain(name);
}

/** Replays a recording without politeness delays. */
const replay = (recording: Recording) =>
  runRecording(recording, {
    browser,
    settings: { minDelayMs: 0, maxDelayMs: 0, stepTimeoutMs: 5000 },
    tuning: { pollIntervalMs: 25, fallbackGraceMs: 300 },
  });

const collapse = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

describe("record, then replay", () => {
  it("site 1: search form, then marked fields", async () => {
    const session = await record(SITES.staticList);
    const { page } = session;
    await page.locator('input[name="q"]').click();
    await page.locator('input[name="q"]').pressSequentially("engineer");
    await page.locator('select[name="type"]').selectOption("Full-time");
    await page.locator('input[name="q"]').press("Enter");
    await page.waitForURL("**q=engineer**");

    await setMode(session, "mark");
    const firstJob = page.locator("li.job").first();
    await mark(session, () => firstJob.locator(".title").click(), "title");
    await mark(session, () => firstJob.locator(".loc").click(), "location");
    await mark(session, () => firstJob.locator(".salary").click(), "salaryText");
    await mark(session, () => firstJob.locator("time").click(), "postedNote");
    await overlay(page).locator('[data-action="stop"]').click();
    const { recording, samples, warnings } = await session.finished;

    expect(warnings).toEqual([]);
    expect(types(recording)).toEqual(["navigate", "fill", "select", "press", "waitFor", "extract"]);
    expect(recording.startUrl).toBe(sites.url(SITES.staticList));
    expect(recording.name).toBe("Jobs at Acme Robotics");
    expect(stepOf(recording, "fill")?.value).toBe("engineer");
    expect(stepOf(recording, "select")?.value).toBe("Full-time");
    expect(stepOf(recording, "waitFor")?.urlPattern).toBe(`**${SITES.staticList}?*`);
    expect(stepOf(recording, "extract")?.fields.map((field) => field.name)).toEqual([
      "title",
      "location",
      "salaryText",
      "postedNote",
    ]);

    const expected = jobsFor("staticList").find(
      (job) => /engineer/i.test(job.title) && job.employmentType === "Full-time",
    );
    expect(samples).toMatchObject({
      title: expected?.title,
      location: expected?.location,
      salaryText: expected?.salary,
    });

    const result = await replay(recording);
    expect(result).toMatchObject({ status: "succeeded", stats: { itemErrors: 0 } });
    expect(result.events.filter((event) => event.type === "locator_drift")).toEqual([]);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      title: samples.title,
      location: samples.location,
      salaryText: samples.salaryText,
      custom: { postedNote: samples.postedNote },
    });
  });

  it("site 5: client-side navigation into a job, then marked fields", async () => {
    const session = await record(SITES.spa);
    const { page } = session;
    const job = jobsFor("spa")[1];
    await page.getByRole("link", { name: job?.title, exact: true }).click();
    await page.locator("h1.job-title").waitFor();

    await setMode(session, "mark");
    await mark(session, () => page.locator("h1.job-title").click(), "title");
    await mark(session, () => page.locator(".job-body p").click(), "description");
    await mark(session, () => page.locator("dd.salary").click(), "salaryText");
    const { recording, samples } = await session.stop();

    expect(types(recording)).toEqual(["navigate", "click", "waitFor", "extract"]);
    expect(stepOf(recording, "waitFor")?.urlPattern).toBe(`**${SITES.spa}jobs/*`);
    expect(stepOf(recording, "click")?.target.locators[0]).toEqual({
      kind: "role",
      role: "link",
      name: job?.title,
      exact: true,
    });
    expect(samples).toEqual({
      title: job?.title,
      description: job?.description,
      salaryText: job?.salary,
    });

    const result = await replay(recording);
    expect(result.status).toBe("succeeded");
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      title: samples.title,
      description: collapse(samples.description),
      salaryText: samples.salaryText,
    });
  });

  it("site 7: a field inside an iframe records the frame chain", async () => {
    const session = await record(SITES.iframe);
    const board = session.page.frameLocator("#job-board");
    await board.locator("li.job").first().waitFor();
    await setMode(session, "mark");
    await mark(session, () => board.locator("li.job a.title").nth(2).click(), "title");
    await mark(session, () => board.locator("li.job a.title").nth(2).click(), "url", "href");
    const { recording, samples } = await session.stop();

    const fields = stepOf(recording, "extract")?.fields ?? [];
    expect(fields.map((field) => field.target.frame)).toEqual([["#job-board"], ["#job-board"]]);
    expect(fields[1]).toMatchObject({
      name: "url",
      read: "attr",
      attr: "href",
      transforms: ["absoluteUrl"],
    });
    const job = jobsFor("iframe")[2];
    expect(samples).toEqual({
      title: job?.title,
      url: sites.url(`${SITES.detail}jobs/${job?.id}`),
    });

    const result = await replay(recording);
    expect(result.jobs[0]).toMatchObject({ title: samples.title, url: samples.url });
  });
});

describe("sensitive input", () => {
  it("never records password values, and points to auth profiles instead", async () => {
    const events: RecorderEvent[] = [];
    const session = await record(SITES.login, { onEvent: (event) => events.push(event) });
    const { page } = session;
    await page.locator('input[name="username"]').pressSequentially(LOGIN_CREDENTIALS.username);
    await page.locator('input[name="password"]').pressSequentially(LOGIN_CREDENTIALS.password);
    await page.locator('input[name="password"]').press("Enter");
    await page.getByTestId("signed-in").waitFor();
    await setMode(session, "mark");
    await mark(session, () => page.locator("li.job .title").first().click(), "title");
    const result = await session.stop();

    const everything = JSON.stringify({ result, events });
    expect(everything).not.toContain(LOGIN_CREDENTIALS.password);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/never recorded.*auth profile/);
    // The typed URL is kept, not the sign-in page it redirected to.
    expect(result.recording.steps[0]).toMatchObject({
      type: "navigate",
      url: sites.url(SITES.login),
    });
    const fills = result.recording.steps.filter((step) => step.type === "fill");
    expect(fills.map((step) => step.value)).toEqual([LOGIN_CREDENTIALS.username]);
    expect(JSON.stringify(result.recording)).not.toMatch(/"password"|type=.?password/);
  });
});

describe("navigation", () => {
  it("records typed URLs as navigate steps, but not navigations caused by clicks", async () => {
    const session = await record(SITES.paginated);
    const { page } = session;
    await page.locator("li.job a.title").first().click();
    await page.waitForURL("**/jobs/*");
    await page.goto(sites.url(SITES.staticList));
    await page.getByRole("button", { name: "Search" }).click();
    await page.waitForURL("**?q=**");
    const { recording } = await session.stop();

    expect(
      recording.steps.map((step) =>
        step.type === "navigate"
          ? step.url.replace(sites.origin, "")
          : step.type === "waitFor"
            ? step.urlPattern
            : step.type,
      ),
    ).toEqual([
      SITES.paginated,
      "click",
      "**/paginated/jobs/*",
      SITES.staticList,
      "click",
      "**/static-list/?*",
    ]);
  });

  it("follows a link that opens a new tab by navigating there instead", async () => {
    const session = await record(`${SITES.detail}?newtab=1`);
    const popupOpened = session.context.waitForEvent("page");
    await session.page.locator("li.job a.title").nth(1).click();
    const popup = await popupOpened;
    await popup.locator(".job-body").waitFor();
    await expect.poll(() => session.page === popup).toBe(true);
    await setMode(session, "mark");
    await mark(session, () => popup.locator(".job-body").click(), "description");
    await mark(session, () => popup.locator("h1").click(), "title");
    const { recording, samples, warnings } = await session.stop();

    const job = jobsFor("detail")[1];
    expect(warnings.join(" ")).toMatch(/opened a new tab/);
    expect(
      recording.steps.map((step) =>
        step.type === "navigate" ? step.url.replace(sites.origin, "") : step.type,
      ),
    ).toEqual([`${SITES.detail}?newtab=1`, `${SITES.detail}jobs/${job?.id}`, "extract"]);
    const result = await replay(recording);
    expect(result.jobs[0]).toMatchObject({ title: job?.title, description: samples.description });
  });
});

describe("capture details", () => {
  it("drops clicks that did nothing, and keeps the overlay out of the recording", async () => {
    const session = await record(SITES.staticList);
    const { page } = session;
    await page.locator("h1").click();
    await page.locator("li.job .loc").first().click();
    await setMode(session, "mark");
    await setMode(session, "record");
    await overlay(page).locator('[data-action="move"]').click();
    await page.waitForTimeout(600);
    expect(session.status().steps).toBe(3);
    const { recording } = await session.stop();
    expect(types(recording)).toEqual(["navigate"]);
  });

  it("does not let the page react while marking, and Escape leaves marking mode", async () => {
    const session = await record(SITES.paginated);
    const { page } = session;
    await setMode(session, "mark");
    await page.locator("li.job a.title").first().click();
    await overlay(page).locator(".dialog.open").waitFor();
    expect(page.url()).toBe(sites.url(SITES.paginated));
    await overlay(page).locator('[data-action="cancel"]').click();
    await page.locator("h1").click();
    await overlay(page).locator(".dialog.open").waitFor();
    // The first Escape cancels the dialog, the second leaves marking mode.
    await overlay(page).locator('[data-role="name"]').press("Escape");
    expect(session.status().mode).toBe("markField");
    await page.keyboard.press("Escape");
    await expect.poll(() => session.status().mode).toBe("record");
    const { recording } = await session.stop();
    expect(types(recording)).toEqual(["navigate"]);
  });

  it("keeps mode and counts across page loads, and lets a field be re-marked", async () => {
    const session = await record(SITES.detail);
    const { page } = session;
    await setMode(session, "mark");
    await mark(session, () => page.locator("li.job .loc").first().click(), "location");
    await mark(session, () => page.locator("li.job .type").first().click(), "location");
    await page.goto(sites.url(`${SITES.detail}jobs/101`));
    await expect
      .poll(() => overlay(page).locator(".status").textContent())
      .toBe("2 steps · 1 field");
    expect(await overlay(page).locator('[data-action="mark"]').getAttribute("aria-pressed")).toBe(
      "true",
    );
    const { recording, samples } = await session.stop();
    expect(samples.location).toBe(jobsFor("detail")[0]?.employmentType);
    expect(stepOf(recording, "extract")?.fields).toHaveLength(1);
  });

  it("hides the overlay internals from page scripts by default", async () => {
    const session = await record(SITES.staticList, { openShadow: false });
    await overlay(session.page).waitFor({ state: "attached" });
    expect(
      await session.page.evaluate(
        (id) => document.getElementById(id)?.shadowRoot ?? null,
        OVERLAY_ID,
      ),
    ).toBeNull();
    await session.stop();
  });

  it("finishes when the window is closed or the signal aborts, and reports a bad start URL", async () => {
    const closed = await record(SITES.staticList);
    await closed.page.close();
    expect(types((await closed.finished).recording)).toEqual(["navigate"]);

    const controller = new AbortController();
    const aborted = await record(SITES.staticList, { signal: controller.signal, name: "Named" });
    controller.abort();
    expect((await aborted.finished).recording.name).toBe("Named");

    await expect(
      startRecording({ url: "http://127.0.0.1:9/", browser, headless: true }),
    ).rejects.toMatchObject({
      code: "NAVIGATION_FAILED",
    });
  });
});
