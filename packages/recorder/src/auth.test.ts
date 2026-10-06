import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jobsFor,
  LOGIN_CREDENTIALS,
  type RunningTestSites,
  SITES,
  startTestSites,
} from "@jobtrace/test-sites";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthCapture, captureAuth } from "./auth.ts";
import { startRecording } from "./session.ts";
import { mark, markList, overlay, press, replay } from "./testing.ts";

let sites: RunningTestSites;
let browser: Browser;
let dir: string;

beforeAll(async () => {
  sites = await startTestSites();
  browser = await chromium.launch();
  dir = mkdtempSync(join(tmpdir(), "jobtrace-auth-"));
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
  rmSync(dir, { recursive: true, force: true });
});

const capture = (statePath: string, extra: Partial<Parameters<typeof captureAuth>[0]> = {}) =>
  captureAuth({
    url: sites.url(`${SITES.login}signin`),
    statePath,
    browser,
    headless: true,
    openShadow: true,
    ...extra,
  });

async function signIn({ page }: AuthCapture) {
  await page.locator('input[name="username"]').pressSequentially(LOGIN_CREDENTIALS.username);
  await page.locator('input[name="password"]').pressSequentially(LOGIN_CREDENTIALS.password);
  await page.locator('input[name="password"]').press("Enter");
  await page.getByTestId("signed-in").waitFor();
}

describe("login capture", () => {
  it("saves the session, readable only by the owner, when the user presses Save login", async () => {
    const statePath = join(dir, "nested", "state.json");
    const session = await capture(statePath);
    await signIn(session);
    await overlay(session.page).locator('[data-action="auth-save"]').click();
    expect(await session.finished).toEqual({ saved: true, domain: "127.0.0.1" });

    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    const state = readFileSync(statePath, "utf8");
    expect(JSON.parse(state).cookies.map((cookie: { name: string }) => cookie.name)).toContain(
      "jobtrace_session",
    );
    // The session is saved; what was typed to obtain it is not.
    expect(state).not.toContain(LOGIN_CREDENTIALS.password);
  });

  it("tightens the permissions of an existing file when refreshing", async () => {
    const statePath = join(dir, "loose.json");
    writeFileSync(statePath, "{}", { mode: 0o644 });
    const session = await capture(statePath);
    await signIn(session);
    await session.save();
    expect(statSync(statePath).mode & 0o777).toBe(0o600);

    // Starting from the saved session, the board opens without signing in again.
    const again = await capture(join(dir, "again.json"), {
      url: sites.url(SITES.login),
      existingState: statePath,
    });
    await again.page.getByTestId("signed-in").waitFor();
    await again.cancel();
  });

  it("saves nothing when cancelled, aborted, or when the window is closed", async () => {
    const cancelled = await capture(join(dir, "cancelled.json"));
    await overlay(cancelled.page).locator('[data-action="auth-cancel"]').click();
    expect((await cancelled.finished).saved).toBe(false);

    const closed = await capture(join(dir, "closed.json"));
    await closed.page.close();
    expect((await closed.finished).saved).toBe(false);

    const controller = new AbortController();
    const aborted = await capture(join(dir, "aborted.json"), { signal: controller.signal });
    controller.abort();
    expect((await aborted.finished).saved).toBe(false);

    for (const name of ["cancelled", "closed", "aborted"])
      expect(existsSync(join(dir, `${name}.json`))).toBe(false);
    await expect(
      capture(join(dir, "x.json"), { url: "http://127.0.0.1:9/" }),
    ).rejects.toMatchObject({
      code: "NAVIGATION_FAILED",
    });
  });

  it("shows only the save bar, and observes nothing the user does", async () => {
    const session = await capture(join(dir, "bar.json"));
    const bar = overlay(session.page);
    expect(await bar.locator("button").allTextContents()).toEqual(["Save login", "Cancel"]);
    expect(await bar.locator(".status").textContent()).toBe("Nothing you type is recorded");
    await session.cancel();
  });
});

describe("recording with a saved login", () => {
  it("stores the profile and the logged-in check, which a replay then enforces", async () => {
    const statePath = join(dir, "record.json");
    const login = await capture(statePath);
    await signIn(login);
    await login.save();

    const session = await startRecording({
      url: sites.url(SITES.login),
      browser,
      headless: true,
      openShadow: true,
      storageState: statePath,
      authProfileId: "auth_demo",
    });
    const { page } = session;
    await page.locator("li.job").first().waitFor();
    expect(session.status().auth).toEqual({ hasCheck: false });
    await press(session, "auth-check");
    await expect.poll(() => session.status().mode).toBe("markLoggedIn");
    await page.getByRole("link", { name: "Sign out" }).click();
    await expect
      .poll(() => session.status())
      .toMatchObject({ auth: { hasCheck: true }, mode: "record" });
    // Marking must not have followed the Sign out link.
    expect(page.url()).toBe(sites.url(SITES.login));
    await markList(session, () => page.locator("li.job .loc").first().click(), 5);
    await mark(session, () => page.locator("li.job .title").first().click(), "title");
    const { recording, warnings } = await session.stop();

    expect(warnings).toEqual([]);
    expect(recording.authProfileId).toBe("auth_demo");
    expect(recording.loggedInCheck?.locators[0]).toEqual({
      kind: "role",
      role: "link",
      name: "Sign out",
      exact: true,
    });

    const loggedIn = await replay(recording, browser, { storageState: statePath });
    expect(loggedIn.jobs.map((job) => job.title)).toEqual(jobsFor("login").map((job) => job.title));
    const anonymous = await replay(recording, browser, { settings: { stepTimeoutMs: 500 } });
    expect(anonymous).toMatchObject({ status: "failed", reason: "auth_expired" });
  });

  it("does not offer the logged-in check without a saved login", async () => {
    const session = await startRecording({
      url: sites.url(SITES.staticList),
      browser,
      headless: true,
      openShadow: true,
    });
    expect(session.status().auth).toBeUndefined();
    expect(await overlay(session.page).locator('[data-action="auth-check"]').isVisible()).toBe(
      false,
    );
    const { recording } = await session.stop();
    expect(recording).toMatchObject({ authProfileId: null });
    expect(recording.loggedInCheck).toBeUndefined();
  });
});
