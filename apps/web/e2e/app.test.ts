import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunningServer, startServer } from "@jobtrace/api";
import { loadConfig } from "@jobtrace/core";
import { type Database, openDatabase } from "@jobtrace/db";
import {
  changingJobs,
  LOGIN_CREDENTIALS,
  type RunningTestSites,
  SITES,
  startTestSites,
} from "@jobtrace/test-sites";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../dist", import.meta.url));

let sites: RunningTestSites;
let browser: Browser;
let dataDir: string;
let db: Database;
let server: RunningServer;
let page: Page;
const pageErrors: string[] = [];

beforeAll(async () => {
  if (!existsSync(join(webRoot, "index.html"))) {
    throw new Error("The web UI is not built. Run `pnpm test:e2e`, which builds it first.");
  }
  sites = await startTestSites();
  browser = await chromium.launch();
  dataDir = mkdtempSync(join(tmpdir(), "jobtrace-e2e-"));
  db = openDatabase(":memory:");
  await fetch(sites.url(`${SITES.changing}__version/1`), { method: "POST" });

  const overlay = (target: Page) => target.locator("#__jobtrace-overlay");
  server = await startServer({
    config: loadConfig({ DATA_DIR: dataDir }),
    db,
    port: 0,
    webRoot,
    worker: {
      pollIntervalMs: 50,
      run: {
        browser,
        tuning: { pollIntervalMs: 25, fallbackGraceMs: 100, optionalFieldTimeoutMs: 100 },
      },
    },
    sessionHooks: {
      recorder: { browser, headless: true, openShadow: true },
      // The recorder window is driven here, the way a person would use its toolbar:
      // mark the list, the title, the link, and the location under a made-up name.
      onRecording: (session) => {
        void (async () => {
          const press = (action: string) =>
            overlay(session.page).locator(`[data-action="${action}"]`).click();
          const first = session.page.locator("li.job").first();
          await press("list");
          await first.locator(".type").click();
          await press("list-use");
          await expect.poll(() => session.status().scope).toBe("list");
          await first.locator("a.title").click();
          await press("save");
          await expect.poll(() => session.status().fields).toEqual(["title"]);
          // The same link again, this time for its address; jobs are matched across runs by URL.
          await first.locator("a.title").click();
          await overlay(session.page)
            .locator('.dialog.open [data-role="name"]')
            .selectOption("url");
          await press("save");
          await expect.poll(() => session.status().fields).toEqual(["title", "url"]);
          await first.locator(".loc").click();
          await overlay(session.page).locator('[data-role="name"]').selectOption("__custom");
          await overlay(session.page).locator('[data-role="custom"]').fill("place");
          await press("save");
        })();
      },
      onAuthCapture: (capture) => {
        void (async () => {
          await capture.page.locator('input[name="username"]').fill(LOGIN_CREDENTIALS.username);
          await capture.page.locator('input[name="password"]').fill(LOGIN_CREDENTIALS.password);
          await capture.page.getByRole("button", { name: "Sign in" }).click();
          await capture.page.getByTestId("signed-in").waitFor();
          await overlay(capture.page).locator('[data-action="auth-save"]').click();
        })();
      },
    },
  });
  const context = await browser.newContext({ acceptDownloads: true });
  context.setDefaultTimeout(10_000);
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  page.on("dialog", (dialog) => void dialog.accept());
});

afterAll(async () => {
  await server?.close();
  await browser?.close();
  await sites?.close();
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const open = (path: string) => page.goto(`${server.url}${path}`);
const heading = (name: string | RegExp) => page.getByRole("heading", { level: 1, name });
const stat = (label: string) =>
  page.getByTestId("run-stats").locator("div", { hasText: label }).locator("dd");

/** Waits on the run page until the run is over, and returns its final status. */
async function runFinished(): Promise<string> {
  await expect.poll(() => page.url()).toMatch(/\/runs\/run_/);
  const badge = page.locator("h1 span span").last();
  await expect
    .poll(() => badge.textContent(), { timeout: 30_000 })
    .toMatch(/succeeded|partial|failed|blocked|cancelled/);
  return (await badge.textContent()) ?? "";
}

describe("the web UI, end to end", () => {
  it("starts empty and saves settings", async () => {
    await open("/");
    await heading("Dashboard").waitFor();
    await page.getByText("Nothing new.").waitFor();
    await page.getByText("Idle").waitFor();

    await page.getByRole("link", { name: "Settings" }).click();
    await heading("Settings").waitFor();
    // Half a second between actions, so the first run is slow enough to watch.
    await page.getByLabel("Shortest pause between actions (ms)").fill("500");
    await page.getByLabel("Longest pause between actions (ms)").fill("500");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByText("Saved.").waitFor();
    expect(await db.settings.get("runtime")).toMatchObject({
      defaultMinDelayMs: 500,
      defaultMaxDelayMs: 500,
    });

    await page.getByLabel("Shortest pause between actions (ms)").fill("900");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByRole("alert").filter({ hasText: "minimum delay must not exceed" }).waitFor();
  });

  let recordingUrl = "";

  it("creates a recording through the UI", async () => {
    await open("/recordings");
    await page.getByText("No job boards yet.").waitFor();
    await page.getByRole("button", { name: "New recording" }).click();
    await page.getByLabel("Career page address").fill(sites.url(SITES.changing));
    await page.getByLabel("Name").fill("Acme board");
    await page.getByRole("button", { name: "Start recording" }).click();

    // The panel follows what happens in the recorder window.
    await page.getByTestId("session-panel").waitFor();
    await expect
      .poll(() => page.getByTestId("session-progress").textContent())
      .toMatch(/3 fields: title, url, place · in list/);
    await page.getByRole("button", { name: "Stop and save" }).click();

    await heading("Acme board").waitFor();
    recordingUrl = page.url();
    expect(recordingUrl).toMatch(/\/recordings\/rec_/);
    await page.getByText("Recording · 127.0.0.1 · 0 open jobs").waitFor();
    await page.getByText("Not run yet.").waitFor();
    // The new recording got the pause configured on the Settings page.
    expect(await page.getByLabel("Shortest pause between actions (ms)").inputValue()).toBe("500");
    await page.getByTestId("step-s2").locator("summary").first().click();
    await page.getByTestId("step-s3").locator("summary").click();
    expect(await page.getByTestId("field-2").getByLabel("Field name").inputValue()).toBe("place");
  });

  it("tries out a single step", async () => {
    const step = page.getByTestId("step-s3");
    await step.getByRole("button", { name: "Test step" }).click();
    const result = step.getByTestId("test-result");
    await result.waitFor({ timeout: 30_000 });
    expect(await result.textContent()).toContain("Worked");
    expect(await result.textContent()).toContain(changingJobs(1)[0]?.title);
    expect(await result.textContent()).toContain(changingJobs(1)[0]?.location);
  });

  it("runs it, shows the log live, and flags every job as new", async () => {
    await page.getByRole("button", { name: "Run now" }).click();
    await expect.poll(() => page.url()).toMatch(/\/runs\/run_/);
    const log = page.getByRole("list", { name: "Run log" });
    // The first log line shows up while the run is still going (it then pauses
    // half a second before loading the page, as configured above).
    await log.getByText('Running "Acme board"').waitFor();
    expect(await page.getByText("Live", { exact: true }).isVisible()).toBe(true);
    expect((await db.runs.list())[0]?.status).toBe("running");
    expect(await page.getByRole("button", { name: "Cancel run" }).isVisible()).toBe(true);
    await log.getByText("Found 5 item(s)").waitFor();

    expect(await runFinished()).toBe("succeeded");
    await log.getByText("5 job(s): 5 new, 0 changed, 0 closed").waitFor();
    expect(await stat("New").textContent()).toBe("5");
    await page.getByRole("heading", { name: "Jobs in this run (5)" }).waitFor();
    const rows = page.locator("table").last().locator("tbody tr");
    expect(await rows.count()).toBe(5);
    expect(await rows.getByText("New", { exact: true }).count()).toBe(5);
    expect(await rows.first().textContent()).toContain(changingJobs(1)[0]?.title);
    // "place" is not a core field yet, so the Location column is still empty.
    expect(await rows.first().locator("td").nth(2).textContent()).toBe("");
    await page.getByText("Steps", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Cancel run" }).count()).toBe(0);
  });

  it("edits a field name, reruns, and flags the jobs as changed", async () => {
    await page.getByRole("button", { name: "Open recording" }).click();
    await heading("Acme board").waitFor();
    await page.getByText("5 open jobs").waitFor();
    await page.getByTestId("step-s2").locator("summary").first().click();
    await page.getByTestId("step-s3").locator("summary").click();
    const name = page.getByTestId("field-2").getByLabel("Field name");
    await name.fill("");
    await page.getByRole("alert").filter({ hasText: "every field needs a name" }).waitFor();
    expect(await page.getByRole("button", { name: "Save changes" }).isDisabled()).toBe(true);
    await name.fill("location");
    await page.getByText("Unsaved changes", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Run now" }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => page.getByText("Unsaved changes", { exact: true }).count()).toBe(0);
    await expect
      .poll(async () => (await db.recordings.versions(recordingUrl.split("/").at(-1) ?? "")).length)
      .toBe(2);

    await page.getByRole("button", { name: "Run now" }).click();
    expect(await runFinished()).toBe("succeeded");
    expect(await stat("Changed").textContent()).toBe("5");
    expect(await stat("New").textContent()).toBe("0");
    const rows = page.locator("table").last().locator("tbody tr");
    expect(await rows.getByText("Changed", { exact: true }).count()).toBe(5);
    expect(await rows.first().locator("td").nth(2).textContent()).toBe(
      changingJobs(1)[0]?.location,
    );
  });

  it("restores an earlier version and reorders locators", async () => {
    await page.goto(recordingUrl);
    await heading("Acme board").waitFor();
    await page.getByTestId("step-s2").locator("summary").first().click();
    const locators = page
      .getByTestId("step-s2")
      .getByRole("list", { name: "Locators, tried in this order" })
      .first();
    const first = await locators.locator("code").first().textContent();
    await locators.getByRole("button", { name: "Try this locator later" }).first().click();
    expect(await locators.locator("code").nth(1).textContent()).toBe(first);
    await page.getByRole("button", { name: "Discard" }).click();
    expect(await locators.locator("code").first().textContent()).toBe(first);

    await page.getByRole("button", { name: "Restore" }).click();
    await page.getByText("Unsaved changes", { exact: true }).waitFor();
    await page.getByTestId("step-s3").locator("summary").click();
    expect(await page.getByTestId("field-2").getByLabel("Field name").inputValue()).toBe("place");
    await page.getByRole("button", { name: "Discard" }).click();
  });

  it("browses, searches and exports jobs, and shows them on the dashboard", async () => {
    await page.getByRole("link", { name: "Jobs", exact: true }).click();
    await heading("Jobs").waitFor();
    await page.getByText("5 jobs match").waitFor();
    await page.getByLabel("Search jobs").fill("frontend");
    await page.getByText("1 job match").waitFor();
    await page.getByRole("button", { name: "Frontend Engineer" }).click();
    const details = page.getByRole("dialog", { name: "Frontend Engineer" });
    await details.getByText("Remote (EU)").first().waitFor();
    await details.getByText("First seen").waitFor();
    expect(await details.getByRole("link", { name: "Open the posting" }).getAttribute("href")).toBe(
      sites.url(`${SITES.detail}jobs/${changingJobs(1)[1]?.id}`),
    );
    await details.getByRole("button", { name: "Close" }).click();
    await page.getByLabel("Work arrangement").selectOption("hybrid");
    await page.getByText("0 jobs match").waitFor();
    await page.getByLabel("Search jobs").fill("");
    await page.getByText("1 job match").waitFor();
    await page.getByLabel("Work arrangement").selectOption("");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export CSV" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("jobtrace-jobs.csv");

    await page.getByRole("link", { name: "Dashboard" }).click();
    await page.getByRole("heading", { name: /New jobs so far \(5\)/ }).waitFor();
    await page.getByRole("heading", { name: "Recent runs" }).waitFor();
    expect(await page.getByRole("link", { name: "Details" }).count()).toBe(2);
    await page.getByRole("button", { name: "Mark all as seen" }).click();
    await page.getByText("Nothing new.").waitFor();

    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await heading("Runs").waitFor();
    await page.getByLabel("Status").selectOption("failed");
    await page.getByText("No runs match.").waitFor();
    await page.getByLabel("Status").selectOption("succeeded");
    await expect.poll(() => page.locator("tbody tr").count()).toBe(2);
  });

  it("schedules the recording, shows it as upcoming, and pauses it", async () => {
    await page.getByRole("navigation").getByRole("link", { name: "Schedules" }).click();
    await page.getByText("No schedules yet.").waitFor();
    await page.getByRole("button", { name: "New schedule" }).click();
    await page.getByLabel("Recording or feed").selectOption({ label: "Acme board" });
    await page.getByLabel("Time zone").fill("Europe/Madrid");
    const preview = page.getByTestId("schedule-preview");
    await preview.getByText("Weekdays at 08:00 Europe/Madrid").waitFor();
    expect(await preview.locator("li").count()).toBe(5);

    await page.getByLabel("How often").selectOption("custom");
    await page.getByRole("textbox", { name: /Cron expression/ }).fill("* * * * *");
    await preview.getByText(/at most every 15 minutes/).waitFor();
    expect(await page.getByRole("button", { name: "Save schedule" }).isDisabled()).toBe(true);
    await page.getByLabel("How often").selectOption("daily");
    await page.getByLabel("Time", { exact: true }).fill("07:30");
    await preview.getByText("Every day at 07:30 Europe/Madrid").waitFor();
    await page.getByRole("button", { name: "Save schedule" }).click();

    const row = page.locator("tbody tr", { hasText: "Acme board" });
    await row.getByText("Every day at 07:30 Europe/Madrid").waitFor();
    await row.getByText("Never").waitFor();
    expect(server.scheduler.registered()).toHaveLength(1);

    await page.getByRole("link", { name: "Dashboard" }).click();
    const upcoming = page.getByTestId("upcoming");
    await upcoming.getByText("Every day at 07:30 Europe/Madrid").first().waitFor();
    expect(await upcoming.locator("li").count()).toBe(3);

    await page.getByRole("navigation").getByRole("link", { name: "Schedules" }).click();
    await row.getByRole("button", { name: "Pause" }).click();
    await row.getByText("Paused").waitFor();
    expect(server.scheduler.registered()).toEqual([]);
    await row.getByRole("button", { name: "Resume" }).click();
    await row.getByRole("button", { name: "Pause" }).waitFor();
    await row.getByRole("button", { name: "Delete" }).click();
    await page.getByText("No schedules yet.").waitFor();
  });

  it("saves and deletes a login", async () => {
    await page.getByRole("link", { name: "Saved logins" }).click();
    await page.getByText("No saved logins.").waitFor();
    await page.getByRole("button", { name: "New login" }).click();
    await page.getByLabel("Name").fill("Intranet");
    await page.getByLabel("Login page address").fill(sites.url(`${SITES.login}signin`));
    await page.getByRole("button", { name: "Open login window" }).click();
    await page.getByText("Login saved.").waitFor();
    const row = page.locator("tbody tr", { hasText: "Intranet" });
    await row.getByText("Not checked yet").waitFor();
    await row.getByText("0 recordings").waitFor();
    await row.getByRole("button", { name: "Delete" }).click();
    await page.getByText("No saved logins.").waitFor();
  });

  it("deletes the recording, serves deep links, and logged no browser errors", async () => {
    await page.goto(recordingUrl);
    await heading("Acme board").waitFor();
    await page.getByRole("button", { name: "Delete" }).click();
    await heading("Recordings").waitFor();
    await page.getByText("No job boards yet.").waitFor();
    expect(await db.jobs.count({ includeClosed: true })).toBe(0);

    // A deep link is answered with the app, which then shows the right page.
    await open("/jobs?q=nothing");
    await page.getByText("No jobs match.").waitFor();
    await open("/no/such/page");
    await page.getByText("There is nothing at this address.").waitFor();
    expect((await fetch(`${server.url}/api/nope`)).status).toBe(404);
    // The one expected console error: the 400 from the deliberately invalid settings save.
    expect(pageErrors.filter((message) => !message.includes("400"))).toEqual([]);
  });
});
