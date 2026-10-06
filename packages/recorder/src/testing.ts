import type { Recording, Step } from "@jobtrace/core";
import { type RunOptions, runRecording } from "@jobtrace/runner";
import type { Browser, Page } from "playwright";
import { expect } from "vitest";
import { OVERLAY_ID } from "./injected/protocol.ts";
import type { RecordingSession } from "./session.ts";

/** The recorder overlay; sessions under test open its shadow root so it can be driven. */
export const overlay = (page: Page) => page.locator(`#${OVERLAY_ID}`);

/** Clicks a toolbar or dialog button by its `data-action`. */
export const press = (session: RecordingSession, action: string) =>
  overlay(session.page).locator(`[data-action="${action}"]`).click();

export const types = (recording: Recording) => recording.steps.map((step) => step.type);

export const stepOf = <T extends Step["type"]>(steps: readonly Step[], type: T) =>
  steps.find((step): step is Extract<Step, { type: T }> => step.type === type);

export async function setMode(session: RecordingSession, mode: "mark" | "record") {
  await press(session, mode);
  await expect.poll(() => session.status().mode).toBe(mode === "mark" ? "markField" : "record");
}

/** Marks an element as a field through the overlay, like a user would. */
export async function mark(
  session: RecordingSession,
  click: () => Promise<void>,
  name: string,
  read?: "text" | "href" | "innerHTML",
) {
  const ui = overlay(session.page);
  await click();
  await ui.locator('.dialog.open [data-role="name"]').waitFor();
  const choice = ui.locator('[data-role="name"]');
  if ((await choice.locator(`option[value="${name}"]`).count()) > 0)
    await choice.selectOption(name);
  else {
    await choice.selectOption("__custom");
    await ui.locator('[data-role="custom"]').fill(name);
  }
  if (read) await ui.locator('[data-role="read"]').selectOption(read);
  await press(session, "save");
  await expect.poll(() => session.status().fields).toContain(name);
}

/** Marks a list by clicking one of its items and accepting the proposal. */
export async function markList(
  session: RecordingSession,
  click: () => Promise<void>,
  expectedCount: number,
) {
  await press(session, "list");
  await expect.poll(() => session.status().mode).toBe("markList");
  await click();
  await expect
    .poll(() => overlay(session.page).locator('[data-role="list-count"]').textContent())
    .toBe(`Found ${expectedCount} similar items`);
  await press(session, "list-use");
  await expect.poll(() => session.status()).toMatchObject({ scope: "list", mode: "markField" });
}

/** Replays a recording without politeness delays. */
export const replay = (recording: Recording, browser: Browser, options: RunOptions = {}) =>
  runRecording(recording, {
    browser,
    ...options,
    settings: { minDelayMs: 0, maxDelayMs: 0, stepTimeoutMs: 5000, ...options.settings },
    tuning: {
      pollIntervalMs: 25,
      fallbackGraceMs: 300,
      scrollWaitMs: 800,
      scrollAttempts: 2,
      ...options.tuning,
    },
  });
